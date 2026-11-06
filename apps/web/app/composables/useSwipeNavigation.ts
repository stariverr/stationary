import { useEventListener, usePreferredReducedMotion } from "@vueuse/core";
import type { MaybeRefOrGetter } from "vue";
import { WheelGestures, type WheelEventState } from "wheel-gestures";

type Direction = "previous" | "next";

interface SwipeNavigationOptions {
    /** Whether a new swipe may start, e.g. false while an image is zoomed in and drags pan it. */
    enabled: () => boolean;
    canPrevious: () => boolean;
    canNext: () => boolean;
    navigate: (direction: Direction) => void | Promise<void>;
}

/** Space between neighbouring items on the strip. */
export const SWIPE_GAP_PX = 24;
/** Movement before a pointer drag picks an axis; below it the press is still a tap or click. */
const AXIS_LOCK_DISTANCE = 10;
/** Share of the stage width that commits a slow drag. */
const COMMIT_RATIO = 0.2;
/** Release speed in px/ms that commits regardless of distance. */
const COMMIT_VELOCITY = 0.35;
const VELOCITY_WINDOW_MS = 100;
/** Rubber band stiffness past the first or last item, as in UIScrollView. */
const RUBBER_BAND = 0.55;
/**
 * Ease-out-quart. Its slope at the start is 4, so a duration of 4 × distance / release speed starts the animation
 * at the speed the gesture let go.
 */
const EASING = "cubic-bezier(0.25, 1, 0.5, 1)";
const EASING_START_SLOPE = 4;
const MIN_DURATION_MS = 240;
const MAX_DURATION_MS = 420;

/**
 * Horizontal swipe between stage items, as a strip: the content and its neighbours follow the gesture, and a release
 * finishes the move at the speed it let go. Touch, pen and mouse drags arrive as pointer events; two-finger trackpad
 * swipes produce only wheel events, which `wheel-gestures` turns into a gesture with a finger lift.
 *
 * Apply `style` to a strip inside `target` that holds the current item at 0 and the neighbours at ±(100% +
 * {@link SWIPE_GAP_PX}). `target` itself must not move, so it stays under the pointer and keeps receiving the
 * gesture. It also needs `touch-action: pan-y` so the browser leaves horizontal touch pans to it.
 *
 * Once a drag locks onto the horizontal axis the stage captures the pointer and claims the gesture, so the release
 * never reaches the viewer below as a tap (Video.js would toggle playback). A second finger hands the gesture back
 * for pinch-zoom. Controls that own their pointer (Video.js sliders) stop propagation, so they never start one.
 */
export function useSwipeNavigation(target: MaybeRefOrGetter<HTMLElement | null | undefined>, options: SwipeNavigationOptions) {
    const offset = ref(0);
    const transitionMs = ref(0);
    const isDragging = ref(false);
    const isAnimating = ref(false);
    const reducedMotion = usePreferredReducedMotion();

    /** Distance from one item to the next on the strip. */
    let pitch = 0;

    const canGo = (direction: Direction) => (direction === "next" ? options.canNext() : options.canPrevious());
    const directionOf = (dx: number): Direction => (dx < 0 ? "next" : "previous");

    const durationFor = (distance: number, velocity: number) => {
        if (reducedMotion.value === "reduce") return 0;
        const speed = Math.abs(velocity);
        const matched = speed > 0 ? (EASING_START_SLOPE * distance) / speed : MAX_DURATION_MS;
        return Math.round(Math.min(MAX_DURATION_MS, Math.max(MIN_DURATION_MS, matched)));
    };

    let animationTimer: ReturnType<typeof setTimeout> | null = null;
    const animateTo = (to: number, velocity: number) =>
        new Promise<void>((resolve) => {
            const duration = durationFor(Math.abs(to - offset.value), velocity);
            isAnimating.value = true;
            transitionMs.value = duration;
            offset.value = to;
            if (animationTimer) clearTimeout(animationTimer);
            animationTimer = setTimeout(() => {
                animationTimer = null;
                transitionMs.value = 0;
                isAnimating.value = false;
                resolve();
            }, duration);
        });

    // Shared drag core: follow, then commit or settle.

    const begin = () => {
        pitch = (toValue(target)?.clientWidth ?? 0) + SWIPE_GAP_PX;
        isDragging.value = true;
    };

    const follow = (dx: number) => {
        if (canGo(directionOf(dx))) {
            offset.value = Math.max(-pitch, Math.min(pitch, dx));
            return;
        }
        // Past the first or last item the strip resists more the further it is pulled.
        offset.value = Math.sign(dx) * (1 - 1 / ((Math.abs(dx) * RUBBER_BAND) / pitch + 1)) * pitch;
    };

    const release = async (dx: number, velocity: number) => {
        isDragging.value = false;
        const direction = directionOf(dx);
        const farEnough = Math.abs(dx) > pitch * COMMIT_RATIO;
        const fastEnough = Math.abs(velocity) > COMMIT_VELOCITY && Math.sign(velocity) === Math.sign(dx);
        if (!canGo(direction) || !(farEnough || fastEnough)) {
            await animateTo(0, velocity);
            return;
        }
        // Land the neighbour exactly where the current item sits, then swap the real viewer in under it.
        await animateTo(direction === "next" ? -pitch : pitch, velocity);
        await options.navigate(direction);
        offset.value = 0;
    };

    // Pointer drags.

    const pointers = new Set<number>();
    let pointerId: number | null = null;
    let startX = 0;
    let startY = 0;
    let axis: "x" | "y" | null = null;
    let samples: { x: number; t: number }[] = [];

    const resetPointer = () => {
        pointerId = null;
        axis = null;
        samples = [];
    };

    const onPointerDown = (e: PointerEvent) => {
        if (e.button !== 0) return;
        pointers.add(e.pointerId);
        if (pointers.size > 1) {
            // Pinch: give the gesture back to the viewer.
            if (axis === "x") void release(0, 0);
            resetPointer();
            return;
        }
        if (isAnimating.value || isDragging.value || !options.enabled()) return;
        pointerId = e.pointerId;
        startX = e.clientX;
        startY = e.clientY;
        samples = [{ x: e.clientX, t: e.timeStamp }];
    };

    const onPointerMove = (e: PointerEvent) => {
        if (e.pointerId !== pointerId) return;
        if (!axis) {
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            if (Math.hypot(dx, dy) < AXIS_LOCK_DISTANCE) return;
            axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
            if (axis === "y") return;
            begin();
            // Keep receiving the drag outside the stage, and take it away from the viewer below.
            try {
                toValue(target)?.setPointerCapture(e.pointerId);
            } catch {}
            // Follow from here, so the strip does not jump by the lock distance.
            startX = e.clientX;
        }
        if (axis !== "x") return;

        samples.push({ x: e.clientX, t: e.timeStamp });
        while (samples.length > 2 && e.timeStamp - samples[0]!.t > VELOCITY_WINDOW_MS) samples.shift();
        follow(e.clientX - startX);
    };

    const onPointerUp = (e: PointerEvent) => {
        pointers.delete(e.pointerId);
        if (e.pointerId !== pointerId) return;
        const claimed = axis === "x";
        const dx = e.clientX - startX;
        const first = samples[0];
        const velocity = first && e.timeStamp > first.t ? (e.clientX - first.x) / (e.timeStamp - first.t) : 0;
        resetPointer();
        if (!claimed) return;
        // The stage owns this gesture: keep the release from reading as a tap underneath.
        e.stopPropagation();
        void release(dx, velocity);
    };

    const onPointerCancel = (e: PointerEvent) => {
        pointers.delete(e.pointerId);
        if (e.pointerId !== pointerId) return;
        if (axis === "x") void release(0, 0);
        resetPointer();
    };

    // Presses bubble up, so controls that stop propagation (sliders) never start a swipe. The rest is caught in the
    // capture phase, so the stage decides before the viewer and the player see the release.
    useEventListener(target, "pointerdown", onPointerDown);
    useEventListener(target, "pointermove", onPointerMove, { capture: true });
    useEventListener(target, "pointerup", onPointerUp, { capture: true });
    useEventListener(target, "pointercancel", onPointerCancel, { capture: true });

    // Two-finger trackpad swipes. The strip follows the fingers and is released when they lift, which is when the
    // browser's momentum takes over. The momentum tail is swallowed, so it neither moves the strip nor triggers the
    // browser's history swipe.

    let wheelGesture: "none" | "following" | "swallowing" = "none";

    const onWheelGesture = (state: WheelEventState) => {
        // Content follows the fingers: wheel-gestures reverses the wheel's sign on x by default.
        const [movementX, movementY] = state.axisMovement;
        if (state.isStart) {
            wheelGesture = "none";
            const horizontal = Math.abs(movementX) > Math.abs(movementY);
            // Pinch-zoom, vertical scrolling and a zoomed-in viewer keep their wheel.
            if (!horizontal || state.event.ctrlKey || state.isMomentum || isDragging.value || !options.enabled()) return;
            if (isAnimating.value) {
                wheelGesture = "swallowing";
            } else {
                wheelGesture = "following";
                begin();
            }
        }
        if (wheelGesture === "none") return;
        state.event.preventDefault?.();

        if (wheelGesture === "following") {
            if (state.isMomentum || state.isEnding) {
                wheelGesture = "swallowing";
                void release(movementX, state.axisVelocity[0]);
            } else {
                follow(movementX);
            }
        }
        if (state.isEnding) wheelGesture = "none";
    };

    // Prevention is decided per gesture above, not by axis.
    const wheelGestures = WheelGestures({ preventWheelAction: false });
    wheelGestures.on("wheel", onWheelGesture);
    watch(
        () => toValue(target),
        (element, _, onCleanup) => {
            if (element) onCleanup(wheelGestures.observe(element));
        },
        { immediate: true },
    );

    onBeforeUnmount(() => {
        wheelGestures.disconnect();
        if (animationTimer) clearTimeout(animationTimer);
    });

    const style = computed(() => ({
        transform: offset.value ? `translate3d(${offset.value}px, 0, 0)` : undefined,
        transition: transitionMs.value ? `transform ${transitionMs.value}ms ${EASING}` : undefined,
    }));

    /** Which neighbour the strip is showing, if it is off its resting place. */
    const direction = computed<Direction | null>(() => (offset.value < 0 ? "next" : offset.value > 0 ? "previous" : null));

    return { style, isDragging, direction };
}
