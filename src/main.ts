import "./style.css";
// import typescriptLogo from "./assets/typescript.svg";
// import viteLogo from "./assets/vite.svg";
// import heroImg from "./assets/hero.png";
// import { setupCounter } from "./counter.ts";
import { setupComponents } from "./components.ts";
import { setupEventListeners } from "./listeners.ts";
import { setupSession } from "./xrsession.ts";

import AFRAME from "aframe";
// import { THREE } from "aframe";
// window.THREE = THREE;

// declare global {
//   interface Window {
//     THREE: typeof THREE;
//   }
// }

import "aframe-extras";

setupSession();
setupEventListeners();
setupComponents();

const scene = document.querySelector("a-scene")!;

const entity: AFRAME.Entity = document.createElement("a-entity");
entity.setAttribute("auto-text-background", true);
entity.setAttribute("position", "0 0 -5");

const text: AFRAME.Entity = document.createElement("a-text");
text.setAttribute("align", "center");
text.setAttribute("color", "white");
text.id = "text";
text.setAttribute("value", "");
text.classList.add("label");

const plane: AFRAME.Entity = document.createElement("a-plane");
plane.classList.add("bg");
plane.setAttribute("position", "0 0 -0.01");
plane.setAttribute("color", "#333");

entity.appendChild(plane);
entity.appendChild(text);

scene.appendChild(entity);

// Some stupid race condition is happening here and I really can't be bothered to look into it more right now
setTimeout(
  () =>
    text.setAttribute(
      "value",
      "Hi there! \nPress 'X' (on Quest) or 'P' on a PC \nto feed an image from your camera straight into the most convenient LLM API.",
    ),
  100,
);
