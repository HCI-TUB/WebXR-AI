import AFRAME from "aframe";
import type * as THREE from "three";

const { Box3, Vector3 } = AFRAME.THREE;

export function setupComponents() {
  AFRAME.registerComponent("auto-text-background", {
    init() {
      const text = this.el.querySelector<AFRAME.Entity>(".label");
      const plane = this.el.querySelector<AFRAME.Entity>(".bg");

      if (!text || !plane) return;

      text.addEventListener("componentchanged", (event) => {
        if (event.detail.name === "text") {
          // Only update if text changed
          this.updateSize(text, plane);
        }
      });

      text.addEventListener("loaded", () => {
        console.log("evennnnt");
        this.updateSize(text, plane);
      });
    },

    updateSize(textEl: AFRAME.Entity, planeEl: AFRAME.Entity) {
      const mesh = textEl.getObject3D("text") as THREE.Mesh | undefined;
      if (!mesh?.geometry) return;

      // We need to use THREE.Box3().setFromObj because it will return measurements in local space
      // while using mesh.geometry.boundingBox would return measurements in world space,
      // which are off by around two orders of magnitude
      const bbox = new Box3().setFromObject(mesh);

      if (!bbox) return;

      const size = new Vector3();
      bbox.getSize(size);

      const padding = 0.1;
      planeEl.setAttribute("width", size.x + padding);
      planeEl.setAttribute("height", size.y + padding);
    },
  });
}
