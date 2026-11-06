/** Short hash of the running build's sources ("dev" when unknown). */
export const APP_VERSION: string = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";

const KST_OFFSET_MS = 9 * 60 * 60 * 1000; // Korea has no daylight saving time

/** "11월 6일 오후 3:12" in Korea time, or "" for a missing time. */
export function formatKst(t: number | null): string {
  if (t === null || !Number.isFinite(t)) return "";
  const d = new Date(t + KST_OFFSET_MS);
  const hour = d.getUTCHours();
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const minute = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일 ${hour < 12 ? "오전" : "오후"} ${h12}:${minute}`;
}
