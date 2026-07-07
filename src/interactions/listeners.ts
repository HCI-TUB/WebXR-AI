import AFRAME from "aframe";
import type * as THREE from "three";
import {
  setPanelText,
  setButtonHandler,
  setButtonLabel,
  setButtonRecording,
} from "../ui/uikit-panel.ts";
import { createVoiceRecorder, type CaptureRequest } from "../voice/recorder.ts";
import { captureFrame } from "../camera.ts";
import { RAY_PITCH_DEG } from "../ui/pointer.ts";
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
Center the object around the origin (position 0 0 0) at a modest, roughly hand-sized scale, with reasonable colors. Do NOT offset it in front of the user — placement in the scene is handled separately. You may combine several primitives, positioned relative to the origin.`;

export function setupEventListeners() {
  const recorder = createVoiceRecorder();

  // Warm up the shared environment camera so the first Ask/Detect has a stream
  // ready (see src/camera.ts).
  void captureFrame();

  // --- Action: ask about what the camera sees (vision Q&A) ---
  async function askWithPhoto(prompt: string) {
    // Label both halves so the transcribed prompt and the model's reply are
    // clearly distinct, with a blank line between them.
    const header = `You: ${prompt}\n\nAI: `;

    const frame = await captureFrame();
    if (!frame) {
      setPanelText(`${header}(Camera unavailable — can't send a photo.)`);
      return;
    }
    const base64Image = frame.base64;

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

  // The object currently being previewed on the right controller's ray, awaiting
  // an A-button press to drop it into the scene. Only one is live at a time.
  let activePreview: AFRAME.Entity | null = null;

  // Callback that receives the object model's response. This is the extension
  // point for turning a reply into scene content; for now it strips any stray
  // code fences, wraps the markup (parsed by A-Frame's own super-three) in a
  // holder that rides the right controller's ray, and waits for the A button.
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
    if (!container) return;

    // Replace any previous object (placed or still previewing). The holder is
    // driven each frame by `placement-follow`; the generated markup sits at its
    // origin, so it appears at the end of the ray until the A button drops it.
    container.innerHTML = "";
    const preview = document.createElement("a-entity");
    preview.setAttribute("placement-follow", "");
    preview.innerHTML = markup;
    container.appendChild(preview);
    activePreview = preview;

    setPanelText(
      `You: ${prompt}\n\nObject created. Aim with the right controller and press A to place it; push the thumbstick up/down to resize.`,
    );
  }

  // Drop the previewed object where it currently sits: stop it following the ray
  // (removing the component freezes the holder at its last transform). Wired to
  // the right controller's A button below.
  function placeObject() {
    if (!activePreview) return;
    activePreview.removeAttribute("placement-follow");
    activePreview = null;
    setPanelText("Object placed.");
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

  // Right controller A button: drop the object currently riding the ray.
  AFRAME.registerComponent("a-button-listener", {
    init: function () {
      const el: AFRAME.Entity = this.el;
      el.addEventListener("abuttondown", () => placeObject());
    },
  });

  // Rides a spawned object at the end of the right controller's ray, a fixed
  // distance out, until placed. The local direction matches the visible laser
  // (pitched forward-and-down by RAY_PITCH_DEG, see src/ui/pointer.ts).
  const PLACE_DISTANCE = 1.5; // metres down the ray
  const pitch = -(RAY_PITCH_DEG * Math.PI) / 180;
  // Thumbstick resize: per-second growth rate at full deflection, and bounds.
  const SCALE_RATE = 1.5;
  const MIN_SCALE = 0.1;
  const MAX_SCALE = 10;
  AFRAME.registerComponent("placement-follow", {
    // Reused per frame; assigned real values in init.
    localDir: null as unknown as THREE.Vector3,
    origin: null as unknown as THREE.Vector3,
    quat: null as unknown as THREE.Quaternion,
    dir: null as unknown as THREE.Vector3,
    controller: null as AFRAME.Entity | null,
    scale: 1,
    // Latest thumbstick Y (up is negative); held between events, driving resize.
    thumbY: 0,
    onThumbstick: null as unknown as (e: Event) => void,
    init: function () {
      const T = AFRAME.THREE;
      // -Z pitched about X, matching the ray pointer / laser direction.
      this.localDir = new T.Vector3(0, Math.sin(pitch), -Math.cos(pitch));
      this.origin = new T.Vector3();
      this.quat = new T.Quaternion();
      this.dir = new T.Vector3();
      this.controller = document.querySelector("#right-controller");
      this.onThumbstick = (e) =>
        (this.thumbY = (e as AFRAME.DetailEvent<{ y: number }>).detail.y);
      this.controller?.addEventListener("thumbstickmoved", this.onThumbstick);
    },
    remove: function () {
      this.controller?.removeEventListener("thumbstickmoved", this.onThumbstick);
    },
    tick: function (_time: number, timeDelta: number) {
      const controller = this.controller;
      if (!controller) return;
      const obj = controller.object3D;
      // #ai-container sits at the scene origin, so world coords double as the
      // holder's local position.
      obj.getWorldPosition(this.origin);
      obj.getWorldQuaternion(this.quat);
      this.dir.copy(this.localDir).applyQuaternion(this.quat);
      this.el.object3D.position
        .copy(this.origin)
        .addScaledVector(this.dir, PLACE_DISTANCE);

      // Push up (negative Y) to grow, down to shrink; framerate-independent.
      if (this.thumbY) {
        const factor = 1 + -this.thumbY * SCALE_RATE * (timeDelta / 1000);
        this.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.scale * factor));
        this.el.object3D.scale.setScalar(this.scale);
      }
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
