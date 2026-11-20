import { useEffect, useRef } from "react";

/**
 * The header's back (‹). In order: the page's own step back (the hand recorder's 결과 → 액션 → 테이블 →
 * 핸드), else the app's own history, else the screen above. Every history entry the app makes carries its
 * place (0 for the entry the app opened on), so a place above 0 means an earlier screen of the app is
 * there to go back to; at 0 (the home-screen app opened on a deep link, a shared address, a reload of the
 * first screen) back goes to the parent screen instead of leaving the app or doing nothing.
 * The decisions are pure (tested in backNav.test.ts); App.tsx does the history calls.
 */

/** The key a history entry's place is kept under. */
export const INDEX_KEY = "pubajIdx";
/** The key the routes of the entries under an entry are kept under (nearest last), for in-page back links. */
export const TRAIL_KEY = "pubajTrail";
/** How many of the routes under an entry it keeps: a back link to a screen further down replaces instead. */
export const TRAIL_MAX = 40;

/**
 * How a page opens a screen (App's `go`): "push" one place up (the default); "replace" this entry (a tab, a
 * toggle: no step back to the tab before); "back", for an in-page back link ("‹ 지난 기록", "← 시나리오"): the
 * earlier entry showing that screen when there is one (as the header's ‹ would), else this entry's place, so
 * the header's ‹ never leads back into the screen just left.
 */
export type GoHow = "push" | "replace" | "back";
export type Go = (route: string, how?: GoHow) => void;

/** An entry's place in the app's history, or null for an entry the app didn't make (or hasn't stamped yet). */
export function entryIndex(state: unknown): number | null {
  if (typeof state !== "object" || state === null) return null;
  const n = (state as Record<string, unknown>)[INDEX_KEY];
  return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : null;
}

/** `state` with the place `idx`, anything else it held kept. */
export function withIndex(state: unknown, idx: number): Record<string, unknown> {
  return { ...(typeof state === "object" && state !== null ? state : {}), [INDEX_KEY]: idx };
}

/** The routes of the entries under this one, nearest last ([] for an entry the app didn't stamp, or its first). */
export function entryTrail(state: unknown): string[] {
  if (typeof state !== "object" || state === null) return [];
  const t = (state as Record<string, unknown>)[TRAIL_KEY];
  return Array.isArray(t) && t.every((r) => typeof r === "string") ? (t as string[]) : [];
}

/** `state` with the trail `trail`, anything else it held kept. */
export function withTrail(state: unknown, trail: string[]): Record<string, unknown> {
  return { ...(typeof state === "object" && state !== null ? state : {}), [TRAIL_KEY]: trail };
}

/** The trail of an entry opened on top of one showing `below` (whose own trail is `trail`). */
export function pushedTrail(trail: string[], below: string): string[] {
  return [...trail, below].slice(-TRAIL_MAX);
}

/**
 * An in-page back link to `to` (GoHow "back"), given the routes under the entry showing: back through
 * history to the nearest entry showing it (`steps` entries down), else open it in this entry's place.
 */
export function backTo(trail: string[], to: string): { kind: "history"; steps: number } | { kind: "replace" } {
  const i = trail.lastIndexOf(to);
  return i >= 0 ? { kind: "history", steps: trail.length - i } : { kind: "replace" };
}

/**
 * The place of the entry now showing, given the place of the one shown before (-1 when the app opens): its
 * own if it has one (a step back or forward, a reload); else one past the last (an address typed by hand),
 * which `stamp` says to write on the entry.
 */
export function arrivedAt(state: unknown, last: number): { idx: number; stamp: boolean } {
  const own = entryIndex(state);
  return own !== null ? { idx: own, stamp: false } : { idx: last + 1, stamp: true };
}

/**
 * Where an opened screen puts its entry: on top of the one showing (one place up), or in its place, for the
 * screen already open (a new hand from the menu: no step back to the same screen) and for the screen above
 * (back with no earlier entry: the parent takes the deep link's place, so the next back goes further up).
 */
export function nextEntry(idx: number, replace: boolean): { idx: number; push: boolean } {
  return replace ? { idx, push: false } : { idx: idx + 1, push: true };
}

/** 내 핸드 screens of the hand log that aren't a saved hand ("log/<id>" is one). */
const LOG_SCREENS = new Set(["log", "log/new", "log/quick", "log/fast", "log/list", "log/list/mine", "log/list/other", "log/players"]);

/**
 * The screen above `route`, for back with no earlier entry: a saved hand → 지난 기록, 남의 핸드 → 빠른 기록
 * (its toggle lives there), a solver report or flop → the scenario list, everything else → home.
 */
export function parentRoute(route: string): string {
  if (route === "log/other" || route.startsWith("log/other/")) return "log/fast";
  if (route.startsWith("log/") && !LOG_SCREENS.has(route)) return "log/list";
  if (route.startsWith("solver/")) return "solver";
  return "home";
}

export type BackMove = { kind: "page" } | { kind: "history" } | { kind: "up"; route: string };

/**
 * What back does on `route` at history place `idx`: the page's own step back if it takes it (`page` is
 * asked first, and only asked), else the earlier entry, else the parent screen.
 */
export function backMove(page: () => boolean, idx: number, route: string): BackMove {
  if (page()) return { kind: "page" };
  if (idx > 0) return { kind: "history" };
  return { kind: "up", route: parentRoute(route) };
}

/**
 * Opens `route` one place up in the app's history, for a page shown without App's `go` (which keeps the
 * place itself); hash listeners hear it as they heard `location.hash = route` before.
 */
export function pushRoute(route: string): void {
  try {
    const below = decodeURIComponent(location.hash.replace(/^#/, "")) || "home";
    const state = withIndex(null, nextEntry(entryIndex(history.state) ?? 0, false).idx);
    history.pushState(withTrail(state, pushedTrail(entryTrail(history.state), below)), "", `#${route}`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } catch {
    location.hash = route;
  }
}

/** The place of the entry showing (0 when it has none, or there is no history): a page's own memory per entry. */
export function currentPlace(): number {
  try {
    return entryIndex(history.state) ?? 0;
  } catch {
    return 0;
  }
}

// ───────────── a page's own step back ─────────────

/** A page's step back; returning false hands back to the route back after all. */
export type BackHandler = () => boolean | void;

const claims: BackHandler[] = [];

/** Takes the header's back for `handler` (the latest claim wins); the result gives it up. */
export function claimBack(handler: BackHandler): () => void {
  claims.push(handler);
  return () => {
    const i = claims.lastIndexOf(handler);
    if (i >= 0) claims.splice(i, 1);
  };
}

/** Runs the latest claim: true when the page stepped back itself. */
export function pageBack(): boolean {
  const h = claims[claims.length - 1];
  return h ? h() !== false : false;
}

/**
 * Takes the header's back while `handler` is given (null: the page has nowhere of its own to step back to,
 * so back leaves the screen). Always calls the latest `handler`; given up on unmount.
 */
export function useBackHandler(handler: BackHandler | null): void {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  const on = handler !== null;
  useEffect(() => (on ? claimBack(() => (latest.current ? latest.current() : false)) : undefined), [on]);
}
