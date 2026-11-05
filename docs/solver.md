# Heads-up postflop solver

A GTO solver for one heads-up postflop spot: two ranges, a board (flop, turn or river), a pot and an
effective stack, and a small menu of bet sizes. It finds an approximate Nash equilibrium with
Discounted CFR and reports the strategy, the ranges and the EVs at every node of the game tree.

It is plain TypeScript with no DOM or Node APIs, so the same module runs in a browser Web Worker
(the app) and in Node (tests, scripts, a server). The public contract is `src/solver/types.ts`.

## Scope

- Heads-up only, postflop only, equal effective stacks.
- No rake, no ante or preflop logic: the solve starts with `pot` in the middle and `stack` behind each player.
- No card abstraction. Every turn and river card is its own subtree of the game. When the spot is symmetric under
  a permutation of the suits, the solver stores one of each set of mirror-image subtrees (suit isomorphism, see
  Algorithm); that changes no result.
- Bet-size abstraction only: each player has a short list of sizes per street.

## Conventions

- Units are big blinds. `pot` = P0 is the money in the middle at the start of the solve and belongs to nobody.
- **Net** of a player = chips at the end − chips at the start of the solve. At every terminal, net0 + net1 = P0.
  - Fold by player f after the players put in x_f and x_w (total over the whole solve): net_w = P0 + x_f, net_f = −x_f.
  - Showdown (both put in the same x): winner P0 + x, loser −x, tie P0/2 each.
- Player 0 = OOP (acts first on every street), player 1 = IP.
- Combos are indexed like `COMBOS` in `src/play/handInfo.ts` (1326 entries). `Card = rank * 4 + suit`
  (`src/poker/cards.ts`). Hand strength comes from `evaluate(cards, n)` in `src/poker/evaluator.ts`
  (higher is better; equal scores tie).
- Range weights are in 0..1 (see Inputs). A combo that shares a card with the board is ignored whatever its weight.
- The chance probability of each next card, given both players' hands, is 1 / (52 − |board| − 4).
  A card that is in either player's hand can't come.

## Inputs

`buildTree`, `estimateMemory`, `createSolver` and `solve` check the input first and throw an `Error` that
names the bad field. Defaults (below) are filled in before the checks.

- `board`: 3, 4 or 5 distinct integer cards in 0..51.
- `pot`: a finite number > 0. `stack`: a finite number ≥ 0. A `stack` of at most ε (1e-9, see the game tree
  rules) is treated as exactly 0: the root is the all-in runout, nobody bets, and every net is as with S = 0.
- `sizes`: each street entry that is given (whether or not the board reaches that street) is a pair
  [OOP, IP] of `{bet, raise}`, each an array of finite numbers ≥ 0. Order and duplicates don't matter
  (sizes are sorted and equal actions merge). A size of 0 means the smallest allowed: `minBet` for a bet,
  the minimum raise for a raise. NaN, ±Infinity, negative or non-number sizes throw.
- `raiseLimit`: an integer ≥ 0. `addAllIn`: a boolean.
- `allInThreshold`: a finite number > 0. Above 1 it never applies (a bet of the whole stack is the all-in anyway).
- `minBet`: a finite number > ε. So every bet, raise and all-in raises the street's top bet by more than ε,
  and a player facing one always has toCall > ε.
- `ranges` (`estimateMemory`, `createSolver`, `solve`; `buildTree` doesn't read them): two array-likes of at most
  1326 weights in COMBOS order; entries past an array's end are 0. Every entry is a number in [0, 1]:
  NaN, negative and > 1 throw (weights are probabilities, not percentages), also for combos on the board.
- The ranges must give a game (`createSolver`, `solve`): each player has a combo with weight > 0 off the board,
  and Σ over compatible pairs (no shared card) of w0 × w1 is > 0, summed pair by pair so that "no compatible
  pair" is exactly 0. This is checked before the tree is built. `estimateMemory` doesn't apply this rule (see API).

Together with the tolerance rules below, these make every tree finite: each bet or raise adds more than ε to
the top bet, a street has at most `raiseLimit` + 1 of them, and nobody ever acts with an empty stack.

## Game tree rules

State: street, board, `pot` (every chip in the middle, this street's bets included), `bets` [b0, b1] on this
street, `stacks` [s0, s1] behind, the player to act, the number of bets/raises made on this street (`n`),
and the last raise increment (`inc`, the size of the last bet or the amount a raise added on top of the bet it raised).

Root: street implied by the board (3 cards = flop, 4 = turn, 5 = river), pot = P0, bets [0, 0], stacks [S, S], OOP to act, n = 0.
If S = 0 (which includes S ≤ ε, see Inputs) the root is the all-in runout described below.

Sizes for a player on a street come from `input.sizes[street][player]`, or `DEFAULT_SIZES[player]` when the
street has no entry. Defaults: `raiseLimit` 2, `addAllIn` true, `allInThreshold` 0.67, `minBet` 1.

Chip amounts are floats, so the rules compare them with a tolerance ε = 1e-9: two amounts within ε are equal.
Concretely: facing a bet means toCall > ε; a bet or raise becomes the all-in when it puts in at least
allInThreshold × stack − ε or at least stack − ε; "more than toCall behind" means myStack > toCall + ε; actions
merge within ε. So a bet never leaves rounding dust behind (in floats 0.7 × 3 = 2.0999999999999996, which
against a 2.1 stack is the all-in, not a bet leaving 4e-16), and every stack is either exactly 0 (after an
all-in or a call of one: an all-in sets the stack to 0 and a call copies the opponent's stack) or more than ε
(the starting stack S is 0 or more than ε, see Inputs).
The "chips behind", `stack > 0` and "both stacks are 0" tests below are therefore exact.

**Not facing a bet** (bets equal; postflop this only happens with bets [0, 0]): actions in this order:

1. `check` (to 0).
2. A bet for each fraction f in `bet`, ascending: amount = max(minBet, f × pot). If amount ≥ allInThreshold × stack
   (the bettor's chips behind), or amount ≥ stack, it becomes the all-in instead (both up to ε).
   Label "벳 {round(f×100)}%", or "벳 {amount}" if minBet raised it (f × pot < minBet), with the amount rounded to
   0.01 and no trailing zeros: `String(Math.round(amount × 100) / 100)`, so 1.25 → "벳 1.25", 1.5 → "벳 1.5", 1 → "벳 1".
3. `allin` (to = stack) if addAllIn and stack > 0. Label "올인".

**Facing a bet** (toCall = max(bets) − myBet > ε): actions in this order:

1. `fold` (to 0), label "폴드".
2. `call` (to = max(bets)), label "콜". Equal stacks mean a call is always complete.
3. Raises, only if n ≤ raiseLimit, the raiser has more than toCall + ε behind, and the opponent has chips behind:
   for each f in `raise`, ascending, to = myBet + toCall + f × (pot + toCall), then at least the minimum raise
   to = max(bets) + inc. If (to − myBet) ≥ allInThreshold × myStack, or ≥ myStack (both up to ε), it becomes the all-in.
   Label "레이즈 {to}" with `to` rounded to 0.1: `String(Math.round(to × 10) / 10)`, so 15.75 → "레이즈 15.8", 10 → "레이즈 10".
4. `allin` (to = myBet + myStack) if addAllIn and the raise conditions hold. An all-in for less than a minimum
   raise is still offered.

Within one node, two actions with the same kind and `to` (within ε) are merged: keep the first. Bets and
raises that became all-ins are the `allin` action, kind "allin", which comes last. `to` is always this
player's street total after the action.

**After an action:**

- `fold` → fold terminal.
- `check` by OOP → IP to act. `check` by IP (after OOP checked) → street over.
- bet/raise/allin → n += 1, inc = max(inc, to − max(bets) before the action) (so an opening bet sets inc to
  its amount and a short all-in leaves it unchanged), pot and stacks updated, the opponent acts.
- `call` → street over.
- Street over: if both stacks are 0 (someone was all-in and got called) → all-in runout. Else if river → showdown
  terminal. Else → chance node dealing the next card, then the next street: bets [0, 0], n = 0, inc = 0, OOP acts.
- **All-in runout**: chance nodes deal the remaining board cards (turn then river, as needed) with no actions
  between them, then a showdown terminal. A river all-in goes straight to showdown.

## Algorithm

Discounted CFR (Brown & Sandholm 2019), α = 1.5, β = 0, γ = 2, alternating updates, vectorized over hands.

- **Hands**: for each player, the list of COMBOS indices with weight > 0 that don't touch the starting board.
  Every per-hand array at a node is sized to the list of the player who owns it. Keep, per hand, its two cards,
  and the index of the same combo in the opponent's list (or −1).
- **Traversal** for the updating player p: `cfv(node, reachSelf, reachOpp) → Float32Array` gives p's
  counterfactual value per hand: Σ over compatible opponent hands o of reachOpp[o] × net_p, chance probabilities
  folded into reachOpp.
  - p's node: strategy σ by regret matching (positive regrets normalized; uniform when none is positive).
    v_a = cfv(child_a, reachSelf × σ_a, reachOpp); v = Σ σ_a v_a; regret_a += v_a − v; strategySum_a += reachSelf × σ_a.
  - Opponent node: σ from the opponent's current regrets; v = Σ_a cfv(child_a, reachSelf, reachOpp × σ_a).
  - Chance node: for each card c, both reach vectors have hands containing c zeroed, reachOpp is multiplied by
    1 / (52 − |board| − 4), and v += child value with p's hands containing c zeroed.
  - A subtree whose reachOpp is all zero has value 0 and can be skipped.
- **Discounting**, at iteration t = 1, 2, … before adding that iteration's values: stored positive regrets
  × t^1.5 / (t^1.5 + 1), negative regrets × 0.5, strategy sums × (t / (t + 1))². One iteration updates OOP, then IP.
- **Fold terminal**: value_p(h) = net_p × compatibleSum(h), where by inclusion–exclusion
  compatibleSum(h) = Σ reachOpp − Σ_{o ∋ card1(h)} − Σ_{o ∋ card2(h)} + reachOpp[same combo].
- **Showdown terminal**: with the river board fixed, sort both players' hands by strength once per board (cache it).
  Sweep upward accumulating opponent reach that is strictly weaker, in total and per card (52 accumulators), so that
  W(h) = weaker − weakerByCard[c1] − weakerByCard[c2]; sweep downward for strictly stronger L(h); ties
  T(h) = compatibleSum(h) − W(h) − L(h). value_p(h) = (P0 + x) W − x L + (P0 / 2) T.
- **Average strategy**: strategySum normalized per hand; uniform where a hand's sum is 0.
- **Best response** for p: the same traversal with the opponent on the average strategy and, at p's nodes, the
  per-hand maximum over actions. BR_p = Σ_h w_p(h) cfv(h) / Σ_{h,o compatible} w_p(h) w_o(o), using the initial
  weights.
- **Exploitability** (% of pot) = (BR_0 + BR_1 − P0) / 2 / P0 × 100. It is ≥ 0, and 0 exactly at equilibrium.
  In floats a spot with nothing to decide can come out a few 1e-14 below 0, so the reported value is clamped at 0
  (the per-player best responses are not).

### Suit isomorphism

A permutation of the four suits σ maps a card to the card of the same rank in the image suit, and a combo to the
combo of the images of its cards. The spot's **symmetry group** G is the set of σ that map the starting board onto
itself (as a set) and leave both ranges unchanged: w_p(σ(c)) = w_p(c) for every combo c and both players, with the
weights the solve uses (combos on the board count as 0) compared exactly, not within a tolerance. G always contains
the identity and is a group. Examples with suit-symmetric (chart) ranges: a rainbow flop like Ks7d2c has none (the
free suit has nothing to swap with), a two-tone flop like Ks7s2d swaps the two free suits, a monotone flop permutes
the other three suits in all 6 ways, and a paired flop like KsKd2c swaps the suits of the pair. When G is the
identity alone, nothing below applies and the solver is the plain one.

- **Group at a node**: the elements of G that fix every card dealt since the start (so a turn card of a free suit
  leaves a smaller group, or none). The subtree under a node, with the reaches at that node, is symmetric under it.
- **Chance node**: the cards that can come fall into orbits under the node's group. The solver keeps a subtree
  only under the smallest card of each orbit (its representative). The subtree under another card c′ = σ(c) is the
  image of the one under c, so p's value for hand h under c′ is the representative's value for σ⁻¹(h): the chance
  node adds, for each card of the orbit, the representative's values gathered through σ⁻¹. This needs both reach
  vectors at the node to be symmetric under the node's group.
- **Symmetric strategy reads**: at an action node whose group is not the identity, every read of a strategy (regret
  matching during training, the average strategy for best responses, evaluation and `Solution.node`) gives each
  hand the probabilities of the canonical hand of its orbit under that group (the one with the lowest index in the
  hand list). In exact arithmetic the hands of an orbit have equal regrets anyway; in floats the chance sums round
  in different orders, and without this, regrets that are 0 up to rounding would let mirror-image hands play
  differently and break the symmetric reaches the chance step relies on. With it the reaches are symmetric bit for
  bit, so the reduced solve equals the full one up to float rounding (after one iteration every regret and strategy
  sum matches the full tree's within 1e-12, and the best response to the same strategy matches within 1e-11).
  Like any two float orderings (compare pruning), the solves with and without isomorphism then drift apart over
  many iterations; both converge to the same game value.
- **Queries**: `Solution.node(path)` accepts every card that can come. A card off the representatives continues in
  the representative's subtree, read through the suit permutation that maps the real cards there (composed along
  the path), and the node's `strategy`, `ranges` and `ev` are mapped back to the real combos; `board` and `cards`
  are the real ones. So a node under 2h and the node under 2d (when h and d are mirror images) are the same arrays
  with the suits swapped.
- **Sizes**: `buildTree` doesn't read the ranges and always returns the full game tree; `estimateMemory` counts the
  full game tree's nodes and gives the bytes of the reduced tree the solver builds.

### Solution queries

`Solution.node(path)` walks from the root (`{action: i}` at action nodes, `{card}` at chance nodes, where the card
is any card that can come, listed in the chance node's `cards`) and returns a `SolutionNode`. A step has exactly one
of the keys `action` and `card`, with an integer value; anything else throws, before any cached result is looked up
(so `{action: "1"}` never returns the node of `{action: 1}`).

- `strategy`: average strategy per action, COMBOS-indexed, 0 outside the acting player's hand list and for
  hands blocked by the board at this node.
- `ranges`: initial weight × the product of each player's own action probabilities along the path, 0 for combos
  blocked by the node's board.
- `ev[p]`: p's expected net per combo from this node on with both players on the average strategy:
  cfv_p(h) / compatibleSum(h), computed against the opponent's reach at this node. It is a counterfactual value,
  so a combo with zero own reach still gets one. NaN where the combo isn't in p's hand list, is blocked by the
  node's board, or the opponent has no compatible reach here.
- Computed lazily per node and cached; illegal paths throw. The same path returns the same object: it and its plain
  arrays (`board`, `bets`, `stacks`, `actions` and each action, `cards`, the `strategy` / `ranges` / `ev` lists)
  are frozen. Its typed arrays can't be frozen and are shared with later calls for that path, so they are
  read-only by contract: copy before changing them. Transferring them is fine (a Web Worker's `postMessage` with
  their buffers in the transfer list): that empties the arrays of the object the caller holds, and the next
  `node()` for the path builds a new object instead of returning the emptied one.

## API (`src/solver/index.ts`)

```ts
solve(input: SolverInput, opts?: SolveOptions): Solution            // blocking; runs until a stop condition
createSolver(input: SolverInput): {                                // incremental, for a Web Worker that must stay responsive
  iterate(n: number): void;  iteration: number;
  exploitability(): number;  solution(): Solution;
}
estimateMemory(input: SolverInput): { bytes: number; actionNodes: number; chanceNodes: number; terminalNodes: number }
buildTree(input): the action tree (for tests and the UI), without solving.
```

`solve` stops at `iterations`, at `targetExploitability` (checked every `checkEvery` iterations and at the end),
or when `onProgress` returns false. `iterations` is a number ≥ 0 rounded down (default 1000; Infinity runs until
the target or `onProgress` stops it, and then `checkEvery` must be finite). `checkEvery` is a number > 0 rounded
down, at least 1 (default 25). `targetExploitability` is a number (default 0.5). Anything else throws, so every
pass of the loop runs at least one iteration and a finite cap always ends the solve. `iterate(n)` runs
floor(n) iterations and needs a finite n ≥ 0. A `Solution` reads the solver's live arrays: it is valid until the next
`iterate()`, after which its `node()` throws ("stale solution"). `estimateMemory` must not allocate the per-hand arrays, so the UI can refuse
a spot that won't fit before building it, and it accounts for suit isomorphism (its node counts are the game tree's,
its bytes those of the reduced tree the solver builds). It checks the same inputs as `createSolver` except that the ranges give a
game, so it also sizes a tree for empty ranges (the tests count nodes that way); `createSolver` rejects such ranges
at once, before building the tree. Its `bytes` is the solver's steady-state memory (per-hand storage, the packed
tree, the showdown cache, scratch, hand lists), within 10% of the measured heap on river, turn and flop spots.
`buildTree` returns a read-only view of the packed tree (see Performance): each node is a `GameNode` object made
on demand, whose `children` array is built on first access and then kept (the same array and child objects on
every access). `children` is an own enumerable property like the other fields, so spreading, JSON and structured
clone (postMessage) see it, and build the whole subtree under the node. Views share frozen arrays: an action list
(and its frozen actions) with every node of the same betting state, a board with every node on it, `bets` and
`stacks` with every node of the same betting line under other cards; `children` and `cards` are frozen too.

## Files

| File | Contents |
|---|---|
| `src/solver/types.ts` | Public contract (additive changes only) |
| `src/solver/hands.ts` | Per-player hand lists, card masks, same-combo maps |
| `src/solver/tree.ts` | Tree building from the rules above into the packed tree (full, or one subtree per orbit of cards), the `GameNode` view, `estimateMemory` |
| `src/solver/iso.ts` | Suit permutations, the symmetry group of a spot, orbits of cards at a chance node |
| `src/solver/showdown.ts` | Fold and showdown values, per-board strength cache |
| `src/solver/cfr.ts` | DCFR iterations |
| `src/solver/bestResponse.ts` | Best response and exploitability |
| `src/solver/solution.ts` | `Solution.node(path)`, lazy ranges and EV |
| `src/solver/index.ts` | `solve`, `createSolver`, `estimateMemory`, `buildTree` |
| `src/solver/oracle/` | Independent slow reference: its own tree builder, scalar evaluation over explicit hand pairs, best response and plain CFR. Shares only `types.ts`, `cards.ts`, `evaluator.ts` and `COMBOS` with the core. |
| `src/solver/*.test.ts` | Tests (vitest) |

## Tests

1. **Tree rules**: exact action lists (kind, `to`) for hand-checked spots: min-bet and min-raise clamps,
   the all-in threshold, the raise cap, a short stack where every raise is all-in, `stack = 0`, river vs turn
   street transitions, all-in runouts.
2. **Toy river game** with a known answer: board 2c3d7h8sKs (no straight or flush possible), OOP holds the 3 KK
   combos (nuts) and air, IP holds QQ; OOP may check or bet the pot all-in, IP may only check behind or fold/call
   (pot = stack, river sizes OOP bet [1] and nothing for IP, raiseLimit 0, and addAllIn false, since otherwise
   IP could shove after a check). Equilibrium: OOP bets every KK, bluffs so bluffs/bets = 1/3, IP calls half the time.
3. **Card removal**: fold and showdown values against a brute-force sum over explicit hand pairs, random reaches.
4. **Oracle cross-check** (`crosscheck.test.ts`, seeded) on random configs and small spots (river and turn, 5–40
   combos per range, plus a tiny flop): identical trees, node by node, and `estimateMemory` counts equal to the
   oracle tree's; the core's exploitability and per-player best responses equal the oracle's best response to
   the core's `SolutionNode.strategy`, within a bound derived from the Float32 rounding of those strategies
   (also for 1-iteration and random strategies); `SolutionNode.ev` and `ranges` match the oracle's at the root
   and along random paths; the value intervals [P0 − BR_1, BR_0] of the core and of the oracle's own CFR
   overlap (both contain the equilibrium value). Each section also runs suit-symmetric spots (random boards that
   a suit permutation maps onto themselves, random weights drawn per orbit of combos, sometimes symmetric under
   only part of the board's symmetries, and one-suit boards whose full group has three-cycles), on which the core
   solves one subtree per orbit while the oracle walks every card. `SOLVER_CROSSCHECK=1` runs many more seeds and
   bigger spots.
5. **Convergence**: exploitability falls and reaches the target on a realistic river spot.
6. **Solution API**: path walking, illegal paths (including steps of the wrong shape after the legal ones were
   cached), every legal card as a step, frozen results, a node rebuilt after its buffers were transferred, ranges,
   NaN EVs, strategy sums to 1 for in-range combos, exploitability exactly 0 with nothing to decide.
7. **Inputs**: every rule of the Inputs section, in the core and the oracle alike (the cross-check also runs one
   list of rejected inputs and one of degenerate valid ones, such as stacks ≤ ε and minBet just above it,
   through both, including ranges that give no game); ranges are checked before the tree is built; fractional
   and infinite iteration counts in `solve` and `iterate`.
8. **Memory** (`memory.test.ts`): `estimateMemory` within 10% of the heap a solver really holds on a river, a turn
   and a flop spot, and on a two-tone turn and a monotone flop solved with suit isomorphism (measured with `gc()`,
   which the test switches on through `node:v8`); the packed tree's 10 bytes per node on the reference flop tree,
   with descriptors per skeleton node; `buildTree` views built lazily, kept, frozen and visible to spread, JSON and
   structured clone.
9. **Suit isomorphism** (`iso.test.ts`): the symmetry group on rainbow, two-tone, monotone and paired boards, weights
   compared exactly (one bit off breaks a permutation, combos on the board don't count), ranges symmetric under part
   of the board's symmetries; the reduced tree's chance nodes (one child per orbit) while `buildTree` and the node
   counts of `estimateMemory` stay the game's; against the solver with isomorphism off on the same spots (monotone
   and two-tone turns, a monotone flop): after one iteration every node of the full tree has the reduced node's
   regrets and strategy sums with the hands permuted, the best responses to the same strategy agree, and so do
   `Solution.node` strategies, ranges and EVs along paths through representatives and the cards mapped onto them;
   both solves bracket the same game value; asymmetric ranges on the same board give the plain solve bit for bit;
   nodes under mirror-image cards are each other's arrays with the suits swapped.

## Performance

Targets in Node on this repo's dev machine (4 cores, one used):

- River, ~500 combos per range, default sizes: 0.5% of pot in < 2 s.
- Turn, ~500 combos per range, default sizes, SPR ≈ 4: 1% of pot in < 30 s, memory estimate < 300 MB.
- Flop: allowed when `estimateMemory` fits; it is meant for a server or narrow ranges.

Levers, in order: avoiding allocation in the hot loop (preallocated scratch per depth), Float32Array storage,
a packed tree, cached sorted orders per river board, skipping zero-reach subtrees, and suit isomorphism at chance
nodes when the board and both ranges are symmetric under a permutation of the suits (see Algorithm; checked by the
oracle cross-check on symmetric spots).

**Packed tree.** A flop tree has about a million nodes (1.14 million for the reference flop below at raiseLimit 1,
two thirds of them terminals), so the solver keeps no object per node. The rules build the betting skeleton: the
tree with every chance node collapsed to one child (643 nodes on the reference flop). Each skeleton node becomes a
descriptor holding the node type, player, pot, bets, stacks, chips invested and action list. The packed tree
repeats the skeleton under every card (with suit isomorphism, under one card per orbit): per node it stores its descriptor (Int32), its board (Uint16, an id into
the table of boards dealt so far) and its first child (Int32; children are consecutive ids, in action order or in
the order of the cards that can come). A fold or showdown terminal is a descriptor id like any other node. The
solver adds a storage offset (Int32 while the storage fits, Float64 beyond) and a last discounted iteration
(Int32) per node, and keeps every action node's regrets and strategy sums in two Float32Array slabs. That is 22
bytes per node instead of about 450 for an object.

Reference flop (100bb 6-max cash, BTN open vs BB call, Ks7d2c, pot 5.5, stack 97.5, 709 / 644 combos; flop IP bets
33% and 75%, turn 66%, river 75%, raises 60%, all-in, raiseLimit 1), measured in Node 22: the solver holds
5.63 GB, of which 5.58 GB is regrets and strategy sums and 49 MB the tree, per-node arrays and showdown cache (the
tree as objects took 447 MB); the tree builds in 0.8 s.

**Suit isomorphism.** The same spot on the other flop textures (the chart ranges are suit-symmetric), measured in
Node 22 on one core of a shared machine, at raiseLimit 1 and 2:

| Flop | Symmetry group | Nodes the solver stores (rl 1) | Memory (rl 1 / rl 2) | Median time per iteration (rl 1 / rl 2) |
|---|---|---|---|---|
| Ks7d2c, rainbow | none | 1,142,560 (all) | 5.63 / 7.90 GB | 18.2 / 24.2 s |
| Ks7s2d, two-tone | h ↔ c | 695,022 (61%) | 3.43 / 4.81 GB | 11.9 / 15.2 s |
| Ks7s2s, monotone | h, d, c in any order | 329,111 (29%) | 1.63 / 2.28 GB | 5.6 / 7.4 s |

To 1% and 0.5% of pot at raiseLimit 1 (exploitability checked every 10 iterations; wall time with the checks):
monotone 170 and 240 iterations, 20 and 29 min, in 1.8 GB of resident memory; two-tone 150 and 210 iterations,
37 and 52 min, in 3.5 GB; rainbow (an earlier run, same cost per iteration) 150 and 220 iterations, 58 and 84 min,
in 5.9 GB. The rainbow flop solves exactly as without isomorphism, bit for bit and at the same speed. With isomorphism off,
the two-tone flop takes 5.63 GB and 17.6 s per iteration like the rainbow one. Over all 22,100 flops, with suit-symmetric
ranges, the solver stores 71% of the river subtrees on average (100% for the 6,864 rainbow flops with distinct ranks, 61–63% for
two-tone and paired ones, 29–32% for monotone flops and trips).
