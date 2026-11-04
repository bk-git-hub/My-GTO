import { useEffect, useState } from "react";
import { CalcPage } from "./features/calc/CalcPage";
import { ChartsPage } from "./features/charts/ChartsPage";
import { CoachProvider } from "./features/coach/CoachContext";
import { HomePage } from "./features/home/HomePage";
import { LogPage } from "./features/log/LogPage";
import { PlayPage } from "./features/play/PlayPage";
import { QuizPage } from "./features/quiz/QuizPage";
import { SettingsPage } from "./features/settings/SettingsPage";

interface NavItem {
  route: string;
  label: string;
  icon: string;
  indent?: boolean;
}

const NAV: (NavItem | { section: string })[] = [
  { route: "home", label: "홈", icon: "⌂" },
  { route: "play", label: "핸드 플레이", icon: "♠" },
  { route: "log", label: "핸드 기록", icon: "✎" },
  { section: "퀴즈" },
  { route: "quiz/stack", label: "레인지 암기", icon: "◎", indent: true },
  { route: "quiz/preflop", label: "프리플랍 퀴즈", icon: "?", indent: true },
  { route: "quiz/odds", label: "팟 오즈·EV", icon: "÷", indent: true },
  { route: "quiz/equity", label: "에퀴티", icon: "%", indent: true },
  { section: "도구" },
  { route: "charts", label: "차트", icon: "▦" },
  { route: "calc", label: "계산기", icon: "∑" },
  { route: "settings", label: "설정", icon: "⚙" },
];
const ITEMS = NAV.filter((n): n is NavItem => "route" in n);

function routeFromHash(): string {
  return decodeURIComponent(location.hash.replace(/^#/, "")) || "home";
}

function titleOf(route: string): string {
  const exact = ITEMS.find((i) => i.route === route);
  if (exact) return exact.label;
  return ITEMS.find((i) => route.startsWith(i.route + "/"))?.label ?? (route.startsWith("quiz") ? "퀴즈" : "PubAJ");
}

export function App() {
  const [route, setRoute] = useState(routeFromHash);
  const [drawer, setDrawer] = useState(false);

  useEffect(() => {
    const onHash = () => setRoute(routeFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const go = (r: string) => {
    location.hash = r;
    setRoute(r);
    setDrawer(false);
    window.scrollTo(0, 0);
  };

  const [top, ...rest] = route.split("/");
  const isActive = (r: string) => route === r || (r !== "home" && route.startsWith(r + "/")) || (r === "quiz/stack" && route === "quiz");

  const nav = (
    <nav className="side-nav">
      <button className="brand" onClick={() => go("home")}>
        <img className="brand-chip" src={`${import.meta.env.BASE_URL}icons/icon.svg`} alt="" />
        <span>
          <b>PubAJ</b>
          <small>펍아재 잡는 홀덤 공부</small>
        </span>
      </button>
      {NAV.map((n, i) =>
        "section" in n ? (
          <div key={i} className="nav-section">
            {n.section}
          </div>
        ) : (
          <button key={n.route} className={`nav-item ${n.indent ? "indent" : ""} ${isActive(n.route) ? "on" : ""}`} onClick={() => go(n.route)}>
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
            <span className="head-title">{route === "home" ? "" : titleOf(route)}</span>
          </header>
          <main>
            {top === "home" && <HomePage go={go} />}
            {top === "play" && <PlayPage />}
            {top === "log" && <LogPage sub={rest.join("/")} go={go} />}
            {top === "quiz" && <QuizPage key={route} sub={rest.join("/")} />}
            {top === "charts" && <ChartsPage />}
            {top === "calc" && <CalcPage />}
            {top === "settings" && <SettingsPage />}
            {!["home", "play", "log", "quiz", "charts", "calc", "settings"].includes(top) && <HomePage go={go} />}
          </main>
        </div>
      </div>
    </CoachProvider>
  );
}
