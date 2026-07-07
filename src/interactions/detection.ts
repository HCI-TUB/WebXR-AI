import AFRAME from "aframe";
import type * as THREE from "three";
import { captureFrame } from "../camera.ts";
import { localizeObjects, type Detection } from "../api/vision.ts";
import { setPanelText } from "../ui/uikit-panel.ts";

// "Detect" flow (third flow after Ask / Create): press the right controller's
// B button to grab a camera frame, send it to Google Cloud Vision object
// localization, and draw a wireframe frame in the scene for each detected box.
//
// Two hard problems and how they're handled here:
//
//  1. Image → world mapping. The getUserMedia photo covers only part of the
//     headset FOV, and its true FOV / optical axis vs. the head forward is
//     unknown. We model the camera as a pinhole with tunable horizontal /
//     vertical FOV plus a yaw/pitch axis offset (CAMERA_MODEL below), and ship
//     a live on-device calibration mode (right-controller GRIP) to dial those
//     numbers in against a semi-transparent overlay of the captured photo. The
//     model is mutable module state so calibration tunes it live; once aligned,
//     bake the printed values into the defaults.
//
//  2. No depth. Vision gives a 2D box only. We place each frame as a billboard
//     at a fixed distance (FRAME_DISTANCE), built from the box's four corner
//     rays, anchored to the head pose *remembered from capture time* — so it
//     overlays the real object from the viewpoint the photo was taken, even if
//     the user has moved by the time the response arrives. Parallax error from
//     other viewpoints is inherent without depth.
//
// All THREE objects here are built with AFRAME.THREE (super-three) and added via
// object3D.add — never setObject3D — per the uikit/A-Frame rules in CLAUDE.md.

// --- Tunable pinhole camera model ---
// Values calibrated on a Meta Quest 3 (2026-07-07) via the on-device overlay
// (right-controller GRIP). Re-run calibration if the capture resolution or the
// device changes.
const CAMERA_MODEL = {
  hFovDeg: 69.5, // horizontal field of view of the captured photo
  vFovDeg: 55.9, // vertical field of view
  yawOffsetDeg: -0.8, // camera optical axis vs. head forward (+ = right)
  pitchOffsetDeg: -10.8, // (+ = up)
};

const FRAME_DISTANCE = 2; // metres along each ray where frames/overlay sit
const DEG = Math.PI / 180;

// Thumbstick tuning rates (per second at full deflection) and a deadzone.
const FOV_RATE = 30;
const OFFSET_RATE = 15;
const DEADZONE = 0.15;

// The head pose snapshotted at the moment of capture, reused for every frame
// and for the calibration overlay. Null until the first B press.
interface Capture {
  base64: string;
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
}
let lastCapture: Capture | null = null;

// Lazily-created THREE scratch/state (AFRAME.THREE is only safe post-import).
let T: typeof THREE;
let frameGroup: THREE.Group | null = null;
let overlay: THREE.Mesh | null = null;
let labels: AFRAME.Entity[] = [];
let calibrating = false;

// Reused temporaries.
let _dir: THREE.Vector3;
let _off: THREE.Quaternion;
let _euler: THREE.Euler;
let _up: THREE.Vector3;
let _lookM: THREE.Matrix4;

function ensureThree() {
  if (T) return;
  T = AFRAME.THREE as unknown as typeof THREE;
  _dir = new T.Vector3();
  _off = new T.Quaternion();
  _euler = new T.Euler();
  _up = new T.Vector3();
  _lookM = new T.Matrix4();
}

/** The scene-origin container that all detection visuals attach to. */
function container(): AFRAME.Entity | null {
  return document.querySelector("#detect-container");
}

// Direction (world space) of the ray through normalized image point (u, v),
// where u=0 is the left edge and v=0 the top edge, using the current camera
// model and the remembered capture orientation. Writes into `out`.
function projectRay(
  u: number,
  v: number,
  quat: THREE.Quaternion,
  out: THREE.Vector3,
): THREE.Vector3 {
  const hx = Math.tan((CAMERA_MODEL.hFovDeg * DEG) / 2);
  const vy = Math.tan((CAMERA_MODEL.vFovDeg * DEG) / 2);
  // Pinhole: image left→right is +x, top→bottom is -y, looking down -z.
  out.set((u - 0.5) * 2 * hx, (0.5 - v) * 2 * vy, -1).normalize();
  // Apply the axis offset, then the remembered head orientation.
  _euler.set(CAMERA_MODEL.pitchOffsetDeg * DEG, CAMERA_MODEL.yawOffsetDeg * DEG, 0, "YXZ");
  _off.setFromEuler(_euler);
  return out.applyQuaternion(_off).applyQuaternion(quat);
}

// The full camera orientation (head + axis offset), used to face the overlay
// and the labels back at the capture viewpoint. Writes into `out`.
function cameraQuat(quat: THREE.Quaternion, out: THREE.Quaternion): THREE.Quaternion {
  _euler.set(CAMERA_MODEL.pitchOffsetDeg * DEG, CAMERA_MODEL.yawOffsetDeg * DEG, 0, "YXZ");
  _off.setFromEuler(_euler);
  return out.copy(quat).multiply(_off);
}

function clearVisuals() {
  if (frameGroup) {
    for (const child of frameGroup.children.slice()) {
      const line = child as THREE.Line;
      line.geometry?.dispose();
      (line.material as THREE.Material)?.dispose();
    }
    frameGroup.clear();
  }
  labels.forEach((l) => l.remove());
  labels = [];
}

// Draw a wireframe frame + label for each detection, anchored to `cap`.
function renderFrames(detections: Detection[], cap: Capture) {
  const el = container();
  if (!el) return;
  ensureThree();

  if (!frameGroup) {
    frameGroup = new T.Group();
    el.object3D.add(frameGroup);
  }
  clearVisuals();

  // "Up" of the capture frame, so labels roll with the box, not world-up.
  _up.set(0, 1, 0).applyQuaternion(cap.quat);

  for (const det of detections) {
    if (det.corners.length < 3) continue;

    // Each box corner ray, placed at FRAME_DISTANCE — the corners lie on a
    // sphere around the capture point, matching the object's silhouette.
    const points = det.corners.map((c) => {
      projectRay(c.x, c.y, cap.quat, _dir);
      return new T.Vector3()
        .copy(cap.pos)
        .addScaledVector(_dir, FRAME_DISTANCE);
    });
    const geom = new T.BufferGeometry().setFromPoints(points);
    const mat = new T.LineBasicMaterial({ color: 0x89b4fa });
    frameGroup.add(new T.LineLoop(geom, mat));

    // Label at the box centre. Orient it to face the capture point along this
    // box's own ray — edge boxes tilt away from the shared view axis, so a
    // per-label lookAt keeps the text in the frame's plane. (#detect-container
    // sits at the origin, so world coords double as the label's local coords.)
    const centre = new T.Vector3();
    points.forEach((p) => centre.add(p));
    centre.multiplyScalar(1 / points.length);
    const label = document.createElement("a-entity");
    label.setAttribute("text", {
      value: `${det.name} ${(det.score * 100) | 0}%`,
      align: "center",
      color: "#89b4fa",
      width: 1.5,
    });
    el.appendChild(label);
    label.object3D.position.copy(centre);
    // Matrix4.lookAt(eye, target, up) → +Z points eye→target… here +Z faces the
    // capture point, which is the readable side of a-text.
    _lookM.lookAt(cap.pos, centre, _up);
    label.object3D.quaternion.setFromRotationMatrix(_lookM);
    labels.push(label);
  }
}

// --- Detect flow: capture + snapshot pose → Vision → frames ---
async function runDetect(sceneEl: AFRAME.Scene) {
  ensureThree();
  setPanelText("Detecting objects…");

  const frame = await captureFrame();
  // Snapshot the head pose as close as possible to the frame grab.
  const cam = sceneEl.camera as unknown as THREE.Camera;
  const pos = new T.Vector3();
  const quat = new T.Quaternion();
  cam.getWorldPosition(pos);
  cam.getWorldQuaternion(quat);

  if (!frame) {
    setPanelText("Camera unavailable — can't detect.");
    return;
  }
  lastCapture = { base64: frame.base64, pos, quat };

  const detections = await localizeObjects(frame.base64);
  if (detections.length === 0) {
    setPanelText("No objects detected.");
    clearVisuals();
    return;
  }
  renderFrames(detections, lastCapture);
  const names = detections.map((d) => d.name).join(", ");
  setPanelText(`Detected ${detections.length}: ${names}`);
}

// --- Calibration overlay: pin the captured photo at FRAME_DISTANCE ---
function positionOverlay(cap: Capture) {
  ensureThree();
  if (!overlay) return;
  // Centre along the (offset-adjusted) view axis.
  projectRay(0.5, 0.5, cap.quat, _dir);
  overlay.position.copy(cap.pos).addScaledVector(_dir, FRAME_DISTANCE);
  // Size to the modelled FOV at that distance.
  const w = 2 * FRAME_DISTANCE * Math.tan((CAMERA_MODEL.hFovDeg * DEG) / 2);
  const h = 2 * FRAME_DISTANCE * Math.tan((CAMERA_MODEL.vFovDeg * DEG) / 2);
  overlay.scale.set(w, h, 1);
  // Face the capture viewpoint (image plane parallel to the camera).
  cameraQuat(cap.quat, overlay.quaternion);
}

function toggleCalibration() {
  ensureThree();
  const el = container();
  if (!el) return;
  if (!lastCapture) {
    setPanelText("Press B to capture a photo before calibrating.");
    return;
  }

  calibrating = !calibrating;
  if (!calibrating) {
    if (overlay) overlay.visible = false;
    setPanelText("Calibration off.");
    return;
  }

  if (!overlay) {
    const geom = new T.PlaneGeometry(1, 1);
    const mat = new T.MeshBasicMaterial({
      transparent: true,
      opacity: 0.5,
      side: T.DoubleSide,
    });
    overlay = new T.Mesh(geom, mat);
    el.object3D.add(overlay);
  }
  // (Re)load the captured photo as the overlay texture.
  new T.TextureLoader().load(
    `data:image/png;base64,${lastCapture.base64}`,
    (tex) => {
      const mat = overlay!.material as THREE.MeshBasicMaterial;
      mat.map = tex;
      mat.needsUpdate = true;
    },
  );
  overlay.visible = true;
  positionOverlay(lastCapture);
  setPanelText(
    "Calibrating. Right stick: hFOV (X) / vFOV (Y). Left stick: yaw (X) / pitch (Y).",
  );
}

// Live thumbstick tuning, driven each frame by the b-button-listener tick.
function tuneStep(
  rightX: number,
  rightY: number,
  leftX: number,
  leftY: number,
  dtSec: number,
) {
  const dz = (n: number) => (Math.abs(n) < DEADZONE ? 0 : n);
  let changed = false;
  const rx = dz(rightX);
  const ry = dz(rightY);
  const lx = dz(leftX);
  const ly = dz(leftY);
  if (rx) {
    CAMERA_MODEL.hFovDeg = clamp(CAMERA_MODEL.hFovDeg + rx * FOV_RATE * dtSec, 10, 160);
    changed = true;
  }
  if (ry) {
    // Push up (negative Y) widens the vertical FOV.
    CAMERA_MODEL.vFovDeg = clamp(CAMERA_MODEL.vFovDeg - ry * FOV_RATE * dtSec, 10, 160);
    changed = true;
  }
  if (lx) {
    CAMERA_MODEL.yawOffsetDeg += lx * OFFSET_RATE * dtSec;
    changed = true;
  }
  if (ly) {
    CAMERA_MODEL.pitchOffsetDeg += -ly * OFFSET_RATE * dtSec;
    changed = true;
  }
  if (changed && lastCapture) {
    positionOverlay(lastCapture);
    setPanelText(
      `hFOV ${CAMERA_MODEL.hFovDeg.toFixed(1)}  vFOV ${CAMERA_MODEL.vFovDeg.toFixed(1)}  ` +
        `yaw ${CAMERA_MODEL.yawOffsetDeg.toFixed(1)}  pitch ${CAMERA_MODEL.pitchOffsetDeg.toFixed(1)}`,
    );
  }
}

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}

export function setupDetection() {
  // The right controller's B button runs detect; its grip toggles calibration;
  // both thumbsticks tune the model while calibrating. Lives on #right-controller
  // (see index.html), matching the x-/y-/a-button-listener pattern.
  AFRAME.registerComponent("b-button-listener", {
    rightThumb: { x: 0, y: 0 },
    leftThumb: { x: 0, y: 0 },
    init: function () {
      const el: AFRAME.Entity = this.el;
      const sceneEl = el.sceneEl as AFRAME.Scene;

      el.addEventListener("bbuttondown", () => void runDetect(sceneEl));
      el.addEventListener("gripdown", () => toggleCalibration());

      el.addEventListener("thumbstickmoved", (e) => {
        const d = (e as AFRAME.DetailEvent<{ x: number; y: number }>).detail;
        this.rightThumb = { x: d.x, y: d.y };
      });
      const left = sceneEl.querySelector("[y-button-listener]");
      left?.addEventListener("thumbstickmoved", (e) => {
        const d = (e as AFRAME.DetailEvent<{ x: number; y: number }>).detail;
        this.leftThumb = { x: d.x, y: d.y };
      });
    },
    tick: function (_time: number, timeDelta: number) {
      if (!calibrating) return;
      tuneStep(
        this.rightThumb.x,
        this.rightThumb.y,
        this.leftThumb.x,
        this.leftThumb.y,
        timeDelta / 1000,
      );
    },
  });

  // PC helpers for desktop testing (webcam as the environment camera).
  document.addEventListener("keydown", (event) => {
    if (event.repeat) return;
    const sceneEl = document.querySelector("a-scene") as AFRAME.Scene | null;
    if (event.key === "b" && sceneEl) void runDetect(sceneEl);
    else if (event.key === "c") toggleCalibration();
  });
}
