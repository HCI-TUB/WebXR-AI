import AFRAME from "aframe";
import { Container, Text, reversePainterSortStable } from "@pmndrs/uikit";
import { initPointerInteraction, type PointerInteraction } from "./pointer.ts";

// A themed, scrollable uikit panel that replaces the old hand-built
// a-text + a-plane "auto-text-background" label. It is the single shared
// output surface the LLM response streams into (see setPanelText).
//
// Integration notes (see memory: uikit-aframe-integration):
// - uikit objects are three@0.184 Object3Ds; A-Frame runs super-three@0.173.
//   Attach with el.object3D.add(), NOT el.setObject3D() (instanceof guard).
// - A Container is its own root: call root.update(dt) every frame in tick().

// The panel's action buttons. Each id is addressed by the input layer to wire a
// handler, retitle the button, and tint it while its flow is recording.
const BUTTON_CONFIGS = [
  { id: "ask", label: "Record" }, // vision Q&A: describe / answer about the view
  { id: "create", label: "Create" }, // object generation: build a 3D object
] as const;

type ButtonId = (typeof BUTTON_CONFIGS)[number]["id"];

interface UikitPanelComponent {
  el: AFRAME.Entity;
  root?: Container;
  body?: Text;
  scrollArea?: Container;
  buttons?: Record<string, { container: Container; label: Text }>;
  interaction?: PointerInteraction;
  // Set when new text arrives; the tick pins the scroll to the bottom once the
  // fresh layout is known (doing it here, not in setPanelText, avoids clamping
  // against a stale/previous-frame content height).
  stickToBottom?: boolean;
}

// Module singleton so the streaming code can push text without threading refs.
let active: UikitPanelComponent | null = null;

// Per-button click handlers registered by the input layer, keyed by button id.
const buttonHandlers: Record<string, () => void> = {};

/** Register the callback fired when the given panel button is clicked. */
export function setButtonHandler(id: ButtonId, handler: () => void) {
  buttonHandlers[id] = handler;
}

const THEME = {
  pixelSize: 0.004,
  panelBg: "#1e1e2e",
  border: "#45475a",
  title: "#89b4fa",
  text: "#cdd6f4",
  muted: "#a6adc8",
  recording: "#f38ba8",
};

/** Set a button's caption (e.g. "Record" / "Stop", "Create" / "Stop"). */
export function setButtonLabel(id: ButtonId, label: string) {
  active?.buttons?.[id]?.label.setProperties({ text: label });
}

/** Tint a button to reflect recording state (red while its flow records). */
export function setButtonRecording(id: ButtonId, on: boolean) {
  active?.buttons?.[id]?.container.setProperties({
    backgroundColor: on ? THEME.recording : THEME.title,
  });
}

/** Replace the panel body text (mirrors the old setAttribute("value", ...)). */
export function setPanelText(text: string) {
  if (!active?.body) return;
  active.body.setProperties({ text });
  // Follow the newest text; actually applied in tick once layout is up to date.
  active.stickToBottom = true;
}

export function setupPanel() {
  AFRAME.registerComponent("uikit-panel", {
    init(this: UikitPanelComponent) {
      const sceneEl = this.el.sceneEl!;

      const start = () => {
        const renderer = sceneEl.renderer;
        if (!renderer) return;

        renderer.localClippingEnabled = true;
        renderer.setTransparentSort(reversePainterSortStable);

        const root = new Container(
          {
            pixelSize: THEME.pixelSize,
            width: 640,
            height: 440,
            padding: 28,
            gap: 16,
            flexDirection: "column",
            backgroundColor: THEME.panelBg,
            borderRadius: 24,
            borderWidth: 2,
            borderColor: THEME.border,
          },
          undefined,
          { renderContext: { requestFrame: () => {} } },
        );

        const title = new Text({
          text: "WebXR AI",
          fontSize: 34,
          fontWeight: "bold",
          color: THEME.title,
        });

        const scrollArea = new Container({
          flexGrow: 1,
          // Classic flexbox gotcha: without minHeight 0 the area grows to fit
          // its content (default minHeight is auto) instead of clipping and
          // scrolling it. With it, the area takes exactly its flex height.
          minHeight: 0,
          overflow: "scroll",
          flexDirection: "column",
          alignItems: "stretch",
          paddingRight: 12,
        });

        // Content wrapper: flexShrink 0 so it keeps its intrinsic (content)
        // height inside the scroll area rather than being clamped to the area's
        // height — that clamp is what stopped the text from ever overflowing.
        const content = new Container({
          flexShrink: 0,
          flexDirection: "column",
          width: "100%",
        });

        const body = new Text({
          text: "",
          fontSize: 20,
          lineHeight: "140%",
          color: THEME.text,
          width: "100%",
          // Default is "middle", which centers the block and hides the newest
          // lines as it overflows — top-anchor so text grows downward.
          verticalAlign: "top",
          textAlign: "left",
        });

        // A row of action buttons, one per BUTTON_CONFIGS entry.
        const buttonRow = new Container({
          flexDirection: "row",
          flexShrink: 0,
          gap: 16,
        });
        const buttons: Record<string, { container: Container; label: Text }> =
          {};
        for (const cfg of BUTTON_CONFIGS) {
          const container = new Container({
            onClick: () => buttonHandlers[cfg.id]?.(),
            cursor: "pointer",
            paddingX: 28,
            paddingY: 16,
            flexShrink: 0,
            borderRadius: 16,
            backgroundColor: THEME.title,
            justifyContent: "center",
            alignItems: "center",
            // Subtle press/hover affordance.
            hover: { backgroundColor: "#b4befe" },
            active: { backgroundColor: "#74a0f0" },
          });
          const label = new Text({
            text: cfg.label,
            fontSize: 24,
            fontWeight: "bold",
            color: THEME.panelBg,
          });
          container.add(label);
          buttonRow.add(container);
          buttons[cfg.id] = { container, label };
        }

        content.add(body);
        scrollArea.add(content);
        root.add(title, scrollArea, buttonRow);

        this.root = root;
        this.body = body;
        this.scrollArea = scrollArea;
        this.buttons = buttons;
        this.el.object3D.add(root);

        this.interaction = initPointerInteraction(sceneEl, root);

        // Point the module singleton at this instance so the exported setters
        // (setPanelText, setButtonLabel, …) and the tick share one `stickToBottom`.
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        active = this;

        setPanelText(
          "Hold 'X' (Quest) / 'P' (PC) — or tap Record — and speak to ask about your view. Hold 'Y' (Quest) / 'O' (PC) — or tap Create — to make a 3D object.",
        );
      };

      if (sceneEl.hasLoaded) start();
      else sceneEl.addEventListener("loaded", start);
    },

    tick(this: UikitPanelComponent, _time: number, deltaTime: number) {
      this.interaction?.update();
      this.root?.update(deltaTime);
      // Pin to the end after update(), when layout (and thus the scroll extent)
      // is fresh. The scroll matrix does NOT clamp, so set the exact max rather
      // than a large sentinel. maxScrollPosition isn't in the public types.
      if (this.stickToBottom && this.scrollArea) {
        const max = (
          this.scrollArea as unknown as {
            maxScrollPosition: {
              value: [number | undefined, number | undefined];
            };
          }
        ).maxScrollPosition.value;
        if (max?.[1] != null) {
          this.scrollArea.scrollPosition.value = [0, max[1]];
          this.stickToBottom = false;
        }
      }
    },

    remove(this: UikitPanelComponent) {
      this.interaction?.destroy();
      if (this.root) this.el.object3D.remove(this.root);
      if (active === this) active = null;
    },
  });
}
