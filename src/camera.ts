// Shared environment-camera capture. The vision Q&A ("Ask") flow and the
// object-detection ("Detect") flow both need a single still frame from the
// rear/passthrough camera, so the getUserMedia stream and the
// video → canvas → base64 PNG grab live here once.
//
// The stream is memoized: getUserMedia is requested lazily on first capture and
// reused thereafter (re-requested only if a prior attempt failed).

let camStream: MediaStream | null = null;

/** Lazily acquire (and cache) the `environment`-facing camera stream. */
export async function getEnvironmentStream(): Promise<MediaStream | null> {
  if (camStream) return camStream;
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
    });
  } catch (err) {
    console.error("Camera error:", err);
  }
  return camStream;
}

export interface CapturedFrame {
  /** PNG bytes, base64-encoded (no data-URL prefix). */
  base64: string;
  width: number;
  height: number;
}

/**
 * Grab a single frame from the environment camera as a base64 PNG. Returns
 * null if the camera is unavailable or a frame can't be drawn.
 */
export async function captureFrame(): Promise<CapturedFrame | null> {
  const stream = await getEnvironmentStream();
  if (!stream) return null;

  const video = document.createElement("video");
  video.srcObject = stream;
  await new Promise((r) => (video.onloadeddata = r));
  await video.play().catch(() => {});

  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0);

  const base64 = canvas.toDataURL("image/png").split(",")[1];
  return { base64, width: canvas.width, height: canvas.height };
}
