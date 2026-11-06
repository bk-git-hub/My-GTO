/**
 * Service worker updates for the installed app.
 *
 * vite-plugin-pwa runs in "prompt" mode: a new service worker installs in the background and then
 * waits, so the running page keeps one consistent set of (old) precached assets and lazy chunks
 * never 404 after a deploy. This module decides when to look for a new version (an installed PWA
 * resumed from the background never reloads, so the browser would rarely check on its own) and
 * when it is safe to switch to it.
 */
import { useSyncExternalStore } from "react";
import type { RegisterSWOptions } from "virtual:pwa-register";

// ---------------------------------------------------------------------------------------------
// Pure policy (unit-tested in update.test.ts)
// ---------------------------------------------------------------------------------------------

export type CheckReason = "startup" | "visible" | "online" | "interval" | "manual";

/** Coming back to the foreground checks at most this often. */
export const VISIBLE_THROTTLE_MS = 5 * 60 * 1000;
/** Guards against a flapping connection firing "online" over and over. */
export const ONLINE_THROTTLE_MS = 30 * 1000;
/** While the app stays open and visible, check this often. */
export const INTERVAL_MS = 30 * 60 * 1000;
/** How often the interval timer looks at the clock. */
export const INTERVAL_TICK_MS = 60 * 1000;
/** A check that hangs (lie-fi) gives up after this, so it can't block the next one. */
const FETCH_TIMEOUT_MS = 15 * 1000;
const UPDATE_TIMEOUT_MS = 30 * 1000;
/** Right after a cold start, before any input, an update is applied without asking. */
export const COLD_START_MS = 3000;

export interface CheckInput {
  /** Date.now() */
  now: number;
  /** Date.now() when the last check went to the network, null if none yet. */
  lastCheckAt: number | null;
  /** The last check could not reach the server (offline or an error). */
  lastFailed: boolean;
  visible: boolean;
  online: boolean;
  /** A check is running or a new worker is installing. */
  busy: boolean;
  /** An update is already waiting (or being applied). */
  ready: boolean;
}

export function shouldCheck(reason: CheckReason, s: CheckInput): boolean {
  if (s.busy) return false;
  if (reason === "manual") return true;
  if (!s.online || s.ready) return false;
  // A clock that jumped backwards counts as "long ago".
  const since = s.lastCheckAt === null || s.now < s.lastCheckAt ? Infinity : s.now - s.lastCheckAt;
  switch (reason) {
    case "startup":
      return true;
    case "online":
      // Right after a failed check the connection coming back is exactly what we waited for.
      return s.lastFailed || since >= ONLINE_THROTTLE_MS;
    case "visible":
      return s.visible && since >= VISIBLE_THROTTLE_MS;
    case "interval":
      return s.visible && since >= INTERVAL_MS;
  }
}

export interface ApplyInput {
  /** ms since this page started */
  sinceStart: number;
  /** Any pointer or key input since the page started. */
  interacted: boolean;
  hidden: boolean;
  /** Focus is in a text field. */
  typing: boolean;
  /** Something on screen would be lost by a reload (see holdUpdates). */
  held: boolean;
}

/** Whether a waiting update may be applied (page reload) without asking. */
export function shouldAutoApply(s: ApplyInput): boolean {
  if (s.typing || s.held) return false;
  // The user switched away: nothing on screen to disturb.
  if (s.hidden) return true;
  // A cold start the user has not touched yet.
  return !s.interacted && s.sinceStart <= COLD_START_MS;
}

const NON_TEXT_INPUTS = new Set(["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"]);

export interface FocusLike {
  tagName: string;
  type?: string;
  readOnly?: boolean;
  disabled?: boolean;
  isContentEditable?: boolean;
}

/** Whether the focused element is somewhere the user types. */
export function isTextEntry(el: FocusLike | null | undefined): boolean {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName.toUpperCase();
  if (tag !== "INPUT" && tag !== "TEXTAREA") return false;
  if (el.readOnly || el.disabled) return false;
  return tag === "TEXTAREA" || !NON_TEXT_INPUTS.has((el.type ?? "text").toLowerCase());
}

export type UpdateStatus =
  | "unsupported" // no service worker here (dev server, old browser, registration failed)
  | "idle" // registered, not checked yet
  | "checking"
  | "latest"
  | "downloading" // a new version is installing
  | "ready" // a new version is waiting
  | "applying"
  | "offline"
  | "error";

/** Status right after a check, from what the registration holds. */
export function statusAfterCheck(r: { installing: boolean; waiting: boolean; controlled: boolean }): UpdateStatus {
  if (!r.controlled) return "latest"; // first install: nothing older is running
  if (r.installing) return "downloading";
  if (r.waiting) return "ready";
  return "latest";
}

/**
 * Status after a new worker changed state (installed, redundant, ...), from what the registration
 * holds then; null keeps the current status. workbox-window stops reporting updates after the
 * first one it takes for "external" (any found more than a minute after registering), so the
 * store follows the workers itself. `waiting` counts only a waiting worker that is not redundant.
 */
export function statusOnWorkerChange(
  current: UpdateStatus,
  r: { installing: boolean; waiting: boolean; controlled: boolean },
): UpdateStatus | null {
  if (!r.controlled || current === "applying") return null;
  if (r.installing) return "downloading"; // a newer one is still on its way
  if (r.waiting) return "ready";
  // The worker we were waiting for failed to install and nothing else is waiting.
  return current === "downloading" ? "error" : null;
}

// ---------------------------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------------------------

export interface UpdateState {
  status: UpdateStatus;
  /** Date.now() of the last check that reached the server. */
  checkedAt: number | null;
  /** The banner was closed for the waiting version (it still applies when the app is hidden). */
  dismissed: boolean;
}

let state: UpdateState = { status: "unsupported", checkedAt: null, dismissed: false };
const listeners = new Set<() => void>();

function setState(patch: Partial<UpdateState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export const updateStore = {
  get: (): UpdateState => state,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

export function useUpdateState(): UpdateState {
  return useSyncExternalStore(updateStore.subscribe, updateStore.get, updateStore.get);
}

// ---------------------------------------------------------------------------------------------
// Runtime (browser only)
// ---------------------------------------------------------------------------------------------

type RegisterSW = (options: RegisterSWOptions) => (reloadPage?: boolean) => Promise<void>;

let started = false;
let startedAt = 0;
let interacted = false;
let registration: ServiceWorkerRegistration | undefined;
let swUrl = "";
let updateSW: ((reloadPage?: boolean) => Promise<void>) | null = null;
let lastCheckAt: number | null = null;
let lastFailed = false;
let inFlight = false;
let applying = false;
let reloading = false;
/** The worker controlling this page changed under it while the user was typing or a hold was open. */
let reloadWhenSafe = false;
/** Open holds (holdUpdates): while any is open, nothing reloads the page by itself. */
let holds = 0;
/** New workers whose state changes are followed (see watchWorker). */
const watched = new WeakSet<ServiceWorker>();

const INPUT_EVENTS = ["pointerdown", "keydown", "touchstart", "wheel"] as const;

const isHidden = () => document.visibilityState === "hidden";
const isTyping = () => isTextEntry(document.activeElement as FocusLike | null);
/** Reloading now would not disturb anything: no text entry, no hold. */
const isSafeToReload = () => !isTyping() && holds === 0;

function reload() {
  if (reloading) return;
  reloading = true;
  window.location.reload();
}

/** A new worker took control of this page: its old asset set is gone, so reload. */
function onControllerChange() {
  if (applying || isSafeToReload()) reload();
  else reloadWhenSafe = true;
}

/** A new version is installed and waiting. */
function becomeReady() {
  if (state.status === "ready" || state.status === "applying") return;
  setState({ status: "ready", dismissed: false });
  maybeAutoApply();
}

function maybeAutoApply() {
  if (state.status !== "ready") return;
  const ok = shouldAutoApply({
    sinceStart: performance.now() - startedAt,
    interacted,
    hidden: isHidden(),
    typing: isTyping(),
    held: holds > 0,
  });
  if (ok) void applyUpdate();
}

/**
 * Keeps the page from reloading by itself (applying an update when the app goes to the
 * background) while something on screen would be lost, e.g. an AI coach reply still streaming.
 * Returns the release; once the last hold is released, a waiting update applies if the app is
 * in the background by then. The banner and [지금 업데이트] still work while held.
 */
export function holdUpdates(): () => void {
  holds++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds--;
    if (holds > 0 || !started) return;
    if (reloadWhenSafe && isHidden() && isSafeToReload()) reload();
    else maybeAutoApply();
  };
}

/** Re-reads the registration whenever this new worker changes state. */
function watchWorker(r: ServiceWorkerRegistration, sw: ServiceWorker) {
  if (watched.has(sw)) return;
  watched.add(sw);
  sw.addEventListener("statechange", () => {
    const waiting = r.waiting;
    const next = statusOnWorkerChange(state.status, {
      installing: r.installing !== null,
      waiting: waiting !== null && waiting.state !== "redundant",
      controlled: navigator.serviceWorker.controller !== null,
    });
    if (next === null || next === state.status) return;
    if (next === "ready") becomeReady();
    else {
      if (next === "error") lastFailed = true;
      setState({ status: next });
    }
  });
}

function markInteracted() {
  interacted = true;
  for (const t of INPUT_EVENTS) window.removeEventListener(t, markInteracted, true);
}

/**
 * Registers the service worker and starts watching for new versions. Call once at startup with
 * `registerSW` from "virtual:pwa-register" (passed in so this module stays testable).
 */
export function startUpdates(registerSW: RegisterSW): void {
  if (started || typeof window === "undefined") return;
  started = true;
  if (import.meta.env.DEV || !("serviceWorker" in navigator)) return; // stays "unsupported"
  startedAt = performance.now();
  setState({ status: "idle" });

  for (const t of INPUT_EVENTS) window.addEventListener(t, markInteracted, { capture: true, passive: true });

  let controller = navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    const hadController = controller !== null;
    controller = navigator.serviceWorker.controller;
    if (hadController) onControllerChange();
  });

  updateSW = registerSW({
    immediate: true,
    onRegisteredSW(url, r) {
      swUrl = url;
      registration = r;
      if (!r) {
        setState({ status: "unsupported" });
        return;
      }
      r.addEventListener("updatefound", () => {
        const sw = r.installing;
        // A first install stays quiet; an update being applied keeps its status.
        if (!sw || !navigator.serviceWorker.controller || state.status === "applying") return;
        setState({ status: "downloading" });
        watchWorker(r, sw);
      });
      void checkForUpdate("startup");
    },
    onRegisterError() {
      setState({ status: "unsupported" });
    },
    onNeedRefresh: becomeReady,
    onOfflineReady() {
      // First install finished: this is the latest version. No toast.
      setState({ status: "latest", checkedAt: Date.now() });
    },
    onNeedReload: onControllerChange,
  });

  document.addEventListener("visibilitychange", () => {
    if (isHidden()) {
      if (reloadWhenSafe && isSafeToReload()) reload();
      else maybeAutoApply();
    } else {
      void checkForUpdate("visible");
    }
  });
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) void checkForUpdate("visible");
  });
  window.addEventListener("online", () => void checkForUpdate("online"));
  window.setInterval(() => void checkForUpdate("interval"), INTERVAL_TICK_MS);
}

/** Gives up waiting on `p` after `ms` (it keeps running; we just stop holding the check lock). */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = window.setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => {
        window.clearTimeout(id);
        resolve(v);
      },
      (e: unknown) => {
        window.clearTimeout(id);
        reject(e);
      },
    );
  });
}

const holdsUpdate = () => state.status === "ready" || state.status === "applying";

/** Looks for a new version. Never throws; the outcome lands in the store. */
export async function checkForUpdate(reason: CheckReason = "manual"): Promise<void> {
  const r = registration;
  if (!r || reloading) return;
  const online = navigator.onLine !== false;
  const go = shouldCheck(reason, {
    now: Date.now(),
    lastCheckAt,
    lastFailed,
    visible: !isHidden(),
    online,
    busy: inFlight || r.installing !== null,
    ready: holdsUpdate(),
  });
  const fail = (status: "offline" | "error") => {
    lastFailed = true;
    if (!holdsUpdate()) setState({ status });
  };
  if (!online && (go || reason === "startup")) return fail("offline");
  if (!go) return;

  inFlight = true;
  lastCheckAt = Date.now();
  if (!holdsUpdate()) setState({ status: "checking" });
  try {
    // Reachability check first (vite-plugin-pwa's documented pattern): update() on a dead
    // connection would fail anyway, and this tells "offline" apart from other errors.
    let reachable: Response;
    const abort = new AbortController();
    const abortTimer = window.setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS);
    try {
      reachable = await fetch(swUrl, { cache: "no-store", headers: { "cache-control": "no-cache" }, signal: abort.signal });
    } catch {
      return fail("offline");
    } finally {
      window.clearTimeout(abortTimer);
    }
    if (!reachable.ok) return fail("error");
    await within(r.update(), UPDATE_TIMEOUT_MS);
    lastFailed = false;
    // A worker still installing reports back when it settles (normally updatefound already did this).
    if (r.installing && navigator.serviceWorker.controller) watchWorker(r, r.installing);
    const next = statusAfterCheck({
      installing: r.installing !== null,
      waiting: r.waiting !== null,
      controlled: navigator.serviceWorker.controller !== null,
    });
    if (state.status === "applying") return;
    if (next === "ready") {
      // Usually onNeedRefresh already said so; the controllerchange listener reloads either way.
      becomeReady();
      setState({ checkedAt: Date.now() });
    } else {
      setState({ status: next, checkedAt: Date.now() });
    }
  } catch {
    fail("error");
  } finally {
    inFlight = false;
  }
}

/** Switches to the waiting version: the new worker takes over and the page reloads. */
export async function applyUpdate(): Promise<void> {
  if (state.status !== "ready" || !updateSW || applying) return;
  applying = true;
  setState({ status: "applying" });
  try {
    await updateSW(true);
  } catch {
    /* the reload below still happens */
  }
  // The reload normally comes from controllerchange; if the waiting worker vanished instead,
  // reload anyway so the button never looks dead.
  window.setTimeout(reload, 5000);
}

/** Hides the banner for the waiting version (Settings still offers it). */
export function dismissBanner(): void {
  setState({ dismissed: true });
}
