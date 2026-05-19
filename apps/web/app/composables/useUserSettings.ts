import { useUserStore } from '@/stores/user';

export const useUserSettings = () => {
    const store = useUserStore();

    return {
        expandDetailByDefault: computed({
            get: () => store.expandDetailByDefault,
            set: (val) => store.expandDetailByDefault = val
        }),
        toggleExpandDefault: store.toggleExpandDefault
    };
};

