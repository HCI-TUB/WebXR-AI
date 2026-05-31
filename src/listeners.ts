export function setupEventListeners() {
  let stream: MediaStream | null = null;

  // Request camera access on page load
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

  AFRAME.registerComponent("x-button-listener", {
    init: function () {
      const el = this.el;
      el.addEventListener("xbuttondown", async function (evt) {
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
        if (ctx) {
          ctx.drawImage(video, 0, 0);
          const a = document.createElement("a");
          a.href = canvas.toDataURL("image/png");
          a.download = `ar-snapshot-${Date.now()}.png`;
          a.click();
        }
      });
    },
  });
}
