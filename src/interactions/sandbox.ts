import AFRAME from "aframe";
import { getVoiceRecorder, type CaptureRequest } from "../voice/recorder.ts";
import { chat, CHAT_MODEL, type ChatMessage } from "../api/mistral.ts";
import { setPanelText } from "../ui/uikit-panel.ts";

// Scratch flow: hold the Quest left-controller TRIGGER to record a spoken prompt;
// on release it's transcribed and handed to `sendToMistral`, a stub that sends it
// to Mistral with a placeholder query. Fill in the query (and reach for the other
// shared building blocks below) to grow this into a real AI interaction.
// (See src/interactions/placement.ts for a worked example that composes them.)
//
// --- Other shared building blocks you may want here ---
//
//   Camera frame (base64 PNG from the passthrough camera) — src/camera.ts:
//     import { captureFrame } from "../camera.ts";
//     const frame = await captureFrame(); // { base64, width, height } | null
//   ...to send a photo alongside the text, make the user turn multimodal:
//     { role: "user", content: [
//         { type: "text", text: transcript },
//         { type: "image_url", image_url: { url: `data:image/png;base64,${frame.base64}` } },
//     ] }
//   ...or stream tokens live instead of `chat`:
//     import { streamChat } from "../api/mistral.ts";
//     await streamChat(messages, CHAT_MODEL, (acc) => setPanelText(acc));
//
//   Generate a 3D object from a description — src/interactions/objects.ts:
//     import { generateObjectMarkup, buildObjectEntity } from "./objects.ts";
//     const entity = buildObjectEntity(await generateObjectMarkup("a small red mug"));
//     document.querySelector("#place-container")?.appendChild(entity);
//     entity.object3D.position.set(x, y, z); // containers sit at the origin
//
//   Detect real objects in view + resolve a placement spot — src/interactions/detection.ts:
//     import { detectObjects, placementPosition } from "./detection.ts";
//     const result = await detectObjects(sceneEl); // (sceneEl = el.sceneEl) { objects, capture } | null
//     const pos = placementPosition(result.objects[0], result.capture, "in front of");

// Placeholder query prepended to the transcript. Swap this for whatever you want
// to ask Mistral about the spoken prompt.
const PLACEHOLDER_QUERY = "Placeholder query — respond to the user's request:";

// Stub: send the transcribed prompt to Mistral with the placeholder query and show
// the reply. Grow this into the actual interaction (add a photo, generate/place an
// object, etc. — see the building blocks above).
async function sendToMistral(transcript: string) {
  setPanelText(`You: ${transcript}\n\nThinking…`);
  const messages: ChatMessage[] = [
    { role: "user", content: `${PLACEHOLDER_QUERY}\n\n${transcript}` },
  ];
  const reply = await chat(messages, CHAT_MODEL);
  setPanelText(`You: ${transcript}\n\nAI: ${reply}`);

  // Do your stuff here
}

export function setupSandbox() {
  const recorder = getVoiceRecorder();

  // Record while the trigger is held; transcribe on release, then send to Mistral.
  const sandboxRequest: CaptureRequest = {
    onTranscript: (transcript) => sendToMistral(transcript),
  };

  // Quest left-controller trigger drives hold-to-talk. NOTE: the trigger is also
  // the uikit panel's click (src/ui/pointer.ts), so both fire — fine for now, but
  // rebind to a free button if the panel click becomes a nuisance.
  AFRAME.registerComponent("left-trigger-listener", {
    init: function () {
      const el: AFRAME.Entity = this.el;
      el.addEventListener("triggerdown", () => void recorder.start(sandboxRequest));
      el.addEventListener("triggerup", () => recorder.stop());
    },
  });
}
