import { useColorMode } from "@vueuse/core";

/** The app theme: "dark" toggles the `dark` class on <html>. Used once by app.vue to apply it, and by the appearance settings to change it. */
export const useThemeMode = () =>
    useColorMode({
        attribute: "class",
        modes: {
            light: "",
            dark: "dark",
        },
    });
