import { useUserStore } from "@/stores/user";

export const useUserSettings = () => {
    const store = useUserStore();

    return {
        store,
    };
};
