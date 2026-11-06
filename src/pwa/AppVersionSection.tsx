import { applyUpdate, checkForUpdate, useUpdateState, type UpdateStatus } from "./update";
import { APP_VERSION, formatKst } from "./version";
import "./pwa.css";

const STATUS: Record<UpdateStatus, { text: string; tone: string }> = {
  unsupported: { text: "이 환경에선 업데이트를 확인할 수 없어요", tone: "muted" },
  idle: { text: "아직 확인 전이에요", tone: "muted" },
  checking: { text: "확인 중…", tone: "muted" },
  latest: { text: "최신 버전이에요", tone: "ok-text" },
  downloading: { text: "새 버전 받는 중…", tone: "pwa-accent" },
  ready: { text: "업데이트 준비됨", tone: "pwa-accent" },
  applying: { text: "업데이트하는 중…", tone: "pwa-accent" },
  offline: { text: "오프라인이라 확인 못 했어요", tone: "muted" },
  error: { text: "확인 못 했어요. 잠시 후 다시 해 보세요", tone: "err-text" },
};

/** Settings section: running version, update state and a manual check. */
export function AppVersionSection() {
  const { status, checkedAt } = useUpdateState();
  const { text, tone } = STATUS[status];
  const busy = status === "unsupported" || status === "checking" || status === "downloading" || status === "applying";
  const checked = formatKst(checkedAt);
  return (
    <section className="card-box">
      <h2>앱 버전</h2>
      <dl className="pwa-facts">
        <dt>버전</dt>
        <dd>
          <code data-testid="app-version">{APP_VERSION}</code>
        </dd>
        <dt>상태</dt>
        <dd className={tone} data-testid="update-status">
          {text}
        </dd>
        {checked && (
          <>
            <dt>마지막 확인</dt>
            <dd>{checked}</dd>
          </>
        )}
      </dl>
      <div className="row-gap wrap">
        {(status === "ready" || status === "applying") && (
          <button className="primary small" onClick={() => void applyUpdate()} disabled={status === "applying"}>
            지금 업데이트
          </button>
        )}
        <button className="ghost small" onClick={() => void checkForUpdate("manual")} disabled={busy}>
          {status === "checking" ? "확인 중…" : "업데이트 확인"}
        </button>
      </div>
      <p className="muted small">그래도 예전 화면 그대로면 앱을 완전히 닫았다가 다시 열어 주세요.</p>
    </section>
  );
}
