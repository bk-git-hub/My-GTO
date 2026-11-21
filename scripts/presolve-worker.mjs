// Presolve worker: lends a computer's idle cores to the solver chart packs. It solves the presolve workflow's queue
// (.github/workflows/presolve.yml) from the back while the workflow's shards solve it from the front, and pushes what it
// solved to the packs-inbox branch, where the workflow's next merge takes it in with the same checks as a shard's files.
// Setup for Windows and Linux (Korean): docs/worker-setup.md.
//
// Usage: node scripts/presolve-worker.mjs [options]       (from a clone of the repository with `npm ci` done)
//   --workers <n>         solves at once (default: one per physical core, fewer when they don't fit in the RAM left
//                         after 3 GB for the rest of the machine at the next flops' memory estimate)
//   --max-mb <mb>         skip flops whose memory estimate is above this (default 2000, as the workflow)
//   --batch-minutes <m>   push the finished flops at least this often (default 30)
//   --batch-flops <n>     ... or as soon as this many are finished (default 20)
//   --idle-minutes <m>    with nothing to solve, look again after this long (default 60)
//   --once                stop once nothing is left to solve instead of waiting for more
//   --remote <name>       the git remote of the repository (default origin); --branch <name>: its main branch (master)
//   --state <dir>         where the worker keeps its files (default .presolve-worker in the clone, git-ignored)
//   --scenario <ids>, --count <n>   solve another selection than the workflow's (tests and experiments only: the merge
//                         takes only the packs its own run covers)
//
// What it does, in a loop:
//   1. Fetches master. The checkout must be master with no local edits; it is fast-forwarded when the code the solve
//      depends on changed (npm ci when package-lock.json changed; the worker restarts itself when its own code did).
//      It solves with exactly master's solver commit: presolve.mjs --publish refuses a dirty or unnamed solver.
//   2. Reads what is done, without downloading flop files: packs-data's tree (a shallow, blobless clone in the state
//      directory, sparse with the catalog and indexes), master's calibration/packs and the packs-inbox branch (the flops
//      of the same solver commit). The same selection as the workflow's scheduled runs (presolve.yml's fallbacks of
//      inputs.scenario and inputs.count; the calibration packs only while there is no packs-data branch).
//   3. Runs scripts/presolve.mjs --order reverse on that queue with the done flops as --skip-from: the shards take the
//      queue front to back, the worker back to front, so nothing is claimed and the two only meet at the end. Several
//      workers split the back between them through heartbeats on the branch (workers/<id>.json: worker i of n takes
//      the flops whose priority index is i mod n, presolve.mjs --shard), so they don't solve the same flops either.
//   4. Every --batch-minutes or --batch-flops it fetches master again: a new solver commit stops the run, drops what
//      was not pushed yet (files of an old solver are never pushed) and starts over on the new code; other changes to
//      the pipeline push first, then start over. Otherwise it pushes the finished flops and their exact summaries as one
//      commit on packs-inbox (with its heartbeat) and rewrites the skip list, which the running presolve re-reads.
//
// Resources: the process and everything it starts run at the lowest priority (os.setPriority), so the machine stays
// usable; solves start only while their memory estimates fit in the RAM minus 3 GB (presolve.mjs --reserve-mb).
// Ctrl+C stops cleanly: unfinished solves write nothing, finished flops are pushed first (Ctrl+C again quits at once;
// what wasn't pushed is pushed at the next start if the solver is still the same).
//
// Git: the machine's own credentials (on Windows, Git Credential Manager's browser login at the first push); no token
// is read from or written to any file by this script. Pushes are plain fast-forwards: when another worker or the merge
// pushed in between, the commit is redone on the new head (scripts/inbox.mjs); nothing is ever force-pushed. The commits
// carry the worker's random id (made once, in <state>/id) and nothing about the machine or its owner.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { load } from "./equity-cache.mjs";
import { commitToBranch, fetchHead, git, INBOX_README, INBOX_VERCEL, readBlob, treePaths } from "./inbox.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const PRESOLVE = join(root, "scripts", "presolve.mjs");
/** What the solve depends on: a change here (test files aside) restarts the queue; src/solver also names the solver commit. */
const CODE_PATHS = [
  "src/solver",
  "src/presolve",
  "scripts/presolve.mjs",
  "scripts/presolve-worker.mjs",
  "scripts/inbox.mjs",
  "scripts/equity-cache.mjs",
  ".github/workflows/presolve.yml",
  "package-lock.json",
];
/** The worker's own modules (imported once): when these change the process restarts itself. */
const SELF_PATHS = ["scripts/presolve-worker.mjs", "scripts/inbox.mjs", "scripts/equity-cache.mjs"];

const { values: opt } = parseArgs({
  options: {
    workers: { type: "string" },
    "max-mb": { type: "string", default: "2000" },
    "batch-minutes": { type: "string", default: "30" },
    "batch-flops": { type: "string", default: "20" },
    "idle-minutes": { type: "string", default: "60" },
    once: { type: "boolean", default: false },
    remote: { type: "string", default: "origin" },
    branch: { type: "string", default: "master" },
    state: { type: "string" },
    scenario: { type: "string" },
    count: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});
if (opt.help) {
  const header = readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n");
  console.log(header.slice(0, header.findIndex((l) => !l.startsWith("//"))).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(0);
}
const fatal = (msg) => {
  console.error(`presolve-worker: ${msg}`);
  releaseLock();
  process.exit(2);
};
const num = (name, min) => {
  const x = Number(opt[name]);
  if (!Number.isFinite(x) || x < min) fatal(`--${name} must be a number ≥ ${min}`);
  return x;
};
const maxMb = num("max-mb", 1);
const batchMs = num("batch-minutes", 0.1) * 60_000;
const batchFlops = Math.floor(num("batch-flops", 1));
const idleMs = num("idle-minutes", 0.1) * 60_000;
const workersOverride = opt.workers !== undefined ? Math.floor(num("workers", 1)) : undefined;
const countOverride = opt.count !== undefined ? Math.floor(num("count", 1)) : undefined;
const remote = opt.remote;
const branch = opt.branch;

const state = resolve(root, opt.state ?? ".presolve-worker");
const stateRepo = join(state, "repo"); // shallow, blobless clone: packs-data (sparse checkout) and packs-inbox (no checkout)
const sessionDir = join(state, "session");
const appDir = join(sessionDir, "app");
const calDir = join(sessionDir, "cal");
const summariesFile = join(sessionDir, "summaries.json");
const pushedFile = join(sessionDir, "pushed.json");
const skipFile = join(state, "skip.txt");
const logDir = join(state, "logs");
mkdirSync(logDir, { recursive: true });

// ───────────────────────── output ─────────────────────────

const day = () => new Date().toISOString().slice(0, 10).replace(/-/g, "");
const logFile = () => join(logDir, `worker-${day()}.log`);
const toLog = (line) => {
  try {
    appendFileSync(logFile(), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // A full disk must not stop the solving.
  }
};
/** One plain-text line on the terminal (local time) and in the log. */
const say = (msg) => {
  const t = new Date();
  console.log(`[${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}] ${msg}`);
  toLog(msg);
};
for (const f of readdirSync(logDir)) {
  const m = /^worker-(\d{8})\.log$/.exec(f);
  if (m && Date.now() - Date.parse(`${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6)}`) > 14 * 86_400_000) rmSync(join(logDir, f), { force: true });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const gb = (bytes) => (bytes / 2 ** 30).toFixed(1);

/** Writes a file through a temp file and a rename, so a reader (presolve re-reading the skip list) never sees half of it. */
function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  for (let i = 0; ; i++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (e) {
      // Windows: a reader or a virus scanner can hold the file for a moment.
      if (i >= 20 || !["EPERM", "EACCES", "EBUSY"].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (i + 1));
    }
  }
}
const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

// ───────────────────────── one worker per clone ─────────────────────────

const lockFile = join(state, "lock");
function releaseLock() {
  try {
    if (readFileSync(lockFile, "utf8").trim() === String(process.pid)) rmSync(lockFile, { force: true });
  } catch {
    // no lock
  }
}
function takeLock() {
  const pid = Number(readJson(lockFile));
  if (pid && pid !== process.pid) {
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (e) {
      alive = e.code === "EPERM";
    }
    if (alive) fatal(`another worker (pid ${pid}) is running from this clone; stop it first (or delete ${lockFile} if it is gone)`);
  }
  writeFileSync(lockFile, String(process.pid));
}

/** The worker's id: random, made once per state directory. Nothing about the machine or its owner goes into it. */
function workerId() {
  const file = join(state, "id");
  const old = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
  if (/^[0-9a-f]{16}$/.test(old)) return old;
  const id = randomBytes(8).toString("hex");
  writeFileSync(file, `${id}\n`);
  return id;
}

/** Physical cores: Linux's CPU topology, Windows' CIM, macOS's sysctl; the logical CPUs when none answers. */
function physicalCores(inbox) {
  const logical = os.availableParallelism?.() ?? os.cpus().length;
  try {
    if (process.platform === "linux") {
      const base = "/sys/devices/system/cpu";
      const lists = readdirSync(base)
        .filter((n) => /^cpu\d+$/.test(n))
        .map((n) => {
          for (const f of ["topology/core_cpus_list", "topology/thread_siblings_list"]) {
            try {
              return readFileSync(join(base, n, f), "utf8");
            } catch {
              // try the next name
            }
          }
          return "";
        });
      const n = inbox.physicalCoresFromSiblings(lists);
      if (n) return Math.min(n, logical);
    } else if (process.platform === "win32") {
      const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "(Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfCores -Sum).Sum"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 30_000,
      });
      const n = Number(String(r.stdout ?? "").trim());
      if (Number.isSafeInteger(n) && n > 0) return Math.min(n, logical);
    } else if (process.platform === "darwin") {
      const n = Number(String(spawnSync("sysctl", ["-n", "hw.physicalcpu"], { encoding: "utf8" }).stdout ?? "").trim());
      if (Number.isSafeInteger(n) && n > 0) return Math.min(n, logical);
    }
  } catch {
    // fall through
  }
  return logical;
}

// ───────────────────────── git ─────────────────────────

const gitOut = async (cwd, args) => (await git(cwd, args, { check: true })).stdout.trim();

/** The URL the state clone uses: the checkout's remote, a local path as a file:// URL (so --filter works). */
async function remoteUrl() {
  const url = await gitOut(root, ["remote", "get-url", remote]).catch(() => fatal(`this clone has no remote "${remote}" (git remote -v)`));
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) || /^[^/\\]+@[^/\\:]+:/.test(url)) return url;
  const p = isAbsolute(url) ? url : resolve(root, url);
  return pathToFileURL(p).href;
}

async function ensureStateRepo(url) {
  if (existsSync(join(stateRepo, ".git"))) {
    await gitOut(stateRepo, ["remote", "set-url", "origin", url]);
    return;
  }
  rmSync(stateRepo, { recursive: true, force: true });
  mkdirSync(state, { recursive: true });
  say("setting up the worker's own shallow, blobless clone (packs-data's catalog and indexes, no flop files)");
  await gitOut(state, ["clone", "--quiet", "--filter=blob:none", "--depth", "1", "--no-checkout", "--no-tags", url, "repo"]);
  await gitOut(stateRepo, ["sparse-checkout", "set", "--no-cone", "/packs/manifest.json", "/packs/*/v*/index-*.json"]);
}

/** A key of the code the solve depends on at `rev` (CODE_PATHS without test files). */
async function codeKey(rev) {
  const lines = (await gitOut(root, ["ls-tree", "-r", rev, "--", ...CODE_PATHS])).split("\n").filter((l) => l && !/\.test\.tsx?$/.test(l));
  return sha256(lines.join("\n")).slice(0, 16);
}

/** Master's tip on the remote: its commit, solver commit (full SHA) and code key. */
async function syncCode() {
  await gitOut(root, ["fetch", "--quiet", "--no-tags", remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`]);
  const tip = await gitOut(root, ["rev-parse", `refs/remotes/${remote}/${branch}`]);
  const solver = await gitOut(root, ["log", "-1", "--format=%H", tip, "--", "src/solver", ":!*.test.ts"]);
  if (!/^[0-9a-f]{40}$/.test(solver)) throw new Error(`could not name the solver commit of ${tip}`);
  return { tip, solver, key: await codeKey(tip) };
}

/**
 * Makes the checkout solve with master's code: nothing to do when its code key matches, else a fast-forward of the
 * checked-out master, refused with local edits or local commits. Restarts the process when its own code changed.
 */
async function updateCheckout(code) {
  if ((await gitOut(root, ["rev-parse", "--is-shallow-repository"])) === "true")
    fatal("this clone is shallow, so it can't name the solver commit: git fetch --unshallow (or clone again without --depth)");
  const head = await gitOut(root, ["rev-parse", "HEAD"]);
  const edits = await gitOut(root, ["status", "--porcelain", "--untracked-files=no", "--", ...CODE_PATHS]);
  if (head !== code.tip && (await codeKey(head)) !== code.key) {
    const name = (await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim();
    if (name !== branch) fatal(`the checkout is on ${name || "a detached HEAD"}, not ${branch}: git switch ${branch} (the worker solves only with ${branch}'s code)`);
    const dirty = await gitOut(root, ["status", "--porcelain", "--untracked-files=no"]);
    if (dirty) fatal(`${branch} moved on and this checkout has local edits, so it is not updated:\n${dirty}\nCommit or discard them (git stash), or use a clone just for the worker.`);
    if (!(await git(root, ["merge-base", "--is-ancestor", head, code.tip])).ok)
      fatal(`this ${branch} has commits that are not on ${remote}/${branch}; the worker solves only with ${remote}'s code (use a clone just for the worker)`);
    say(`updating the checkout to ${remote}/${branch} ${code.tip.slice(0, 7)} (fast-forward)`);
    await gitOut(root, ["merge", "--ff-only", "--quiet", code.tip]);
    const changed = (await gitOut(root, ["diff", "--name-only", head, code.tip, "--", "package-lock.json", ...SELF_PATHS])).split("\n").filter(Boolean);
    if (changed.includes("package-lock.json")) {
      say("package-lock.json changed: npm ci");
      const win = process.platform === "win32";
      const r = spawnSync(win ? "npm.cmd" : "npm", ["ci", "--no-audit", "--no-fund"], { cwd: root, stdio: "inherit", shell: win });
      if (r.status !== 0) fatal("npm ci failed; run it by hand and start the worker again");
    }
    if (changed.some((p) => SELF_PATHS.includes(p))) restartSelf();
  } else if (edits) {
    fatal(`local edits in the code the solve depends on:\n${edits}\nThe worker solves only with ${branch}'s code: discard them, or use a clone just for the worker.`);
  }
}

/** The worker's own code changed: run the new one in this terminal and exit with it. */
function restartSelf() {
  say("the worker's own code changed on master; starting the new version");
  releaseLock();
  for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.removeAllListeners(s);
    process.on(s, () => {}); // the new process gets the same signal and stops cleanly; this one waits for it
  }
  const r = spawnSync(process.execPath, process.argv.slice(1), { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

// ───────────────────────── what is done ─────────────────────────

let checkedOutData = null;

/**
 * What is solved for this solver commit: packs-data's flops (the branch's tree), master's calibration flops and the
 * inbox's flops of the same solver commit; writes them as the skip list. Also the live workers and this one's share.
 */
async function syncData(code, inbox) {
  const dataHead = await fetchHead(stateRepo, "origin", "packs-data");
  if (dataHead && dataHead !== checkedOutData) {
    // Sparse: only the catalog and the indexes come down (presolve.mjs reads them for its checks).
    await gitOut(stateRepo, ["-c", "advice.detachedHead=false", "checkout", "--quiet", "--force", "--detach", dataHead]);
    checkedOutData = dataHead;
  }
  const strip = (prefix) => (p) => p.slice(prefix.length);
  const appDone = dataHead ? (await treePaths(stateRepo, dataHead, "packs")).map(strip("packs/")).filter(inbox.isPackFlopPath) : [];
  const calDone = (await treePaths(root, code.tip, "calibration/packs")).map(strip("calibration/packs/")).filter(inbox.isPackFlopPath);
  const inboxHead = await fetchHead(stateRepo, "origin", inbox.INBOX_BRANCH);
  const inboxPaths = inboxHead ? await treePaths(stateRepo, inboxHead) : [];
  const inInbox = inbox.inboxFlops(inboxPaths, code.solver).map((f) => f.path);
  const beats = [];
  for (const p of inboxPaths.filter((x) => x.startsWith(`${inbox.HEARTBEAT_DIR}/`) && x !== inbox.heartbeatPath(id))) {
    const h = inbox.parseHeartbeat((await readBlob(stateRepo, inboxHead, p)) ?? "");
    if (h) beats.push(h);
  }
  const active = inbox.activeWorkers(beats, id, Date.now());
  const published = new Set([...appDone, ...calDone]);
  const done = new Set([...published, ...inInbox]);
  const text = inbox.skipList(done);
  if (!existsSync(skipFile) || readFileSync(skipFile, "utf8") !== text) writeAtomic(skipFile, text);
  return { dataHead, inboxHead, published, done, active, shard: inbox.workerShard(active, id), inInbox: inInbox.length };
}

// ───────────────────────── the queue ─────────────────────────

async function loadModules() {
  const [scenarios, flops, shard, format, solver, inbox] = await Promise.all(
    ["src/presolve/scenarios.ts", "src/presolve/flops.ts", "src/presolve/shard.ts", "src/presolve/format.ts", "src/solver/index.ts", "src/presolve/inbox.ts"].map((p) => load(p)),
  );
  return { scenarios, flops, shard, format, solver, inbox };
}

/** The workflow's selection (or the --scenario / --count override) and this machine's part of its queue, back to front. */
function planQueue(data, mods) {
  const { ALL_SCENARIOS, getScenario, solverInput } = mods.scenarios;
  let sel;
  try {
    sel = mods.inbox.workflowSelection(readFileSync(join(root, ".github", "workflows", "presolve.yml"), "utf8"));
  } catch (e) {
    fatal(e.message);
  }
  if (opt.scenario !== undefined) sel.scenario = opt.scenario;
  if (countOverride !== undefined) sel.count = countOverride;
  // As the workflow: the calibration packs only while there is no packs-data branch.
  const set = data.dataHead ? undefined : "calibration";
  let scenarios;
  try {
    scenarios = (sel.scenario === "all" ? ALL_SCENARIOS : sel.scenario.split(",").map((s) => getScenario(s.trim()))).filter((sc) => !set || sc.set === set);
  } catch (e) {
    fatal(`--scenario: ${e.message}`);
  }
  const mine = mods.shard.shardFlops(mods.flops.FLOPS_BY_PRIORITY, sel.count, data.shard);
  const perPack = scenarios.map((sc) => ({
    queue: sc.queue ?? 0,
    jobs: mine.filter((f) => !data.done.has(mods.format.packFilePath(sc.id, sc.version, f.key))).map((f) => ({ sc, flop: f })),
  }));
  const queue = mods.shard.jobQueue(perPack, "reverse");
  // The memory of the next flops this machine would start (one over --max-mb is skipped by presolve.mjs anyway).
  let perFlop = 0;
  for (let i = 0, seen = 0; i < queue.length && seen < 4 * cores; i++) {
    const b = mods.solver.estimateMemory(solverInput(queue[i].sc, queue[i].flop.cards)).bytes;
    if (b / 1e6 > maxMb) continue;
    perFlop = Math.max(perFlop, b);
    seen++;
  }
  const slots = workersOverride ?? mods.inbox.solveSlots({ physicalCores: cores, totalBytes: os.totalmem(), perFlopBytes: perFlop * mods.inbox.MEMORY_MARGIN });
  return { sel, set, queue, perFlop, slots };
}

// ───────────────────────── pushing ─────────────────────────

const identity = () => ({ name: `presolve-worker ${id}`, email: "presolve-worker@invalid" });
const heartbeat = (slots, stopped) => JSON.stringify({ v: 1, id, slots, updatedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"), ...(stopped ? { stopped: true } : {}) }) + "\n";

/** The session's files written so far ({ set, path, sha256, summary }, presolve.mjs --summaries-out). */
function sessionFiles() {
  const s = readJson(summariesFile);
  return s?.summaries === 1 && Array.isArray(s.files) ? s.files : [];
}
const localFile = (e) => join(e.set === "app" ? appDir : calDir, ...e.path.split("/"));

/**
 * Pushes the session's finished, unpushed flops as one commit on packs-inbox, with their summaries and this worker's
 * heartbeat (also when there is no flop: the others see it is alive). Only flops of `solver`, the solver commit master
 * has now: a session of another solver commit pushes nothing. Flops published meanwhile (the shards got there first)
 * and flops another worker already left on the branch are not pushed again. Resolves false when the push failed; the
 * flops then stay for the next batch.
 */
async function pushPending({ solver, published, inbox, slots, stopped = false }) {
  const session = readJson(join(sessionDir, "session.json"));
  const pushed = new Set(readJson(pushedFile) ?? []);
  const fresh = [];
  for (const e of session?.solver === solver ? sessionFiles() : []) {
    if (pushed.has(e.path) || typeof e.path !== "string" || !inbox.isPackFlopPath(e.path) || (e.set !== "app" && e.set !== "calibration")) continue;
    if (published?.has(e.path)) {
      pushed.add(e.path);
      continue;
    }
    let ok = false;
    try {
      ok = sha256(readFileSync(localFile(e))) === e.sha256;
    } catch {
      // missing
    }
    if (ok) fresh.push(e);
    else say(`${e.path}: the file on disk is missing or differs from its summary; not pushed`);
  }
  let added = [];
  const at = new Date();
  try {
    const res = await commitToBranch({
      repo: stateRepo,
      branch: inbox.INBOX_BRANCH,
      identity: identity(),
      log: say,
      change: (paths, head) => {
        // Another worker's copy of a flop stays: never replace a file on the branch.
        added = fresh.filter((e) => !paths.has(inbox.inboxPath(solver, e.set, e.path)));
        const add = added.map((e) => ({ path: inbox.inboxPath(solver, e.set, e.path), file: localFile(e) }));
        if (added.length)
          add.push({
            path: inbox.summariesPath(solver, id, at),
            text: JSON.stringify({ summaries: 1, files: added.map(({ set, path, sha256: h, summary }) => ({ set, path, sha256: h, summary })) }),
          });
        add.push({ path: inbox.heartbeatPath(id), text: heartbeat(slots, stopped), replace: true });
        if (!head) add.push({ path: "README.md", text: INBOX_README }, { path: "vercel.json", text: INBOX_VERCEL });
        return { add, message: `Inbox: ${added.length} flop(s) from worker ${id} (solver ${solver.slice(0, 7)})${stopped ? ", stopped" : ""}` };
      },
    });
    for (const e of fresh) pushed.add(e.path);
    if (session) writeAtomic(pushedFile, JSON.stringify([...pushed]));
    if (added.length) say(`pushed ${added.length} flop(s) to ${inbox.INBOX_BRANCH} (${res.commit.slice(0, 7)})`);
    else if (fresh.length) say(`${fresh.length} flop(s) were already on ${inbox.INBOX_BRANCH} (another worker); not pushed again`);
    return true;
  } catch (e) {
    if (fresh.length) say(`push failed: ${e.message.split("\n")[0]}; the ${fresh.length} flop(s) stay here and go out with the next batch`);
    else say(`heartbeat not pushed: ${e.message.split("\n")[0]}`);
    if (session) writeAtomic(pushedFile, JSON.stringify([...pushed]));
    return false;
  }
}

/**
 * Settles a finished session (this run's last one, or one a run that quit left behind): its unpushed flops are pushed
 * when they are of master's current solver commit, else dropped; then the session is cleared. Resolves false when the
 * push failed: the session stays, and no new one starts over it.
 */
async function settleSession(code, data, mods, slots) {
  const s = readJson(join(sessionDir, "session.json"));
  if (!s) {
    rmSync(sessionDir, { recursive: true, force: true });
    return true;
  }
  const pushed = new Set(readJson(pushedFile) ?? []);
  const left = sessionFiles().filter((e) => !pushed.has(e.path)).length;
  if (left && s.solver === code.solver) {
    if (!(await pushPending({ solver: code.solver, published: data.published, inbox: mods.inbox, slots }))) return false;
  } else if (left) say(`dropping ${left} unpushed flop(s): solved with solver ${String(s.solver).slice(0, 7)}, and ${branch} now has ${code.solver.slice(0, 7)}`);
  rmSync(sessionDir, { recursive: true, force: true });
  return true;
}

// ───────────────────────── a session: one presolve.mjs run ─────────────────────────

let stopping = false;
let stopSession = null;
let wakeIdle = null;

/**
 * Runs presolve.mjs over the plan until its queue is empty, the code or the workers change, or the worker is stopped;
 * pushes at every batch. Resolves why it ended: "done", "solver", "code", "workers", "stopped" or "failed".
 */
async function runSession(code, data, plan, mods) {
  rmSync(sessionDir, { recursive: true, force: true });
  mkdirSync(appDir, { recursive: true });
  mkdirSync(calDir, { recursive: true });
  // presolve.mjs checks every flop against the published catalog (settings, summary template), as a shard does.
  const dataPacks = join(stateRepo, "packs");
  if (data.dataHead && existsSync(join(dataPacks, "manifest.json"))) {
    const copy = (from, to) => {
      for (const n of readdirSync(from)) {
        const f = join(from, n);
        if (statSync(f).isDirectory()) copy(f, join(to, n));
        else if (n === "manifest.json" || /^index-[0-9a-f]{16}\.json$/.test(n)) {
          mkdirSync(to, { recursive: true });
          copyFileSync(f, join(to, n));
        }
      }
    };
    copy(dataPacks, appDir);
  }
  const calManifest = join(root, "calibration", "packs", "manifest.json");
  if (existsSync(calManifest)) copyFileSync(calManifest, join(calDir, "manifest.json"));
  writeFileSync(join(sessionDir, "session.json"), JSON.stringify({ v: 1, solver: code.solver, key: code.key, startedAt: new Date().toISOString() }));
  writeAtomic(pushedFile, "[]");

  const args = [
    PRESOLVE,
    "--scenario", plan.sel.scenario,
    ...(plan.set ? ["--set", plan.set] : []),
    "--count", String(plan.sel.count),
    "--order", "reverse",
    ...(data.shard.count > 1 ? ["--shard", `${data.shard.index}/${data.shard.count}`] : []),
    "--out", appDir,
    "--cal-out", calDir,
    "--skip-from", skipFile,
    "--summaries-out", summariesFile,
    "--workers", String(plan.slots),
    "--reserve-mb", String(Math.round(mods.inbox.HEADROOM_BYTES / 1e6)),
    "--max-mb", String(maxMb),
    "--budget-minutes", String(60 * 24 * 365),
    "--publish",
  ];
  toLog(`node ${args.join(" ")}`);
  const child = spawn(process.execPath, args, { cwd: root, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
  try {
    os.setPriority(child.pid, os.constants.priority.PRIORITY_LOW);
  } catch {
    // inherited from this process anyway
  }
  const tail = [];
  for (const stream of [child.stdout, child.stderr]) {
    let buf = "";
    stream.on("data", (b) => {
      buf += b.toString("utf8");
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const l of lines) {
        toLog(`  presolve | ${l}`);
        tail.push(l);
        if (tail.length > 30) tail.shift();
      }
    });
  }
  let solved = 0;
  let sinceBatch = 0;
  let left = plan.queue.length;
  child.on("message", (m) => {
    if (m?.type === "done") {
      solved++;
      sinceBatch++;
      left = m.left;
      say(`${m.scenario} ${m.board}  ${Math.round(m.seconds)} s  (${solved} done, ${left} left)`);
    } else if (m?.type === "not-written") say(`${m.scenario} ${m.board}: not written (${m.reason})`);
    else if (m?.type === "dropped") {
      left = m.left;
      say(`${m.count} queued flop(s) were solved elsewhere meanwhile (${left} left)`);
    } else if (m?.type === "queued") left = m.jobs;
  });
  const exited = new Promise((res) => child.on("exit", (exitCode, signal) => res({ exitCode, signal })));
  let reason = null;
  const requestStop = (why) => {
    reason ??= why;
    if (child.connected) child.send({ type: "stop" });
    setTimeout(() => child.exitCode === null && child.signalCode === null && child.kill(), 60_000).unref();
  };
  stopSession = requestStop;
  if (stopping) requestStop("stopped");

  let lastBatch = Date.now();
  for (;;) {
    const r = await Promise.race([exited, sleep(5_000).then(() => null)]);
    if (r) break;
    if (reason || (Date.now() - lastBatch < batchMs && sinceBatch < batchFlops)) continue;
    lastBatch = Date.now();
    sinceBatch = 0;
    // Master first: a new solver commit means none of the unpushed files may go out.
    let fresh;
    try {
      fresh = await syncCode();
    } catch (e) {
      say(`could not fetch ${branch} (${e.message.split("\n")[0]}); trying again at the next batch`);
      continue;
    }
    if (reason) continue;
    if (fresh.solver !== code.solver) {
      say(`${branch} has a new solver commit (${code.solver.slice(0, 7)} → ${fresh.solver.slice(0, 7)}): stopping, dropping the unpushed flops, starting over`);
      requestStop("solver");
      continue;
    }
    try {
      Object.assign(data, await syncData(code, mods.inbox));
    } catch (e) {
      say(`could not read packs-data / ${mods.inbox.INBOX_BRANCH} (${e.message.split("\n")[0]}); trying again at the next batch`);
      continue;
    }
    await pushPending({ solver: code.solver, published: data.published, inbox: mods.inbox, slots: plan.slots });
    if (fresh.key !== code.key) {
      say(`the pipeline's code changed on ${branch}: starting over with it`);
      requestStop("code");
    } else if (data.shard.index !== plan.shard.index || data.shard.count !== plan.shard.count) {
      say(`the workers changed (${data.active.length} live: worker ${data.shard.index + 1} of ${data.shard.count} now): starting over with the new split`);
      requestStop("workers");
    }
  }
  const { exitCode, signal } = await exited;
  stopSession = null;
  if (stopping) reason = "stopped";
  if (!reason) reason = exitCode === 0 ? "done" : "failed";
  if (reason === "failed") {
    say(`presolve.mjs exited with ${signal ?? exitCode}; its last lines (all of it: ${logFile()}):`);
    for (const l of tail.slice(-15)) console.log(`    ${l}`);
  }
  // The last flops of the session, unless the solver changed in the meantime (settleSession drops them then).
  try {
    const fresh = await syncCode();
    if (!(await settleSession(fresh, data, mods, plan.slots))) say(`the unpushed flops stay in ${sessionDir}; they go out with the next push`);
  } catch (e) {
    say(`could not check ${branch} before the last push (${e.message.split("\n")[0]}); the unpushed flops stay in ${sessionDir} for the next try`);
  }
  return { reason, solved };
}

// ───────────────────────── main ─────────────────────────

const onSignal = (sig) => {
  if (stopping) {
    say(`quitting now; finished flops not pushed yet stay in ${sessionDir} and go out at the next start`);
    releaseLock();
    process.exit(130);
  }
  stopping = true;
  say(`${sig === "SIGINT" ? "Ctrl+C" : sig}: stopping. Unfinished solves are dropped, finished flops are pushed first (Ctrl+C again quits at once).`);
  stopSession?.("stopped");
  wakeIdle?.();
};
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);
process.on("SIGHUP", onSignal); // the terminal window closed

async function idle(ms) {
  await new Promise((res) => {
    const t = setTimeout(res, ms);
    wakeIdle = () => {
      clearTimeout(t);
      res();
    };
  });
  wakeIdle = null;
}

const major = Number(process.versions.node.split(".")[0]);
if (major < 22) console.warn(`presolve-worker: Node ${process.versions.node}; the workflow uses Node 22 (install Node 22 LTS)`);
try {
  os.setPriority(os.constants.priority.PRIORITY_LOW); // inherited by presolve.mjs, its solver threads and git
} catch {
  say("could not lower this process's priority; the machine may feel slower while it solves");
}
mkdirSync(state, { recursive: true });
takeLock();
const id = workerId();
let cores = 1;
let exitCode = 0;

try {
  const url = await remoteUrl();
  await ensureStateRepo(url);
  let mods = await loadModules();
  cores = physicalCores(mods.inbox);
  say(
    `presolve worker ${id}: ${cores} physical core(s) of ${os.availableParallelism?.() ?? os.cpus().length}, ${gb(os.totalmem())} GB RAM ` +
      `(${gb(mods.inbox.HEADROOM_BYTES)} GB kept free), lowest priority; Ctrl+C stops it`,
  );
  let code = await syncCode();
  await updateCheckout(code);
  let data = await syncData(code, mods.inbox);
  let idleNext = false;
  while (!stopping) {
    if (idleNext) {
      if (opt.once) break;
      say(`nothing to solve right now; looking again in ${Math.round(idleMs / 60_000)} min`);
      await idle(idleMs);
      if (stopping) break;
    }
    idleNext = false;
    try {
      code = await syncCode();
      await updateCheckout(code);
      mods = await loadModules();
      data = await syncData(code, mods.inbox);
    } catch (e) {
      say(`could not sync (${e.message.split("\n")[0]}); trying again in 10 min`);
      await idle(10 * 60_000);
      continue;
    }
    // A session a quit run left behind (or whose last push failed) goes out first; nothing starts over it.
    if (!(await settleSession(code, data, mods, workersOverride ?? cores))) {
      say(`could not push the finished flops in ${sessionDir}; check the network and git credentials. Trying again in 10 min`);
      await idle(10 * 60_000);
      continue;
    }
    const plan = { ...planQueue(data, mods), shard: data.shard };
    const share = data.shard.count > 1 ? `, worker ${data.shard.index + 1} of ${data.shard.count} live workers` : "";
    if (!plan.queue.length) {
      say(`queue of ${plan.sel.scenario} --count ${plan.sel.count}: nothing left for this machine${share} (${data.inInbox} flop(s) waiting in the inbox)`);
      await pushPending({ solver: code.solver, published: data.published, inbox: mods.inbox, slots: plan.slots });
      idleNext = true;
      continue;
    }
    const next = plan.queue[0];
    say(
      `solver ${code.solver.slice(0, 7)}, queue of ${plan.sel.scenario} --count ${plan.sel.count}${plan.set ? " (calibration packs only: no packs-data)" : ""}: ` +
        `${plan.queue.length} flops left for this machine${share}, from the back (next ${next.sc.id} ${next.flop.key}); ` +
        `up to ${gb(plan.perFlop * mods.inbox.MEMORY_MARGIN)} GB a flop → ${plan.slots} solve(s) at once`,
    );
    await pushPending({ solver: code.solver, published: data.published, inbox: mods.inbox, slots: plan.slots }); // heartbeat: the others see this worker now
    const { reason, solved } = await runSession(code, data, plan, mods);
    if (reason === "stopped") break;
    if (reason === "failed") {
      if (opt.once) {
        exitCode = 1;
        break;
      }
      say("presolve.mjs failed; trying again in 10 min");
      await idle(10 * 60_000);
    } else if (reason === "done" && solved === 0) idleNext = true;
  }
  // Gone: the others take this worker's share at their next batch instead of after ACTIVE_MS.
  await pushPending({ solver: code.solver, published: data.published, inbox: mods.inbox, slots: workersOverride ?? cores, stopped: true });
} catch (e) {
  say(`stopped by an error: ${e?.stack ?? e}`);
  exitCode = 1;
}
releaseLock();
say(exitCode ? "worker stopped with an error" : "worker stopped");
process.exit(exitCode);
