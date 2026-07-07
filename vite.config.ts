import basicSsl from "@vitejs/plugin-basic-ssl";
import tailwindcss from "@tailwindcss/vite";

// The Mistral and Google Vision requests are proxied through the dev server so
// the API keys stay in the Node process and never ship to the client. The
// browser hits same-origin /api/* paths; this proxy rewrites the target URL and
// injects credentials. Keys come from process.env (NOT import.meta.env / the
// VITE_ prefix, which would inline them into the client bundle).
//
// NOTE: server.proxy only runs under `pnpm run dev`. A production `vite build`
// is served statically with no server to inject keys — that would need a real
// backend (serverless function, etc.). See CLAUDE.md > Required environment.
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
const GOOGLE_CLOUD_VISION_API_KEY = process.env.GOOGLE_CLOUD_VISION_API_KEY;

export default {
  plugins: [basicSsl(), tailwindcss()],
  base: "/WebXR-AI",
  server: {
    proxy: {
      // Mistral: strip the /api/mistral prefix and add the bearer token.
      "/api/mistral": {
        target: "https://api.mistral.ai/v1",
        changeOrigin: true,
        rewrite: (p: string) => p.replace(/^\/api\/mistral/, ""),
        configure: (proxy: any) => {
          proxy.on("proxyReq", (proxyReq: any) => {
            proxyReq.setHeader("Authorization", `Bearer ${MISTRAL_API_KEY}`);
          });
        },
      },
      // Google Vision: strip the /api/vision prefix and append the ?key= param.
      "/api/vision": {
        target: "https://vision.googleapis.com/v1",
        changeOrigin: true,
        rewrite: (p: string) =>
          p.replace(/^\/api\/vision/, "") +
          (p.includes("?") ? "&" : "?") +
          `key=${GOOGLE_CLOUD_VISION_API_KEY}`,
      },
    },
  },
};
