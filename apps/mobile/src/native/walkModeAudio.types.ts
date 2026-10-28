export type WalkModeGestureEvent =
  | { readonly presses: 1 | 2 | 3; readonly source?: undefined }
  | { readonly presses: 1; readonly source: "call"; readonly action: string };
export type WalkModeSpeechEvent = {
  readonly type: "chunkStarted" | "chunkFinished" | "finished";
};
export type WalkModeSessionEvent =
  | { readonly type: "configured" }
  | { readonly type: "engineRestarted" }
  | { readonly type: "callAudioActivated" }
  | { readonly type: "route"; readonly outputs: string; readonly inputs: string };

export interface WalkModeAudio {
  configureSession(): Promise<void>;
  speak(chunks: readonly string[]): Promise<void>;
  enqueue(chunks: readonly string[]): Promise<void>;
  setNowPlayingTitle(title: string): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
  setKeepAlive(enabled: boolean): Promise<void>;
  startRecording(useCallMode: boolean): Promise<string>;
  stopRecording(): Promise<{ readonly uri: string | null; readonly seconds: number }>;
  playSound(kind: "error" | "sent" | "tick" | "thinking"): Promise<void>;
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
