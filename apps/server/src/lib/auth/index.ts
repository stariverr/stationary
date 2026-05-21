import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "@/global/db";
import * as schema from "@/db/schema";
import { env } from "@/global/env";

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
    trustedOrigins: env.TRUSTED_ORIGINS,
    emailAndPassword: {
        enabled: true,
    },
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
