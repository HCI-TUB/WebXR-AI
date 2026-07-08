import "./style.css";
import { setupEventListeners } from "./interactions/listeners.ts";
import { setupDetection } from "./interactions/detection.ts";
import { setupPlacement } from "./interactions/placement.ts";
import { setupDepthSensing } from "./xr/depth-sensing.ts";
import { setupPanel } from "./ui/uikit-panel.ts";

import "aframe-extras";

setupEventListeners();
setupDepthSensing();
setupDetection();
setupPlacement();
setupPanel();

// The uikit panel entity (the shared output surface the LLM response streams
// into) is declared statically in index.html as <a-entity uikit-panel>.
