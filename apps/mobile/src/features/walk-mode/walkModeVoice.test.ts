import { describe, expect, it } from "vite-plus/test";

import type { WalkModeVoice } from "../../native/walkModeAudio.types";
import { bestWalkModeVoice, resolveWalkModeVoice } from "./walkModeVoice";

const voice = (
  identifier: string,
  language: string,
  quality: WalkModeVoice["quality"],
): WalkModeVoice => ({ identifier, name: identifier, language, quality });

describe("bestWalkModeVoice", () => {
  it("prefers Premium, then Enhanced, and leaves default voices to iOS", () => {
    const compact = voice("compact", "en-US", "default");
    const enhanced = voice("enhanced", "en-US", "enhanced");
    const premium = voice("premium", "en-US", "premium");
    expect(bestWalkModeVoice([compact, enhanced, premium], "en-US")).toBe(premium);
    expect(bestWalkModeVoice([compact, enhanced], "en-US")).toBe(enhanced);
    expect(bestWalkModeVoice([compact], "en-US")).toBeNull();
  });

  it("matches the phone's language, the exact region first at equal quality", () => {
    const german = voice("german", "de-DE", "premium");
    const british = voice("british", "en-GB", "enhanced");
    const american = voice("american", "en-US", "enhanced");
    expect(bestWalkModeVoice([german, british, american], "en-US")).toBe(american);
    expect(bestWalkModeVoice([german, british], "en-US")).toBe(british);
    expect(bestWalkModeVoice([german], "en-US")).toBeNull();
  });

  it("returns null when nothing is installed", () => {
    expect(bestWalkModeVoice([], "en-US")).toBeNull();
  });
});

describe("resolveWalkModeVoice", () => {
  const premium = voice("premium", "en-US", "premium");
  const picked = voice("picked", "fr-FR", "default");

  it("keeps a picked voice while it is installed and falls back to Automatic once deleted", () => {
    expect(resolveWalkModeVoice("picked", { language: "en-US", voices: [premium, picked] })).toBe(
      "picked",
    );
    expect(resolveWalkModeVoice("picked", { language: "en-US", voices: [premium] })).toBe(
      "premium",
    );
    expect(resolveWalkModeVoice(null, { language: "en-US", voices: [premium, picked] })).toBe(
      "premium",
    );
  });
});
