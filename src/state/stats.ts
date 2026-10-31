import { createStore } from "./store";

export interface Tally {
  attempts: number;
  correct: number;
}

export interface Stats {
  byKey: Record<string, Tally>;
  streak: number;
  bestStreak: number;
}

export const statsStore = createStore<Stats>("mygto.stats", { byKey: {}, streak: 0, bestStreak: 0 });
export const useStats = statsStore.use;

/** Record a quiz answer under one or more keys (e.g. "preflop", "preflop:bb-vs-btn"). */
export function recordAnswer(keys: string[], correct: boolean) {
  statsStore.set((s) => {
    const byKey = { ...s.byKey };
    for (const k of keys) {
      const t = byKey[k] ?? { attempts: 0, correct: 0 };
      byKey[k] = { attempts: t.attempts + 1, correct: t.correct + (correct ? 1 : 0) };
    }
    const streak = correct ? s.streak + 1 : 0;
    return { byKey, streak, bestStreak: Math.max(s.bestStreak, streak) };
  });
}

export function accuracy(t?: Tally): string {
  if (!t || t.attempts === 0) return "-";
  return `${Math.round((t.correct / t.attempts) * 100)}%`;
}
