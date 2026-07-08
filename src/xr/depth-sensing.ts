import AFRAME from "aframe";

// WebXR **CPU** depth sensing, wrapped for on-demand point sampling.
//
// Why not three's WebXRDepthSensing module: that module is GPU-only — it wraps
// the depth buffer (`XRWebGLBinding.getDepthInformation`) into an ExternalTexture
// for a fullscreen occlusion mesh, and it is driven by real-three's WebXRManager.
// This app renders with A-Frame's super-three, which owns the XR session, so that
// module is never wired up here; and it exposes no way to read a depth value in
// metres at a given image point. The Detect flow needs exactly that — "how far is
// the object at this box centre" — which is the CPU path: `XRFrame.getDepthInformation(view)`
// → per-pixel raw values → metres.
//
// The catch: `getDepthInformation` is only valid inside the active `requestAnimationFrame`
// callback (A-Frame exposes the live `XRFrame` as `sceneEl.frame` during component
// tick). The Detect flow, by contrast, is async (it awaits a getUserMedia photo and
// a Vision round-trip) — the frame is long dead by the time boxes come back. So we
// snapshot the raw depth buffer + the view/projection matrices on the next tick after
// a request, copy them out, and sample that snapshot later at leisure.
//
// Types: the WebXR depth-sensing IDL is not in this project's lib.dom, so the bits
// we touch are declared locally below and reached through casts.

// --- Minimal local WebXR typings (depth sensing) ---
interface XRRigidTransformLike {
  matrix: Float32Array;
  inverse: XRRigidTransformLike;
}
interface XRViewLike {
  projectionMatrix: Float32Array;
  transform: XRRigidTransformLike;
}
interface XRViewerPoseLike {
  views: XRViewLike[];
}
interface XRCPUDepthInformationLike {
  width: number;
  height: number;
  rawValueToMeters: number;
  data: ArrayBuffer;
  // Column-major 4x4 mapping normalized view coords → normalized depth-buffer coords.
  normDepthBufferFromNormView: XRRigidTransformLike;
}
interface XRFrameLike {
  getViewerPose(space: unknown): XRViewerPoseLike | null;
  getDepthInformation(view: XRViewLike): XRCPUDepthInformationLike | null;
}
interface XRSessionLike {
  depthUsage?: string;
  depthDataFormat?: string;
}
interface WebXRSessionConfig {
  requiredFeatures: string[];
  optionalFeatures: string[];
  depthSensing?: {
    usagePreference: string[];
    dataFormatPreference: string[];
  };
}
// The slice of the A-Frame scene element we reach into.
interface SceneLike {
  hasLoaded?: boolean;
  frame?: XRFrameLike | null;
  xrSession?: XRSessionLike | null;
  renderer?: { xr?: { getReferenceSpace(): unknown } };
  systems?: { webxr?: { sessionConfiguration?: WebXRSessionConfig } };
  addEventListener(type: string, listener: () => void): void;
}

/**
 * An immutable copy of one XR frame's depth buffer plus the camera matrices needed
 * to project a world point into it. Safe to hold and sample after the frame ends.
 */
export interface DepthSnapshot {
  width: number;
  height: number;
  /** Multiply a raw buffer value by this to get metres. */
  rawValueToMeters: number;
  /** Column-major 4x4: normalized view coords → normalized depth-buffer coords. */
  normFromView: Float32Array;
  /** Column-major 4x4: world space → view (camera) space. */
  viewMatrix: Float32Array;
  /** Column-major 4x4: view space → clip space. */
  projMatrix: Float32Array;
  /** Row-major width*height raw depth values. */
  data: Uint16Array | Float32Array;
}

const REQUEST_TIMEOUT_MS = 300;
// How far along a sample ray we place the probe point before projecting it back
// into the depth view. Direction is all that matters for which pixel we hit, but a
// distant point makes the result insensitive to the small head translation between
// the pose snapshot and the (slightly later) depth frame.
const PROBE_DISTANCE = 20;
// Plausible depth window (metres); values outside are treated as "no reading".
const MIN_DEPTH = 0.1;
const MAX_DEPTH = 15;

// Requests waiting for the next tick that can produce a snapshot.
let pendingResolvers: Array<(snap: DepthSnapshot | null) => void> = [];

function scene(): SceneLike | null {
  return document.querySelector("a-scene") as unknown as SceneLike | null;
}

/** True if the live XR session was actually granted depth sensing. */
function depthAvailable(el: SceneLike): boolean {
  const session = el.xrSession;
  if (!session) return false;
  try {
    // `depthUsage` throws if the session was created without the feature.
    return session.depthUsage != null;
  } catch {
    return false;
  }
}

/**
 * Register the depth-sensing scene component. Declared as `xr-depth-sensing` on
 * `<a-scene>` (see index.html); it injects the depth-sensing session request and
 * fulfils pending snapshot requests each frame.
 */
export function setupDepthSensing() {
  AFRAME.registerComponent("xr-depth-sensing", {
    init: function () {
      const el = this.el as unknown as SceneLike;
      // The webxr system builds `sessionConfiguration` in its own init; if it isn't
      // there yet, retry once the scene has finished loading. Injection is idempotent.
      if (!injectSessionConfig(el) && !el.hasLoaded) {
        el.addEventListener("loaded", () => injectSessionConfig(el));
      }
    },
    tick: function () {
      if (pendingResolvers.length === 0) return;
      const el = this.el as unknown as SceneLike;
      const snap = grabSnapshot(el);
      if (!snap) return; // no depth this frame — keep waiting until timeout
      const resolvers = pendingResolvers;
      pendingResolvers = [];
      for (const resolve of resolvers) resolve(snap);
    },
  });
}

// Add `depth-sensing` to the session request and attach the required config dict.
// A-Frame's webxr system builds `sessionConfiguration` in its own init (a system,
// so it runs before this component) and hands it verbatim to `requestSession` when
// the user enters AR — mutating it here, before that, opts the session into depth.
function injectSessionConfig(el: SceneLike): boolean {
  const cfg = el.systems?.webxr?.sessionConfiguration;
  if (!cfg) return false;
  if (!cfg.optionalFeatures.includes("depth-sensing")) {
    cfg.optionalFeatures.push("depth-sensing");
  }
  // The spec requires this dict whenever depth-sensing is requested. We use the CPU
  // path, so prefer cpu-optimized; accept either data format (luminance-alpha is a
  // packed 16-bit value, float32 is metres directly).
  cfg.depthSensing = {
    usagePreference: ["cpu-optimized"],
    dataFormatPreference: ["luminance-alpha", "float32"],
  };
  return true;
}

// Copy the current frame's depth buffer + camera matrices, or null if unavailable.
function grabSnapshot(el: SceneLike): DepthSnapshot | null {
  const frame = el.frame;
  const refSpace = el.renderer?.xr?.getReferenceSpace();
  if (!frame || !refSpace || !depthAvailable(el)) return null;

  let pose: XRViewerPoseLike | null;
  try {
    pose = frame.getViewerPose(refSpace);
  } catch {
    return null;
  }
  if (!pose) return null;

  for (const view of pose.views) {
    let info: XRCPUDepthInformationLike | null;
    try {
      info = frame.getDepthInformation(view);
    } catch {
      return null; // depth genuinely unavailable this session
    }
    if (!info) continue; // this view has no depth this frame; try the next

    const isFloat = (el.xrSession?.depthDataFormat ?? "").includes("float");
    const copy = info.data.slice(0);
    const data = isFloat ? new Float32Array(copy) : new Uint16Array(copy);
    return {
      width: info.width,
      height: info.height,
      rawValueToMeters: info.rawValueToMeters,
      normFromView: new Float32Array(info.normDepthBufferFromNormView.matrix),
      viewMatrix: new Float32Array(view.transform.inverse.matrix),
      projMatrix: new Float32Array(view.projectionMatrix),
      data,
    };
  }
  return null;
}

/**
 * Request a depth snapshot from the next available XR frame. Resolves with null —
 * immediately — when depth sensing isn't active (no XR session, unsupported device,
 * or feature not granted), or after a short timeout if no usable frame arrives.
 */
export function captureDepthSnapshot(): Promise<DepthSnapshot | null> {
  const el = scene();
  if (!el || !depthAvailable(el)) return Promise.resolve(null);
  return new Promise((resolve) => {
    pendingResolvers.push(resolve);
    window.setTimeout(() => {
      const i = pendingResolvers.indexOf(resolve);
      if (i !== -1) {
        pendingResolvers.splice(i, 1);
        resolve(null);
      }
    }, REQUEST_TIMEOUT_MS);
  });
}

// Column-major 4x4 (m) times a vec4 → vec4.
function transform(m: Float32Array, x: number, y: number, z: number, w: number): [number, number, number, number] {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12] * w,
    m[1] * x + m[5] * y + m[9] * z + m[13] * w,
    m[2] * x + m[6] * y + m[10] * z + m[14] * w,
    m[3] * x + m[7] * y + m[11] * z + m[15] * w,
  ];
}

// Read metres at integer buffer pixel (col,row), or null if the raw value is 0
// (the API's "no data here" sentinel) or out of the plausible window.
function readPixel(snap: DepthSnapshot, col: number, row: number): number | null {
  const c = Math.min(snap.width - 1, Math.max(0, col));
  const r = Math.min(snap.height - 1, Math.max(0, row));
  const raw = snap.data[r * snap.width + c];
  if (!raw) return null;
  const metres = raw * snap.rawValueToMeters;
  return metres >= MIN_DEPTH && metres <= MAX_DEPTH ? metres : null;
}

/**
 * Estimate the distance in metres, from the capture viewpoint, to the real-world
 * surface seen along the ray from `origin` in direction `dir` (both world space).
 * Returns null when there's no depth reading there.
 *
 * `dir` need not be normalized. The returned distance is measured along the ray
 * (treated as radial) — an approximation for boxes off the optical axis, in line
 * with the flow's other pinhole approximations.
 */
export function sampleDepthMeters(
  snap: DepthSnapshot,
  origin: { x: number; y: number; z: number },
  dir: { x: number; y: number; z: number },
): number | null {
  const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
  // A point far along the ray: same pixel, minimal sensitivity to head translation.
  const px = origin.x + (dir.x / len) * PROBE_DISTANCE;
  const py = origin.y + (dir.y / len) * PROBE_DISTANCE;
  const pz = origin.z + (dir.z / len) * PROBE_DISTANCE;

  // World → view → clip.
  const v = transform(snap.viewMatrix, px, py, pz, 1);
  const clip = transform(snap.projMatrix, v[0], v[1], v[2], v[3]);
  if (clip[3] <= 1e-6) return null; // behind the camera
  const ndcX = clip[0] / clip[3];
  const ndcY = clip[1] / clip[3];
  if (ndcX < -1 || ndcX > 1 || ndcY < -1 || ndcY > 1) return null; // outside FOV

  // NDC → normalized view coords (origin top-left), then → depth-buffer coords.
  const nvX = (ndcX + 1) / 2;
  const nvY = (1 - ndcY) / 2;
  const b = transform(snap.normFromView, nvX, nvY, 0, 1);
  const bx = b[0];
  const by = b[1];
  if (bx < 0 || bx > 1 || by < 0 || by > 1) return null;

  const col = Math.round(bx * (snap.width - 1));
  const row = Math.round(by * (snap.height - 1));

  // Sample the centre and its 4-neighbours; the median of the valid ones rejects
  // the frequent 0-holes in the depth map without blurring across the object edge.
  const readings: number[] = [];
  for (const [dc, dr] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    const m = readPixel(snap, col + dc, row + dr);
    if (m != null) readings.push(m);
  }
  if (readings.length === 0) return null;
  readings.sort((a, z) => a - z);
  return readings[(readings.length - 1) >> 1];
}
