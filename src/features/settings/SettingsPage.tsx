import { useState } from "react";
import { MODEL_OPTIONS, settingsStore, useSettings, type Effort } from "../../state/settings";
import { statsStore } from "../../state/stats";
import { threadsStore } from "../coach/threads";

const EFFORTS: { id: Effort; label: string; note: string }[] = [
  { id: "low", label: "빠르게", note: "짧은 질문, 빠른 답변" },
  { id: "medium", label: "보통", note: "기본값" },
  { id: "high", label: "깊게", note: "복잡한 상황을 꼼꼼히 (느리고 비쌈)" },
];

export function SettingsPage() {
  const settings = useSettings();
  const threads = threadsStore.use();
  const [showKey, setShowKey] = useState(false);
  const [keyStatus, setKeyStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const update = (patch: Partial<typeof settings>) => settingsStore.set((s) => ({ ...s, ...patch }));

  async function checkKey() {
    setTesting(true);
    setKeyStatus(null);
    const { describeError, testApiKey } = await import("../coach/client");
    try {
      const name = await testApiKey(settings.apiKey.trim(), settings.model);
      setKeyStatus({ ok: true, text: `연결 성공 — ${name} 사용 가능` });
    } catch (e) {
      setKeyStatus({ ok: false, text: describeError(e) });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="page">
      <section className="card-box">
        <h2>AI 코치 (Claude API)</h2>
        <label className="field">
          API 키
          <div className="row-gap">
            <input
              type={showKey ? "text" : "password"}
              value={settings.apiKey}
              onChange={(e) => update({ apiKey: e.target.value.trim() })}
              placeholder="sk-ant-..."
              autoComplete="off"
              spellCheck={false}
            />
            <button className="ghost small" onClick={() => setShowKey((v) => !v)}>
              {showKey ? "숨기기" : "보기"}
            </button>
          </div>
        </label>
        <div className="row-gap">
          <button className="primary small" onClick={checkKey} disabled={!settings.apiKey || testing}>
            {testing ? "확인 중…" : "키 확인"}
          </button>
          {keyStatus && <span className={keyStatus.ok ? "ok-text" : "err-text"}>{keyStatus.text}</span>}
        </div>
        <p className="muted small">
          키는 이 기기의 브라우저에만 저장되고, Anthropic API로 직접 요청할 때만 쓰여요. 키는{" "}
          <a href="https://platform.claude.com/settings/keys" target="_blank" rel="noreferrer">
            Claude Console
          </a>
          에서 만들 수 있어요. Ultra·Max 요금제의 월 API 크레딧을 쓰려면 claude.ai 설정 → 결제 → API 크레딧에서
          Console 조직을 연결하고, <b>그 조직에서</b> 키를 만들어야 해요.
        </p>

        <label className="field">
          모델
          <select className="select" value={settings.model} onChange={(e) => update({ model: e.target.value })}>
            {MODEL_OPTIONS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} — {m.note}
              </option>
            ))}
          </select>
        </label>

        <div className="field">
          생각 깊이
          <div className="seg small">
            {EFFORTS.map((e) => (
              <button key={e.id} className={settings.effort === e.id ? "on" : ""} onClick={() => update({ effort: e.id })}>
                {e.label}
              </button>
            ))}
          </div>
          <span className="muted small">{EFFORTS.find((e) => e.id === settings.effort)?.note}</span>
        </div>
      </section>

      <section className="card-box">
        <h2>나만의 해설 노트</h2>
        <p className="muted small">
          책이나 강의에서 정리한 내용, 헷갈리는 개념, 원하는 설명 방식 등을 적어 두면 AI 코치가 해설할 때
          기본 해설집과 함께 참고해요.
        </p>
        <textarea
          className="notes"
          rows={6}
          value={settings.userNotes}
          onChange={(e) => update({ userNotes: e.target.value })}
          placeholder={"예)\n- 숫자 계산은 꼭 단계별로 보여줘\n- '블로커'는 아직 잘 모르니 나올 때마다 설명해줘"}
        />
      </section>

      <section className="card-box">
        <h2>데이터</h2>
        <div className="row-gap wrap">
          <button
            className="ghost small"
            onClick={() => confirm("퀴즈 기록을 모두 지울까요?") && statsStore.set({ byKey: {}, streak: 0, bestStreak: 0 })}
          >
            퀴즈 기록 초기화
          </button>
          <button
            className="ghost small"
            onClick={() => confirm("AI 대화 기록을 모두 지울까요?") && threadsStore.set({ threads: {} })}
          >
            AI 대화 기록 삭제 ({Object.keys(threads.threads).length}개)
          </button>
        </div>
      </section>

      <p className="muted small disclaimer">
        프리플랍 차트는 솔버 정확값이 아닌 학습용 근사 차트예요. 에퀴티·팟 오즈 숫자는 앱이 직접 계산해요
        (플랍·턴·리버 대 핸드는 정확 계산, 프리플랍과 레인지는 시뮬레이션).
      </p>
    </div>
  );
}
