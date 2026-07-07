// Thin client for the Google Cloud Vision REST API. We use OBJECT_LOCALIZATION,
// which returns detected objects with normalized (0..1) bounding polygons in
// image space; src/interactions/detection.ts projects those into world-space
// frames.
//
// Auth mirrors the Mistral client (src/api/mistral.ts): the request goes to the
// same-origin /api/vision path and the Vite dev-server proxy rewrites it to
// vision.googleapis.com and appends the ?key= param, so the API key never ships
// to the client (see vite.config.ts). The key must have the Vision API enabled.

const ANNOTATE_URL = "/api/vision/images:annotate";

// One object detection: its label, confidence, and the 4 corners of its
// bounding box as normalized (0..1) image coordinates (x: left→right,
// y: top→bottom), in polygon order (top-left, top-right, bottom-right,
// bottom-left).
export interface Detection {
  name: string;
  score: number;
  corners: Array<{ x: number; y: number }>;
}

/**
 * Run object localization on a base64 PNG (no data-URL prefix). Returns the
 * detected objects, or [] on error.
 */
export async function localizeObjects(base64: string): Promise<Detection[]> {
  const res = await fetch(ANNOTATE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: [
        {
          image: { content: base64 },
          features: [{ type: "OBJECT_LOCALIZATION", maxResults: 20 }],
        },
      ],
    }),
  });
  if (!res.ok) {
    console.error("Vision localize failed:", res.status, await res.text());
    return [];
  }

  const json = await res.json();
  const annotations = json.responses?.[0]?.localizedObjectAnnotations ?? [];
  // proto3 omits zero-valued fields, so a vertex at x=0 or y=0 arrives with the
  // property absent — default those back to 0.
  return annotations.map(
    (a: {
      name?: string;
      score?: number;
      boundingPoly?: { normalizedVertices?: Array<{ x?: number; y?: number }> };
    }): Detection => ({
      name: a.name ?? "object",
      score: a.score ?? 0,
      corners: (a.boundingPoly?.normalizedVertices ?? []).map((v) => ({
        x: v.x ?? 0,
        y: v.y ?? 0,
      })),
    }),
  );
}
