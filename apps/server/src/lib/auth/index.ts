import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer, emailOTP, captcha } from "better-auth/plugins";
import { createAuthMiddleware, APIError, getIp } from "better-auth/api";
import { createHmac } from "crypto";
import { db } from "@/global/db";
import * as schema from "@/db/schema";
import { env } from "@/global/env";
import { kv } from "@/global/kv";
import { Resend } from "resend";

const resend = new Resend(env.RESEND_API_KEY);

const emailRateLimitPlugin = () => ({
    id: "email-rate-limit",
    hooks: {
        before: [
            {
                matcher(context: any) {
                    return context.path === "/email-otp/send-verification-otp" || context.path === "/email-otp/request-password-reset";
                },
                handler: createAuthMiddleware(async (ctx) => {
                    const email = ctx.body?.email;
                    if (typeof email !== "string" || !email) {
                        return; // Let Better Auth validate email presence/format
                    }

                    const normalizedEmail = email.trim().toLowerCase();
                    const emailHash = createHmac("sha256", env.BETTER_AUTH_SECRET || "")
                        .update(normalizedEmail)
                        .digest("hex");
                    const ip = (ctx.request ? getIp(ctx.request, ctx.context.options) : null) || "unknown-ip";

                    // 1. Email 60s cooldown (1 / 60s)
                    const emailCooldownKey = `rate-limit:email:cooldown:${emailHash}`;
                    const cooldownRes = await kv.consumeFixedWindow(emailCooldownKey, 1, 60);
                    if (!cooldownRes.allowed) {
                        const err = new APIError("TOO_MANY_REQUESTS", {
                            message: "Verification code requested too frequently. Please wait.",
                            code: "OTP_COOLDOWN",
                        });
                        err.headers = {
                            "Retry-After": String(cooldownRes.retryAfter),
                            "X-Retry-After": String(cooldownRes.retryAfter),
                        };
                        throw err;
                    }

                    // 2. Email daily limit (15 / 24h)
                    const emailDailyKey = `rate-limit:email:daily:${emailHash}`;
                    const dailyRes = await kv.consumeFixedWindow(emailDailyKey, 15, 86400);
                    if (!dailyRes.allowed) {
                        const err = new APIError("TOO_MANY_REQUESTS", {
                            message: "Daily verification code limit exceeded. Please try again later.",
                            code: "OTP_DAILY_LIMIT",
                        });
                        err.headers = {
                            "Retry-After": String(dailyRes.retryAfter),
                            "X-Retry-After": String(dailyRes.retryAfter),
                        };
                        throw err;
                    }

                    // 3. IP hourly limit (30 / 1h)
                    const ipHourlyKey = `rate-limit:ip:hourly:${ip}`;
                    const ipRes = await kv.consumeFixedWindow(ipHourlyKey, 30, 3600);
                    if (!ipRes.allowed) {
                        const err = new APIError("TOO_MANY_REQUESTS", {
                            message: "IP address hourly limit exceeded. Please try again later.",
                            code: "IP_HOURLY_LIMIT",
                        });
                        err.headers = {
                            "Retry-After": String(ipRes.retryAfter),
                            "X-Retry-After": String(ipRes.retryAfter),
                        };
                        throw err;
                    }
                }),
            },
        ],
    },
});

export const auth = betterAuth({
    database: drizzleAdapter(db, {
        provider: "pg",
        schema: {
            user: schema.BetterUser,
            session: schema.BetterSession,
            account: schema.BetterAccount,
            verification: schema.BetterVerification,
        },
    }),
    advanced: {
        ipAddress: {
            ipAddressHeaders: ["cf-connecting-ip"],
        },
    },
    rateLimit: {
        customStorage: {
            get: async (key) => null,
            set: async (key, value, update) => {},
            consume: async (key, rule) => {
                const res = await kv.consumeFixedWindow(`auth:rate-limit:${key}`, rule.max, rule.window);
                return {
                    allowed: res.allowed,
                    retryAfter: res.allowed ? null : res.retryAfter,
                };
            },
        },
    },
    emailAndPassword: {
        enabled: true,
        requireEmailVerification: true,
        minPasswordLength: 8,
        maxPasswordLength: 20,
    },
    emailVerification: {
        sendOnSignUp: true,
        autoSignInAfterVerification: true,
    },
    plugins: [
        bearer(),
        emailOTP({
            overrideDefaultEmailVerification: true,
            sendVerificationOTP: async ({ email, otp, type }, request) => {
                let subject = "Stationary - Verification Code";
                let html = `
                    <div style="font-family: sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; border: 1px solid #e5e7eb; rounded: 12px;">
                        <h2 style="color: #10b981; font-weight: bold; margin-bottom: 16px;">Stationary</h2>
                        <p style="font-size: 16px; color: #374151;">Hello,</p>
                        <p style="font-size: 16px; color: #374151; line-height: 1.5;">
                            ${
                                type === "forget-password"
                                    ? "You requested to reset your password. Please use the following code to reset it:"
                                    : "Thank you for registering. Please use the following verification code to verify your email address:"
                            }
                        </p>
                        <div style="font-size: 24px; font-weight: bold; letter-spacing: 4px; text-align: center; margin: 24px 0; color: #111827; padding: 12px; background: #f9fafb; border-radius: 8px;">
                            ${otp}
                        </div>
                        <p style="font-size: 14px; color: #6b7280;">This code is valid for 5 minutes. If you did not make this request, you can safely ignore this email.</p>
                    </div>
                `;

                if (type === "forget-password") {
                    subject = "Stationary - Reset Password Code";
                } else if (type === "email-verification") {
                    subject = "Stationary - Email Verification Code";
                }

                try {
                    const { data, error } = await resend.emails.send({
                        from: `Stationary <${env.RESEND_EMAIL_SENDER}>`,
                        to: email,
                        subject: subject,
                        html: html,
                    });
                    if (error) {
                        console.error(`[Resend] Failed to send OTP to ${email}:`, error);
                        throw new Error(`Failed to send verification email: ${error.message}`);
                    }
                    console.log(`[Resend] Successfully sent OTP (${type}) to ${email}, id: ${data?.id}`);
                } catch (error) {
                    console.error(`[Resend] Error in sendVerificationOTP callback for ${email}:`, error);
                    throw error;
                }
            },
        }),
        captcha({
            provider: "cloudflare-turnstile",
            secretKey: env.TURNSTILE_SECRET_KEY,
            endpoints: ["/sign-up/email", "/sign-in/email", "/email-otp/request-password-reset"],
        }),
        emailRateLimitPlugin(),
    ],
    trustedOrigins: env.TRUSTED_ORIGINS,
    socialProviders: {
        github: {
            clientId: process.env.GITHUB_CLIENT_ID || "",
            clientSecret: process.env.GITHUB_CLIENT_SECRET || "",
        },
        google: {
            clientId: process.env.GOOGLE_CLIENT_ID || "",
            clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
        },
    },
    user: {
        additionalFields: {
            externalId: {
                type: "string",
                required: false,
            },
        },
    },
    databaseHooks: {
        user: {
            create: {
                after: async (user) => {
                    await db.insert(schema.User).values({
                        auth_id: user.id,
                        name: user.name,
                        image: user.image || null,
                    });
                },
            },
        },
    },
});
