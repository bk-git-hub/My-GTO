import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { App } from "./App";
import { stopFocusZoomHere } from "./pwa/iosZoom";
import { startUpdates } from "./pwa/update";
import "./styles.css";

stopFocusZoomHere();
startUpdates(registerSW);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
