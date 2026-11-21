import { runBots, type LoadKey, type PlayState, type TableCtx } from "../../play/table";

/**
 * Runs a hand on after runBots stopped for data (`s.needs`): load it, run the bots again, at most three times. A load
 * that fails, times out or throws marks the hand (`post.failed`) and it goes on with the approximate rules; so does a
 * run of the bots that throws on the loaded data (a malformed pack), so the hand never stays stuck waiting. Null when
 * the hand was replaced meanwhile (새 핸드, 다시 이 상황): `isCurrent` says whether the result is still wanted.
 */
export async function advance(
  s: PlayState,
  src: { load(key: LoadKey, timeoutMs?: number): Promise<boolean> },
  ctx: TableCtx,
  isCurrent: () => boolean,
  timeoutMs?: number,
): Promise<PlayState | null> {
  const failed = (st: PlayState, kind: LoadKey["kind"]): PlayState => ({ ...st, needs: undefined, post: { match: st.post?.match ?? null, failed: kind } });
  // The bots once more; if they throw, the same state marked failed (the oracle then reads no pack at all).
  const run = (st: PlayState, kind: LoadKey["kind"]): PlayState => {
    try {
      return runBots(st, ctx);
    } catch {
      return runBots(failed(st, kind), ctx);
    }
  };
  let cur = s;
  for (let n = 0; cur.needs && n < 3; n++) {
    const key = cur.needs;
    let ok = false;
    try {
      ok = await src.load(key, timeoutMs);
    } catch {
      ok = false;
    }
    if (!isCurrent()) return null;
    cur = run(ok ? { ...cur, needs: undefined } : failed(cur, key.kind), key.kind);
  }
  if (cur.needs) cur = run(failed(cur, cur.needs.kind), cur.needs.kind);
  return cur;
}
