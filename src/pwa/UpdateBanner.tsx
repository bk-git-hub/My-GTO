import { applyUpdate, dismissBanner, useUpdateState } from "./update";
import "./pwa.css";

/** Bottom banner shown while a new version waits. */
export function UpdateBanner() {
  const { status, dismissed } = useUpdateState();
  if ((status !== "ready" && status !== "applying") || dismissed) return null;
  const applying = status === "applying";
  return (
    <>
      {/* Lets the end of the page scroll clear of the banner. */}
      <div className="pwa-banner-spacer" aria-hidden="true" />
      <div className="pwa-banner" role="status">
        <span className="pwa-banner-text">새 버전이 있어요</span>
        <button className="primary small" onClick={() => void applyUpdate()} disabled={applying}>
          {applying ? "업데이트 중…" : "업데이트"}
        </button>
        <button className="pwa-banner-close" onClick={dismissBanner} disabled={applying} aria-label="닫기">
          ×
        </button>
      </div>
    </>
  );
}
