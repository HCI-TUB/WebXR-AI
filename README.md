# WebXR-AI

[![Build](https://github.com/HCI-TUB/WebXR-AI/actions/workflows/build.yml/badge.svg)](https://github.com/HCI-TUB/WebXR-AI/actions/workflows/build.yml)
[![volkswagen status](https://auchenberg.github.io/volkswagen/volkswargen_ci.svg?v=1)](https://github.com/auchenberg/volkswagen)

This is a small example app for testing AI models — mostly multimodal LLM and computer vision — in WebXR using [three.js](https://threejs.org/).
It will hopefully be a good starting point if you want to play around with a few things in WebXR and AI.

## Getting Started

### Prerequisites

You'll need a working toolchain (Node and pnpm) and one or two API keys.

#### Toolchain

You will need a recent [node](https://nodejs.org/en) version and [pnpm](https://pnpm.io/) installed.
On macOS you can do this via Homebrew:

```sh
brew install node pnpm
```

#### API keys

The app expects its API keys to be stored in environment variables. These keys
stay in the Node process — the dev server proxies the AI requests and injects
the credentials server-side, so they never ship to the client bundle.

Two keys are used:

- `MISTRAL_API_KEY` — **required.** Powers transcription (Voxtral) and the
  multimodal LLM (Mistral) behind the Ask, Create, Place, and Sandbox flows.
  Without it every AI flow fails. See [here](https://docs.mistral.ai/admin/identity-access/api-keys) on how to create one.
- `GOOGLE_CLOUD_VISION_API_KEY` — **optional.** Only needed for the Detect flow
  (object localization via Google Cloud Vision). The key must have the Cloud
  Vision API enabled; restrict it to that API and your origin. Without it,
  object detection fails but every other flow still works. See [here](https://docs.cloud.google.com/docs/authentication/api-keys) on how to create one.

In any reasonable usage scenario you should stay within the free tier of both services.

Once you have them, they need to be exported so they are visible to the `vite` process. Exactly how to do that depends on your OS. On macOS or Linux you can do it like so:

```
export MISTRAL_API_KEY=YOUR_KEY_HERE
export GOOGLE_CLOUD_VISION_API_KEY=YOUR_KEY_HERE
```

To make them permanent, add those lines to your `.zshrc` (or `.bashrc` if using
bash). Note that these are plain, un-prefixed variables (no `VITE_` prefix) — a
`VITE_`-prefixed name would inline the secret into the client bundle.

### Setup

Once all of that is done, clone the repository, navigate into the folder and run:

> If you want to use another package manager, npm should work by just substituting `npm` for `pnpm`; for others you may need to adapt the commands.

```
pnpm install
```

That's it.

### Running

To start the app, run the following in a terminal:

```
pnpm run dev --host 0.0.0.0
```

This will expose the dev server to the network.
Make sure your device and the one you want to use the app on are in the same network (or at least in networks that can communicate with each other) and then browse to the location that vite tells you to use the app.

> The dev server runs over self-signed HTTPS (WebXR and the camera only work in
> a secure context), so expect a browser certificate warning the first time —
> accept it to continue.

The app was tested on a Meta Quest device. If you have none available, you can try Meta's [Immersive Web Emulator](https://chromewebstore.google.com/detail/immersive-web-emulator/cgffilbpcibhmcfbgggfhfolhkfbhmik?hl=en) in Chrome, an Android phone that supports [Play Services for AR](https://play.google.com/store/apps/details?id=com.google.ar.core&hl=en), or an iPhone (the XR features won't work, but image capture will).
