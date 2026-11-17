import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  makeWalkModePressGrouper,
  WALK_MODE_REPEAT_WINDOW_MS,
  type WalkModePress,
} from "./presses.ts";

function setup() {
  const presses: WalkModePress[] = [];
  return { presses, grouper: makeWalkModePressGrouper((press) => presses.push(press)) };
}

describe("walk mode press grouper", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes a single press at once and a lone next or previous after the window", () => {
    vi.useFakeTimers();
    const { presses, grouper } = setup();
    grouper.press(1);
    expect(presses).toEqual([{ presses: 1, twice: false }]);
    grouper.press(2);
    vi.advanceTimersByTime(WALK_MODE_REPEAT_WINDOW_MS - 1);
    expect(presses).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(presses).toEqual([
      { presses: 1, twice: false },
      { presses: 2, twice: false },
    ]);
  });

  it("the same command twice inside the window is one gesture", () => {
    vi.useFakeTimers();
    const { presses, grouper } = setup();
    grouper.press(3);
    grouper.press(3);
    vi.advanceTimersByTime(WALK_MODE_REPEAT_WINDOW_MS);
    expect(presses).toEqual([{ presses: 3, twice: true }]);
  });

  it("a different press first releases the waiting one, in order", () => {
    vi.useFakeTimers();
    const { presses, grouper } = setup();
    grouper.press(2);
    grouper.press(3);
    grouper.press(1);
    expect(presses).toEqual([
      { presses: 2, twice: false },
      { presses: 3, twice: false },
      { presses: 1, twice: false },
    ]);
  });

  it("dispose drops a waiting press", () => {
    vi.useFakeTimers();
    const { presses, grouper } = setup();
    grouper.press(2);
    grouper.dispose();
    vi.advanceTimersByTime(WALK_MODE_REPEAT_WINDOW_MS);
    expect(presses).toEqual([]);
  });
});
