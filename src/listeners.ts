export function setupEventListeners() {
  let stream: MediaStream | null = null;

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

    const response = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${import.meta.env.VITE_MISTRAL_API_KEY}`,
      },
      body: JSON.stringify({
        model: "mistral-medium-latest",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Describe what you see in this image in detail.",
              },
              {
                type: "image_url",
                image_url: { url: `data:image/png;base64,${base64Image}` },
              },
            ],
          },
        ],
        max_tokens: 500,
        stream: true,
      }),
    });

    const reader = response.body?.getReader();
    let result = "";
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = new TextDecoder().decode(value);
        const lines = text
          .split("\n\n")
          .filter((l) => l.trim().startsWith("data: "));
        for (const line of lines) {
          const data = line.slice(6).trim();
          if (data === "[DONE]") continue;
          try {
            const parsed = JSON.parse(data);
            const chunk = parsed.choices?.[0]?.delta?.content;
            if (chunk) {
              result += chunk;
              textEl.setAttribute("value", result);
            }
          } catch (e) {
            console.error("Stream parsing error:", e);
          }
        }
      }
    }
  });
}
