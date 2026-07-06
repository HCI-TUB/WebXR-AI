# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

WebXR-AI: a browser-based WebXR (AR) demo built with A-Frame. The user records a spoken prompt, which Voxtral transcribes; the transcript plus a frame from the device camera is then sent to a multimodal LLM (Mistral). Both the transcript and the streamed reply appear in a `@pmndrs/uikit` panel in the scene. The package name is `webxr-ts`; the deployed/repo name is `WebXR-AI`.

## Commands

Uses **pnpm** (see `pnpm-workspace.yaml`); npm works as a substitute for most commands.

- `pnpm install` — install dependencies
- `pnpm run dev --host 0.0.0.0` — start the Vite dev server exposed to the LAN (needed so an XR headset on the same network can reach it)
- `pnpm run build` — type-check (`tsc`) then `vite build`. The build fails on type errors.
- `pnpm run preview` — serve the production build
- `pnpm exec eslint .` — lint (config in `eslint.config.mjs`, flat config with `typescript-eslint`)

There is **no test suite**.

### Required environment

The Mistral API key must be provided as a Vite env var before running: `export VITE_MISTRAL_API_KEY=...`. It is read via `import.meta.env.VITE_MISTRAL_API_KEY`. Without it, the LLM calls fail.

### HTTPS / camera

`@vitejs/plugin-basic-ssl` (in `vite.config.ts`) serves over self-signed HTTPS. This is mandatory: WebXR and `getUserMedia` (camera) only work in a secure context. Expect a browser certificate warning on the dev server.

### Deployment base path

`vite.config.ts` sets `base: "/WebXR-AI"`. Built assets assume they are served under that path — relevant when changing hosting.

## Architecture

Entry is `index.html` → `src/main.ts`. The `<a-scene>` lives in `index.html` with `xr-mode-ui="XRMode: ar"`; AR controllers are wired there (`meta-touch-controls`, and `x-button-listener` on the left controller).

Source is grouped by concern under `src/`:
- `main.ts`, `style.css` — entry point and global CSS.
- `api/mistral.ts` — the Mistral REST client (transcription + chat).
- `voice/recorder.ts` — the shared mic-capture → transcribe driver.
- `ui/uikit-panel.ts`, `ui/pointer.ts` — the uikit panel component and its pointer-events input bridge.
- `interactions/listeners.ts` — the two voice flows and the triggers/components that drive them.

`main.ts` boots the app in two phases, then relies on the statically-declared panel entity:
1. `setupEventListeners()` (`src/interactions/listeners.ts`) — registers input handlers.
2. `setupPanel()` (`src/ui/uikit-panel.ts`) — registers the `uikit-panel` A-Frame component.

The `a-entity[uikit-panel]` is declared statically in `index.html`. That component builds the `@pmndrs/uikit` panel — the single shared output surface the LLM response is written into via the exported `setPanelText()`.

### The uikit panel (`src/ui/uikit-panel.ts`)

The `uikit-panel` component builds a themed, scrollable panel: title, a scroll container holding the body `Text`, and a row of action buttons. Buttons are declared by `BUTTON_CONFIGS` (`{ id, label }`) — currently **`ask`** ("Record", vision Q&A) and **`create`** ("Create", object generation) — and addressed by id. Module-level exports drive it without threading refs:

- `setupPanel()` — registers the A-Frame component.
- `setPanelText(text)` — replaces the body text (mirrors the old `setAttribute("value", …)`); marks `stickToBottom` so the `tick` pins the scroll to the end after layout, keeping streamed text in view.
- `setButtonHandler(id, fn)` — sets the callback fired when the button with that id is clicked.
- `setButtonLabel(id, label)` — sets a button's caption ("Record" / "Stop", "Create" / "Stop").
- `setButtonRecording(id, on)` — tints that button red while its flow is recording.

**uikit scroll gotchas (all needed together, or nothing overflows/scrolls):**
- The scroll `Container` needs `overflow: "scroll"` **and** `minHeight: 0` — otherwise, as a flex child it grows to fit its content instead of clipping+scrolling it (the classic flexbox `min-height:auto` trap).
- The body `Text` must sit inside a wrapper `Container` with `flexShrink: 0`. A `Text` placed directly in the scroll area gets its height clamped to the area height (so it never overflows); the wrapper holds the intrinsic content height.
- Auto-scroll: the scroll matrix does **not** clamp `scrollPosition`, so pin to the exact `scrollArea.maxScrollPosition.value[1]` (read after `update()`), not a large sentinel. `maxScrollPosition` is a runtime signal not in uikit's public types.
- Body `Text` defaults to `verticalAlign: "middle"` — set `verticalAlign: "top"` or overflowing text shows the middle, not the newest lines.

### uikit ↔ A-Frame integration (important)

A-Frame runs its own three fork (`super-three`, ~r173); `@pmndrs/uikit` and `@pmndrs/pointer-events` import real `three` (~r184). **Two THREE instances coexist at runtime — this is expected and works** (the "Multiple instances of Three.js" console warning is benign). Do NOT alias `three`→`super-three` in Vite; it fights pnpm's layout and A-Frame's own `three/addons/*` subpath imports.

Constraints when mounting uikit into A-Frame:
- Attach uikit objects with `el.object3D.add(root)`, **never `el.setObject3D()`** — the latter does an `instanceof THREE.Object3D` check against super-three and rejects a real-three object.
- A uikit `Container` is its own root: call `root.update(deltaTime)` every frame in the component's `tick`.
- On the shared renderer (`el.sceneEl.renderer`) set `localClippingEnabled = true` and `setTransparentSort(reversePainterSortStable)` once.
- For A-Frame's own objects, `THREE` is still accessed via `AFRAME.THREE`; `@types/three` / `import type * as THREE` are used for types only.

### Interaction flow

Two voice flows share one **record → transcribe** path, diverging only in what the transcript feeds into. The shared path lives in `src/voice/recorder.ts` (`createVoiceRecorder`) and the Mistral API calls in `src/api/mistral.ts` (`transcribe`, `chat`, `streamChat`, model-id constants); `src/interactions/listeners.ts` defines the two actions and wires the triggers.

- **Ask** (vision Q&A): the **X button** (Quest), **`p`** key (PC), and the panel's **Record** button. After transcription, grab the `environment`-facing camera stream → draw a frame to a canvas → base64 PNG → `streamChat` prompt + image to `chat/completions` (model `mistral-medium-latest`, `stream: true`) → each accumulated SSE delta is pushed into the panel live under a `You: <prompt>` header (`askWithPhoto`).
- **Create** (object generation): the **Y button** (Quest), **`o`** key (PC), and the panel's **Create** button. After transcription, a system + user prompt is sent (non-streaming `chat`) to `chat/completions` (model `devstral-medium-latest`, the object model) asking for A-Frame entity markup. The reply is handed to `handleObjectResponse()` — the callback/extension point — which strips any code fences, injects the markup into `#ai-container`, and echoes it to the panel.

Recording is **hold-to-talk** on the Quest buttons and PC keys (`keydown`/`keyup`, `repeat`-guarded) and a **toggle** on the panel buttons. A single-flight `busy` flag ignores new starts while a round-trip is in flight; on start each trigger passes a `CaptureRequest` (`{ onTranscript, onRecordingChange }`) so the initiating button reflects Stop/red regardless of which trigger started it. Recording itself: `getUserMedia({ audio: true })` → `MediaRecorder` (Opus-in-WebM on Quest/Chromium, mp4 fallback); on stop the `Blob` is POSTed as multipart to `audio/transcriptions` (model `voxtral-mini-latest`) → the returned `text` is the prompt.

**Why the offline transcription endpoint, not realtime Voxtral:** Mistral's realtime WS (`wss://api.mistral.ai/v1/audio/transcriptions/realtime`, model `voxtral-mini-transcribe-realtime-2602`) only accepts the API key via the `Authorization` header. Browsers can't set headers on a `WebSocket` (query-param and subprotocol auth all return 401 — verified), so direct browser use needs a header-injecting proxy. The offline `POST` endpoint takes the same header via `fetch`, so it works client-side with no proxy — at the cost of transcribing only after the clip finishes (which matches the record-then-send UX).

Pointer input into uikit is wired in `src/ui/pointer.ts` (`initPointerInteraction`, called from the panel's `init`, driven from its `tick`):
- **PC**: mouse move / click / wheel-scroll via `forwardHtmlEvents` on the canvas.
- **XR**: one `createRayPointer` per `[meta-touch-controls]` controller, moved each frame (only while `renderer.xr.isPresenting`) and clicked on `triggerdown`/`triggerup`. Each controller also gets a visible laser via A-Frame's native `line` component (`end: 0 0 -5`), aimed down −Z to match the ray pointer's default direction.
Raycasting targets only the panel `root`, never the whole A-Frame scene, so the real-three raycaster never touches super-three meshes.

### A-Frame custom components

- `uikit-panel` (`src/ui/uikit-panel.ts`) — builds and drives the uikit UI panel (see above).
- `x-button-listener` (`src/interactions/listeners.ts`) — maps the Quest X button `xbuttondown`/`xbuttonup` to the **Ask** flow's recording start/stop (hold-to-talk).
- `y-button-listener` (`src/interactions/listeners.ts`) — maps the Quest Y button `ybuttondown`/`ybuttonup` to the **Create** flow's recording start/stop. Both X and Y live on the left Touch controller, so both components sit on the left `meta-touch-controls` entity in `index.html`.

## TypeScript config notes

`tsconfig.json` uses bundler mode with strict-ish flags: `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax` (use `import type` for type-only imports), and `erasableSyntaxOnly`. `noEmit` is set — `tsc` only type-checks; Vite does the actual transpile/bundle.
