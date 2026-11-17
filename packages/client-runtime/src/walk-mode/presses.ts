// @effect-diagnostics globalTimers:off - The grouper runs in the mobile client without an Effect runtime.

export const WALK_MODE_REPEAT_WINDOW_MS = 500;

export type WalkModePress =
  | { readonly presses: 1 | 2 | 3; readonly twice: false }
  | { readonly presses: 2 | 3; readonly twice: true };

/**
 * iOS reports a headphone double and triple press as next and previous track, the same
 * commands a media remote's buttons send. The same one twice within the window is its own
 * gesture, so a lone next or previous waits out the window; a single press passes at once.
 */
export function makeWalkModePressGrouper(onPress: (press: WalkModePress) => void) {
  let pending: { readonly presses: 2 | 3; readonly timer: ReturnType<typeof setTimeout> } | null =
    null;

  const flush = () => {
    if (pending === null) return;
    const { presses, timer } = pending;
    pending = null;
    clearTimeout(timer);
    onPress({ presses, twice: false });
  };

  return {
    press(presses: 1 | 2 | 3): void {
      if (pending !== null && pending.presses === presses) {
        clearTimeout(pending.timer);
        pending = null;
        onPress({ presses, twice: true });
        return;
      }
      flush();
      if (presses === 1) {
        onPress({ presses, twice: false });
        return;
      }
      pending = { presses, timer: setTimeout(flush, WALK_MODE_REPEAT_WINDOW_MS) };
    },
    dispose(): void {
      if (pending !== null) clearTimeout(pending.timer);
      pending = null;
    },
  };
}
