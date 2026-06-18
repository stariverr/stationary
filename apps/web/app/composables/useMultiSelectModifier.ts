export const useMultiSelectModifier = () => {
    const isApplePlatform = () => {
        if (!import.meta.client) return false;

        const platform = (navigator as any).userAgentData?.platform || navigator.platform || navigator.userAgent || "";

        return /Mac|iPhone|iPad|iPod/i.test(platform);
    };

    const isMultiSelectClick = (event: MouseEvent) => {
        return isApplePlatform() ? event.metaKey : event.ctrlKey;
    };

    return {
        isApplePlatform,
        isMultiSelectClick,
    };
};
