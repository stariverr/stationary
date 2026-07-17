import { createAuthClient } from "better-auth/vue";
import { emailOTPClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
    // baseURL: "/api/auth",
    // 'fetchOptions': {
    //     'credentials': 'include',
    // }
    plugins: [
        emailOTPClient()
    ]
});

export const { signIn, signUp, signOut, useSession, getSession } = authClient;
