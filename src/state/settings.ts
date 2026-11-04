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
}

export const settingsStore = createStore<Settings>("mygto.settings", {
  keyMode: "server",
  passcode: "",
  apiKey: "",
  model: "claude-opus-5-5",
  effort: "medium",
  userNotes: "",
  chartSet: "pub",
});

export const useSettings = settingsStore.use;

export function isCoachConfigured(s: Settings): boolean {
  // Server mode works without a passcode when APP_PASSCODE isn't set on Vercel.
  return s.keyMode === "server" || s.apiKey.length > 0;
}
