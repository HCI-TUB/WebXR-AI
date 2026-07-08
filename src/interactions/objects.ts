import AFRAME from "aframe";
import { chat, OBJECT_MODEL, type ChatMessage } from "../api/mistral.ts";

// Shared object-generation helpers. The "Create" flow (src/interactions/listeners.ts)
// and the "Place" flow (src/interactions/placement.ts) both turn a short description
// into A-Frame entity markup and drop it into the scene, so the model call, the
// code-fence stripping, and the entity wrapping live here once.

// System prompt for object generation: turn a spoken description into A-Frame
// entity markup we can drop straight into the scene.
export const OBJECT_SYSTEM_PROMPT = `You generate 3D objects for an A-Frame WebXR scene from a short spoken description.
Reply with ONLY A-Frame entity markup (e.g. <a-box>, <a-sphere>, <a-cylinder>, <a-cone>, <a-torus>).
Do NOT include prose, explanations, or markdown code fences.
Center the object around the origin (position 0 0 0) at a modest, roughly hand-sized scale, with reasonable colors. Do NOT offset it in front of the user — placement in the scene is handled separately. You may combine several primitives, positioned relative to the origin.`;

/** Ask the object model to turn a description into A-Frame markup ("" on error). */
export function generateObjectMarkup(prompt: string): Promise<string> {
  const messages: ChatMessage[] = [
    { role: "system", content: OBJECT_SYSTEM_PROMPT },
    { role: "user", content: prompt },
  ];
  return chat(messages, OBJECT_MODEL);
}

/** Strip any stray markdown code fences the model may have wrapped the markup in. */
export function stripCodeFences(response: string): string {
  return response
    .replace(/```[a-z]*\n?/gi, "")
    .replace(/```/g, "")
    .trim();
}

/**
 * Wrap generated markup (fences stripped) in an `<a-entity>` holder, parsed by
 * A-Frame's own super-three. The markup centres the object at the holder's origin,
 * so callers position the holder to place the object.
 */
export function buildObjectEntity(markup: string): AFRAME.Entity {
  const entity = document.createElement("a-entity");
  entity.innerHTML = stripCodeFences(markup);
  return entity;
}
