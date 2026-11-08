import { accuracy, useStats, type Tally } from "../../state/stats";
import { useCoach } from "../coach/CoachContext";

const STAGE_LABEL: Record<string, string> = { deep: "딥", mid: "미들", short: "숏", push: "푸시/폴드" };

interface Weak {
  label: string;
  route: string;
  t: Tally;
}

/** Lowest-accuracy stage+seat in the range drill (at least 5 answers). */
function weakestSpot(byKey: Record<string, Tally>): Weak | null {
  let worst: Weak | null = null;
  for (const [key, t] of Object.entries(byKey)) {
    if (t.attempts < 5) continue;
    let m = key.match(/^stack:(deep|mid|short|push):(.+)$/);
    let w: Weak | null = null;
    if (m) w = { label: `펍아재 ${STAGE_LABEL[m[1]]} · ${m[2]}`, route: `quiz/stack/pub/${m[1]}/${encodeURIComponent(m[2])}`, t };
    m = key.match(/^stack-cash:100bb:(.+)$/);
    if (m) w = { label: `100bb 캐시 · ${m[1]}`, route: `quiz/stack/cash/all/${encodeURIComponent(m[1])}`, t };
    m = key.match(/^stack:vs:(deep|mid|short|push):(.+)$/);
    if (m) w = { label: `펍아재 ${STAGE_LABEL[m[1]]} · ${m[2]} vs 오픈`, route: `quiz/stack/pub/${m[1]}/${encodeURIComponent(m[2])}/vs`, t };
    m = key.match(/^stack-nash:(\d+bb):(.+)$/);
    if (m) w = { label: `푸시/폴드 내쉬 ${m[1]} · ${m[2]} 푸시`, route: `quiz/stack/nash/${m[1]}/${encodeURIComponent(m[2])}`, t };
    m = key.match(/^stack-nash:vs:(\d+bb):(.+)$/);
    if (m) w = { label: `푸시/폴드 내쉬 ${m[1]} · ${m[2]} vs 올인`, route: `quiz/stack/nash/${m[1]}/${encodeURIComponent(m[2])}/vs`, t };
    m = key.match(/^stack-short:(\d+bb):(.+)$/);
    if (m) w = { label: `숏스택 내쉬 ${m[1]} · ${m[2]} 오픈`, route: `quiz/stack/short/${m[1]}/${encodeURIComponent(m[2])}`, t };
    m = key.match(/^stack-short:vs:(\d+bb):(.+)$/);
    if (m) w = { label: `숏스택 내쉬 ${m[1]} · ${m[2]} vs 오픈`, route: `quiz/stack/short/${m[1]}/${encodeURIComponent(m[2])}/vs`, t };
    m = key.match(/^stack-cash:vs:100bb:(.+)$/);
    if (m) w = { label: `100bb 캐시 · ${m[1]} vs 오픈`, route: `quiz/stack/cash/all/${encodeURIComponent(m[1])}/vs`, t };
    if (w && (!worst || w.t.correct / w.t.attempts < worst.t.correct / worst.t.attempts)) worst = w;
  }
  return worst;
}

export function HomePage({ go }: { go: (route: string) => void }) {
  const stats = useStats();
  const coach = useCoach();
  const by = stats.byKey;
  const total = ["preflop", "stack", "stack-cash", "stack-nash", "stack-short", "odds", "equity"].reduce((n, k) => n + (by[k]?.attempts ?? 0), 0);
  const weak = weakestSpot(by);

  const cards: { route: string; icon: string; title: string; desc: string; stat?: string; tone: string }[] = [
    { route: "charts", icon: "▦", title: "펍아재 차트", desc: "스택 구간별 레인지 보기", tone: "gray" },
    { route: "solver", icon: "◆", title: "솔버 차트", desc: "미리 푼 플랍 전략 · 핸드별 빈도와 EV", tone: "gray" },
    { route: "log", icon: "✎", title: "핸드 복기", desc: "기억나는 핸드부터 · 자리·액션은 나중에 이어서", tone: "blue" },
    { route: "log/list", icon: "☰", title: "지난 기록 보기", desc: "내 핸드 · 남의 핸드 따로, 작성 중 이어 쓰기", tone: "gray" },
    { route: "log/fast", icon: "⚡", title: "빠른 기록", desc: "들어온 핸드 전부 · 차트대로 했는지 바로", tone: "green" },
    { route: "quiz/stack/pub", icon: "◎", title: "레인지 암기 · 펍아재", desc: "내 스택·평균 스택 보고 폴드/오픈/올인", stat: accuracy(by["stack"]), tone: "gold" },
    { route: "quiz/stack/cash", icon: "◎", title: "레인지 암기 · 100bb 캐시", desc: "6맥스 100bb 오픈 레인지", stat: accuracy(by["stack-cash"]), tone: "blue" },
    { route: "quiz/preflop", icon: "?", title: "프리플랍 퀴즈", desc: "RFI · vs 레이즈 · vs 올인", stat: accuracy(by["preflop"]), tone: "red" },
    { route: "quiz/odds", icon: "÷", title: "팟 오즈·EV", desc: "필요 에퀴티, MDF, 아웃츠", stat: accuracy(by["odds"]), tone: "green" },
    { route: "quiz/equity", icon: "%", title: "에퀴티 감각", desc: "핸드 vs 핸드, 플랍 올인", stat: accuracy(by["equity"]), tone: "purple" },
    { route: "calc", icon: "∑", title: "계산기", desc: "에퀴티 · 팟 오즈 · 콜 EV", tone: "gray" },
  ];

  function freeChat() {
    coach.open({
      id: "free-chat",
      title: "자유 질문",
      facts: "자유 질문. 사용자의 게임: 홀덤펍 토너먼트, 9인, BB 앤티, 시작 250bb, 콜이 많은 테이블.",
      defaultQuestion: "",
    });
  }

  return (
    <div className="page home">
      <section className="home-hero">
        <img className="hero-chip" src={`${import.meta.env.BASE_URL}icons/icon.svg`} alt="" />
        <div>
          <h1>PubAJ 펍아재</h1>
          <p>펍아재 잡는 홀덤 공부 · 9인 · BB 앤티 · 250bb 시작</p>
        </div>
      </section>

      <button className="cta" onClick={() => go("play")}>
        <span className="cta-icon">♠</span>
        <span className="cta-text">
          <b>핸드 플레이</b>
          <span>펍아재 9인 토너먼트 · 100bb 캐시 · 한 핸드를 리버까지, 결정마다 EV 채점</span>
        </span>
        <span className="cta-go">→</span>
      </button>

      {weak ? (
        <button className="weak" onClick={() => go(weak.route)}>
          <span>
            <b>약점 연습</b> {weak.label} · 정답률 {accuracy(weak.t)} ({weak.t.attempts}문제)
          </span>
          <span className="cta-go">→</span>
        </button>
      ) : (
        <div className="weak muted">레인지 암기를 자리마다 5문제 이상 풀면, 가장 약한 자리를 찾아서 여기 띄워 줄게요.</div>
      )}

      <div className="home-stats">
        <div>
          <b>{total}</b>
          <span>푼 문제</span>
        </div>
        <div>
          <b>{stats.streak}</b>
          <span>연속 정답</span>
        </div>
        <div>
          <b>{stats.bestStreak}</b>
          <span>최고 연속</span>
        </div>
        <div>
          <b>{accuracy(by["play"])}</b>
          <span>플레이 결정</span>
        </div>
      </div>

      <div className="home-grid">
        {cards.map((c) => (
          <button key={c.route} className={`home-card tone-${c.tone}`} onClick={() => go(c.route)}>
            <span className="home-icon">{c.icon}</span>
            <b>{c.title}</b>
            <span className="muted small">{c.desc}</span>
            {c.stat !== undefined && <span className="home-stat">정답률 {c.stat}</span>}
          </button>
        ))}
        <button className="home-card tone-gold" onClick={freeChat}>
          <span className="home-icon">✦</span>
          <b>AI 코치에게 질문</b>
          <span className="muted small">아무거나 물어보기</span>
        </button>
      </div>
    </div>
  );
}
