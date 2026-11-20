# Solver content packs

Precomputed GTO solutions for common heads-up single-raised-pot flops, the way commercial trainers ship
them: the app downloads one small JSON file per flop and shows the strategy, the ranges and the EVs at the
first flop decisions without solving anything on the device. The numbers come from our own solver
(`src/solver/`, spec in `docs/solver.md`); no third-party solver code or output is involved.

A GitHub Action runs the presolve pipeline back to back while flops are left (and every 6 hours as a backstop),
split over parallel jobs. It solves the next flops (in priority order) that have no file yet in each pack's current
version directory under `public/packs/`, and rewrites `public/packs/manifest.json` (see Pipeline below).
The format lives in `src/presolve/format.ts` (types plus pure encode/decode helpers that run in Node and in the
browser). The manifest shape matches §9 "솔버 콘텐츠 팩" of `docs/server-design.md` (branch
`claude/lucid-brown-8ikhmc`) and adds fields to it.

The same pipeline also solves **calibration packs** for the preflop solver's realization model: the same file format
with a second manifest, `calibration/packs/manifest.json`, outside `public/`. They are never deployed and the app never
lists them; only `scripts/fit-realization.mjs` reads them (Calibration packs, below).

## Scenarios

A pack is one preflop scenario solved on many flops. Its id is
`[<format>-]<pot>-<raiser>-<caller>-<stack>`: lowercase seat names (`utg1` for UTG+1), `srp` for a single
raised pot (later `3bp` for 3-bet pots), and the effective stack in bb at the start of the hand. The format
prefix is left out for 6-max cash.

| id | Game | Preflop | Flop pot / stack | Ranges (chart refs) |
|---|---|---|---|---|
| `srp-btn-bb-100` | 6-max cash, 100bb, no ante | BTN opens 2.5bb, SB folds, BB calls | 5.5 / 97.5 | OOP `cash6/100bb/bb-vs-btn:call`, IP `cash6/100bb/rfi-btn:raise` |
| `pub-srp-btn-bb-55` | Pub tournament, mid stage (55bb, the play mode's `STAGE_STACK.mid`), 9-handed, 1bb BB ante | BTN opens 2.5bb, SB folds, BB calls | 6.5 / 51.5 | OOP `pub/mid/bb-vs-btn:call`, IP `pub/mid/rfi-btn:open` |
| `pub-srp-utg-bb-55` | Pub tournament, mid stage (55bb), 9-handed, 1bb BB ante | UTG opens 2.5bb, the others fold, BB calls | 6.5 / 51.5 | OOP `pub/mid/bb-vs-utg:call`, IP `pub/mid/rfi-utg:open` |

The UTG pack pairs a tight opener (12% of hands) with a wide BB call (46%): the BTN packs only show realization
against wide ranges, and the preflop solver's realization model (`docs/preflop-solver.md` §3.7) also needs
dominated hands such as Q7s or A4o against a strong range. It is measured, not fitted: the shipped fit leaves it out
on purpose and uses it as held-out data, which shows that the BB realizes more against a strong range than the
range-blind model says (§3.7 bias 2 there). It is the data for a model that depends on the opponent's range.

Calibration packs (`CAL_SCENARIOS`, set `"calibration"`, not in the app; section Calibration packs below):

| id | Game | Preflop | Flop pot / stack (SPR) | Ranges |
|---|---|---|---|---|
| `cal-srp-btn-bb-20` | Solver tournament, 9-handed, everyone 20bb, 1bb BB ante (the `20bb-2` stage) | BTN opens 2bb, SB folds, BB calls | 5.5 / 17 (3.09) | OOP `solver/20bb-2/bb-vs-btn-open:call`, IP `solver/20bb-2/rfi-btn:open`, each with ghost combos |
| `cal-srp-btn-bb-15` | The same at 15bb (the `15bb-2` stage) | the same | 5.5 / 12 (2.18) | `solver/15bb-2/…` the same spots, with ghost combos |

The pot counts all dead money (SB, ante): pot = 2 × open + 0.5 + ante, and the effective stack is the BB's,
start − open − ante (the BB paid the ante too). `src/presolve/scenarios.ts` derives both from the play-mode rules
(`openSize`, `STAGE_STACK`, `PUB_TABLE.bbAnte`). The numbers above are what the pipeline is expected to use; the
manifest's `scenario` block is the authority. A chart ref is `<set>/<stage>/<scenario>:<action>`, the ids of
`src/data/charts.ts` (`Scenario.id` + an action key); the range string written into the manifest is the
hand-class frequency of that action (`Scenario.strategy[hand][action]`).

## Files

```
public/packs/manifest.json
public/packs/<scenario>/v<version>/flop-<board>.json      e.g. srp-btn-bb-100/v1/flop-AsKh7d.json
calibration/packs/manifest.json                            calibration packs only (same format)
calibration/packs/<scenario>/v<version>/flop-<board>.json  e.g. cal-srp-btn-bb-20/v1/flop-Qs8h5h.json
```

Everything below about paths, manifests and files holds for both directories; a file's `path` is relative to the
directory of the manifest that lists it. Pack ids are unique across the two manifests, and a pack is listed in its own
set's manifest only (`scripts/presolve.mjs` refuses to run when a manifest lists a pack of the other set).

Paths in the manifest are relative to `packs/` (`PACKS_DIR`), so the app fetches
`${import.meta.env.BASE_URL}packs/<path>`. A file at a given path never changes: it can be cached forever
(`Cache-Control: public, max-age=31536000, immutable`); only the manifest is cached briefly. The PWA
precache does not include `.json`, so packs are not part of the app install: the app downloads the files it
needs, checks their sha256 with WebCrypto and keeps them in Cache Storage for offline use.

Every file is `JSON.stringify` output (no whitespace). `bytes` and `sha256` are over its UTF-8 bytes (labels
are Korean, so bytes ≠ string length).

## Manifest

```jsonc
{
  "v": 1,
  "generatedAt": "2026-11-06T03:12:00Z",
  "packs": [{
    "id": "srp-btn-bb-100",
    "title": "BTN vs BB 싱글 레이즈드 팟 (100bb)",
    "version": 1,
    "tier": "free",
    "solverCommit": "0cdd611",
    "scenario": {
      "format": "cash", "positions": ["BB", "BTN"], "preflop": "BTN 2.5bb 오픈, BB 콜",
      "pot": 5.5, "stack": 97.5,
      "sizes": { "flop": [{ "bet": [0.33, 0.75], "raise": [0.75] }, { "bet": [0.33, 0.75], "raise": [0.75] }],
                 "turn": [...], "river": [...] },
      "raiseLimit": 2, "addAllIn": true, "allInThreshold": 0.67, "minBet": 1,
      "iterations": 1000, "targetExploitability": 0.5,
      "ranges": ["22+, A2s+, ...", "22+, A2s+, ..."],
      "rangeSources": ["cash6/100bb/bb-vs-btn:call", "cash6/100bb/rfi-btn:raise"],
      "flopSet": "subset-95"
    },
    "summaryNodes": [
      { "path": [],     "player": 0, "labels": ["체크", "벳 33%", "벳 75%", "올인"], "kinds": ["check", "bet", "bet", "allin"] },
      { "path": [0],    "player": 1, "labels": ["체크", "벳 33%", "벳 75%", "올인"], "kinds": [...] },
      { "path": [1],    "player": 1, "labels": ["폴드", "콜", "레이즈 7.4", "올인"], "kinds": [...] },
      { "path": [0, 1], "player": 0, "labels": ["폴드", "콜", "레이즈 7.4", "올인"], "kinds": [...] }
      // ... one entry per action node at depth ≤ 2: [2], [3], [0, 2], [0, 3] as well
    ],
    "files": [{
      "path": "srp-btn-bb-100/v1/flop-AsKh7d.json", "sha256": "…64 hex…", "bytes": 41873,
      "board": "AsKh7d", "weight": 24, "exploitability": 0.42,
      "summary": { "equity": [0.4281, 0.5719], "ev": [2.08, 3.42],
                   "freq": [[0.61, 0.33, 0.06, 0], [0.38, 0.47, 0.15, 0], [0.22, 0.61, 0.17, 0], [0.31, 0.55, 0.14, 0], ...] }
    }]
  }]
}
```

**PackEntry**: `id`, `title` (Korean), `version` (integer ≥ 1), `tier` (`"free"` or `"pro"`), `scenario`,
`summaryNodes`, optional `solverCommit`, `files`.

**ScenarioMeta** holds everything needed to rebuild the exact game tree: `format` (`"cash"` or `"pub"`),
`positions` [OOP, IP], `pot` and `stack` at the start of the flop (bb), `sizes` for all three streets
([OOP, IP] `StreetSizes` as in `src/solver/types.ts`), `raiseLimit`, `addAllIn`, `allInThreshold`, `minBet`,
the solve targets `iterations` and `targetExploitability` (% of pot), the starting `ranges` as range strings
(`src/poker/range.ts` syntax) and optionally `rangeSources` (chart refs), `preflop` (Korean description),
`flopSet` (which flops the pack covers) and, in calibration packs only, `ghostWeight` (the ghost-combo floor of both
ranges). `treeSettings(meta)` turns it into solver input fields.

**summaryNodes**: the game tree is the same on every flop of a pack (it depends only on pot, stack and
sizes), so the action labels of the summarized nodes are written once per pack. They are every action node
with at most two actions on its path: OOP's root, IP after a check, IP facing each OOP bet, and OOP facing
each IP bet after checking. `summaryNodeDefs(flop)` builds them.

**FileEntry**: `path`, `sha256` (lowercase hex), `bytes`, `board` (canonical key, see below), `weight`,
`exploitability` (% of pot), `summary`.

- `weight`: how many of the 22100 raw flops the file stands for: its suit-isomorphism class size (4, 12 or
  24 for distinct ranks), plus the classes the pipeline maps onto it when the pack covers a subset. Weights of
  a pack add up to at most 22100, exactly 22100 when the subset is meant to stand for every flop. Reports
  average per-flop numbers with these weights.
- `summary.equity`: each range's raw equity share against the other at the root, both run out to the river
  (sums to 1). `summary.ev`: each player's range-average expected net at the root in bb, from the solver
  (sums to the pot). `summary.freq`: per `summaryNodes` entry, in the same order, the actor's overall action
  frequencies weighted by absolute reach, rounded to 0.001; `null` when the actor never reaches the node.
  `summarizeFlop(flop, defs, root)` builds it.

A file's `path` may point to an older `v<k>/` directory of the same pack when its bytes did not change
(same sha256), so clients that already have it don't download it again.

## Flop file

```jsonc
{
  "v": 1, "scenario": "srp-btn-bb-100", "version": 1, "board": "AsKh7d",
  "pot": 5.5, "stack": 97.5, "iterations": 850, "exploitability": 0.42,
  "ranges": [ { "combos": "<bitmap>", "weights": "<uint8>" }, { "combos": "...", "weights": "..." } ],
  "nodes": [
    { "path": [], "player": 0, "pot": 5.5, "bets": [0, 0], "stacks": [97.5, 97.5],
      "actions": [ { "kind": "check", "to": 0, "label": "체크", "next": "action" },
                   { "kind": "bet", "to": 1.815, "label": "벳 33%", "next": "action" }, ... ],
      "combos": "<bitmap>", "strategy": ["<uint8>", "<uint8>", ...], "ev": ["<int16>", "<int16>", ...] },
    { "path": [1], "player": 1, "pot": 7.315, "bets": [1.815, 0], "stacks": [95.685, 97.5],
      "actions": [ { "kind": "fold", "to": 0, "label": "폴드", "next": "fold" },
                   { "kind": "call", "to": 1.815, "label": "콜", "next": "street" }, ... ],
      "combos": "...", "strategy": [...], "ev": [null, "<int16>", ...] },
    { "path": [0, 1], "player": 0, ..., "reach": "<uint8>" }
  ]
}
```

- `ranges`: the starting ranges [OOP, IP] with board-blocked combos removed.
- `nodes`: flop action nodes only. `path` is the list of action indices from the flop root (`[]` is the root,
  `[0, 1]` is "OOP checks, IP takes action 1"). Nodes are prefix-closed: every stored node's parent is stored,
  and the parent's action leading to it has `next: "action"`.
- `pot` (this street's bets included), `bets`, `stacks`: the state at the node, bb rounded to 0.001.
- `actions[i]`: `kind`, `to` (the actor's street total after the action), `label` exactly as the solver's
  `SolverAction`, plus `next`, what follows: `"action"` (another flop decision), `"street"` (the flop is over
  and the turn comes), `"fold"`, `"showdown"` (only possible in river packs), `"allin-runout"` (an all-in was
  called; the board runs out with no more decisions).
- `combos`: the actor's combos stored at the node: in its starting range, not blocked by the board, with
  relative reach that doesn't round to 0. Every per-combo array of the node is aligned with this list
  (ascending COMBOS index).
- `strategy[a]`: the solver's average strategy for action a.
- `ev[a]`: the actor's EV after taking action a: the solver's `ev[player]` at the child node, i.e. the
  expected net from the start of the flop (both players' nets sum to the pot). The node's own EV for a combo
  is Σ strategy × ev. A fold's EV is the same for every combo, −(stack − stacks[player]), so it is stored as
  `null`.
- `reach`: the actor's reach at the node divided by its starting weight (the product of its own action
  probabilities along the path). Left out when it is 1 for every combo (always at the root and at IP's first
  decision). Absolute reach = starting weight × reach; `DecodedNode.weight` holds it.

### Encodings and quantization

All binary arrays are standard base64 **without** `=` padding (decoders accept either).

| Data | Encoding | Precision |
|---|---|---|
| Combo set | 1326-bit bitmap, bit i = byte `i >> 3`, bit `i & 7` (LSB first): 166 bytes, 222 characters | exact |
| Range weight | Uint8, 255 = 1; any weight above 0 stays ≥ 1 | ±0.002 |
| Strategy | Uint8 per action; per combo the values sum to exactly 255 (largest remainder, ties to the lower action) | ±0.004 |
| Relative reach | Uint8, 255 = 1 | ±0.002 |
| EV | Int16 little endian, centi-bb; −32768 = no EV (NaN); clamped to ±327.67 bb | ±0.005 bb |
| Chips | JSON numbers rounded to 0.001 bb | |

`dequantize` gives each combo probabilities q / 255, except the last nonzero action, which gets 1 minus the
others, so adding them in action order gives exactly 1. Int16 centi-bb covers stacks up to ~300bb; a deeper
scenario needs a format change.

## Boards

`boardKey(cards)` writes the cards from high rank to low, equal ranks in suit order `s h d c`
(`"AhKd7c"`, `"KsKh7d"`); `parseBoardKey` only accepts keys in that order.

Files are stored for the **canonical suit-isomorphic representative** of a flop:
`canonicalBoard(cards)` tries the 24 suit relabelings and keeps the one whose sorted cards have the smallest
suit sequence (rainbow AK7 → `AsKh7d`, monotone → all spades, two-tone AK7 with A and 7 suited → `AsKh7s`).
There are 1755 classes (`flopClasses()`, weights summing to 22100). To look up a real flop, the app
canonicalizes it, finds the file by key, and maps every combo it wants to show through the returned
`suitMap` (`mapComboSuits(index, suitMap)`; back with `invertSuitMap`). This is exact because chart ranges
treat all suits alike.

## What is stored, what is not

Stored: the starting ranges; every flop action node with at most two actions on its path (the summary relies
on them); deeper flop nodes (raises and re-raises) while the file stays within the size budget, in order of
both players' relative reach mass (roughly how often the node is reached); per node and combo: strategy, action EVs, relative reach.

Not stored: turn and river nodes and chance nodes (the app solves the turn live, below); the opponent's EV at a
node; combos whose reach rounds to 0 at a node; nodes below the depth limit; preflop. Exact floats are not
kept anywhere; everything is quantized as above.

## Turn solving from a flop line

A flop line that ends the street (last action `next: "street"`, e.g. check-check or bet-call) is the start
of a turn spot the app can solve live with `src/solver` (turn spots of ~500 combos per range solve in tens
of seconds in a Web Worker, `docs/solver.md`).

1. `turnStart(decodedFlop, line)` returns the turn-start `pot`, the effective `stack` and both players'
   COMBOS-indexed `ranges`: starting weight × each player's own action probabilities along the line (a
   player's range only depends on their own actions). Every node on the line must be stored, which the
   prefix rule guarantees for lines through stored nodes.
2. The user picks (or the app deals) a turn card; the solver input is the flop plus that card, these ranges,
   pot and stack, and `treeSettings(manifestPack.scenario)` so the turn tree matches the presolved one. The
   solver skips combos blocked by the turn card.
3. The result is a subgame re-solve with fixed ranges. It can differ slightly from what the full flop solve
   played on that turn; the trainer treats it as the reference.

A line ending in `"allin-runout"` has no decisions left (stack 0); the app shows the equity instead.
`rangesAfter(flop, path)` gives both players' ranges at any stored node (e.g. to show the opponent's range
next to the actor's strategy).

## Size budget

Aim for **< ~60 KB per flop file before gzip**. A node costs about
`4/3 × n × (A + 2 × A_nonfold + r) + 300` bytes, where n is the actor's stored combos, A its actions,
A_nonfold the actions that aren't folds and r = 1 when `reach` is stored. Measured with random strategies and
EVs (an upper bound; real output has many pure 0/255 strategies and compresses better), board AsKh7d,
ranges from the charts after board removal:

| Ranges (OOP / IP combos) | Tree | Nodes | Raw | gzip |
|---|---|---|---|---|
| cash6 BB call / BTN open (679 / 604) | flop bets 33/75 + all-in | 8 (depth ≤ 2) | 66 KB | 44 KB |
| cash6 same | same | 12 (+ raises) | 76 KB | 50 KB |
| pub mid BB call / BTN open (532 / 420) | flop bets 33/75 + all-in | 8 (depth ≤ 2) | 50 KB | 33 KB |
| pub mid same | same | 12 (+ raises) | 58 KB | 38 KB |

The all-in at every flop node costs one action everywhere; at 100bb (SPR ≈ 17) it is almost never played,
so cash packs that need room should set `addAllIn: false` (an oversized raise still becomes all-in through
`allInThreshold`), which brings the cash depth-2 file (6 nodes) to about 44 KB raw, 29 KB gzip. The pipeline stops adding deeper nodes
when the next one would cross 60 KB, and never writes a file above 96 KB.

The manifest grows by ~400 bytes per file (path, sha256, summary). A pack covering a representative subset
(50–200 flops) keeps it well under 100 KB; covering all 1755 classes in several packs would call for moving
the file lists into per-pack index files in a v2 manifest.

## Pipeline

`src/presolve/` holds the pipeline; `scripts/presolve.mjs` runs it and `.github/workflows/presolve.yml` runs the
script every 6 hours in parallel shards (below).

- `scenarios.ts`: `SCENARIOS` (the app's packs, one per pack: id, set, title, version, tier, `meta: ScenarioMeta`,
  COMBOS-indexed starting ranges from the charts' effective frequencies), `CAL_SCENARIOS` (the calibration packs, set
  `"calibration"`, ranges from `calRanges.ts` plus ghost combos), `ALL_SCENARIOS`, `getScenario(id)` (either set),
  `PACK_SET_DIRS` (each set's directory), `chartRange(ref)`, `calRange(ref)`, `withGhosts`, `ghostRangeString`,
  `srpPotStack`, `solverInput(sc, board)` and the tree preset. `calRanges.ts` holds the calibration packs' source
  ranges (generated by `scripts/cal-ranges.mjs`), `sets.ts` the rules that route each set to its directory
  (`setDirs`, `writesCommitted`, `misplacedPacks`). A full flop tree multiplies every flop line by 49 turn × 48 river
  cards, so the tree is small. `TREE_SRP`, used by every pack: on the flop OOP only checks and may raise IP's bet by 60% of the pot
  after calling (the check-raise), IP bets 33% or 75% and can't re-raise; turn and river: one 66% bet each, no
  raises; no all-in button (`allInThreshold` still turns big bets into all-ins). The root therefore has a
  single action ("체크", frequency 1). By `estimateMemory` over the first 200 priority flops: cash 1.58–1.78 GB,
  pub 1.20–1.36 GB per flop. A tree with an OOP donk bet and no raises at all fits in 1.3 GB, but there the
  solver donks about half the time because IP can't raise the donk (a tree artifact), so it was dropped. Flop
  raises for both players plus turn raises would need 3.5–8 GB. Timings are in the Pipeline numbers below.
- `flops.ts`: textures of the 1755 classes, `FLOPS_BY_PRIORITY` (greedy weighted k-median over texture
  features, so every prefix is a representative subset: the first 25 already mix monotone, two-tone, rainbow,
  paired, high, low and connected boards) and `representativeWeightsFor(keys)` / `representativeWeights(n)`
  (every class assigned to its nearest solved flop; these are the manifest's `weight`s, summing to 22100).
- `extract.ts`: `extractFlop(input, solution, { scenario, version })` → the flop file, its JSON and byte count,
  the summary and the summary template. Action EVs are `solution.node([...path, a]).ev[actor]`; the root
  equity enumerates every runout (`rangeEquity`); the root EV is the pair-weighted range average
  (`rangeAverageEv`). `summarizeFile(file)` rebuilds a summary from a stored file.
- `scripts/presolve.mjs --scenario <id,...|all> --count <n> --budget-minutes <m> [--workers n] [--max-mb mb]
  [--out dir] [--cal-out dir] [--dry-run]`: `all` is every pack of both sets. Each set has its own directory and
  manifest: the app's packs go to `--out` (default `public/packs`), the calibration packs to `--cal-out` (default
  `calibration/packs` with the default `--out`, else `<out>/calibration`, so an experiment never writes into a
  committed directory). A run reads and rewrites only the manifests of the sets it covers; a calibration pack never
  enters `public/packs/manifest.json`. It solves the first `count` flops of the priority order that have no
  file yet for the pack's version, one flop per worker thread, skipping flops over `--max-mb`, abandoning any
  solve that would pass the budget, and writing each file and the manifest atomically as it goes. Before a
  file is written it must pass two checks, because a file under `v<version>/` is never replaced: its
  exploitability must be at most 1.5 × the scenario's `targetExploitability` (else it is logged as above the
  limit and not written; `--accept-above-target` overrides), and its summary nodes must match the pack's
  version (else it is not written: the tree or its labels changed, bump the version). The manifest is only
  rewritten when something other than `generatedAt` changes, so a run that adds nothing leaves no diff and
  makes no commit. A pack whose files can't be summarized keeps its previous manifest entry; the other packs
  are still updated. It refuses to run when a pack's settings changed without a version bump.
  When it writes into a committed directory (`public/packs` or `calibration/packs`) it also refuses `--iterations` /
  `--target` (they change the numbers but are not recorded in the pack; use a scratch `--out` for experiments) and
  refuses to run while `src/solver` has uncommitted changes (`--allow-dirty` overrides), so `solverCommit` always
  names code that exists.
- `--shard <i>/<n>` (`shard.ts`): solve only shard i of n. Flop k of `FLOPS_BY_PRIORITY` (its index in the full
  order, not among the missing flops) belongs to shard k % n, so jobs started from the same commit solve
  disjoint flops whatever they find on disk; each shard keeps the priority order, the `--count` prefix, the
  skip-what-exists rule and the budget. No flag is `0/1`, everything.
- `--rebuild-manifest` solves nothing: it rebuilds each covered set's `manifest.json` from each pack's current-version
  files on disk (after copying in the files of several shards) and writes it exactly as a run does (atomically, only when
  more than `generatedAt` changes, the old version's entry kept until the new version has a file, the same
  settings-vs-manifest checks). A file the manifest doesn't list yet gets the checks a run applies before
  writing one: `validateFlopFile`, scenario, version and board as its path says, the size cap, the
  exploitability limit (`--accept-above-target` overrides) and summary nodes equal to the pack's. When a pack's
  files fail them its entry is kept as it was and the script exits 1. `--summaries-from <manifest>`
  (repeatable) takes a new file's summary from another run's manifest when path and sha256 match, i.e. the exact
  summary of the solve rather than one rebuilt from the quantized file (`summarizeFile`).

Measured run (4-core dev machine, `--count 3 --workers 3`, other jobs sharing the CPU): three
`srp-btn-bb-100` flops (Qs8h5h, Qs8h5d, 8s5s3h) took 9.2–9.6 min each to reach 0.40–0.46% of the pot in
80 iterations (~7 s per iteration), plus ~22 s of extraction; estimate 1.66–1.71 GB, 1.75–1.79 GB used per
worker; files 36–38 KB raw, 18 KB gzip (6 nodes). The strategies look like solver output should: BB checks,
BTN c-bets ~55% mixing 33% and 75%, BB facing 33% folds ~32%, calls ~52%, check-raises ~16% (sets always).
The workflow (public repository: standard runners with 4 vCPU and 16 GB, unlimited minutes, 6 h per job) runs
every 6 hours, at 05:23, 11:23, 17:23 and 23:23 UTC, and starts 16 `solve` jobs with `--shard i/16 --workers $(nproc) --budget-minutes 300 --count 1755` (4 workers on
these runners); each uploads the flop files it added (app packs under `files/`, calibration packs under `cal-files/`)
and its manifests (`shard-manifest.json`, `shard-cal-manifest.json`), for the summaries. All jobs check out the
branch head that a first `plan` job reads when the run starts, so a run that waited behind another one continues
from that run's commit. A `merge` job, which also runs when some shards failed or timed out, copies the files
into one checkout (`public/packs` and `calibration/packs`; an existing file is never replaced), runs
`--rebuild-manifest` with all the shards' manifests as `--summaries-from` and pushes one commit, "Presolve: N new
flops" (N counts both directories; nothing is committed when the rebuild exits 1; the shard artifacts are kept for 2
days). When the branch changed a manifest meanwhile (a one-line manifest always conflicts), the push keeps the
branch's files, runs `--rebuild-manifest` again on top of the branch and counts N again. The result is the manifest one unsharded run over the same flops would write: a local 2-shard
simulation gave byte-identical flop files and an identical manifest apart from `generatedAt`. At ~11
core-minutes per flop one run solves roughly 1,700 flops, about a whole pack (1,755). A run with work takes
~5 h 15 min. While flops are left, a run whose merge pushed new flops starts the next run itself at the end
(`gh workflow run` with the run's own inputs; a `workflow_dispatch` is one of the two events `GITHUB_TOKEN` may
trigger), so the runs follow each other back to back (the concurrency group makes the new run wait for the merge
to finish). A run that pushed nothing does not, so it never loops without progress (for example when only flops
over `--max-mb` are left), and the 6-hourly schedule stays as the backstop: GitHub sometimes never starts a
scheduled run (neither the 11:23 nor the 17:23 UTC run of 2026-11-16 started). With nothing left a run ends
within minutes. A push to `master` that changes `src/presolve/scenarios.ts` or `src/presolve/calRanges.ts` (a new
pack, a version bump, new calibration ranges) also starts a run at once; it solves only what is missing, like any
run, and its pushes then start the next runs as above. The bot's own "Presolve" commits never trigger it: they touch
only the pack directories, and pushes made with `GITHUB_TOKEN` start no workflow anyway.

## Versioning and the presolve job

- `version` bumps when anything that changes the numbers changes: solver code (`solverCommit`), scenario
  settings, ranges, or the solve targets. New content goes under `v<version>/`; a file whose bytes are
  unchanged may keep its old path.
- `solverCommit` is the last commit that changed `src/solver` apart from its `*.test.ts` files, recorded when
  the version's first file is written. When a later run finds a different commit it logs "solver changed
  since v<k>"; the job keeps adding flops with the new code until the version is bumped, so bump it when the
  solver change affects the numbers.
- Within a version the job only adds flops (new files under the current directory). It never re-solves or
  replaces a file: a flop that misses 1.5 × its exploitability target is not written at all (and the job
  fails so someone raises the scenario's `iterations`), and changing a file means a new path, i.e. a version
  bump for that pack.
- Old version directories stay until no manifest from the last few days references them.
- The job runs `validateFlopFile` on every file and `validateManifest` on the manifest before committing.

## Calibration of the preflop solver

The 9-handed preflop solver (`docs/preflop-solver.md`) does not solve flops: it values them with a realization model
fitted to these packs. `scripts/fit-realization.mjs` reads every flop file of the packs it fits, takes each combo's EV
at OOP's root and at IP's node after OOP checks, and fits the model to the per-class pot shares. The result,
`src/poker/preflop/eqrFit.ts`, records each pack's version, flop count and a hash of its file list. For the packs
this means:
- New flops change the fit's inputs, but the charts move only when the fit is rerun. The committed fit (`2862daa7a90f`,
  2026-11-17) names the pack state it used: `srp-btn-bb-100` v1 and `pub-srp-btn-bb-55` v2 with all 1,755 flops
  each, at their exact class weights. Both packs are complete, so the presolve job cannot change its inputs any more;
  the planned refit on every flop class is done.
- Which packs are fitted is a decision, not a side effect of the manifest. `fit-realization.mjs --packs <ids>` names
  them; without `--packs` it fits the packs the committed `eqrFit.ts` names, and `--packs all` takes every manifest
  pack. Every fit and `--check` names its packs (`--packs srp-btn-bb-100,pub-srp-btn-bb-55`).
- `pub-srp-utg-bb-55` is in the manifest but kept out of the fit. Predicted as held-out data (1,728 of its 1,755
  flops), the fit misses it by a weighted RMS of 0.056 of the pot OOP and 0.083 IP, against 0.014 / 0.019 on the pub
  BTN pack (the same game, pot and tree; only the ranges differ): against UTG the BB realizes about 0.046 of the pot
  more than the model says, and UTG's big pairs 0.14–0.17 less. A joint fit with all three packs broke a sign guard
  of the model and moved the charts back toward known artifacts, so it was rejected (`docs/preflop-solver.md` §3.7
  bias 2). The pack's last flops cannot change the shipped fit.
- The fit reads IP's root EV at IP's node after OOP's check, which is IP's root only because OOP never bets the flop
  in these trees (`sizes.flop[0].bet` is `[]`); the opponent's EV at a node is not stored. It stops if OOP checks
  less than 99.9% of its range at the root, so a pack that gives OOP a donk bet first needs IP's root EV in the flop
  file.
- The trees (no OOP donk bet, two IP sizes) and the hand-made chart ranges are the calibration's known biases.
  The calibration packs below are the first packs made for the fit alone.
- Calibration packs enter a fit only when `--packs` names them (`--packs all` is still the app's manifest); the
  default (the committed fit's packs) looks them up in both manifests, so a fit that names them stays reproducible
  with `--check`. `--cal-manifest <file>` points the script at a scratch run's calibration manifest.

### Calibration packs

The short stages of the preflop solver (25, 20 and 15bb) are solved but not in the app: their BB defense is set by
the realization model at SPR 1–4, which no pack measured (the app's packs sit at SPR 17.7 and 7.9), and the low-SPR
rules one could defend move it by 25–50pp (`docs/preflop-solver.md` §3.8). Two packs measure flop realization in the
short stages' own single raised pot, for a refit of the low-SPR part of the model (α's shrink and the surplus shrink
below SPR 6):

- `cal-srp-btn-bb-20` and `cal-srp-btn-bb-15` (table in Scenarios): everyone 20bb (15bb), 9-handed with the 1bb BB
  ante, BTN opens 2bb, SB folds, BB calls; pot 5.5, stack 17 (12), SPR 3.09 (2.18). Tree `TREE_SRP`, the app packs'
  own, so their rows differ from the app packs' in stack depth and ranges only; at these stacks lines end in an
  all-in sooner (the check-raise of a 75% bet is an all-in at both stacks, and so is the turn bet after a called
  75% flop bet).
  Solve targets as in the app packs: 300 iterations at most, 0.5% of the pot.
- **Ranges: the stages' own.** `src/presolve/calRanges.ts`, generated by `scripts/cal-ranges.mjs` from a make-preflop
  export of the stages (`--from <data file>`; `--check` compares). The committed file comes from the main solve of
  `20bb-2` and `15bb-2` on the release schedule with the shipped fit `2862daa7a90f` (passed at 1,500 iterations,
  NashConv 0.29 / 0.15 mbb/hand; `make-preflop.mjs --stages 20bb-2,15bb-2 --no-sensitivity --no-twostart --out
  <scratch>`; the sensitivity and two-start solves change only confidence marks, not σ̄). Two earlier feasibility
  solves of the same presets give the same file (`cal-ranges.mjs --check`), and so can a release run's
  `--check-stage-out DIR` export (`--from DIR/20bb-2.json --from DIR/15bb-2.json --check`). OOP is the BB's flat call of
  the BTN's open after the SB folds (`bb-vs-btn-open:call`: 55.4% of hands at 20bb, 43.3% at 15bb), IP the BTN's 2bb
  open (`rfi-btn:open`: 23.0%, 12.6%; the SB's fold and the BB's call don't depend on the BTN's hand, so this is its
  flop range). Both are capped the solver's way: the BB jams AA, KK, AKs and the like instead of flatting, and the
  BTN jams much of what it plays at 15bb.
- **Ghost combos.** Every hand class starts with at least `GHOST_WEIGHT` = 2/255 ≈ 0.0078 on both sides (`withGhosts`, recorded
  as the meta's `ghostWeight`), so the hands just outside a range (the BB's folds and its jams next to its flats, the
  BTN's folds and jams next to its opens) get a measured flop EV and a refit can place the fold boundary from
  measurements instead of extrapolating. The source ranges are snapped to tenths, so a class at exactly 2/255 is a
  ghost. At the 0.02 floor first tried, ghosts were 1.4% (OOP, 62 classes) and 6.0% (IP, 116 classes) of the weighted
  combos at 20bb, 2.4% (80) and 11.9% (140) at 15bb (the BTN's narrow 15bb open); at 2/255 they are about 0.4 of that. Ghosts are real combos to the solver, so they move the
  real hands' numbers too. On `cal-srp-btn-bb-15` Qs8h5h, solved to 0.13–0.14% of the pot with and without ghosts,
  the 0.02 floor moves OOP's real classes' pot share by 0.025 on average (+0.019 signed: OOP realizes more against an
  IP range padded with hands the BTN would not open) and IP's by 0.009; a 0.005 floor by 0.007 (+0.005) and 0.002.
  The convergence noise at the packs' 0.5% target is 0.003 (OOP) and 0.005 (IP), and the deep-stack fit's whole RMS
  is 0.014 / 0.019. At 20bb (6% ghosts on IP) 0.02 and 0.005 differ by 0.007 / 0.002 on Qs8h5h. The floor does not
  change the cost (every combo is in both ranges either way); `ghostRangeString` writes any floor exactly in the
  meta's range strings (`rangeToString` rounds to 0.01). So the floor is 2/255: the smallest weight the packs' Uint8
  encoding keeps apart from zero with room, which moves the real classes about as little as 0.005 does.
  The fit weights a class row by its reach, so ghost rows weigh under 1% of a full class; a refit that wants them to set
  the boundary has to weight them on purpose.
- **What the fit reads is stored.** OOP only checks at the root (no donk bet), so OOP's root EV is its check EV at
  node `[]` and IP's root EV is its EV at node `[0]`, both for every combo (ghosts included: every combo has weight,
  and relative reach is 1 at both nodes); `fit-realization.mjs`'s MIN_CHECK assertion holds by construction.
- **Cost.** With every combo in both ranges, a flop's size depends only on the board's suit pattern: by
  `estimateMemory` 430–473 MB (monotone), 902–931 MB (two-tone) or 1,476 MB (rainbow), mean 918 MB over the 1,755
  flops, 76,054 action nodes at both stacks; a worker used 977 MB on a two-tone flop and 1,551 MB on a rainbow one,
  so 4 workers fit a 16 GB runner. Six local solves (`--count 3`, both packs, a loaded 4-core machine) reached
  0.38–0.48% of the pot in 50–60 iterations (the app packs need 74–79 on average), and wrote 54–59 KB per file (all
  six flop nodes, under the 60 KB target; about 27 KB gzip). One iteration costs 1.13–1.24 × one of
  `pub-srp-btn-bb-55` on the same board (single thread, interleaved, rainbow, two-tone and monotone boards), whose
  flops took 7.7 min plus 22 s of extraction on the runners (1,749 flops, 2026-11-16). So a calibration flop is about
  7.7 × 1.18 × 57 / 74 + 0.4 ≈ 7.4 core-minutes on a runner (rainbow about 11, monotone about 3.5), and one
  16-shard run solves about 16 × 4 × 290 / 7.4 ≈ 2,500 flops: a pack (1,755 flops) takes about 0.7 of a run, both
  packs about 1.4 runs. The job interleaves the packs, so the first run (5 h 15 min) leaves both about 70% done, in
  priority order (a representative subset at every step), and the run it starts finishes them in about 2.5 hours.
  The 3,510 files add about 200 MB to the checkout (about 95 MB to the git history; the app's packs take 159 MB).
- **Versions.** The ranges are pinned in `calRanges.ts`. Rerunning `cal-ranges.mjs` after a refit or a new stage
  solve changes them, and the packs then need a version bump (the presolve job refuses changed settings otherwise).
  Like every pack, they record their `solverCommit` and never replace a file.

## API (`src/presolve/format.ts`)

- Binary: `encodeBase64`/`decodeBase64`, `encodeUint8`/`decodeUint8`, `encodeInt16`/`decodeInt16`,
  `encodeCombos`/`decodeCombos`.
- Quantization: `quantizeStrategy`, `dequantize`, `quantizeUnit`, `quantizeEv`/`dequantizeEv`, `roundChips`.
- Boards and combos: `boardKey`, `parseBoardKey`, `canonicalBoard`, `flopClasses`, `comboIndex`,
  `comboString`, `mapComboSuits`, `invertSuitMap`.
- Paths: `packFilePath(scenarioId, version, board)`, `pathKey`, `PACKS_DIR`, `MANIFEST_PATH`.
- Writing: `encodeRange`, `encodeFlopNode(source)` (COMBOS-indexed solver arrays in, quantized node out),
  `summaryNodeDefs`, `summarizeFlop`, `validateFlopFile`, `validateManifest`.
- Reading: `decodeRange`, `decodeFlopNode`, `decodeFlopFile`, `nodeActionTotals`, `aggregateByHandClass`
  (169 hand classes, weighted by reach × starting weight), `comboRows`, `rangesAfter`, `turnStart`,
  `treeSettings`.
