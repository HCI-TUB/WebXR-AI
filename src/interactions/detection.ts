import AFRAME from "aframe";
import type * as THREE from "three";
import { captureFrame } from "../camera.ts";
import { localizeObjects, type Detection } from "../api/vision.ts";
import {
  captureDepthSnapshot,
  sampleDepthMeters,
  type DepthSnapshot,
} from "../xr/depth-sensing.ts";
import { setPanelText, setButtonHandler } from "../ui/uikit-panel.ts";

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
//  2. Depth. Vision gives a 2D box only. On devices with WebXR depth sensing we
//     sample the real distance to each box's centre (src/xr/depth-sensing.ts) and
//     place that frame there; without it (or where the depth map has no reading)
//     we fall back to a fixed distance (FRAME_DISTANCE). Either way the frame is a
//     billboard built from the box's four corner rays, anchored to the head pose
//     *remembered from capture time* — so it overlays the real object from the
//     viewpoint the photo was taken, even if the user has moved by the time the
//     response arrives. Parallax error from other viewpoints is inherent.
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

// Fallback distance (metres) along each ray where a frame sits when depth sensing
// gives no reading; also the fixed distance for the calibration overlay.
const FRAME_DISTANCE = 2;
const DEG = Math.PI / 180;

// How far (metres) the Place flow nudges a new object off its target for a
// spatial relation ("in front of", "left of", …).
const RELATION_OFFSET = 0.4;

// Thumbstick tuning rates (per second at full deflection) and a deadzone.
const FOV_RATE = 30;
const OFFSET_RATE = 15;
const DEADZONE = 0.15;

// The head pose snapshotted at the moment of capture, reused for every frame
// and for the calibration overlay. Null until the first B press.
export interface Capture {
  base64: string;
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
}
let lastCapture: Capture | null = null;

/** A Vision detection paired with its estimated distance from the capture point. */
export interface DetectedObject {
  detection: Detection;
  /** Distance in metres from WebXR depth sensing, or null when unavailable. */
  depth: number | null;
}

/** Everything the Detect flow produces: the objects plus the capture they anchor to. */
export interface DetectionResult {
  objects: DetectedObject[];
  capture: Capture;
}

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
// Scratch for placementPosition (relation offsets).
let _pUp: THREE.Vector3;
let _pFwd: THREE.Vector3;
let _pRight: THREE.Vector3;

function ensureThree() {
  if (T) return;
  T = AFRAME.THREE as unknown as typeof THREE;
  _dir = new T.Vector3();
  _off = new T.Quaternion();
  _euler = new T.Euler();
  _up = new T.Vector3();
  _lookM = new T.Matrix4();
  _pUp = new T.Vector3();
  _pFwd = new T.Vector3();
  _pRight = new T.Vector3();
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
  _euler.set(
    CAMERA_MODEL.pitchOffsetDeg * DEG,
    CAMERA_MODEL.yawOffsetDeg * DEG,
    0,
    "YXZ",
  );
  _off.setFromEuler(_euler);
  return out.applyQuaternion(_off).applyQuaternion(quat);
}

// The full camera orientation (head + axis offset), used to face the overlay
// and the labels back at the capture viewpoint. Writes into `out`.
function cameraQuat(
  quat: THREE.Quaternion,
  out: THREE.Quaternion,
): THREE.Quaternion {
  _euler.set(
    CAMERA_MODEL.pitchOffsetDeg * DEG,
    CAMERA_MODEL.yawOffsetDeg * DEG,
    0,
    "YXZ",
  );
  _off.setFromEuler(_euler);
  return out.copy(quat).multiply(_off);
}

// World-space positions of a detected box's corners, each corner ray placed at the
// object's measured depth (or FRAME_DISTANCE when depth is null) — the corners lie
// on a sphere around the capture point, matching the object's silhouette.
function cornerPoints(obj: DetectedObject, cap: Capture): THREE.Vector3[] {
  ensureThree();
  const dist = obj.depth ?? FRAME_DISTANCE;
  return obj.detection.corners.map((c) => {
    projectRay(c.x, c.y, cap.quat, _dir);
    return new T.Vector3().copy(cap.pos).addScaledVector(_dir, dist);
  });
}

// Centre of a detected box in world space, at its measured depth. Returns a fresh
// vector the caller is free to mutate.
function objectCentre(obj: DetectedObject, cap: Capture): THREE.Vector3 {
  const points = cornerPoints(obj, cap);
  const centre = new T.Vector3();
  points.forEach((p) => centre.add(p));
  return centre.multiplyScalar(1 / (points.length || 1));
}

/**
 * World position to drop a newly-created object at, given a detected target and a
 * spatial relation ("in front of", "behind", "on"/"above", "below", "left of",
 * "right of", "next to"). Starts at the target's centre and nudges it by a fixed
 * offset resolved against the capture viewpoint (so "in front of" means between the
 * target and where the user was standing). Used by the Place flow.
 */
export function placementPosition(
  obj: DetectedObject,
  cap: Capture,
  relation: string,
): THREE.Vector3 {
  ensureThree();
  const centre = objectCentre(obj, cap);
  const up = _pUp.set(0, 1, 0);
  // Horizontal direction from the target toward the capture viewpoint.
  const toViewer = _pFwd.copy(cap.pos).sub(centre);
  toViewer.y = 0;
  if (toViewer.lengthSq() < 1e-6) toViewer.set(0, 0, 1);
  else toViewer.normalize();
  // "Right" from the viewer's perspective (looking at the target).
  const right = _pRight.crossVectors(up, toViewer).normalize();

  switch (relation) {
    case "in front of":
      return centre.addScaledVector(toViewer, RELATION_OFFSET);
    case "behind":
      return centre.addScaledVector(toViewer, -RELATION_OFFSET);
    case "on":
    case "above":
      return centre.addScaledVector(up, RELATION_OFFSET);
    case "below":
      return centre.addScaledVector(up, -RELATION_OFFSET);
    case "left of":
      return centre.addScaledVector(right, -RELATION_OFFSET);
    case "right of":
      return centre.addScaledVector(right, RELATION_OFFSET);
    case "next to":
    default:
      return centre.addScaledVector(right, RELATION_OFFSET);
  }
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

// Draw a wireframe frame + label for each detected object, anchored to `cap`. Each
// frame sits at the object's measured depth (or FRAME_DISTANCE if depth is null).
function renderFrames(objects: DetectedObject[], cap: Capture) {
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

  for (const obj of objects) {
    const det = obj.detection;
    if (det.corners.length < 3) continue;

    // Each box corner ray, placed at the object's distance.
    const points = cornerPoints(obj, cap);
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
    const depthLabel = obj.depth != null ? ` ${obj.depth.toFixed(1)}m` : "";
    const label = document.createElement("a-entity");
    label.setAttribute("text", {
      value: `${det.name} ${(det.score * 100) | 0}%${depthLabel}`,
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

// Estimate the distance to a detection by sampling the depth snapshot along the ray
// through the box centre. Returns null when there's no snapshot or no reading there.
function estimateDepth(
  det: Detection,
  cap: Capture,
  snap: DepthSnapshot | null,
): number | null {
  if (!snap || det.corners.length < 3) return null;
  let u = 0;
  let v = 0;
  for (const c of det.corners) {
    u += c.x;
    v += c.y;
  }
  u /= det.corners.length;
  v /= det.corners.length;
  projectRay(u, v, cap.quat, _dir);
  return sampleDepthMeters(snap, cap.pos, _dir);
}

/**
 * The Detect flow's core, independent of any rendering: grab a camera frame + head
 * pose (+ a WebXR depth snapshot when available), run Vision object localization,
 * and return each detected object with its estimated depth. Returns null only when
 * the camera is unavailable. Also updates `lastCapture` for the calibration overlay.
 *
 * Reusable on its own — e.g. to act on detected objects and their depth without
 * drawing the wireframe frames.
 */
export async function detectObjects(
  sceneEl: AFRAME.Scene,
): Promise<DetectionResult | null> {
  ensureThree();

  // Kick off the (next-frame) depth snapshot alongside the photo so both are taken
  // as close together as possible.
  const depthPromise = captureDepthSnapshot();
  const frame = await captureFrame();
  // Snapshot the head pose as close as possible to the frame grab.
  const cam = sceneEl.camera as unknown as THREE.Camera;
  const pos = new T.Vector3();
  const quat = new T.Quaternion();
  cam.getWorldPosition(pos);
  cam.getWorldQuaternion(quat);

  if (!frame) return null;
  const capture: Capture = { base64: frame.base64, pos, quat };
  lastCapture = capture;

  const depthSnap = await depthPromise;
  const detections = await localizeObjects(frame.base64);
  const objects: DetectedObject[] = detections.map((det) => ({
    detection: det,
    depth: estimateDepth(det, capture, depthSnap),
  }));
  return { objects, capture };
}

// --- Detect flow: detect → draw frames + panel summary ---
async function runDetect(sceneEl: AFRAME.Scene) {
  setPanelText("Detecting objects…");

  const result = await detectObjects(sceneEl);
  if (!result) {
    setPanelText("Camera unavailable — can't detect.");
    return;
  }
  if (result.objects.length === 0) {
    setPanelText("No objects detected.");
    clearVisuals();
    return;
  }

  renderFrames(result.objects, result.capture);
  const names = result.objects.map((o) => o.detection.name).join(", ");
  const withDepth = result.objects.filter((o) => o.depth != null).length;
  const depthNote = withDepth
    ? ` — depth for ${withDepth}/${result.objects.length}`
    : " — no depth";
  setPanelText(`Detected ${result.objects.length}: ${names}${depthNote}`);
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
    CAMERA_MODEL.hFovDeg = clamp(
      CAMERA_MODEL.hFovDeg + rx * FOV_RATE * dtSec,
      10,
      160,
    );
    changed = true;
  }
  if (ry) {
    // Push up (negative Y) widens the vertical FOV.
    CAMERA_MODEL.vFovDeg = clamp(
      CAMERA_MODEL.vFovDeg - ry * FOV_RATE * dtSec,
      10,
      160,
    );
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
  // Panel "Detect" button: run detect against the live scene. Detect is not a
  // voice flow (single momentary action, no transcript), so the button just
  // fires — no Stop / recording state. The scene is queried at click time.
  setButtonHandler("detect", () => {
    const sceneEl = document.querySelector("a-scene") as AFRAME.Scene | null;
    if (sceneEl) void runDetect(sceneEl);
  });

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
