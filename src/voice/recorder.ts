import { transcribe } from "../api/mistral.ts";
import { setPanelText } from "../ui/uikit-panel.ts";

// Shared voice-capture driver. It owns the mic stream, the MediaRecorder, and
// the single-flight `busy` guard, and turns a recording into transcribed text.
//
// It is action-agnostic: each trigger supplies what to do with the transcript
// via CaptureRequest.onTranscript, so the vision-Q&A and object-generation
// flows reuse the exact same record → transcribe path (and status messages)
// while diverging only on what the transcript feeds into.

export interface CaptureRequest {
  /** Called with the transcribed prompt once the clip is transcribed. */
  onTranscript: (prompt: string) => Promise<void> | void;
  /** Reflect recording state in the UI (e.g. tint the initiating button). */
  onRecordingChange?: (on: boolean) => void;
}

export interface VoiceRecorder {
  /**
   * Acquire the mic stream ahead of time so the permission prompt fires now
   * rather than on the first record. Requesting getUserMedia mid-session tears
   * down the immersive XR session, so this is called once on page load (mirrors
   * the camera warm-up in setupEventListeners).
   */
  warmUp(): Promise<void>;
  start(req: CaptureRequest): Promise<void>;
  stop(): void;
  toggle(req: CaptureRequest): void;
  readonly isRecording: boolean;
}

export function createVoiceRecorder(): VoiceRecorder {
  let micStream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  let recording = false;
  // True from stop() until the transcribe + action round-trip finishes; guards
  // against starting a new recording mid-flight.
  let busy = false;
  // The trigger that started the in-progress recording. Its onTranscript runs
  // once transcription completes, and its onRecordingChange resets the UI.
  let active: CaptureRequest | null = null;

  async function getMic(): Promise<MediaStream | null> {
    if (micStream) return micStream;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      console.error("Microphone error:", err);
    }
    return micStream;
  }

  function pickMimeType(): string {
    // Quest Browser / Chromium record Opus-in-WebM; Safari falls back to mp4.
    // Both are accepted by the transcription endpoint (verified).
    const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
    for (const c of candidates) if (MediaRecorder.isTypeSupported(c)) return c;
    return "";
  }

  async function start(req: CaptureRequest) {
    if (recording || busy) return;
    const stream = await getMic();
    if (!stream) {
      setPanelText("Microphone unavailable — check permissions and try again.");
      return;
    }
    active = req;
    chunks = [];
    const mimeType = pickMimeType();
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    recorder.onstop = () => void process();
    recorder.start();
    recording = true;
    req.onRecordingChange?.(true);
    setPanelText("Listening… speak your prompt.");
  }

  function stop() {
    if (!recording || !recorder) return;
    recording = false;
    active?.onRecordingChange?.(false);
    recorder.stop(); // fires onstop -> process()
  }

  function toggle(req: CaptureRequest) {
    if (recording) stop();
    else void start(req);
  }

  async function process() {
    if (busy) return;
    busy = true;
    const req = active;
    try {
      const blob = new Blob(chunks, {
        type: recorder?.mimeType || "audio/webm",
      });
      chunks = [];
      if (blob.size === 0) {
        setPanelText("No audio captured — try holding a little longer.");
        return;
      }

      setPanelText("Transcribing…");
      const prompt = await transcribe(blob);
      if (!prompt) {
        setPanelText("Couldn't make out any speech. Try again.");
        return;
      }

      await req?.onTranscript(prompt);
    } catch (err) {
      console.error("Voice flow error:", err);
      setPanelText("Something went wrong. Try again.");
    } finally {
      busy = false;
      active = null;
    }
  }

  return {
    async warmUp() {
      await getMic();
    },
    start,
    stop,
    toggle,
    get isRecording() {
      return recording;
    },
  };
}

// The whole app shares one recorder so its single-flight `busy` guard serialises
// every voice flow (Ask / Create / Place): a recording or its round-trip in one
// flow blocks starting another, regardless of which trigger fired.
let shared: VoiceRecorder | null = null;

/** The shared, lazily-created voice recorder used by all voice-driven flows. */
export function getVoiceRecorder(): VoiceRecorder {
  if (!shared) shared = createVoiceRecorder();
  return shared;
}
