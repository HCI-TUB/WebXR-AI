import AFRAME from "aframe";
import type * as THREE from "three";

const { Vector3 } = AFRAME.THREE;

AFRAME.registerComponent("auto-text-background", {
  init() {
    const text = this.el.querySelector<AFRAME.Entity>(".label");
    const plane = this.el.querySelector<AFRAME.Entity>(".bg");

    if (!text || !plane) return;

    text.addEventListener("loaded", () => {
      this.updateSize(text, plane);
    });
  },

  updateSize(textEl: AFRAME.Entity, planeEl: AFRAME.Entity) {
    const mesh = textEl.object3D as THREE.Mesh;
    if (!mesh?.geometry) return;

    if (!mesh.geometry.boundingBox) {
      mesh.geometry.computeBoundingBox();
    }

    const bbox = mesh.geometry.boundingBox;
    if (!bbox) return;

    const size = new Vector3();
    bbox.getSize(size);

    const padding = 0.1;
    planeEl.setAttribute("width", size.x + padding);
    planeEl.setAttribute("height", size.y + padding);
  },
});
