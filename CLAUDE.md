# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

WebXR-AI: a browser-based WebXR (AR) demo built with A-Frame that captures a frame from the device camera and sends it to a multimodal LLM (Mistral) for description. The result streams back into a 3D text label in the scene. The package name is `webxr-ts`; the deployed/repo name is `WebXR-AI`.

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

`main.ts` boots the app in three phases, then builds the text-label UI imperatively:
1. `setupSession()` (`src/xrsession.ts`) — currently a no-op stub.
2. `setupEventListeners()` (`src/listeners.ts`) — registers input handlers.
3. `setupComponents()` (`src/components.ts`) — registers A-Frame components.

It then creates an `a-entity[auto-text-background]` containing an `a-plane.bg` and an `a-text#text.label`, appended to the scene. The `#text` element is the single shared output surface that the LLM response is written into.

### Interaction flow

Triggered by the **`p`** key (PC) or the **X button** (Quest, via the `x-button-listener` A-Frame component). On trigger (`handleKeyUp` in `src/listeners.ts`): grab the `environment`-facing camera stream → draw a frame to a canvas → base64 PNG → POST to `https://api.mistral.ai/v1/chat/completions` (model `mistral-medium-latest`, `stream: true`) → parse the SSE `data:` lines and append each delta chunk into `#text` live.

### A-Frame custom components

- `auto-text-background` (`src/components.ts`) — resizes the `.bg` plane to fit the `.label` text whenever the text changes. Measures with `new THREE.Box3().setFromObject(mesh)` (local space) rather than `geometry.boundingBox` (world space) — the comment explains the latter is off by ~2 orders of magnitude here.
- `x-button-listener` (`src/listeners.ts`) — bridges the Quest controller `xbuttondown` event to the same capture handler.

`THREE` is accessed via `AFRAME.THREE` (A-Frame bundles its own three.js); avoid importing `three` at runtime to prevent a duplicate-instance mismatch. `@types/three` / `import type * as THREE` are used for types only.

### Duplicate/alternate files (important)

Two pairs of files implement the same thing; only one of each is wired into `main.ts`. Edit the active one:

- **Listeners**: `src/listeners.ts` (active, raw `fetch`) vs `src/listeners.api.ts` (unused, same exported `setupEventListeners` using the `@mistralai/mistralai` SDK).
- **Components**: `src/components.ts` (active, wraps registration in `setupComponents()`) vs `src/components/auto-background.ts` (unused, registers at import time and uses the world-space `geometry.boundingBox` approach).

`src/counter.ts` and the asset/logo imports in `main.ts` are leftover Vite scaffolding (commented out / unused).

## TypeScript config notes

`tsconfig.json` uses bundler mode with strict-ish flags: `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax` (use `import type` for type-only imports), and `erasableSyntaxOnly`. `noEmit` is set — `tsc` only type-checks; Vite does the actual transpile/bundle.
