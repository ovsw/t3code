export type WalkModeGestureEvent =
  | { readonly presses: 1 | 2 | 3; readonly source?: undefined }
  | { readonly presses: 1; readonly source: "call"; readonly action: string };
export type WalkModeSpeechEvent = { readonly type: "chunkFinished" };
export type WalkModeSessionEvent = { readonly type: "route"; readonly headphones: boolean };

export type WalkModeVoiceQuality = "default" | "enhanced" | "premium";
export type WalkModeVoice = {
  readonly identifier: string;
  readonly name: string;
  /** BCP 47, such as "en-US". */
  readonly language: string;
  readonly quality: WalkModeVoiceQuality;
};
export type WalkModeInstalledVoices = {
  /** The phone's speech language. */
  readonly language: string;
  readonly voices: readonly WalkModeVoice[];
};
/** A null identifier, or one no longer installed, speaks in the iOS default voice. */
export type WalkModeVoiceChoice = { readonly identifier: string | null; readonly speed: number };

export interface WalkModeAudio {
  configureSession(): Promise<void>;
  speak(chunks: readonly string[], voice: WalkModeVoiceChoice): Promise<void>;
  setNowPlayingTitle(title: string): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  announce(text: string, voice: WalkModeVoiceChoice): Promise<void>;
  listVoices(): Promise<WalkModeInstalledVoices>;
  previewVoice(text: string, voice: WalkModeVoiceChoice): Promise<void>;
  setKeepAlive(enabled: boolean): Promise<void>;
  hasWiredInput(): Promise<boolean>;
  startRecording(useCallMode: boolean): Promise<string>;
  stopRecording(): Promise<{ readonly uri: string | null; readonly seconds: number }>;
  playSound(kind: "error" | "sent" | "saved" | "tick" | "thinking"): Promise<void>;
  shutdown(): Promise<void>;
  addListener(
    event: "gesture",
    listener: (event: WalkModeGestureEvent) => void,
  ): { remove(): void };
  addListener(event: "speech", listener: (event: WalkModeSpeechEvent) => void): { remove(): void };
  addListener(
    event: "session",
    listener: (event: WalkModeSessionEvent) => void,
  ): { remove(): void };
}
