import { Mistral } from "@mistralai/mistralai";
import type {
  ContentChunk,
  ImageURL,
  TextContent,
  UserMessage,
} from "@mistralai/mistralai/models/components";

export function setupEventListeners() {
  let stream: MediaStream | null = null;
  const client = new Mistral({ apiKey: import.meta.env.VITE_MISTRAL_API_KEY });

  async function initCamera() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
      });
    } catch (err) {
      console.error("Camera error:", err);
    }
  }
  initCamera();

  document.addEventListener("keyup", async (event) => {
    if (event.key !== "p") return;

    if (!stream) await initCamera();
    if (!stream) return;

    const video = document.createElement("video");
    video.srcObject = stream;
    await new Promise((r) => (video.onloadeddata = r));
    await video.play().catch(() => {});

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.drawImage(video, 0, 0);
    const base64Image = canvas.toDataURL("image/png").split(",")[1];

    const textEl = document.querySelector("#text");
    if (!textEl) return;
    textEl.setAttribute("value", "Processing...");

    const responseStream = await client.chat.stream({
      model: "mistral-medium-latest",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Describe what you see in this image in detail.",
            } as TextContent,
            {
              type: "image_url",
              image_url: {
                url: `data:image/png;base64,${base64Image}`,
              } as ImageURL,
            },
          ] as ContentChunk[],
        } as UserMessage,
      ],
      maxTokens: 500,
    });

    let result = "";
    for await (const chunk of responseStream) {
      const content = chunk.choices?.[0]?.delta?.content;
      if (content) {
        result += content;
        textEl.setAttribute("value", result);
      }
    }
  });
}
