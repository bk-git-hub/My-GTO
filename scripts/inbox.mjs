// Git plumbing for the packs-inbox branch (src/presolve/inbox.ts), shared by the presolve worker
// (scripts/presolve-worker.mjs, on someone's own computer) and the workflow's merge (scripts/packs-inbox.mjs).
//
// Both work in a shallow, blobless clone and never touch a work tree for the branch: a commit is built from the head's
// tree in a temporary index (read-tree, update-index, write-tree, commit-tree) and pushed as a fast-forward of the head
// it was built on. A rejected push means someone pushed in between: the change is asked for again on the new head and
// pushed again, so nobody's commit is ever lost; nothing here force-pushes. git always runs with an argument array and
// no shell, so Windows (Git for Windows, its Credential Manager for the push) and Linux behave the same.
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Runs git and resolves { ok, code, stdout, stderr } (never rejects on a non-zero exit; `check` throws then). `input` is
 * written to stdin; `env` is added to the environment.
 */
export function git(cwd, args, { input, env, check = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: [input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const out = [];
    const err = [];
    child.stdout.on("data", (b) => out.push(b));
    child.stderr.on("data", (b) => err.push(b));
    child.on("error", reject);
    child.on("close", (code) => {
      const r = { ok: code === 0, code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") };
      if (check && !r.ok) reject(new Error(`git ${args.join(" ")} failed (${code}): ${r.stderr.trim().split("\n").slice(-3).join(" / ")}`));
      else resolve(r);
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

const out = async (cwd, args, opts) => (await git(cwd, args, { ...opts, check: true })).stdout.trim();

/** The head of a branch on the remote, or null when there is no such branch. */
export async function remoteHead(repo, remote, branch) {
  const line = await out(repo, ["ls-remote", remote, `refs/heads/${branch}`]);
  const sha = line.split(/\s/)[0];
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/**
 * Fetches a branch's head, shallow and without blobs, into refs/remotes/<remote>/<branch>; returns its SHA, or null when
 * the branch doesn't exist.
 */
export async function fetchHead(repo, remote, branch) {
  if (!(await remoteHead(repo, remote, branch))) return null;
  await out(repo, ["fetch", "--quiet", "--no-tags", "--depth", "1", "--filter=blob:none", remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`]);
  return out(repo, ["rev-parse", `refs/remotes/${remote}/${branch}`]);
}

/** Every file path in a commit's tree (trees only: no blob is fetched). */
export async function treePaths(repo, commit, ...pathspecs) {
  const text = await out(repo, ["ls-tree", "-r", "-z", "--name-only", commit, ...(pathspecs.length ? ["--", ...pathspecs] : [])]);
  return text.split("\0").filter(Boolean);
}

/** A file of a commit as text (a blobless clone fetches the blob on demand); null when it isn't there. */
export async function readBlob(repo, commit, path) {
  const r = await git(repo, ["cat-file", "blob", `${commit}:${path}`]);
  return r.ok ? r.stdout : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Commits a change on top of a branch's current head and pushes it. `change(paths, head)` gets the head's file paths (a
 * Set; empty and head null when the branch doesn't exist yet) and returns `{ add, remove, message }`: `add` entries are
 * `{ path, file }` (a file on disk) or `{ path, text }`, and are dropped when the path already exists unless they say
 * `replace: true` (a file someone else pushed is never overwritten); `remove` paths that aren't there are dropped. A
 * rejected push fetches the new head and asks `change` again. Resolves { pushed, head, commit, added, removed } (pushed
 * false when nothing was left to change); throws after `attempts` rejected pushes.
 *
 * `identity` ({ name, email }) sets author and committer; without it git's own config is used. The commit is never
 * signed: a background worker must not wait for a passphrase.
 */
export async function commitToBranch({ repo, remote = "origin", branch, change, identity, attempts = 6, log = () => {} }) {
  const gitDir = await out(repo, ["rev-parse", "--absolute-git-dir"]);
  const index = join(gitDir, `inbox-index-${process.pid}`);
  const idEnv = identity
    ? { GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email, GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email }
    : {};
  try {
    for (let attempt = 1; ; attempt++) {
      const head = await fetchHead(repo, remote, branch);
      const paths = new Set(head ? await treePaths(repo, head) : []);
      const c = await change(paths, head);
      const add = (c.add ?? []).filter((a) => a.replace || !paths.has(a.path));
      const remove = [...new Set(c.remove ?? [])].filter((p) => paths.has(p) && !add.some((a) => a.path === p));
      if (!add.length && !remove.length) return { pushed: false, head, commit: head, added: 0, removed: 0 };

      const env = { GIT_INDEX_FILE: index };
      rmSync(index, { force: true });
      await out(repo, head ? ["read-tree", head] : ["read-tree", "--empty"], { env });
      const lines = [];
      const files = add.filter((a) => a.file !== undefined);
      if (files.length) {
        const shas = (await out(repo, ["hash-object", "-w", "--stdin-paths"], { input: files.map((a) => a.file).join("\n") + "\n" })).split(/\r?\n/);
        if (shas.length !== files.length) throw new Error(`hash-object returned ${shas.length} ids for ${files.length} files`);
        files.forEach((a, i) => lines.push(`100644 ${shas[i]}\t${a.path}`));
      }
      for (const a of add.filter((x) => x.file === undefined)) lines.push(`100644 ${await out(repo, ["hash-object", "-w", "--stdin"], { input: a.text })}\t${a.path}`);
      for (const p of remove) lines.push(`0 ${"0".repeat(40)}\t${p}`);
      await out(repo, ["update-index", "--index-info"], { env, input: lines.join("\n") + "\n" });
      // --missing-ok: the head's blobs were never fetched (blobless clone), and the remote has them all.
      const tree = await out(repo, ["write-tree", "--missing-ok"], { env });
      if (head && tree === (await out(repo, ["rev-parse", `${head}^{tree}`]))) return { pushed: false, head, commit: head, added: 0, removed: 0 };
      const commit = await out(repo, ["commit-tree", "--no-gpg-sign", tree, ...(head ? ["-p", head] : []), "-m", c.message], { env: idEnv });
      // A plain push: the remote takes it only while the branch is still at `head` (a fast-forward), which is the lease.
      const r = await git(repo, ["push", "--quiet", "--no-verify", remote, `${commit}:refs/heads/${branch}`]);
      if (r.ok) return { pushed: true, head, commit, added: add.length, removed: remove.length };
      const why = r.stderr.trim().split("\n").filter(Boolean).slice(-2).join(" / ");
      if (attempt >= attempts) throw new Error(`could not push to ${branch} after ${attempts} attempts: ${why}`);
      log(`push to ${branch} rejected (attempt ${attempt}: ${why}); redoing on its new head`);
      await sleep(Math.min(30_000, attempt * 3000));
    }
  } finally {
    rmSync(index, { force: true });
  }
}

/** The branch's README and vercel.json, added with the commit that creates it. */
export const INBOX_README = `# packs-inbox

Data only, never merged: postflop flops solved by presolve workers outside the presolve workflow
(\`scripts/presolve-worker.mjs\` on master, docs/worker-setup.md), waiting for the workflow's next merge. The merge takes
the files of its own solver commit and of each pack's current version through the same checks as a shard's files
(\`scripts/packs-ingest.mjs\`, \`scripts/presolve.mjs --rebuild-manifest\`), publishes them on packs-data or master and then
removes them here.

- \`<solver>/files/<pack>/v<k>/flop-<board>.json\`: app packs; \`<solver>/cal-files/...\`: calibration packs.
- \`<solver>/summaries/<worker>-<time>.json\`: the exact summaries of one batch.
- \`workers/<worker>.json\`: each worker's heartbeat; the live workers split the back of the queue between them.

\`<solver>\` is the full SHA of the last commit that changed src/solver. Do not edit by hand.
`;
export const INBOX_VERCEL = `{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "git": {
    "deploymentEnabled": false
  }
}
`;
