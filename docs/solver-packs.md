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
lists them; only `scripts/fit-realization.mjs` reads them (Calibration packs, below). The packs of the calibration queue
write slim files: no action nodes, only what the fit reads (`storage: "rootClasses"`, about 2 KB a flop).

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

After them comes the calibration queue: 41 heads-up pots of the shipped solver stages (100bb-2.2, 55bb-2.2, 35bb-2,
100bb-3) with each stage's own ranges and sizes, solved one pack after the other (The calibration queue, below, lists
every pack).

The pot counts all dead money (SB, ante): pot = 2 × open + 0.5 + ante, and the effective stack is the BB's,
start − open − ante (the BB paid the ante too). `src/presolve/scenarios.ts` derives both from the play-mode rules
(`openSize`, `STAGE_STACK`, `PUB_TABLE.bbAnte`). Any other heads-up pot (`huPotStack`): pot = 2 × put + the blinds of the
seats that folded + the BB's ante, where put is each player's total bet when the flop comes (the open, 3-bet or 4-bet
both called, 1 in a limped pot); each player has start − put behind, the BB also less its ante. The numbers above are what the pipeline is expected to use; the
manifest's `scenario` block is the authority. A chart ref is `<set>/<stage>/<scenario>:<action>`, the ids of
`src/data/charts.ts` (`Scenario.id` + an action key); the range string written into the manifest is the
hand-class frequency of that action (`Scenario.strategy[hand][action]`). A calibration pack may join the refs of one
player's line with ` × ` (`LINE_SEP`), e.g. `solver/100bb-2.2/rfi-btn:open × solver/100bb-2.2/btn-open-vs-bb-3bet:call`
for the BTN that opened and called the BB's 3-bet: its flop range is the product of its own actions' frequencies
(`lineRange`; the others' actions on the line don't depend on its hand).

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
ranges; in the queue's packs only on the classes that reach each player's last decision, so a class missing from a
range string is one the player never holds there), and in the calibration queue's packs `compress: true` (solved with the solver's 16-bit storage),
`storage: "rootClasses"` (slim files, below) and `aggressor` (the last preflop raiser: 0 OOP, 1 IP, null in a limped
pot). `treeSettings(meta)` turns it into solver input fields.

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

### Slim files (calibration queue, `storage: "rootClasses"`)

```jsonc
{
  "v": 1, "scenario": "cal-3bp-bb-btn-100", "version": 1, "board": "Qs8h5h",
  "pot": 19.1, "stack": 90.2, "iterations": 64, "exploitability": 0.48,
  "ranges": [ { "classes": "<uint8 ×169>" }, { "classes": "<uint8 ×169>" } ],
  "nodes": [],
  "rootClasses": {
    "ev": ["<int16 ×169>", "<int16 ×169>"],
    "actions": [ { "kind": "check", "to": 0, "label": "체크", "next": "action" },
                 { "kind": "bet", "to": 6.303, "label": "벳 33%", "next": "action" }, ... ],
    "strategy": ["<uint8 ×169>", "<uint8 ×169>", "<uint8 ×169>"]
  }
}
```

- `ranges[p].classes` (`ClassRange`): one Uint8 weight per hand class in `ALL_HANDS` order; every combo of the class that
  is off the board has it (chart ranges are the same for every combo of a class; `encodeClassRange` refuses one that
  is not). Decoded, it is the same per-combo range an `EncodedRange` gives. Only allowed together with `rootClasses`
  and no nodes.
- `rootClasses.ev[p]`: player p's EV at the flop root per class (Int16 centi-bb, net from the start of the flop, the
  solver's root `ev[p]`), averaged over the class's combos in the range with their starting weights; EV_NAN exactly for
  a class the player doesn't hold. IP's root EV is stored directly, so it doesn't need OOP to check at the root.
- `rootClasses.actions` and `strategy`: OOP's root actions and, per action, its frequency per class (start-weighted;
  each class sums to 255, or is all 0 for a class OOP doesn't hold).
- The manifest entry of a slim pack has `summaryNodes: []` and every file's `summary.freq` is `[]`; `summary.equity` and
  `summary.ev` are the solver's, as in every pack.

That is exactly what the realization fit reads (Calibration of the preflop solver, below): per class, the root EV of
each side, and per combo the ranges for the equities. The fit's row weight for a combo is its node weight, starting
weight × relative reach (1 at the root), the same for every combo of a class, so the per-class mean gives the class
rows of a full file (within the two 0.005 bb roundings). A slim file is about 1.8 KB with one OOP root action and 2.4 KB
with three, against 54–59 KB for the full files of the first calibration packs.

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
kept anywhere; everything is quantized as above. (A slim calibration file stores no nodes at all, see above.)

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
  `srpPotStack`, `huPotStack`, `lineRange`, `lineReach`, `solverInput(sc, board)` (with `compress: true` only for a pack whose meta
  records it) and the tree presets. `calRanges.ts` holds the calibration packs' source ranges and their chart lines
  (generated by `scripts/cal-ranges.mjs`), `sets.ts` the rules that route each set to its directory
  (`setDirs`, `writesCommitted`, `misplacedPacks`). Every scenario has a `queue` value (the job's order, below): 0 for the
  app's packs and the first two calibration packs, 1–41 for the calibration queue. A full flop tree multiplies every flop line by 49 turn × 48 river
  cards, so the tree is small. `TREE_SRP`, used by every pack: on the flop OOP only checks and may raise IP's bet by 60% of the pot
  after calling (the check-raise), IP bets 33% or 75% and can't re-raise; turn and river: one 66% bet each, no
  raises; no all-in button (`allInThreshold` still turns big bets into all-ins). The root therefore has a
  single action ("체크", frequency 1). By `estimateMemory` over the first 200 priority flops: cash 1.58–1.78 GB,
  pub 1.20–1.36 GB per flop. A tree with an OOP donk bet and no raises at all fits in 1.3 GB, but there the
  solver donks about half the time because IP can't raise the donk (a tree artifact), so it was dropped. Flop
  raises for both players plus turn raises would need 3.5–8 GB. Timings are in the Pipeline numbers below.
  Two more presets serve the calibration queue: `TREE_OOP_AGGR` for pots where OOP raised last preflop (the flop is
  TREE_SRP's mirror: OOP bets 33% or 75% and IP may raise 60%; after OOP checks, IP bets 50% and OOP may check-raise
  60%; one raise per street) and `TREE_LIMP` for the limped pot (both bet 50% and may raise 60%); turn and river as
  TREE_SRP.
- `flops.ts`: textures of the 1755 classes, `FLOPS_BY_PRIORITY` (greedy weighted k-median over texture
  features, so every prefix is a representative subset: the first 25 already mix monotone, two-tone, rainbow,
  paired, high, low and connected boards) and `representativeWeightsFor(keys)` / `representativeWeights(n)`
  (every class assigned to its nearest solved flop; these are the manifest's `weight`s, summing to 22100).
- `extract.ts`: `extractFlop(input, solution, { scenario, version }, opts)` → the flop file, its JSON and byte count,
  the summary and the summary template; `opts.storage: "rootClasses"` writes a slim file (per-class ranges and root,
  no nodes). Action EVs are `solution.node([...path, a]).ev[actor]`; the root
  equity enumerates every runout (`rangeEquity`); the root EV is the pair-weighted range average
  (`rangeAverageEv`). `summarizeFile(file)` rebuilds a summary from a stored file.
- `scripts/presolve.mjs --scenario <id,...|all> --count <n> --budget-minutes <m> [--workers n] [--max-mb mb]
  [--out dir] [--cal-out dir] [--dry-run]`: `all` is every pack of both sets. Each set has its own directory and
  manifest: the app's packs go to `--out` (default `public/packs`), the calibration packs to `--cal-out` (default
  `calibration/packs` with the default `--out`, else `<out>/calibration`, so an experiment never writes into a
  committed directory). A run reads and rewrites only the manifests of the sets it covers; a calibration pack never
  enters `public/packs/manifest.json`. It solves the first `count` flops of the priority order that have no
  file yet for the pack's version, one flop per worker thread, skipping flops over `--max-mb`, abandoning any
  solve that would pass the budget, and writing each file and the manifest atomically as it goes. The order is
  `jobQueue` (`shard.ts`): the packs' lists of missing flops grouped by their `queue` value, lower first, and
  interleaved within a group (one flop of each pack in turn). With every pack at 0 that is the plain interleave the job
  always used; the calibration queue (1, 2, ...) is solved one pack after the other, each shard finishing its share of a
  pack before it starts the next, so the packs finish in priority order. A pack whose meta has `storage` is extracted
  with it; every other pack exactly as before. Before a
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
  file. The slim files of the calibration queue store it (`rootClasses.ev[1]`, the solver's root EV of IP), so their
  OOP may bet; the fit then reads both sides from `rootClasses` (every combo of a class gets the class's EV, which gives
  the class rows of a full file) and needs no check assertion.
- **Exactly what the fit reads**, per flop file: the board, the pot (checked against the manifest), both starting ranges
  per combo (weights, and the per-combo flop equities it enumerates against the other range), and per combo of each
  side the root EV (Σ strategy × action EV at OOP's root and at IP's node after the check); from the manifest the
  file's path, sha256 and weight, the pack's version, format, pot, stack and range strings (the expectations over the
  opponent's range). It aggregates per hand class at once, with a combo's node weight (the same for every combo of a
  class at the root). The planned refits (v1.5 and the low-SPR refit, `docs/preflop-solver.md` §9) use the same class
  rows: other forms, α per SPR, c and u per context and a u that depends on the opponent's range all fit per-class
  shares and equities. Nothing deeper in the tree, no strategy and no per-combo EV within a class enters. The slim
  files hold that and OOP's root frequencies per class (a few hundred bytes, to see how an OOP raiser plays).
- The fitted form is the single raised pot with an IP aggressor (O = caller, I = aggressor). `fit-realization.mjs`
  refuses a pack whose manifest scenario records another `aggressor` (the queue's OOP-raiser and limped pots): they
  are for a fit with c and u per context. The SPR shrinks are not in the fitted form either (the app's packs sit at
  SPR 7.9 and 17.7), so every pack below SPR 6 is for the low-SPR refit as well.
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

### The calibration queue

After the two short-stage packs, `CAL_SCENARIOS` holds the calibration queue (`QUEUE` in `scenarios.ts`): 41 heads-up
pots of the shipped solver stages, each with its stage's own ranges and sizes, solved one pack after the other
(`queue` 1–41, `jobQueue`). Their purpose is the refit that raises the confidence of the chart scenarios the app badges
낮음 or 보통 (`docs/preflop-solver.md` §6.6): today the realization model is fitted on one context (BTN vs BB, IP raiser,
hand-made ranges, SPR 7.9 and 17.7) and every other context, SPR and opponent range is a named prior (§3.8) or an
extrapolation (§3.7 biases 2, 3, 6, 7, 9). Each pack measures one of them where the chart applies it. Every pack is
heads-up: the postflop solver (`src/solver`) solves two players, so the multiway part of the model (§3.6: κ_k, α_mw,
c_pos) stays uncalibrated, and a 3-way postflop chart would need a multiway solver first.

- **Ranges: the shipped chart's, pinned.** `calRanges.ts` (`node scripts/cal-ranges.mjs --from src/data/sets/preflopData.ts
  --keep`, which keeps the short stages' committed ranges) holds every spot of the queue's lines at the shipped fit
  `2862daa7a90f`, with the stage's sizes and each spot's chart line (`CAL_RANGE_LINES`). A player's flop range is the
  product of its own actions along the line (`lineRange`): the 3-bettor brings its 3-bet range, the caller of a 3-bet its
  open × its call, the 4-bettor its open × its 4-bet. The tests check every ref against the shipped chart (scenario,
  action, line, `reachFrom`, and the numbers while the chart's fit is the pinned one), every put against its chart line,
  and every pot and stack against a hand-worked table. A refit that regenerates the charts does not change a pack in
  place: the pins only move when `cal-ranges.mjs` is rerun, and then the packs need a version bump.
- **Ghost combos**, as in the first two packs (`GHOST_WEIGHT` = 2/255), on the classes that reach each player's last
  decision of its line (`lineReach`): every class for a one-decision line (the BB facing an open, the opener, the
  3-bettor, the limper, the BB checking a limp), the open range for the caller of a 3-bet and for the 4-bettor, the
  3-bet range for the caller of a 4-bet. A hand the player never holds at that decision (the BTN's 72o when it calls a
  3-bet) has no fold boundary to measure, and ghosting it only moves the real hands' numbers. With every class
  ghosted, ghosts were 15% and 12% of the 100bb-3 4-bet pot's ranges (4% and 5% of hands) and 11% and 8% of the 100bb
  one's; on their first flop (Qs8h5h, against a no-ghost solve to 0.1% of the pot) they moved the real classes' pot
  share by 0.037 OOP / 0.046 IP (100bb-3) and 0.029 / 0.034 (100bb), +0.02 to +0.05 signed (each side realizes more
  against a range padded with hands it never faces), 5 to 20 times the convergence noise; a 1/255 floor on every
  class still moved it 0.017 / 0.023 and 0.013 / 0.018. On the reaching classes only, ghosts are 5.1% / 1.4% and 3.7%
  / 0.9% of those ranges and move the pot share 0.008 / 0.013 and 0.008 / 0.009 (+0.001 to +0.009 signed; 0.009 /
  0.012 and 0.013 / 0.011 on the rainbow Qs8h5d), against 0.004 / 0.002 and 0.007 / 0.005 of convergence noise at the
  0.5% target (the no-ghost solve at the target against the one at 0.1%), about what the running packs' ghosts cost
  (Calibration packs, above). Ghosts are now at most 8.0% of a range's weighted combos: the BTN's flat of the 100bb CO
  open (8.1% of hands, a one-decision line); there 2/255 moves the real classes' pot share 0.011 / 0.010 (+0.005 /
  +0.004 signed) against a no-ghost solve at the same target on Qs8h5h, 1/255 0.006 / 0.005, so it keeps 2/255.
  Everywhere else ghosts are at most 5.9% (`calibration.test.ts` pins every range under 8.1%). The reach rule also
  leaves the callers of 3-bets and 4-bets with fewer combos, so those packs need less memory and time (below).
- **Trees.** A pot with an IP raiser keeps `TREE_SRP`, the app packs' tree, so those rows differ from the fitted ones in
  stack, ranges and pot only. A pot with an OOP raiser (the SB's open, the blinds' 3-bets, the CO's 4-bet, the CO's open
  that the BTN flats) gets `TREE_OOP_AGGR` (the raiser bets 33% or 75%, the caller may raise 60%; checked to, the caller
  bets 50% and may be check-raised 60%), and the limped pot `TREE_LIMP`. In TREE_SRP an OOP raiser could never bet, which
  would measure a tree artifact, not realization. `aggressor` in the meta says which applies; the fit refuses the OOP and
  limped ones (its form has an IP raiser).
- **16-bit storage** (`compress: true`): with every combo in both ranges, a rainbow flop needs up to 3.8 GB in Float32
  (over 2 GB, the job's `--max-mb` 2000, in 27 of the 41 packs; too much for 4 at once on a 16 GB runner in 20).
  Compressed, the largest flop of the queue is 1,928 MB (the deep OOP-raiser pots, on a rainbow board; 3.6% under
  `--max-mb`, so a bigger tree would get those flops skipped on every run, which the tests catch), a pack's mean flop
  102–1,198 MB, and 4 run at once. It costs about 13% more time per iteration and as many iterations
  (`docs/solver.md`); one rule for every queued pack keeps their numbers comparable.
- **Slim files** (`storage: "rootClasses"`, Files above): 1.87–2.46 KB a flop on the dry runs below.

**Order.** The pots with an IP raiser come first, because `fit-realization.mjs` can read them now: its form is the
IP-aggressor pot, and it refuses an OOP raiser or a limped pot until a fit with c and u per context exists (Trees,
above; `docs/preflop-solver.md` §9 v2). 1–7: the main stage (100bb, 2.2bb opens) and the SPR curve of its BTN vs BB
pot (35bb 5.8, 55bb 8.8, 100bb 16.4, next to the running 2.2 and 3.1). The SPR knee comes first because the low-SPR
refit the running packs feed is next, then the v1.5 round-1 pack and the biggest measured miss (range-aware u), the CO
opener, the IP 3-bettor and the BB's 3-bet of the SB. 8–13: the IP-raiser 3-bet pots of the other stages (SPR
1.7–4.4), for α's low-SPR rule. 14–20: the opener series vs the BB of the other stages. Then the pots with an OOP
raiser and the limped pots, in the same order of value: 21–26 the main stage's (the blind 3-bet pot where PF-SANITY-6
fires first, then the SB's open, the SB's 3-bet, the small 4-bet pot, the IP caller and the limped pot), 27–33 the
OOP-raiser 3-bet and 4-bet pots of the other stages (SPR 1.5–3.9: α's low-SPR rule and the 4-bet / jam split;
PF-SANITY-6 fires on 27 / 21 spots at 100bb-3 / 55bb), 34–41 their SB opens, IP callers and limped pots. These 21
packs are 45.8 runs (10 days) of the queue; they wait for that fit either way, and solving them last puts the
measurements a fit can use today first. The BTN flats the CO's 35bb open with 0.9% of hands, so that pot is left out.

| # | id | stage | OOP / IP | preflop | pot / stack (SPR) | ranges (OOP; IP) | purpose (badges: §6.6 confidence, move in pp) | core-min / flop | runs | KB / flop |
|---|---|---|---|---|---|---|---|---|---|---|
<!-- queue-table:start -->
| 1 | `cal-srp-btn-bb-35` | 35bb-2 | BB / BTN | BTN 2bb 오픈, 나머지 폴드, BB 콜 | 5.5 / 32 (5.82) | bb-vs-btn-open:call; rfi-btn:open | SPR 5.8, the knee of the surplus shrink (SPR_SURPLUS = 6), between the running 3.1 and the app's 7.9; 35bb BB defense is 낮음 (vs BTN 23.6, vs CO 22.6) | 15.1 | 1.47 | 1.87 |
| 2 | `cal-srp-btn-bb-100` | 100bb-2.2 | BB / BTN | BTN 2.2bb 오픈, 나머지 폴드, BB 콜 | 5.9 / 96.8 (16.41) | bb-vs-btn-open:call; rfi-btn:open | §9's round-1 pack: the main stage's own ranges at SPR 16.4, ghosts at the BB's fold boundary (bias 3, the extrapolated 72o / AA rows); bb-vs-btn-open 보통 18.7 | 21.7 | 2.13 | 1.88 |
| 3 | `cal-srp-utg-bb-100` | 100bb-2.2 | BB / UTG | UTG 2.2bb 오픈, 나머지 폴드, BB 콜 | 5.9 / 96.8 (16.41) | bb-vs-utg-open:call; rfi-utg:open | a u that depends on the opener's range (bias 2), with the solver's ranges at 100bb (pub-srp-utg-bb-55 is the hand-made chart at 55bb, 2.5bb); bb-vs-utg-open 보통 13.8 | 22.5 | 2.21 | 1.88 |
| 4 | `cal-srp-co-bb-100` | 100bb-2.2 | BB / CO | CO 2.2bb 오픈, 나머지 폴드, BB 콜 | 5.9 / 96.8 (16.41) | bb-vs-co-open:call; rfi-co:open | the middle of the opener series (CO 35% between UTG 14% and BTN 54%); bb-vs-co-open 보통 11.0 | 22.5 | 2.21 | 1.88 |
| 5 | `cal-3bp-btn-co-100` | 100bb-2.2 | CO / BTN | CO 2.2bb 오픈, BTN 3벳 6.6bb, 블라인드 폴드, CO 콜 | 15.7 / 93.4 (5.95) | rfi-co:open × co-open-vs-btn-3bet:call; btn-vs-co-open:3bet | IP 3-bettor (the fitted role) at SPR 6.0 with 3-bet ranges; co-open-vs-btn-3bet 낮음 21.7 | 11.6 | 1.12 | 1.88 |
| 6 | `cal-srp-btn-bb-55` | 55bb-2.2 | BB / BTN | BTN 2.2bb 오픈, 나머지 폴드, BB 콜 | 5.9 / 51.8 (8.78) | bb-vs-btn-open:call; rfi-btn:open | SPR 8.8 with the solver's ranges (the app's 55bb pack has the hand-made pub ranges at 7.9); 55bb bb-vs-btn-open 보통 18.4 | 19 | 1.86 | 1.87 |
| 7 | `cal-3bp-bb-sb-100` | 100bb-2.2 | SB / BB | 나머지 폴드, SB 3bb 오픈, BB 3벳 9bb, SB 콜 | 19 / 90 (4.74) | rfi-sb:raise × sb-open-vs-bb-3bet:call; bb-vs-sb-open:3bet | blind vs blind 3-bet pot; sb-open-vs-bb-3bet 낮음 36.2, the stage's least confident spot | 10.9 | 1.05 | 1.87 |
| 8 | `cal-3bp-btn-co-55` | 55bb-2.2 | CO / BTN | CO 2.2bb 오픈, BTN 3벳 6.6bb, 블라인드 폴드, CO 콜 | 15.7 / 48.4 (3.08) | rfi-co:open × co-open-vs-btn-3bet:call; btn-vs-co-open:3bet | SPR 3.1, IP 3-bettor; co-open-vs-btn-3bet 낮음 21.0 | 7.6 | 0.73 | 1.88 |
| 9 | `cal-3bp-bb-sb-55` | 55bb-2.2 | SB / BB | 나머지 폴드, SB 3bb 오픈, BB 3벳 9bb, SB 콜 | 19 / 45 (2.37) | rfi-sb:raise × sb-open-vs-bb-3bet:call; bb-vs-sb-open:3bet | SPR 2.4; sb-open-vs-bb-3bet 낮음 37.0 | 9.4 | 0.91 | 1.87 |
| 10 | `cal-3bp-btn-co-100-o3` | 100bb-3 | CO / BTN | CO 3bb 오픈, BTN 3벳 9bb, 블라인드 폴드, CO 콜 | 20.5 / 91 (4.44) | rfi-co:open × co-open-vs-btn-3bet:call; btn-vs-co-open:3bet | SPR 4.4; co-open-vs-btn-3bet 낮음 23.5 | 10.6 | 1.03 | 1.88 |
| 11 | `cal-3bp-bb-sb-100-o3` | 100bb-3 | SB / BB | 나머지 폴드, SB 3.5bb 오픈, BB 3벳 10.5bb, SB 콜 | 22 / 88.5 (4.02) | rfi-sb:raise × sb-open-vs-bb-3bet:call; bb-vs-sb-open:3bet | SPR 4.0; sb-open-vs-bb-3bet 낮음 32.0 | 11.2 | 1.08 | 1.88 |
| 12 | `cal-3bp-btn-co-35` | 35bb-2 | CO / BTN | CO 2bb 오픈, BTN 3벳 6bb, 블라인드 폴드, CO 콜 | 14.5 / 29 (2) | rfi-co:open × co-open-vs-btn-3bet:call; btn-vs-co-open:3bet | SPR 2.0; co-open-vs-btn-3bet 낮음 25.2 | 7.4 | 0.71 | 1.87 |
| 13 | `cal-3bp-bb-sb-35` | 35bb-2 | SB / BB | 나머지 폴드, SB 2.5bb 오픈, BB 3벳 7.5bb, SB 콜 | 16 / 26.5 (1.66) | rfi-sb:raise × sb-open-vs-bb-3bet:call; bb-vs-sb-open:3bet | SPR 1.7; sb-open-vs-bb-3bet 낮음 33.3 | 4.9 | 0.47 | 1.87 |
| 14 | `cal-srp-utg-bb-55` | 55bb-2.2 | BB / UTG | UTG 2.2bb 오픈, 나머지 폴드, BB 콜 | 5.9 / 51.8 (8.78) | bb-vs-utg-open:call; rfi-utg:open | the opener series at SPR 8.8; bb-vs-utg-open 보통 10.6 | 19 | 1.86 | 1.88 |
| 15 | `cal-srp-co-bb-55` | 55bb-2.2 | BB / CO | CO 2.2bb 오픈, 나머지 폴드, BB 콜 | 5.9 / 51.8 (8.78) | bb-vs-co-open:call; rfi-co:open | bb-vs-co-open 보통 16.7 | 19 | 1.86 | 1.87 |
| 16 | `cal-srp-utg-bb-35` | 35bb-2 | BB / UTG | UTG 2bb 오픈, 나머지 폴드, BB 콜 | 5.5 / 32 (5.82) | bb-vs-utg-open:call; rfi-utg:open | the opener series at SPR 5.8; bb-vs-utg-open 보통 15.5 | 15.1 | 1.47 | 1.87 |
| 17 | `cal-srp-co-bb-35` | 35bb-2 | BB / CO | CO 2bb 오픈, 나머지 폴드, BB 콜 | 5.5 / 32 (5.82) | bb-vs-co-open:call; rfi-co:open | bb-vs-co-open 낮음 22.6 | 19 | 1.86 | 1.87 |
| 18 | `cal-srp-btn-bb-100-o3` | 100bb-3 | BB / BTN | BTN 3bb 오픈, 나머지 폴드, BB 콜 | 7.5 / 96 (12.8) | bb-vs-btn-open:call; rfi-btn:open | the pub's open size at SPR 12.8: other ranges at the same stack; bb-vs-btn-open 보통 10.9 | 22.6 | 2.22 | 1.88 |
| 19 | `cal-srp-utg-bb-100-o3` | 100bb-3 | BB / UTG | UTG 3bb 오픈, 나머지 폴드, BB 콜 | 7.5 / 96 (12.8) | bb-vs-utg-open:call; rfi-utg:open | UTG's 13% open vs a 13% BB call: the tightest pair; bb-vs-utg-open 높음 5.8 | 22.6 | 2.22 | 1.88 |
| 20 | `cal-srp-co-bb-100-o3` | 100bb-3 | BB / CO | CO 3bb 오픈, 나머지 폴드, BB 콜 | 7.5 / 96 (12.8) | bb-vs-co-open:call; rfi-co:open | bb-vs-co-open 보통 9.4 | 22.6 | 2.22 | 1.88 |
| 21 | `cal-3bp-bb-btn-100` | 100bb-2.2 | BB / BTN | BTN 2.2bb 오픈, SB 폴드, BB 3벳 8.8bb, BTN 콜 | 19.1 / 90.2 (4.72) | bb-vs-btn-open:3bet; rfi-btn:open × btn-open-vs-bb-3bet:call | blind 3-bet pot, OOP raiser, SPR 4.7: ⅓·c, s = 0.79, α below SPR 6; PF-SANITY-6 fires on blind 3-bets here (낮음); btn-open-vs-bb-3bet 낮음 20.1 | 23.5 | 2.32 | 2.46 |
| 22 | `cal-srp-sb-bb-100` | 100bb-2.2 | SB / BB | 나머지 폴드, SB 3bb 오픈, BB 콜 | 7 / 96 (13.71) | rfi-sb:raise; bb-vs-sb-open:call | the SB's open: an OOP raiser in a single raised pot; rfi-sb 낮음 28.3, bb-vs-sb-open 보통 18.1 | 31.5 | 3.15 | 2.45 |
| 23 | `cal-3bp-sb-btn-100` | 100bb-2.2 | SB / BTN | BTN 2.2bb 오픈, SB 3벳 8.8bb, BB 폴드, BTN 콜 | 19.6 / 91.2 (4.65) | sb-vs-btn-open:3bet; rfi-btn:open × btn-open-vs-sb-3bet:call | the SB's 3-bet (OOP raiser, the BB's blind and ante dead); btn-open-vs-sb-3bet 보통 18.2, sb-vs-btn-open 보통 8.9 | 18.9 | 1.84 | 2.45 |
| 24 | `cal-4bp-co-btn-100` | 100bb-2.2 | CO / BTN | CO 2.2bb 오픈, BTN 3벳 6.6bb, 블라인드 폴드, CO 4벳 16.5bb, BTN 콜 | 35.5 / 83.5 (2.35) | rfi-co:open × co-open-vs-btn-3bet:4bet; btn-vs-co-open:3bet × btn-3bet-vs-co-4bet:call | §9's small 4-bet pot at SPR 2.35: the low-SPR α rule that splits small 4-bets from jams; btn-3bet-vs-co-4bet 낮음 27.3 | 4 | 0.38 | 2.46 |
| 25 | `cal-srp-co-btn-100` | 100bb-2.2 | CO / BTN | CO 2.2bb 오픈, BTN 콜, 블라인드 폴드 | 6.9 / 97.8 (14.17) | rfi-co:open; btn-vs-co-open:call | §9's in-position caller (u_call in position is never fitted, the role rule); btn-vs-co-open 높음 7.8, the BTN's flats of earlier opens 낮음 (UTG–LJ) and 보통 (HJ) | 42.1 | 4.29 | 2.46 |
| 26 | `cal-lp-sb-bb-100` | 100bb-2.2 | SB / BB | 나머지 폴드, SB 림프, BB 체크 | 3 / 98 (32.67) | rfi-sb:limp; bb-vs-sb-limp:check | the limped pot (⅔·c, both u_call), SPR 32.7; bb-vs-sb-limp 낮음 28.9, rfi-sb 낮음 28.3 | 23.4 | 2.31 | 2.16 |
| 27 | `cal-3bp-bb-btn-55` | 55bb-2.2 | BB / BTN | BTN 2.2bb 오픈, SB 폴드, BB 3벳 8.8bb, BTN 콜 | 19.1 / 45.2 (2.37) | bb-vs-btn-open:3bet; rfi-btn:open × btn-open-vs-bb-3bet:call | 3-bet pots at 55bb, SPR 2.4: α's low-SPR shrink in 3-bet pots; 55bb PF-SANITY-6 on 21 spots | 8.8 | 0.85 | 2.45 |
| 28 | `cal-3bp-sb-btn-55` | 55bb-2.2 | SB / BTN | BTN 2.2bb 오픈, SB 3벳 8.8bb, BB 폴드, BTN 콜 | 19.6 / 46.2 (2.36) | sb-vs-btn-open:3bet; rfi-btn:open × btn-open-vs-sb-3bet:call | SPR 2.4; btn-open-vs-sb-3bet 낮음 27.8 | 8.2 | 0.79 | 2.45 |
| 29 | `cal-3bp-bb-btn-100-o3` | 100bb-3 | BB / BTN | BTN 3bb 오픈, SB 폴드, BB 3벳 10.5bb, BTN 콜 | 22.5 / 88.5 (3.93) | bb-vs-btn-open:3bet; rfi-btn:open × btn-open-vs-bb-3bet:call | the pub's 3bb opens (blind 3-bets 3.5×), SPR 3.9; 100bb-3 has the most PF-SANITY-6 spots (27); btn-open-vs-bb-3bet 낮음 18.3 | 15.2 | 1.47 | 2.46 |
| 30 | `cal-4bp-co-btn-100-o3` | 100bb-3 | CO / BTN | CO 3bb 오픈, BTN 3벳 9bb, 블라인드 폴드, CO 4벳 22.5bb, BTN 콜 | 47.5 / 77.5 (1.63) | rfi-co:open × co-open-vs-btn-3bet:4bet; btn-vs-co-open:3bet × btn-3bet-vs-co-4bet:call | 4-bet pot at SPR 1.6, right at SPR_ALPHA; btn-3bet-vs-co-4bet 낮음 25.2 | 2.4 | 0.23 | 2.46 |
| 31 | `cal-3bp-sb-btn-100-o3` | 100bb-3 | SB / BTN | BTN 3bb 오픈, SB 3벳 10.5bb, BB 폴드, BTN 콜 | 23 / 89.5 (3.89) | sb-vs-btn-open:3bet; rfi-btn:open × btn-open-vs-sb-3bet:call | SPR 3.9; btn-open-vs-sb-3bet 낮음 17.5 | 17.3 | 1.68 | 2.46 |
| 32 | `cal-3bp-bb-btn-35` | 35bb-2 | BB / BTN | BTN 2bb 오픈, SB 폴드, BB 3벳 8bb, BTN 콜 | 17.5 / 26 (1.49) | bb-vs-btn-open:3bet; rfi-btn:open × btn-open-vs-bb-3bet:call | SPR 1.5: the SPR_ALPHA = 1.5 shrink itself; btn-open-vs-bb-3bet 낮음 23.1 | 4.9 | 0.47 | 2.45 |
| 33 | `cal-3bp-sb-btn-35` | 35bb-2 | SB / BTN | BTN 2bb 오픈, SB 3벳 8bb, BB 폴드, BTN 콜 | 18 / 27 (1.5) | sb-vs-btn-open:3bet; rfi-btn:open × btn-open-vs-sb-3bet:call | SPR 1.5; btn-open-vs-sb-3bet 낮음 28.2 | 4 | 0.38 | 2.45 |
| 34 | `cal-srp-sb-bb-55` | 55bb-2.2 | SB / BB | 나머지 폴드, SB 3bb 오픈, BB 콜 | 7 / 51 (7.29) | rfi-sb:raise; bb-vs-sb-open:call | OOP raiser at SPR 7.3; rfi-sb 낮음 29.8, bb-vs-sb-open 보통 17.4 | 28.2 | 2.81 | 2.45 |
| 35 | `cal-srp-co-btn-55` | 55bb-2.2 | CO / BTN | CO 2.2bb 오픈, BTN 콜, 블라인드 폴드 | 6.9 / 52.8 (7.65) | rfi-co:open; btn-vs-co-open:call | IP caller at SPR 7.7; btn-vs-co-open 보통 18.0 | 31.7 | 3.17 | 2.45 |
| 36 | `cal-lp-sb-bb-55` | 55bb-2.2 | SB / BB | 나머지 폴드, SB 림프, BB 체크 | 3 / 53 (17.67) | rfi-sb:limp; bb-vs-sb-limp:check | limped pot at SPR 17.7; bb-vs-sb-limp 낮음 32.5 | 26.2 | 2.59 | 2.16 |
| 37 | `cal-srp-sb-bb-35` | 35bb-2 | SB / BB | 나머지 폴드, SB 2.5bb 오픈, BB 콜 | 6 / 31.5 (5.25) | rfi-sb:raise; bb-vs-sb-open:call | OOP raiser at SPR 5.3; rfi-sb 낮음 29.1 | 26.2 | 2.59 | 2.45 |
| 38 | `cal-lp-sb-bb-35` | 35bb-2 | SB / BB | 나머지 폴드, SB 림프, BB 체크 | 3 / 33 (11) | rfi-sb:limp; bb-vs-sb-limp:check | limped pot at SPR 11; bb-vs-sb-limp 낮음 22.4 | 26.6 | 2.64 | 2.16 |
| 39 | `cal-srp-sb-bb-100-o3` | 100bb-3 | SB / BB | 나머지 폴드, SB 3.5bb 오픈, BB 콜 | 8 / 95.5 (11.94) | rfi-sb:raise; bb-vs-sb-open:call | rfi-sb 낮음 24.2, bb-vs-sb-open 낮음 20.2 | 41.8 | 4.26 | 2.45 |
| 40 | `cal-srp-co-btn-100-o3` | 100bb-3 | CO / BTN | CO 3bb 오픈, BTN 콜, 블라인드 폴드 | 8.5 / 97 (11.41) | rfi-co:open; btn-vs-co-open:call | btn-vs-co-open 보통 9.0 | 51.1 | 5.29 | 2.46 |
| 41 | `cal-lp-sb-bb-100-o3` | 100bb-3 | SB / BB | 나머지 폴드, SB 림프, BB 체크 | 3 / 98 (32.67) | rfi-sb:limp; bb-vs-sb-limp:check | bb-vs-sb-limp 낮음 26.8 | 23.4 | 2.31 | 2.16 |
<!-- queue-table:end -->

**Cost.** Every pack was dry-run on its first priority flop (Qs8h5h, two-tone, about the mean flop by memory) with
`node scripts/presolve.mjs --scenario <ids> --count 1 --budget-minutes 8 --iterations 20 --workers 4
--accept-above-target` on a 4-core machine, next to `cal-srp-btn-bb-15` on the same board (20 iterations in 1.2 min).
The runner cost of a flop is estimated as 7.0 × r × I / 57 + 0.4 core-minutes: the short-stage packs' estimate above
(7.0 core-minutes of solving at 57 iterations, plus 0.4 for the extraction, which the slim files keep, since the root
equity enumeration is most of it) scaled by r, the pack's time for 20 iterations over `cal-srp-btn-bb-15`'s on the
same machine and board, and by I, the iterations it needs to reach 0.5% of the pot (checked every 10, as on the
runners). The 18 packs whose ranges the ghost rule changed (the 3-bet and 4-bet pots) were dry-run again the same way,
four at a time, next to two unchanged packs that set this machine's speed against the first dry runs (1.02×; r is
taken at the first runs' speed). I was measured by solving the same flop to the target (300 iterations at most, 0.5%)
for 10 packs: `cal-srp-btn-bb-15` 50 (0.473%); `cal-srp-btn-bb-100` 80 (0.462%); `cal-srp-sb-bb-100` 80 (0.406%);
`cal-srp-co-btn-100` 110 (0.421%); `cal-srp-btn-bb-35` 60 (0.49%); `cal-lp-sb-bb-100` 90 (0.405%);
`cal-4bp-co-btn-100-o3` 50 (0.477%); `cal-4bp-co-btn-100` 60 (0.426%); `cal-3bp-btn-co-55` 60 (0.459%);
`cal-3bp-bb-btn-100` 100 (0.456%). The others are extrapolated from the dry run's exploitability after 20 iterations
with exploitability ∝ iterations^−k, k = 1.89 (the probes' mean; 1.91, 1.99, 1.86, 1.93, 2.02, 1.94, 1.94, 1.73,
1.67). The worst converger, the 100bb-3 IP caller (10.971% after 20 iterations), comes to about 110, well under the
300 a flop may take before it is not written. On the probes, this extrapolation from 20 iterations misses the measured
counts by −20 once, −10 once, 0 five times and +10 twice (iterations), so the iteration counts are good to about ±10%.
That covers the extrapolation only: the 7.0 itself is the short-stage packs' estimate, not a runner measurement yet
(their first run was still going when this was written), and every row scales with it. A run gives each of its 16 × 4
workers about 290 minutes, less about half a flop: a worker does not start a flop its pack's timings say would not
finish before the deadline, and from then on the run starts nothing, so every worker idles for about half a flop at
the end (25 minutes for the 51-minute flops of the 100bb-3 IP caller, 1–21 for the others). So a pack takes 1,755 × c
/ (64 × (290 − c / 2)) runs for c core-minutes a flop, and a run takes about 5 h 15 min. The estimates span 2.4–51.1
core-minutes a flop (`cal-4bp-co-btn-100-o3` to `cal-srp-co-btn-100-o3`) and 0.23–5.29 runs a pack: in all about 76.5
runs, 16.7 days of back-to-back runs, after the short-stage packs: 30.7 runs (6.7 days) for the IP-raiser packs 1–20
(12.1 / 2.6 for 1–7, 4.9 / 1.1 for 8–13, 13.7 / 3 for 14–20), then 45.8 (10 days) for 21–41 (14.3 / 3.1, 5.9 / 1.3 and
25.7 / 5.6). One more loss is not in these numbers: when a run moves to the next pack of the queue late in a run, that
pack has no timings yet, so its first flops start with only `MIN_START_MS` (4 minutes) checked and can be abandoned at
the deadline (at most a flop per worker; the next run solves them). The real runner numbers will replace these: the
shard logs print every flop's iterations and minutes, and the short-stage packs' first runs calibrate the 7.0.

**Size.** The dry runs wrote 1.87–2.46 KB a flop: 1.87–1.88 KB with one OOP root action (TREE_SRP), 2.16 KB in the
limped pots (two), 2.45–2.46 KB with an OOP raiser (three), the reach rule's packs included. That is 3.3–4.3 MB a pack
of 1,755 flops and about 154 MB for the whole queue, against about 100 MB a pack for the full files of the first two
calibration packs. The calibration manifest grows by about 0.45 MB a pack (a file entry is about 250 bytes, its path
and sha256 most of it; about 18 MB with the whole queue); if that matters, the per-pack index files of Size budget (a
v2 manifest) are the fix.

**Changing the queue.** `queue` is only the job's order: moving a pack needs no version bump, and a pack that has no
files yet can be dropped from `QUEUE` (one with files keeps them in the manifest). Everything else about a pack is in
its meta and needs a version bump once it has files, as for every pack.

## API (`src/presolve/format.ts`)

- Binary: `encodeBase64`/`decodeBase64`, `encodeUint8`/`decodeUint8`, `encodeInt16`/`decodeInt16`,
  `encodeCombos`/`decodeCombos`.
- Quantization: `quantizeStrategy`, `dequantize`, `quantizeUnit`, `quantizeEv`/`dequantizeEv`, `roundChips`.
- Boards and combos: `boardKey`, `parseBoardKey`, `canonicalBoard`, `flopClasses`, `comboIndex`,
  `comboString`, `mapComboSuits`, `invertSuitMap`.
- Paths: `packFilePath(scenarioId, version, board)`, `pathKey`, `PACKS_DIR`, `MANIFEST_PATH`.
- Writing: `encodeRange`, `encodeFlopNode(source)` (COMBOS-indexed solver arrays in, quantized node out),
  `encodeClassRange`, `encodeClassRoot` (slim files), `summaryNodeDefs`, `summarizeFlop`, `validateFlopFile`,
  `validateManifest`.
- Reading: `decodeRange`, `decodeClassRange`, `decodeFileRange` (either form), `decodeClassRoot`, `decodeFlopNode`,
  `decodeFlopFile` (`rootClasses` in a slim file), `COMBO_CLASS`, `NUM_CLASSES`, `nodeActionTotals`, `aggregateByHandClass`
  (169 hand classes, weighted by reach × starting weight), `comboRows`, `rangesAfter`, `turnStart`,
  `treeSettings`.
