import { createStore } from "./store";

export type Effort = "low" | "medium" | "high";

export interface ModelOption {
  id: string;
  label: string;
  note: string;
  /** Server-side refusal fallback (`fallbacks: "default"`) is available. */
  fallback: boolean;
}

export const MODEL_OPTIONS: ModelOption[] = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", note: "기본값 · 해설 품질 최고", fallback: true },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", note: "빠르고 저렴", fallback: true },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", note: "가장 저렴 · 간단한 질문용", fallback: false },
];

/** server: Vercel 함수가 서버에 등록된 키로 중계 / own: 이 기기에 저장한 키로 직접 호출 */
export type KeyMode = "server" | "own";

/**
 * The deck's colors. "four" is the online standard (♠ black, ♥ red, ♦ blue, ♣ green), so no two
 * suits look alike; "two" is a real deck (♠♣ black, ♥♦ red).
 */
export type CardColors = "four" | "two";

export interface Settings {
  keyMode: KeyMode;
  /** keyMode "server"이고 Vercel에 APP_PASSCODE를 등록한 경우에만 필요 */
  passcode: string;
  apiKey: string;
  model: string;
  effort: Effort;
  /** 사용자가 직접 추가하는 해설 노트 (시스템 프롬프트에 함께 들어감) */
  userNotes: string;
  /** 차트·퀴즈에 쓸 차트 세트 (src/data/sets) */
  chartSet: string;
  /** 핸드 플레이 모드: 펍아재 토너먼트 or 6맥스 100bb 캐시 */
  playMode: "pub" | "cash";
  /** 카드 색: 4색 (온라인 표준) or 2색 (실물 카드); read it through cardColorsOf. */
  cardColors: CardColors;
}

export const settingsStore = createStore<Settings>("mygto.settings", {
  keyMode: "server",
  passcode: "",
  apiKey: "",
  model: "claude-opus-5-5",
  effort: "medium",
  userNotes: "",
  chartSet: "pub",
  playMode: "pub",
  cardColors: "four",
});

export const useSettings = settingsStore.use;

export function isCoachConfigured(s: Settings): boolean {
  // Server mode works without a passcode when APP_PASSCODE isn't set on Vercel.
  return s.keyMode === "server" || s.apiKey.length > 0;
}

export const CARD_COLOR_OPTIONS: { id: CardColors; label: string; note: string }[] = [
  { id: "four", label: "4색 (온라인 표준)", note: "무늬마다 색이 달라서 한눈에 구분돼요." },
  { id: "two", label: "2색 (실물 카드)", note: "실물 카드처럼 검정과 빨강 두 색이에요." },
];

/** The stored value as a deck: anything but "two" (missing in settings saved before it existed, or broken) is 4색. */
export function cardColorsOf(value: unknown): CardColors {
  return value === "two" ? "two" : "four";
}

/** The attribute on <html> that styles.css reads for every card's suit colors. */
export const CARD_COLORS_ATTR = "data-card-colors";

type AttrTarget = Pick<Element, "getAttribute" | "setAttribute">;

/** Puts the deck's colors on the page root (only when they changed, so other settings never restyle the page). */
export function applyCardColors(root: AttrTarget, s: Pick<Settings, "cardColors"> = settingsStore.get()): void {
  const value = cardColorsOf(s.cardColors);
  if (root.getAttribute(CARD_COLORS_ATTR) !== value) root.setAttribute(CARD_COLORS_ATTR, value);
}

/**
 * Call once at startup, before the first render: colors the cards from the saved setting, then
 * again whenever it changes. Returns the unsubscribe.
 */
export function startCardColors(): () => void {
  if (typeof document === "undefined") return () => {};
  const root = document.documentElement;
  const apply = () => applyCardColors(root);
  apply();
  const stop = settingsStore.subscribe(apply);
  return () => void stop();
}
