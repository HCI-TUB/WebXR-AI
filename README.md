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

The app expects API Keys to be stored in environment variables.
How to do this depends on your OS.

On macOS or Linux you can do it like so:

```
export MISTRAL_API_KEY=YOUR_KEY_HERE
```

To make it permanent, add that line to your `.zshrc` (or `.bashrc` if using bash).

To start the app, run the following in a terminal:

```
pnpm run dev --host 0.0.0.0
```

This will expose the dev server to the network.
You can then browse to that location to use the app.

> The [Immersive Web Emuator](https://chromewebstore.google.com/detail/immersive-web-emulator/cgffilbpcibhmcfbgggfhfolhkfbhmik?hl=en) from Meta has an option to send a URL to a device, if you want to avoid typing random numbers in XR.
