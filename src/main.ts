import "./style.css";
// import typescriptLogo from "./assets/typescript.svg";
// import viteLogo from "./assets/vite.svg";
// import heroImg from "./assets/hero.png";
// import { setupCounter } from "./counter.ts";
import { setupEventListeners } from "./listeners.ts";
import { setupSession } from "./xrsession.ts";
// import * as THREE from "three";

// window.THREE = THREE;
import AFRAME from "aframe";
import "aframe-extras";

// declare global {
//   interface Window {
//     THREE: typeof THREE;
//   }
// }

// document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
//     <a-scene button xr-mode-ui="XRMode: ar" webxr="requiredFeatures: hit-test,local-floor
//                                                    optionalFeatures: dom-overlay,unbounded;">
//       <a-entity id="rain" particle-system="preset: rain; color: #24CAFF; particleCount: 5000"></a-entity>

//       <a-entity id="sphere" geometry="primitive: sphere"
//                 material="color: #EFEFEF; shader: flat"
//                 position="0 0.15 -5"
//                 light="type: point; intensity: 15.7"
//                 animation="property: position; easing: easeInOutQuad; dir: alternate; dur: 1000; to: 0 -0.10 -5; loop: true"></a-entity>

//       <a-entity id="ocean" ocean="density: 20; width: 50; depth: 50; speed: 4"
//                 material="color: #9CE3F9; opacity: 0.75; metalness: 0; roughness: 1"
//                 rotation="-90 0 0"></a-entity>

//       <a-sky-background top-color="#EBEBF5" bottom-color="#B9B9D2"></a-sky-background>

//       <a-entity id="light" light="type: ambient; color: #888"></a-entity>
//     </a-scene>`;

setupSession();
setupEventListeners();
console.log(AFRAME.version);
