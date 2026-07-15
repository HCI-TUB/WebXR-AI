import AFRAME from "aframe";
import type * as THREE from "three";
import {
  setPanelText,
  setButtonHandler,
  setButtonLabel,
  setButtonRecording,
} from "../ui/uikit-panel.ts";
import { getVoiceRecorder, type CaptureRequest } from "../voice/recorder.ts";
import { chat, CHAT_MODEL, type ChatMessage } from "../api/mistral.ts";
import {
  generateObjectMarkup,
  buildObjectEntity,
  stripCodeFences,
} from "./objects.ts";
import { detectObjects, placementPosition } from "./detection.ts";

// "Place" flow (fourth flow, after Ask / Create / Detect): the left controller's
// grip button records a spoken instruction like "put a tree in front of the
// cabinet". The transcript is parsed into an object to create and a target already
// in the room; the object is generated (Create flow's model), the room is scanned
// (Detect flow), the target is matched against the detected objects (Mistral), and
// the new object is dropped at the match — offset by the requested spatial relation.
//
// The heavy lifting lives in the shared helpers this file composes (object
// generation in objects.ts, detection + placement math in detection.ts); runPlace
// below is just the high-level flow.

// Parse a spoken instruction into the object to create, the target to place it by,
// and their spatial relation.
const PARSE_SYSTEM_PROMPT = `You extract an AR placement instruction from a short spoken sentence.
The user names an object to create and a target already in the room to place it near, optionally with a spatial relation.
Reply with ONLY minified JSON: {"object":"...","target":"...","relation":"..."}
- "object": a concise noun phrase for the thing to create (e.g. "a small potted tree").
- "target": a single common object label for the reference thing in the room (e.g. "cabinet"), phrased the way a generic object detector would name it.
- "relation": one of "in front of", "behind", "on", "above", "below", "left of", "right of", "next to". Use "next to" if unclear.
No prose, no code fences.`;

// Match the parsed target against the labels an object detector actually returned.
const MATCH_SYSTEM_PROMPT = `You match a target object to the best candidate in a list of detected object labels.
Given a TARGET and a numbered LIST, reply with ONLY the index number of the best semantic match (e.g. a "cabinet" target matches a "Cabinetry" or "Drawer" label), or -1 if none is a reasonable match.
Reply with the number only — no prose.`;

interface PlaceInstruction {
  object: string;
  target: string;
  relation: string;
}

/** Parse the spoken instruction via Mistral; null if it can't be understood. */
async function parseInstruction(prompt: string): Promise<PlaceInstruction | null> {
  const messages: ChatMessage[] = [
    { role: "system", content: PARSE_SYSTEM_PROMPT },
    { role: "user", content: prompt },
  ];
  const reply = await chat(messages, CHAT_MODEL);
  try {
    const parsed = JSON.parse(stripCodeFences(reply));
    if (!parsed?.object || !parsed?.target) return null;
    return {
      object: String(parsed.object),
      target: String(parsed.target),
      relation: String(parsed.relation ?? "next to"),
    };
  } catch (err) {
    console.error("Place: couldn't parse instruction:", reply, err);
    return null;
  }
}

/** Ask Mistral which detected label best matches `target`; -1 if none fits. */
async function matchTarget(target: string, names: string[]): Promise<number> {
  const list = names.map((n, i) => `${i}: ${n}`).join("\n");
  const messages: ChatMessage[] = [
    { role: "system", content: MATCH_SYSTEM_PROMPT },
    { role: "user", content: `TARGET: ${target}\nLIST:\n${list}` },
  ];
  const reply = await chat(messages, CHAT_MODEL);
  const idx = parseInt(reply.match(/-?\d+/)?.[0] ?? "", 10);
  return Number.isInteger(idx) && idx >= 0 && idx < names.length ? idx : -1;
}

/** Drop generated markup into the scene at a world position (#place-container is
 * at the origin, so world coords double as its children's local coords). */
function placeObjectAt(markup: string, worldPos: THREE.Vector3): boolean {
  const container = document.querySelector("#place-container");
  if (!container) return false;
  const entity = buildObjectEntity(markup);
  container.appendChild(entity);
  entity.object3D.position.copy(worldPos);
  return true;
}

// --- The high-level Place flow ---
async function runPlace(sceneEl: AFRAME.Scene, prompt: string) {
  setPanelText(`You: ${prompt}\n\nWorking on it…`);

  // 1. Understand what to create and where.
  const instruction = await parseInstruction(prompt);
  if (!instruction) {
    setPanelText(`You: ${prompt}\n\nCouldn't understand that. Name an object and where to put it.`);
    return;
  }
  const { object, target, relation } = instruction;

  // 2. Generate the object and scan the room (independent — run together).
  setPanelText(`You: ${prompt}\n\nCreating a ${object} and looking for the ${target}…`);
  const [markup, detection] = await Promise.all([
    generateObjectMarkup(object),
    detectObjects(sceneEl),
  ]);
  if (!markup) {
    setPanelText(`You: ${prompt}\n\nCouldn't create the ${object}. Try again.`);
    return;
  }
  if (!detection || detection.objects.length === 0) {
    setPanelText(`You: ${prompt}\n\nNo objects in view to place it by.`);
    return;
  }

  // 3. Match the target to a detected object.
  const names = detection.objects.map((o) => o.detection.name);
  const idx = await matchTarget(target, names);
  if (idx < 0) {
    setPanelText(`You: ${prompt}\n\nCouldn't find a ${target} nearby. Saw: ${names.join(", ")}.`);
    return;
  }
  const match = detection.objects[idx];

  // 4. Place it at the match, offset by the requested relation.
  const pos = placementPosition(match, detection.capture, relation);
  if (!placeObjectAt(markup, pos)) return;
  setPanelText(`You: ${prompt}\n\nPlaced a ${object} ${relation} the ${match.detection.name}.`);
}

export function setupPlacement() {
  const recorder = getVoiceRecorder();

  const placeRequest = (sceneEl: AFRAME.Scene): CaptureRequest => ({
    onTranscript: (prompt) => runPlace(sceneEl, prompt),
    // Drives the panel's Place button, so a tap started anywhere shows Stop / red.
    onRecordingChange: (on) => {
      setButtonRecording("place", on);
      setButtonLabel("place", on ? "Stop" : "Place");
    },
  });

  // Panel "Place" button toggles the flow against the live scene.
  setButtonHandler("place", () => {
    const sceneEl = document.querySelector("a-scene") as AFRAME.Scene | null;
    if (sceneEl) recorder.toggle(placeRequest(sceneEl));
  });

  // Quest left controller: hold the grip to speak a placement instruction (X and
  // Y on the same controller already drive Ask / Create; the right grip toggles
  // Detect's calibration, so the left grip is the free hold-to-talk button).
  AFRAME.registerComponent("place-button-listener", {
    init: function () {
      const el: AFRAME.Entity = this.el;
      const sceneEl = el.sceneEl as AFRAME.Scene;
      el.addEventListener("gripdown", () => void recorder.start(placeRequest(sceneEl)));
      el.addEventListener("gripup", () => recorder.stop());
    },
  });

  // PC: hold 'l' to place (mirrors the Quest grip).
  document.addEventListener("keydown", (event) => {
    if (event.repeat || event.key !== "l") return;
    const sceneEl = document.querySelector("a-scene") as AFRAME.Scene | null;
    if (sceneEl) void recorder.start(placeRequest(sceneEl));
  });
  document.addEventListener("keyup", (event) => {
    if (event.key === "l") recorder.stop();
  });
}
