import { useEffect, useRef, useState } from "react";
import { arrivedAt, backMove, backTo, entryTrail, nextEntry, pageBack, pushedTrail, withIndex, withTrail, type Go } from "./backNav";
import { CalcPage } from "./features/calc/CalcPage";
import { ChartsPage } from "./features/charts/ChartsPage";
import { CoachProvider } from "./features/coach/CoachContext";
import { HomePage } from "./features/home/HomePage";
import { LogPage } from "./features/log/LogPage";
import { PlayPage } from "./features/play/PlayPage";
import { QuizPage } from "./features/quiz/QuizPage";
import { SettingsPage } from "./features/settings/SettingsPage";
import { SolverPage } from "./features/solver/SolverPage";
import { isActive, NAV, redirectRoute, titleOf } from "./nav";
import { UpdateBanner } from "./pwa/UpdateBanner";

/** The route in the address bar; an old route that moved is replaced there by its new place. */
function routeFromHash(): string {
  const route = decodeURIComponent(location.hash.replace(/^#/, "")) || "home";
  const moved = redirectRoute(route);
  if (moved === null) return route;
  try {
    history.replaceState(history.state, "", `#${moved}`);
  } catch {
    /* no history: the route still changes */
  }
  return moved;
}

/** Where an entry sits in the app's history: its place, and the routes of the entries under it (nearest last). */
type Spot = { idx: number; trail: string[] };

/**
 * The entry now showing, stamped with its place when it has none (see backNav.ts): `last` is the entry shown
 * before (null when the app opens) and `lastRoute` its route, which an address typed by hand stacks on.
 */
function placeHere(last: Spot | null, lastRoute: string): { spot: Spot; stamped: boolean } {
  const { idx, stamp } = arrivedAt(history.state, last ? last.idx : -1);
  if (!stamp) return { spot: { idx, trail: entryTrail(history.state) }, stamped: false };
  const trail = last ? pushedTrail(last.trail, lastRoute) : [];
  try {
    history.replaceState(withTrail(withIndex(history.state, idx), trail), "");
  } catch {
    /* no history: back goes to the parent screen */
  }
  return { spot: { idx, trail }, stamped: true };
}

/** The screens with a page of their own; any other route shows the home screen. */
const PAGES = ["home", "play", "log", "quiz", "charts", "solver", "calc", "settings"];

export function App() {
  const [route, setRoute] = useState(routeFromHash);
  const [opened] = useState(() => placeHere(null, route).spot);
  /**
   * The entry showing: its place in the app's history (above 0, back has an earlier screen of the app) and
   * the routes under it (where an in-page back link finds its screen). Kept ahead of the screen: a step
   * back counts at once, so a second tap before it lands can't go past the screen it goes to.
   */
  const place = useRef(opened);
  /** The route showing, for the listener (set up once): set with the route. */
  const shown = useRef(route);
  const [drawer, setDrawer] = useState(false);
  /** The screen was reached by a step back or forward, not opened anew: the hand log shows it as it was left. */
  const [returned, setReturned] = useState(false);

  useEffect(() => {
    // A step back or forward (the header's ‹, a phone's back), or an address typed by hand (a new screen).
    const onNav = () => {
      const here = placeHere(place.current, shown.current);
      place.current = here.spot;
      setReturned(!here.stamped);
      shown.current = routeFromHash();
      setRoute(shown.current);
      setDrawer(false);
    };
    window.addEventListener("popstate", onNav);
    window.addEventListener("hashchange", onNav);
    return () => {
      window.removeEventListener("popstate", onNav);
      window.removeEventListener("hashchange", onNav);
    };
  }, []);

  /** Every visit starts the hand log afresh, even to the screen already open (a new hand from the menu). */
  const [visit, setVisit] = useState(0);
  /** Opens a screen: one place up in history, or in this entry's place (`replace`, and the screen already open). */
  const open = (to: string, replace: boolean) => {
    const r = redirectRoute(to) ?? to;
    const next = nextEntry(place.current.idx, replace || r === shown.current);
    const trail = next.push ? pushedTrail(place.current.trail, shown.current) : place.current.trail;
    try {
      if (next.push) history.pushState(withTrail(withIndex(null, next.idx), trail), "", `#${r}`);
      else history.replaceState(withTrail(withIndex(history.state, next.idx), trail), "", `#${r}`);
    } catch {
      location.hash = r;
    }
    place.current = { idx: next.idx, trail };
    shown.current = r;
    setRoute(r);
    setReturned(false);
    setVisit((v) => v + 1);
    setDrawer(false);
    window.scrollTo(0, 0);
  };
  /** `steps` entries back through history, counted at once (see `place`). */
  const stepBack = (steps: number) => {
    const { idx, trail } = place.current;
    place.current = { idx: idx - steps, trail: trail.slice(0, Math.max(0, trail.length - steps)) };
    history.go(-steps);
  };
  /** A page opens a screen: on top (the default), in this entry's place, or back to it (see GoHow in backNav.ts). */
  const go: Go = (to, how = "push") => {
    const r = redirectRoute(to) ?? to;
    if (how === "back" && r !== shown.current) {
      const move = backTo(place.current.trail, r);
      if (move.kind === "history") return stepBack(move.steps);
    }
    open(r, how !== "push");
  };

  /** The header's ‹: the page's own step back, else the earlier screen, else the screen above (never out of the app). */
  const back = () => {
    const move = backMove(pageBack, place.current.idx, shown.current);
    if (move.kind === "history") stepBack(1);
    else if (move.kind === "up") open(move.route, true);
  };

  const [top, ...rest] = route.split("/");
  const home = top === "home" || !PAGES.includes(top);

  const nav = (
    <nav className="side-nav">
      <button className="brand" onClick={() => go("home")}>
        <img className="brand-chip" src={`${import.meta.env.BASE_URL}icons/icon.svg`} alt="" />
        <span>
          <b>PubAJ</b>
          <small>펍아재 잡는 홀덤 공부</small>
        </span>
      </button>
      {NAV.map((n) =>
        "section" in n ? (
          <div key={n.section} className="nav-section">
            {n.section}
          </div>
        ) : (
          <button key={n.route} className={`nav-item ${isActive(n.route, route) ? "on" : ""}`} onClick={() => go(n.route)}>
            <span className="nav-icon">{n.icon}</span>
            {n.label}
          </button>
        ),
      )}
    </nav>
  );

  return (
    <CoachProvider onNeedKey={() => go("settings")}>
      <div className="shell">
        <aside className="sidebar">{nav}</aside>
        {drawer && (
          <div className="drawer-backdrop" onClick={() => setDrawer(false)}>
            <aside className="drawer" onClick={(e) => e.stopPropagation()}>
              {nav}
            </aside>
          </div>
        )}
        <div className="content">
          {/* Home: the logo, ☰ at the right. Elsewhere: ‹ and the screen's name, ☰ at the right. */}
          <header className="app-head">
            {home ? (
              <button className="logo" onClick={() => go("home")}>
                <img className="logo-icon" src={`${import.meta.env.BASE_URL}icons/icon.svg`} alt="" />
                PubAJ <small>펍아재</small>
              </button>
            ) : (
              <>
                <button className="back-btn" onClick={back} aria-label="뒤로">
                  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
                    <path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                <span className="head-title">{titleOf(route)}</span>
              </>
            )}
            <button className="menu-btn" onClick={() => setDrawer(true)} aria-label="메뉴">
              ☰
            </button>
          </header>
          <main>
            {top === "home" && <HomePage go={go} />}
            {top === "play" && <PlayPage />}
            {top === "log" && <LogPage key={visit} sub={rest.join("/")} go={go} returned={returned} />}
            {top === "quiz" && <QuizPage key={route} sub={rest.join("/")} />}
            {top === "charts" && <ChartsPage />}
            {top === "solver" && <SolverPage sub={rest.join("/")} go={go} />}
            {top === "calc" && <CalcPage />}
            {top === "settings" && <SettingsPage />}
            {!PAGES.includes(top) && <HomePage go={go} />}
          </main>
          <UpdateBanner />
        </div>
      </div>
    </CoachProvider>
  );
}
