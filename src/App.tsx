import { useEffect, useState } from "react";
import { CalcPage } from "./features/calc/CalcPage";
import { ChartsPage } from "./features/charts/ChartsPage";
import { PlayPage } from "./features/play/PlayPage";
import { CoachProvider } from "./features/coach/CoachContext";
import { QuizPage } from "./features/quiz/QuizPage";
import { SettingsPage } from "./features/settings/SettingsPage";

const TABS = [
  { id: "charts", label: "차트", icon: "▦" },
  { id: "quiz", label: "퀴즈", icon: "?" },
  { id: "play", label: "플레이", icon: "♠" },
  { id: "calc", label: "계산기", icon: "%" },
  { id: "settings", label: "설정", icon: "⚙" },
] as const;
type Tab = (typeof TABS)[number]["id"];

function tabFromHash(): Tab {
  const h = location.hash.replace("#", "");
  return (TABS.find((t) => t.id === h)?.id ?? "charts") as Tab;
}

export function App() {
  const [tab, setTab] = useState<Tab>(tabFromHash);

  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const go = (t: Tab) => {
    location.hash = t;
    setTab(t);
    window.scrollTo(0, 0);
  };

  return (
    <CoachProvider onNeedKey={() => go("settings")}>
      <header className="app-head">
        <span className="logo">My GTO</span>
        <span className="muted small">{TABS.find((t) => t.id === tab)?.label}</span>
      </header>
      <main>
        {tab === "charts" && <ChartsPage />}
        {tab === "quiz" && <QuizPage />}
        {tab === "play" && <PlayPage />}
        {tab === "calc" && <CalcPage />}
        {tab === "settings" && <SettingsPage />}
      </main>
      <nav className="tabbar">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? "on" : ""} onClick={() => go(t.id)}>
            <span className="tab-icon">{t.icon}</span>
            {t.label}
          </button>
        ))}
      </nav>
    </CoachProvider>
  );
}
