import { forwardHtmlEvents, createRayPointer } from "@pmndrs/pointer-events";
import AFRAME from "aframe";
import type { Object3D } from "three";

// Bridges input into uikit. uikit ships no event system, so we drive
// @pmndrs/pointer-events manually:
//   - PC: mouse + wheel on the canvas via forwardHtmlEvents (verified).
//   - XR: one ray pointer per motion controller, moved every frame and
//     clicked on the controller trigger (needs on-device verification).
//
// We raycast only into `root` (the panel), never the whole A-Frame scene, so
// the three@0.184 raycaster never touches super-three meshes.

export interface PointerInteraction {
  update(): void;
  destroy(): void;
}

const now = () => ({ timeStamp: performance.now() });
const click = () => ({ timeStamp: performance.now(), button: 0 });

// Tilt the ray forward from the grip axis so it emits from the top of the
// controller like the Quest system menu (raw -Z runs along the grip). Shared
// with the object-placement preview (src/interactions/listeners.ts) so a spawned
// object sits exactly at the end of the visible laser.
export const RAY_PITCH_DEG = 35;

export function initPointerInteraction(
  sceneEl: AFRAME.Scene,
  root: Object3D,
): PointerInteraction {
  const renderer = sceneEl.renderer;
  // Cross-instance camera is fine at runtime (see uikit-aframe-integration).
  const getCamera = () => sceneEl.camera as never;

  const updaters: Array<() => void> = [];
  const disposers: Array<() => void> = [];

  // --- PC: mouse move / click / wheel-scroll ---
  const html = forwardHtmlEvents(renderer.domElement, getCamera, root);
  updaters.push(html.update);
  disposers.push(html.destroy);

  // Tilt the ray forward from the grip axis (see RAY_PITCH_DEG above) so it
  // emits from the top of the controller (raw -Z runs along the grip).
  const pitch = -(RAY_PITCH_DEG * Math.PI) / 180;
  // Direction after rotating -Z about X by `pitch`: (0, sin(pitch), -cos(pitch)).
  const LASER_LEN = 5;
  const laserEnd = `0 ${Math.sin(pitch) * LASER_LEN} ${-Math.cos(pitch) * LASER_LEN}`;

  // --- XR: a ray pointer following each controller ---
  const controllers = sceneEl.querySelectorAll("[meta-touch-controls]");
  controllers.forEach((el) => {
    const controllerEl = el as AFRAME.Entity;
    // The ray pointer aims down its space's -Z. Parent a pitched pivot under the
    // controller so that -Z points forward-and-down, and match the laser to it.
    const controllerObj = controllerEl.object3D as unknown as {
      add(child: Object3D): void;
    };
    const pivot = new AFRAME.THREE.Object3D() as unknown as Object3D & {
      rotation: { x: number };
    };
    pivot.rotation.x = pitch;
    controllerObj.add(pivot);
    const space = { current: pivot as Object3D };
    const pointer = createRayPointer(getCamera, space, {});

    // Visible laser so the user can aim. A-Frame's native `line` component is
    // rendered by super-three in the controller's local space (no cross-
    // instance concern), and its end matches the pitched ray direction above.
    controllerEl.setAttribute(
      "line",
      `start: 0 0 0; end: ${laserEnd}; color: #89b4fa; opacity: 0.75`,
    );

    const onDown = () => pointer.down(click());
    const onUp = () => pointer.up(click());
    controllerEl.addEventListener("triggerdown", onDown);
    controllerEl.addEventListener("triggerup", onUp);

    // Only track while an immersive session is presenting, otherwise the
    // untracked controller sits at the origin and fires spurious hovers.
    updaters.push(() => {
      if (renderer.xr?.isPresenting) pointer.move(root, now());
    });
    disposers.push(() => {
      controllerEl.removeEventListener("triggerdown", onDown);
      controllerEl.removeEventListener("triggerup", onUp);
      pointer.exit(now());
    });
  });

  return {
    update: () => updaters.forEach((u) => u()),
    destroy: () => disposers.forEach((d) => d()),
  };
}
