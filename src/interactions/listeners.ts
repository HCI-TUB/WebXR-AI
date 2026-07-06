import AFRAME from "aframe";
import {
  setPanelText,
  setButtonHandler,
  setButtonLabel,
  setButtonRecording,
} from "../ui/uikit-panel.ts";
import { createVoiceRecorder, type CaptureRequest } from "../voice/recorder.ts";
import {
  chat,
  streamChat,
  CHAT_MODEL,
  OBJECT_MODEL,
  type ChatMessage,
} from "../api/mistral.ts";

// Two voice-driven flows share one record → transcribe path (src/recorder.ts):
//
//   Ask   (X button / 'P' / "Record" button): transcribe the prompt, grab a
//         camera frame, and stream the multimodal model's reply to the panel.
//   Create(Y button / 'O' / "Create" button): transcribe the prompt and ask the
//         object model (Devstral) to turn it into A-Frame markup, handed to
//         handleObjectResponse() below.
//
// A recording is transcribed only after the clip finishes, which matches the
// hold-to-talk / record-then-send UX (see CLAUDE.md for the Voxtral rationale).

// System prompt for the object-generation flow: turn a spoken description into
// A-Frame entity markup we can drop straight into the scene.
const OBJECT_SYSTEM_PROMPT = `You generate 3D objects for an A-Frame WebXR scene from a short spoken description.
Reply with ONLY A-Frame entity markup (e.g. <a-box>, <a-sphere>, <a-cylinder>, <a-cone>, <a-torus>).
Do NOT include prose, explanations, or markdown code fences.
Place objects a couple of metres in front of the user (negative Z) around eye height (y ~1.6), with reasonable sizes and colors. You may combine several primitives.`;

export function setupEventListeners() {
  const recorder = createVoiceRecorder();

  let camStream: MediaStream | null = null;

  async function initCamera() {
    try {
      camStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
      });
    } catch (err) {
      console.error("Camera error:", err);
    }
  }
  initCamera();

  // --- Action: ask about what the camera sees (vision Q&A) ---
  async function askWithPhoto(prompt: string) {
    // Label both halves so the transcribed prompt and the model's reply are
    // clearly distinct, with a blank line between them.
    const header = `You: ${prompt}\n\nAI: `;

    if (!camStream) await initCamera();
    if (!camStream) {
      setPanelText(`${header}(Camera unavailable — can't send a photo.)`);
      return;
    }

    const video = document.createElement("video");
    video.srcObject = camStream;
    await new Promise((r) => (video.onloadeddata = r));
    await video.play().catch(() => {});

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setPanelText(`${header}(Couldn't capture a frame.)`);
      return;
    }
    ctx.drawImage(video, 0, 0);
    const base64Image = canvas.toDataURL("image/png").split(",")[1];

    setPanelText(`${header}Thinking…`);

    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${base64Image}` },
          },
        ],
      },
    ];
    await streamChat(messages, CHAT_MODEL, (acc) => setPanelText(header + acc));
  }

  // --- Action: create a 3D object from the spoken prompt ---
  async function createObject(prompt: string) {
    setPanelText(`You: ${prompt}\n\nCreating an object…`);
    const markup = await chat(
      [
        { role: "system", content: OBJECT_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      OBJECT_MODEL,
    );
    handleObjectResponse(prompt, markup);
  }

  // Callback that receives the object model's response. This is the extension
  // point for turning a reply into scene content; for now it strips any stray
  // code fences, injects the markup into the #ai-container entity (parsed by
  // A-Frame's own super-three), and echoes the result to the panel.
  function handleObjectResponse(prompt: string, response: string) {
    console.log("Object generation response:", response);
    if (!response) {
      setPanelText(`You: ${prompt}\n\n(No object was generated — try again.)`);
      return;
    }
    const markup = response
      .replace(/```[a-z]*\n?/gi, "")
      .replace(/```/g, "")
      .trim();
    const container = document.querySelector("#ai-container");
    if (container) container.innerHTML = markup;
    setPanelText(`You: ${prompt}\n\nCreated:\n${markup}`);
  }

  // Each capture request pairs an action with the button whose state it drives,
  // so the same button shows Stop / red whether started from the panel, a Quest
  // button, or the keyboard.
  const askRequest: CaptureRequest = {
    onTranscript: askWithPhoto,
    onRecordingChange: (on) => {
      setButtonRecording("ask", on);
      setButtonLabel("ask", on ? "Stop" : "Record");
    },
  };
  const createRequest: CaptureRequest = {
    onTranscript: createObject,
    onRecordingChange: (on) => {
      setButtonRecording("create", on);
      setButtonLabel("create", on ? "Stop" : "Create");
    },
  };

  // Panel buttons toggle their respective flows.
  setButtonHandler("ask", () => recorder.toggle(askRequest));
  setButtonHandler("create", () => recorder.toggle(createRequest));

  // Quest left controller: hold X to ask, hold Y to create (both buttons live
  // on the left Touch controller). Registered as separate components so each
  // can sit on its own entity if the scene is rearranged.
  AFRAME.registerComponent("x-button-listener", {
    init: function () {
      const el: AFRAME.Entity = this.el;
      el.addEventListener("xbuttondown", () => void recorder.start(askRequest));
      el.addEventListener("xbuttonup", () => recorder.stop());
    },
  });
  AFRAME.registerComponent("y-button-listener", {
    init: function () {
      const el: AFRAME.Entity = this.el;
      el.addEventListener(
        "ybuttondown",
        () => void recorder.start(createRequest),
      );
      el.addEventListener("ybuttonup", () => recorder.stop());
    },
  });

  // PC: hold 'P' to ask, hold 'O' to create (mirrors the Quest buttons).
  // `repeat` guards key auto-repeat.
  document.addEventListener("keydown", (event) => {
    if (event.repeat) return;
    if (event.key === "p") void recorder.start(askRequest);
    else if (event.key === "o") void recorder.start(createRequest);
  });
  document.addEventListener("keyup", (event) => {
    if (event.key === "p" || event.key === "o") recorder.stop();
  });
}
