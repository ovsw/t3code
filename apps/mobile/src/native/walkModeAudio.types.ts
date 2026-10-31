export type WalkModeGestureEvent =
  | { readonly presses: 1 | 2 | 3; readonly source?: undefined }
  | { readonly presses: 1; readonly source: "call"; readonly action: string };
export type WalkModeSpeechEvent = { readonly type: "chunkFinished" };
export type WalkModeSessionEvent = { readonly type: "route"; readonly headphones: boolean };

export interface WalkModeAudio {
  configureSession(): Promise<void>;
  speak(chunks: readonly string[]): Promise<void>;
  setNowPlayingTitle(title: string): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  announce(text: string): Promise<void>;
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
