import { useSyncExternalStore } from "react";
import { cleanFastState, fastOtherStore, fastStore, forgetHands } from "./fastLog";
import { restackAll } from "./fastTourney";
import { deleteHands, handLogStore, undoDeletion, type Deletion } from "./handLog";

/**
 * Deleting hands with 되돌리기: the hands go at once, and a toast at the bottom offers them back for a
 * few seconds, exactly as they were (deleteHands / undoDeletion in handLog.ts do the work). The toast's
 * note lives here, outside any screen, so it survives the trip back to the list after deleting the hand
 * on screen. Nothing here is stored: a reload ends the offer, the deletion stays.
 */

/** How long 되돌리기 is offered after a delete. */
export const UNDO_MS = 6000;

export interface UndoNote {
  /** Changes with every note, so a timer only ever closes its own. */
  key: number;
  text: string;
  /** What 되돌리기 puts back; null for a note without the button ("되돌렸어요"). */
  deletion: Deletion | null;
  /** When it goes (ms). */
  until: number;
  error?: boolean;
}

let note: UndoNote | null = null;
let seq = 0;
const listeners = new Set<() => void>();
const get = () => note;
function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}
function show(n: UndoNote | null) {
  note = n;
  listeners.forEach((l) => l());
}

/** The toast's note right now (null: none). */
export const undoNote = get;
export const useUndoNote = (): UndoNote | null => useSyncExternalStore(subscribe, get, get);

/**
 * Delete the hands `ids` and offer them back: a correction of one of them on 빠른 기록 / 남의 핸드 gives
 * way to the new hand put aside. The hands by 스택 after them in their tournaments are worked out again in
 * the same write (restack). Returns how many were deleted (0: none of them was on file).
 */
export function deleteWithUndo(ids: Iterable<string>, now: number = Date.now()): number {
  const drop = new Set(ids);
  const tns = handLogStore.get().hands.filter((h) => drop.has(h.id)).map((h) => h.tourney);
  const d = deleteHands(drop, (s) => restackAll(s, tns, now));
  if (!d) return 0;
  const gone = d.removed.map((r) => r.hand.id);
  for (const store of [fastStore, fastOtherStore]) {
    const raw = store.get();
    // An editor never opened has nothing to let go of (and its first visit keeps its own defaults).
    if (!raw.draft) continue;
    const s = cleanFastState(raw);
    const next = forgetHands(s, gone);
    if (next !== s) store.set(next);
  }
  show({ key: ++seq, text: `${gone.length}개 삭제했어요`, deletion: d, until: now + UNDO_MS });
  return gone.length;
}

/** 되돌리기: the last deletion back in place. False if there was none to undo, or the browser refused to store it. */
export function undoLast(now: number = Date.now()): boolean {
  const d = note?.deletion;
  if (!d) return false;
  // Back in place, the hands by 스택 after them work from them again.
  const ok = undoDeletion(d, (s) => restackAll(s, d.removed.map((r) => r.hand.tourney), now));
  show(
    ok
      ? { key: ++seq, text: "되돌렸어요", deletion: null, until: now + 1800 }
      : { key: ++seq, text: "되돌렸지만 저장 공간이 꽉 차서 저장하지 못했어요. 백업해 주세요.", deletion: null, until: now + UNDO_MS, error: true },
  );
  return ok;
}

/**
 * A new hand was just saved: the 되돌리기 offer (if any) closes, so it can't be mistaken for the
 * 되돌리기 next to that hand's verdict (which reopens the new hand, not the deleted one). A note
 * without the button (e.g. the storage-full warning) stays until its time is up.
 */
export function closeUndoOffer(): void {
  if (note?.deletion) show(null);
}

/** The note `key` is over (its time is up): it goes, unless a newer one took its place. */
export function dismissUndo(key: number): void {
  if (note?.key === key) show(null);
}
