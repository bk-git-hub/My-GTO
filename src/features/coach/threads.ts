import { createStore } from "../../state/store";
import type { CoachMessage } from "./client";
import type { SpotContext } from "./prompt";

export interface DisplayMessage {
  role: "user" | "assistant";
  text: string;
}

export interface Thread {
  spot: SpotContext;
  /** Exact API history (assistant turns keep their thinking blocks). */
  history: CoachMessage[];
  display: DisplayMessage[];
  updatedAt: number;
}

const MAX_THREADS = 40;

export const threadsStore = createStore<{ threads: Record<string, Thread> }>("mygto.coach", { threads: {} });

export function saveThread(thread: Thread) {
  threadsStore.set((s) => {
    const threads = { ...s.threads, [thread.spot.id]: { ...thread, updatedAt: Date.now() } };
    const ids = Object.keys(threads).sort((a, b) => threads[b].updatedAt - threads[a].updatedAt);
    for (const id of ids.slice(MAX_THREADS)) delete threads[id];
    return { threads };
  });
}

export function deleteThread(id: string) {
  threadsStore.set((s) => {
    const threads = { ...s.threads };
    delete threads[id];
    return { threads };
  });
}
