# WebXR-AI

[![Build](https://github.com/HCI-TUB/WebXR-AI/actions/workflows/build.yml/badge.svg)](https://github.com/HCI-TUB/WebXR-AI/actions/workflows/build.yml)
[![volkswagen status](https://auchenberg.github.io/volkswagen/volkswargen_ci.svg?v=1)](https://github.com/auchenberg/volkswagen)

This is a small example app to test AI (speak mostly Multimodal LLM/Computer Vision) models in WebXR using `A-Frame.js`.

## Getting Started

You will need a recent [node](https://nodejs.org/en) version and [pnpm](https://pnpm.io/) installed.
Clone the repository, navigate into the folder and run:

> If you want to use another package manager npm should work by just subsituting `npm` for `pnpm`, for others you will potentially need to adapt the commands.

```
pnpm install
```

The app expects its API keys to be stored in environment variables. These keys
stay in the Node process — the dev server proxies the AI requests and injects
the credentials server-side, so they never ship to the client bundle.

Two keys are used:

- `MISTRAL_API_KEY` — **required.** Powers transcription (Voxtral) and the
  multimodal LLM (Mistral) behind the Ask, Create, and Place flows. Without it
  every AI flow fails.
- `GOOGLE_CLOUD_VISION_API_KEY` — **optional.** Only needed for the Detect flow
  (object localization via Google Cloud Vision). The key must have the Cloud
  Vision API enabled; restrict it to that API and your origin. Without it,
  object detection fails but every other flow still works.

How to set them depends on your OS. On macOS or Linux you can do it like so:

```
export MISTRAL_API_KEY=YOUR_KEY_HERE
export GOOGLE_CLOUD_VISION_API_KEY=YOUR_KEY_HERE
```

To make them permanent, add those lines to your `.zshrc` (or `.bashrc` if using
bash). Note that these are plain, un-prefixed variables (no `VITE_` prefix) — a
`VITE_`-prefixed name would inline the secret into the client bundle.

To start the app, run the following in a terminal:

```
pnpm run dev --host 0.0.0.0
```

This will expose the dev server to the network.
You can then browse to that location to use the app.

> The dev server runs over self-signed HTTPS (WebXR and the camera only work in
> a secure context), so expect a browser certificate warning the first time —
> accept it to continue.

> The [Immersive Web Emuator](https://chromewebstore.google.com/detail/immersive-web-emulator/cgffilbpcibhmcfbgggfhfolhkfbhmik?hl=en) from Meta has an option to send a URL to a device, if you want to avoid typing random numbers in XR.
