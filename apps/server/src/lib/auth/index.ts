import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer, emailOTP, captcha } from "better-auth/plugins";
import { db } from "@/global/db";
import * as schema from "@/db/schema";
import { env } from "@/global/env";
import { Resend } from "resend";

const resend = new Resend(env.RESEND_API_KEY);

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
                            ${type === "forget-password" 
                                ? "You requested to reset your password. Please use the following code to reset it:" 
                                : "Thank you for registering. Please use the following verification code to verify your email address:"}
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
                    await resend.emails.send({
                        from: "Stationary <onboarding@resend.dev>",
                        to: email,
                        subject: subject,
                        html: html,
                    });
                    console.log(`[Resend] Successfully sent OTP (${type}) to ${email}`);
                } catch (error) {
                    console.error(`[Resend] Failed to send OTP to ${email}:`, error);
                }
            }
        }),
        captcha({
            provider: "cloudflare-turnstile",
            secretKey: env.TURNSTILE_SECRET_KEY,
        }),
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
