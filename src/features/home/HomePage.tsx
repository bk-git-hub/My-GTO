import { accuracy, useStats, type Tally } from "../../state/stats";
import { useCoach } from "../coach/CoachContext";

/** Every quiz's answers together, for the one 퀴즈 card. */
const QUIZ_KEYS = ["stack", "stack-cash", "preflop", "odds", "equity"];
function quizTally(byKey: Record<string, Tally>): Tally {
  return QUIZ_KEYS.reduce<Tally>((t, k) => ({ attempts: t.attempts + (byKey[k]?.attempts ?? 0), correct: t.correct + (byKey[k]?.correct ?? 0) }), { attempts: 0, correct: 0 });
}

export function HomePage({ go }: { go: (route: string) => void }) {
  const stats = useStats();
  const coach = useCoach();
  const by = stats.byKey;

  const cards: { route: string; icon: string; title: string; desc: string; stat?: string; tone: string }[] = [
    { route: "charts", icon: "▦", title: "펍아재 차트", desc: "스택 구간별 레인지 보기", tone: "gray" },
    { route: "solver", icon: "◆", title: "솔버 차트", desc: "미리 푼 플랍 전략 · 핸드별 빈도와 EV", tone: "gray" },
    { route: "log", icon: "✎", title: "핸드 복기", desc: "기억나는 핸드부터 · 자리·액션은 나중에 이어서", tone: "blue" },
    { route: "log/list", icon: "☰", title: "지난 기록 보기", desc: "내 핸드 · 남의 핸드 따로, 작성 중 이어 쓰기", tone: "gray" },
    { route: "log/fast", icon: "⚡", title: "빠른 기록", desc: "핸드마다 칩 증감 · 기억나는 보드만", tone: "green" },
    { route: "quiz", icon: "?", title: "퀴즈", desc: "레인지 암기 · 프리플랍 · 팟 오즈·EV · 에퀴티", stat: accuracy(quizTally(by)), tone: "gold" },
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
          <span>펍아재 9인 토너먼트 · 100bb 캐시 · AI들과 한 핸드를 리버까지, 차트·솔버로 채점</span>
        </span>
        <span className="cta-go">→</span>
      </button>

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
