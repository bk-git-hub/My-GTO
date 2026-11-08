import { useEffect, useState } from "react";
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

export function App() {
  const [route, setRoute] = useState(routeFromHash);
  const [drawer, setDrawer] = useState(false);

  useEffect(() => {
    const onHash = () => setRoute(routeFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  /** Every visit starts the hand log afresh, even to the screen already open (a new hand from the menu). */
  const [visit, setVisit] = useState(0);
  const go = (to: string) => {
    const r = redirectRoute(to) ?? to;
    location.hash = r;
    setRoute(r);
    setVisit((v) => v + 1);
    setDrawer(false);
    window.scrollTo(0, 0);
  };

  const [top, ...rest] = route.split("/");

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
          <header className="app-head">
            <button className="menu-btn" onClick={() => setDrawer(true)} aria-label="메뉴">
              ☰
            </button>
            <button className="logo" onClick={() => go("home")}>
              <img className="logo-icon" src={`${import.meta.env.BASE_URL}icons/icon.svg`} alt="" />
              PubAJ <small>펍아재</small>
            </button>
            <span className="head-title">{titleOf(route)}</span>
          </header>
          <main>
            {top === "home" && <HomePage go={go} />}
            {top === "play" && <PlayPage />}
            {top === "log" && <LogPage key={visit} sub={rest.join("/")} go={go} />}
            {top === "quiz" && <QuizPage key={route} sub={rest.join("/")} />}
            {top === "charts" && <ChartsPage />}
            {top === "solver" && <SolverPage sub={rest.join("/")} go={go} />}
            {top === "calc" && <CalcPage />}
            {top === "settings" && <SettingsPage />}
            {!["home", "play", "log", "quiz", "charts", "solver", "calc", "settings"].includes(top) && <HomePage go={go} />}
          </main>
          <UpdateBanner />
        </div>
      </div>
    </CoachProvider>
  );
}
