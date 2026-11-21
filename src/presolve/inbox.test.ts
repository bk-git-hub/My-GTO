import { describe, expect, it } from "vitest";
import { FLOPS_BY_PRIORITY } from "./flops";
import { packFilePath } from "./format";
import {
  ACTIVE_MS,
  activeWorkers,
  HEADROOM_BYTES,
  heartbeatPath,
  inboxFlops,
  inboxPath,
  inboxRemovals,
  isSummariesPath,
  MEMORY_MARGIN,
  otherSolvers,
  parseHeartbeat,
  parseInboxFlop,
  parseSkipList,
  physicalCoresFromSiblings,
  planInbox,
  skipList,
  solveSlots,
  summariesPath,
  workerShard,
  workflowSelection,
  type Heartbeat,
} from "./inbox";
import { ALL_SCENARIOS, getScenario } from "./scenarios";
import { jobQueue, shardFlops } from "./shard";

// No @types/node here: reach node:fs through an untyped handle (as calibration.test.ts does).
const fs = (await import(/* @vite-ignore */ "node:fs" as string)) as { readFileSync(path: URL, encoding: "utf8"): string };

const S = "0123456789abcdef0123456789abcdef01234567";
const OLD = "fedcba9876543210fedcba9876543210fedcba98";
const GB = 2 ** 30;

describe("packs-inbox layout", () => {
  it("puts each set's flops under the solver commit and reads them back", () => {
    const app = inboxPath(S, "app", "sv-srp-btn-bb-55/v1/flop-Qs8h5h.json");
    const cal = inboxPath(S, "calibration", "cal-srp-btn-bb-35/v1/flop-2c2d2h.json");
    expect(app).toBe(`${S}/files/sv-srp-btn-bb-55/v1/flop-Qs8h5h.json`);
    expect(cal).toBe(`${S}/cal-files/cal-srp-btn-bb-35/v1/flop-2c2d2h.json`);
    expect(parseInboxFlop(app)).toEqual({ inboxPath: app, solver: S, set: "app", path: "sv-srp-btn-bb-55/v1/flop-Qs8h5h.json", pack: "sv-srp-btn-bb-55", version: 1, board: "Qs8h5h" });
    expect(parseInboxFlop(cal)?.set).toBe("calibration");
    for (const bad of [
      `${S}/summaries/abcd-20261121T120000Z.json`,
      `${S.slice(0, 7)}/files/sv-srp-btn-bb-55/v1/flop-Qs8h5h.json`, // abbreviated solver commit
      `${S}/files/sv-srp-btn-bb-55/v1/flop-Qs8h5.json`,
      `${S}/files/sv-srp-btn-bb-55/flop-Qs8h5h.json`,
      `${S}/other/sv-srp-btn-bb-55/v1/flop-Qs8h5h.json`,
      "workers/0123456789abcdef.json",
      "README.md",
    ])
      expect(parseInboxFlop(bad), bad).toBeNull();
  });

  it("lists one solver commit's flops and the other solver commits", () => {
    const paths = [
      inboxPath(S, "app", "a-pack/v1/flop-Qs8h5h.json"),
      inboxPath(S, "calibration", "c-pack/v2/flop-2c2d2h.json"),
      inboxPath(OLD, "app", "a-pack/v1/flop-Kd7h2c.json"),
      `${S}/summaries/abcd-20261121T120000Z.json`,
      "workers/0123456789abcdef.json",
      "README.md",
    ];
    expect(inboxFlops(paths, S).map((f) => f.path)).toEqual(["a-pack/v1/flop-Qs8h5h.json", "c-pack/v2/flop-2c2d2h.json"]);
    expect(otherSolvers(paths, S)).toEqual([OLD]);
  });

  it("names a batch's summaries file by worker and UTC time", () => {
    const p = summariesPath(S, "0123456789abcdef", new Date("2026-11-21T12:34:56.789Z"));
    expect(p).toBe(`${S}/summaries/0123456789abcdef-20261121T123456Z.json`);
    expect(isSummariesPath(p, S)).toBe(true);
    expect(isSummariesPath(p, OLD)).toBe(false);
    expect(isSummariesPath(`${S}/summaries/x/y.json`, S)).toBe(false);
    expect(isSummariesPath(inboxPath(S, "app", "a/v1/flop-Qs8h5h.json"), S)).toBe(false);
  });
});

describe("skipping the inbox's flops", () => {
  it("writes and reads a skip list of pack paths only", () => {
    const text = skipList(["b-pack/v1/flop-Qs8h5h.json", "a-pack/v2/flop-2c2d2h.json", "b-pack/v1/flop-Qs8h5h.json", "README.md"]);
    expect(text).toBe("a-pack/v2/flop-2c2d2h.json\nb-pack/v1/flop-Qs8h5h.json\n");
    expect(skipList([])).toBe("");
    // CRLF (a list edited on Windows), comments and junk are tolerated.
    expect([...parseSkipList(`# done\r\n${text.replace(/\n/g, "\r\n")}\r\n  \r\nnot a path\r\n`)]).toEqual(["a-pack/v2/flop-2c2d2h.json", "b-pack/v1/flop-Qs8h5h.json"]);
  });

  it("drops the skipped flops from the reverse queue as from the forward one, so both ends skip the same flops", () => {
    const packs = [getScenario("sv-3bp-bb-btn-35"), getScenario("cal-lp-sb-bb-100-o3")];
    const flops = FLOPS_BY_PRIORITY.slice(0, 6);
    const inInbox = new Set([packFilePath(packs[1].id, packs[1].version, flops[5].key), packFilePath(packs[0].id, packs[0].version, flops[0].key)]);
    const lists = packs.map((sc) => ({ queue: sc.queue, jobs: flops.filter((f) => !inInbox.has(packFilePath(sc.id, sc.version, f.key))).map((f) => `${sc.id} ${f.key}`) }));
    const forward = jobQueue(lists);
    const back = jobQueue(lists, "reverse");
    expect(back).toEqual([...forward].reverse());
    expect(forward).toHaveLength(10);
    // The app pack (queue −2) comes first, the calibration queue's last pack (41) last: a worker starts there.
    expect(forward[0]).toBe(`sv-3bp-bb-btn-35 ${flops[1].key}`);
    expect(back[0]).toBe(`cal-lp-sb-bb-100-o3 ${flops[4].key}`);
    for (const j of [`${packs[1].id} ${flops[5].key}`, `${packs[0].id} ${flops[0].key}`]) expect(forward).not.toContain(j);
  });
});

describe("what the merge takes and removes", () => {
  const packs = [
    { id: "a-pack", set: "app" as const, version: 2 },
    { id: "c-pack", set: "calibration" as const, version: 1 },
    { id: "other", set: "app" as const, version: 1 },
  ];
  const f = (set: "app" | "calibration", path: string) => parseInboxFlop(inboxPath(S, set, path))!;
  const current = f("app", "a-pack/v2/flop-Qs8h5h.json");
  const older = f("app", "a-pack/v1/flop-Qs8h5h.json");
  const newer = f("app", "a-pack/v3/flop-Qs8h5h.json");
  const unknown = f("app", "new-pack/v1/flop-Qs8h5h.json");
  const wrongSet = f("calibration", "a-pack/v2/flop-Kd7h2c.json");
  const cal = f("calibration", "c-pack/v1/flop-2c2d2h.json");
  const notCovered = f("app", "other/v1/flop-Qs8h5h.json");

  it("takes the covered packs at the code's version and leaves newer ones for a later run", () => {
    const plan = planInbox([current, older, newer, unknown, wrongSet, cal, notCovered], packs, new Set(["a-pack", "c-pack"]));
    expect(plan.take).toEqual([current, cal]);
    expect(plan.stale).toEqual([older, wrongSet]);
    expect(plan.later).toEqual([newer, unknown, notCovered]);
  });

  it("removes the published, the stale, the older solver's and the summaries left without flops; never a later push", () => {
    const summaries = [
      { inboxPath: `${S}/summaries/w1-20261121T120000Z.json`, files: [{ set: "app", path: current.path }, { set: "calibration", path: cal.path }] },
      { inboxPath: `${S}/summaries/w2-20261121T130000Z.json`, files: [{ set: "app", path: current.path }, { set: "app", path: newer.path }] },
    ];
    const paths = [current, older, newer, cal, ...summaries].map((x) => x.inboxPath).concat([`${OLD}/files/a-pack/v2/flop-Kd7h2c.json`, `${OLD}/summaries/w1-x.json`, "workers/w1.json", "README.md"]);
    const base = { paths, solver: S, taken: [current, cal], stale: [older], olderSolvers: new Set([OLD]), summaries };
    // Only the app file got published (e.g. a calibration-only master push failed): the calibration file stays.
    const some = inboxRemovals({ ...base, published: (x) => x === current, rejected: false });
    expect(some).toEqual([current.inboxPath, older.inboxPath, `${OLD}/files/a-pack/v2/flop-Kd7h2c.json`, `${OLD}/summaries/w1-x.json`].sort());
    const all = inboxRemovals({ ...base, published: () => true, rejected: false });
    expect(all).toEqual([current.inboxPath, older.inboxPath, cal.inboxPath, summaries[0].inboxPath, `${OLD}/files/a-pack/v2/flop-Kd7h2c.json`, `${OLD}/summaries/w1-x.json`].sort());
    // Rejected by the checks: every taken file goes, published or not, so the flops get solved again.
    expect(inboxRemovals({ ...base, published: () => false, rejected: true })).toEqual(all);
    // The newer version's file, the heartbeat and the README are never touched; neither is a path not on the read head.
    for (const keep of [newer.inboxPath, summaries[1].inboxPath, "workers/w1.json", "README.md"]) expect(all).not.toContain(keep);
    expect(inboxRemovals({ ...base, paths: paths.filter((p) => p !== cal.inboxPath), published: () => true, rejected: false })).not.toContain(cal.inboxPath);
  });
});

describe("splitting the back of the queue between workers", () => {
  const now = Date.parse("2026-11-21T12:00:00Z");
  const beat = (id: string, agoMin: number, extra: Partial<Heartbeat> = {}): Heartbeat => ({ v: 1, id, slots: 4, updatedAt: new Date(now - agoMin * 60_000).toISOString(), ...extra });

  it("reads heartbeats and rejects anything else", () => {
    expect(parseHeartbeat(JSON.stringify(beat("0123456789abcdef", 5)))).toEqual(beat("0123456789abcdef", 5));
    expect(parseHeartbeat(JSON.stringify({ ...beat("0123456789abcdef", 5), stopped: true }))?.stopped).toBe(true);
    for (const bad of ["", "{", JSON.stringify({ v: 2, id: "0123456789abcdef", updatedAt: "2026-11-21T12:00:00Z" }), JSON.stringify({ v: 1, id: "Mallory's laptop", updatedAt: "2026-11-21T12:00:00Z" }), JSON.stringify({ v: 1, id: "0123456789abcdef", updatedAt: "soon" })])
      expect(parseHeartbeat(bad), bad).toBeNull();
    expect(heartbeatPath("0123456789abcdef")).toBe("workers/0123456789abcdef.json");
  });

  it("counts live workers only: not expired, not stopped, not from a clock far in the future", () => {
    const beats = [beat("bbbb0000bbbb0000", 10), beat("cccc0000cccc0000", ACTIVE_MS / 60_000 + 1), beat("dddd0000dddd0000", 1, { stopped: true }), beat("eeee0000eeee0000", -600)];
    expect(activeWorkers(beats, "aaaa0000aaaa0000", now)).toEqual(["aaaa0000aaaa0000", "bbbb0000bbbb0000"]);
    expect(activeWorkers([], "aaaa0000aaaa0000", now)).toEqual(["aaaa0000aaaa0000"]);
    expect(workerShard(["aaaa0000aaaa0000", "bbbb0000bbbb0000"], "bbbb0000bbbb0000")).toEqual({ index: 1, count: 2 });
    expect(workerShard(["aaaa0000aaaa0000"], "aaaa0000aaaa0000")).toEqual({ index: 0, count: 1 });
  });

  it("gives every flop of the back to exactly one worker", () => {
    const ids = activeWorkers([beat("bbbb0000bbbb0000", 3), beat("cccc0000cccc0000", 20)], "aaaa0000aaaa0000", now);
    const parts = ids.map((id) => shardFlops(FLOPS_BY_PRIORITY, 1755, workerShard(ids, id)).map((f) => f.key));
    const all = parts.flat();
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(1755);
  });
});

describe("how many solves at once", () => {
  it("is one per physical core while the RAM after 3 GB holds them", () => {
    // Dell XPS 9570 (6 cores), the back of the queue (~1.4 GB estimate × 1.25 a flop).
    const perFlop = 1.39e9 * MEMORY_MARGIN;
    expect(solveSlots({ physicalCores: 6, totalBytes: 16 * GB, perFlopBytes: perFlop })).toBe(6);
    expect(solveSlots({ physicalCores: 6, totalBytes: 32 * GB, perFlopBytes: perFlop })).toBe(6);
    expect(solveSlots({ physicalCores: 6, totalBytes: 8 * GB, perFlopBytes: perFlop })).toBe(3); // 5 GB left / 1.74 GB
    // Oracle's free ARM tier: 2 OCPU (2 cores, no SMT), 12 GB.
    expect(solveSlots({ physicalCores: 2, totalBytes: 12 * GB, perFlopBytes: perFlop })).toBe(2);
    // Never 0: a machine too small for two still solves one at a time.
    expect(solveSlots({ physicalCores: 4, totalBytes: 4 * GB, perFlopBytes: perFlop })).toBe(1);
    expect(solveSlots({ physicalCores: 4, totalBytes: 2 * GB, perFlopBytes: perFlop })).toBe(1);
    // Nothing to estimate (empty queue): the cores.
    expect(solveSlots({ physicalCores: 4, totalBytes: 16 * GB, perFlopBytes: 0 })).toBe(4);
    expect(solveSlots({ physicalCores: 6, totalBytes: 16 * GB, perFlopBytes: 2e9, headroomBytes: 10 * GB })).toBe(3);
    expect(HEADROOM_BYTES).toBe(3 * GB);
  });

  it("counts physical cores from Linux's sibling lists", () => {
    // 6 cores × 2 threads (the XPS's i7-8750H) and 2 cores without SMT (Ampere A1).
    const ht = Array.from({ length: 12 }, (_, cpu) => `${cpu % 6},${(cpu % 6) + 6}\n`);
    expect(physicalCoresFromSiblings(ht)).toBe(6);
    expect(physicalCoresFromSiblings(["0\n", "1\n"])).toBe(2);
    expect(physicalCoresFromSiblings(["", ""])).toBeNull();
  });
});

describe("the workflow's selection", () => {
  it("is read from presolve.yml's fallbacks, which must all agree", () => {
    const yml = fs.readFileSync(new URL("../../.github/workflows/presolve.yml", import.meta.url), "utf8");
    const sel = workflowSelection(yml);
    expect(sel.scenario === "all" || sel.scenario.split(",").every((id) => ALL_SCENARIOS.some((s) => s.id === id))).toBe(true);
    expect(sel.count).toBeGreaterThan(0);
    expect(workflowSelection("SCENARIO: ${{ inputs.scenario || 'a,b' }}\nCOUNT: ${{ inputs.count || '3' }}")).toEqual({ scenario: "a,b", count: 3 });
    expect(() => workflowSelection("${{ inputs.scenario || 'all' }} ${{ inputs.scenario || 'x' }} ${{ inputs.count || '3' }}")).toThrow(/disagree/);
    expect(() => workflowSelection("${{ inputs.scenario || 'all' }}")).toThrow(/count/);
    expect(() => workflowSelection("${{ inputs.scenario || 'all' }} ${{ inputs.count || 'many' }}")).toThrow(/count/);
  });
});
