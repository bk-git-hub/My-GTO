import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MODEL_OPTIONS, useSettings } from "../../state/settings";
import { describeError, isAbort, streamCoachReply, type CoachMessage } from "./client";
import { firstUserMessage, type SpotContext } from "./prompt";
import { deleteThread, saveThread, threadsStore, type Thread } from "./threads";

const FOLLOW_UPS = ["더 쉽게 설명해줘", "팟 오즈랑 에퀴티로 다시 설명해줘", "비슷한 다른 핸드라면?", "실전에서 기억할 요령은?"];

export default function CoachSheet({ spot, onClose, onNeedKey }: { spot: SpotContext; onClose: () => void; onNeedKey: () => void }) {
  const settings = useSettings();
  const [thread, setThread] = useState<Thread>(
    () => threadsStore.get().threads[spot.id] ?? { spot, history: [], display: [], updatedAt: 0 },
  );
  const [streaming, setStreaming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const autoSent = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const busy = streaming !== null;
  const modelLabel = MODEL_OPTIONS.find((m) => m.id === settings.model)?.label ?? settings.model;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [thread.display.length, streaming]);

  useEffect(() => {
    if (!autoSent.current && thread.display.length === 0 && settings.apiKey) {
      autoSent.current = true;
      void send(spot.defaultQuestion);
    }
    // No abort on unmount: if the sheet is closed mid-answer, the reply still finishes and is saved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function send(question: string) {
    const q = question.trim();
    if (!q || busy) return;
    if (!settings.apiKey) return onNeedKey();

    const before = thread;
    const userContent = before.history.length === 0 ? firstUserMessage(spot, q) : q;
    const history: CoachMessage[] = [...before.history, { role: "user", content: userContent }];
    const display = [...before.display, { role: "user" as const, text: q }];
    setThread({ ...before, history, display });
    setInput("");
    setError(null);
    setStreaming("");

    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const reply = await streamCoachReply({
        settings,
        history,
        signal: ac.signal,
        onText: (d) => setStreaming((s) => (s ?? "") + d),
      });
      if (reply.refused) {
        setThread(before);
        setInput(q);
        setError("이 질문에는 답변이 거절됐어요. 표현을 바꿔서 다시 물어봐 주세요.");
        return;
      }
      const next: Thread = {
        spot,
        history: [...history, { role: "assistant", content: reply.content }],
        display: [...display, { role: "assistant", text: reply.text }],
        updatedAt: Date.now(),
      };
      setThread(next);
      saveThread(next);
    } catch (err) {
      // Nothing was saved for this turn; put the question back so it can be retried.
      setThread(before);
      setInput(q);
      if (!isAbort(err)) setError(describeError(err));
    } finally {
      abortRef.current = null;
      setStreaming(null);
    }
  }

  function reset() {
    abortRef.current?.abort();
    deleteThread(spot.id);
    setThread({ spot, history: [], display: [], updatedAt: 0 });
    setError(null);
    autoSent.current = false;
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="AI 코치">
        <header className="sheet-head">
          <div>
            <div className="sheet-title">AI 코치</div>
            <div className="sheet-sub">{spot.title}</div>
          </div>
          <div className="sheet-actions">
            {thread.display.length > 0 && (
              <button className="ghost small" onClick={reset} disabled={busy}>
                새 대화
              </button>
            )}
            <button className="ghost small" onClick={onClose} aria-label="닫기">
              닫기
            </button>
          </div>
        </header>

        <div className="sheet-body">
          <details className="spot-facts">
            <summary>코치에게 전달된 스팟 정보</summary>
            <pre>{spot.facts}</pre>
          </details>

          {!settings.apiKey && (
            <div className="notice">
              AI 해설을 쓰려면 Anthropic API 키가 필요해요.
              <button className="primary small" onClick={onNeedKey}>
                설정으로 이동
              </button>
            </div>
          )}

          {thread.display.map((m, i) => (
            <div key={i} className={`msg msg-${m.role}`}>
              {m.role === "assistant" ? <Markdown text={m.text} /> : m.text}
            </div>
          ))}

          {streaming !== null && (
            <div className="msg msg-assistant">
              {streaming ? <Markdown text={streaming} /> : <span className="thinking">생각하는 중…</span>}
            </div>
          )}

          {error && <div className="notice error">{error}</div>}

          {!busy && thread.display.length > 0 && (
            <div className="chips">
              {FOLLOW_UPS.map((f) => (
                <button key={f} className="chip" onClick={() => send(f)}>
                  {f}
                </button>
              ))}
            </div>
          )}

          {!busy && thread.display.length === 0 && settings.apiKey && (
            <div className="chips">
              <button className="chip" onClick={() => send(spot.defaultQuestion)}>
                {spot.defaultQuestion}
              </button>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        <form
          className="sheet-input"
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="궁금한 걸 물어보세요"
            rows={1}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send(input);
              }
            }}
          />
          {busy ? (
            <button type="button" className="ghost" onClick={() => abortRef.current?.abort()}>
              중단
            </button>
          ) : (
            <button type="submit" className="primary" disabled={!input.trim()}>
              보내기
            </button>
          )}
        </form>
        <div className="sheet-foot">{modelLabel} · 답변은 학습 보조용이에요</div>
      </div>
    </div>
  );
}

function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}
