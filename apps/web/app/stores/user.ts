import { defineStore } from 'pinia';

export const useUserStore = defineStore('user', () => {
    const expandDetailByDefault = ref(false);

    const toggleExpandDefault = () => {
        expandDetailByDefault.value = !expandDetailByDefault.value;
    };

    return {
        expandDetailByDefault,
        toggleExpandDefault
    };
});
