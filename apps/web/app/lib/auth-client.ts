import { createAuthClient } from "better-auth/vue";

export const authClient = createAuthClient({
    // baseURL: "/api/auth",
    // 'fetchOptions': {
    //     'credentials': 'include',
    // }

});

export const { signIn, signUp, signOut, useSession, getSession } = authClient;
