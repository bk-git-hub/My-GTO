import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { App } from "./App";
import { stopFocusZoomHere } from "./pwa/iosZoom";
import { startUpdates } from "./pwa/update";
import { hideSplash, startSplash } from "./splash/splash";
import { startCardColors } from "./state/settings";
import "./styles.css";

startSplash();
startCardColors();
stopFocusZoomHere();
startUpdates(registerSW);

/** Runs after the app's first commit: the launch splash (index.html) may go. */
function SplashDone() {
  useEffect(hideSplash, []);
  return null;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
    <SplashDone />
  </StrictMode>,
);
