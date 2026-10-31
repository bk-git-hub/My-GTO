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

export interface Settings {
  apiKey: string;
  model: string;
  effort: Effort;
  /** 사용자가 직접 추가하는 해설 노트 (시스템 프롬프트에 함께 들어감) */
  userNotes: string;
}

export const settingsStore = createStore<Settings>("mygto.settings", {
  apiKey: "",
  model: "claude-opus-5-5",
  effort: "medium",
  userNotes: "",
});

export const useSettings = settingsStore.use;
