import { defineStore } from "pinia";
import { ref, watch } from "vue";
import { useApi } from "@/composables/useApi";
import { useSession } from "@/lib/auth-client";

export interface BusinessUser {
    id: string;
    auth_id: string;
    name: string;
    image: string | null;
    email: string | null;
    create_time?: string;
    update_time?: string;
}

export const useUserStore = defineStore("user", () => {
    const expandDetailByDefault = ref(false);
    const userProfile = ref<BusinessUser | null>(null);
    const isLoading = ref(false);

    const toggleExpandDefault = () => {
        expandDetailByDefault.value = !expandDetailByDefault.value;
    };

    const fetchUserProfile = async () => {
        isLoading.value = true;
        try {
            console.log("[useUserStore] Fetching user profile...");
            const response = await useApi<{ success: boolean; data: BusinessUser }>("/user");
            console.log("[useUserStore] Fetching user profile success:", response);
            if (response && response.success) {
                userProfile.value = response.data;
            }
        } catch (error) {
            console.error("[useUserStore] Failed to fetch user profile:", error);
        } finally {
            isLoading.value = false;
        }
    };

    return {
        expandDetailByDefault,
        toggleExpandDefault,
        userProfile,
        isLoading,
        fetchUserProfile,
    };
});
