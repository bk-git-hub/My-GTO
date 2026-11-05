# Heads-up postflop solver

A GTO solver for one heads-up postflop spot: two ranges, a board (flop, turn or river), a pot and an
effective stack, and a small menu of bet sizes. It finds an approximate Nash equilibrium with
Discounted CFR and reports the strategy, the ranges and the EVs at every node of the game tree.

It is plain TypeScript with no DOM or Node APIs, so the same module runs in a browser Web Worker
(the app) and in Node (tests, scripts, a server). The public contract is `src/solver/types.ts`.

## Scope

- Heads-up only, postflop only, equal effective stacks.
- No rake, no ante or preflop logic: the solve starts with `pot` in the middle and `stack` behind each player.
- No card abstraction. Every turn and river card is its own subtree. Suit isomorphism is an optional
  optimization (see Performance).
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
- Range weights are in 0..1. A combo that shares a card with the board is ignored whatever its weight.
- The chance probability of each next card, given both players' hands, is 1 / (52 − |board| − 4).
  A card that is in either player's hand can't come.

## Game tree rules

State: street, board, `pot` (every chip in the middle, this street's bets included), `bets` [b0, b1] on this
street, `stacks` [s0, s1] behind, the player to act, the number of bets/raises made on this street (`n`),
and the last raise increment (`inc`, the size of the last bet or the amount a raise added on top of the bet it raised).

Root: street implied by the board (3 cards = flop, 4 = turn, 5 = river), pot = P0, bets [0, 0], stacks [S, S], OOP to act, n = 0.
If S = 0 the root is the all-in runout described below.

Sizes for a player on a street come from `input.sizes[street][player]`, or `DEFAULT_SIZES[player]` when the
street has no entry. Defaults: `raiseLimit` 2, `addAllIn` true, `allInThreshold` 0.67, `minBet` 1.

Chip amounts are floats, so the rules compare them with a tolerance ε = 1e-9: two amounts within ε are equal.
Concretely: facing a bet means toCall > ε; a bet or raise becomes the all-in when it puts in at least
allInThreshold × stack − ε or at least stack − ε; "more than toCall behind" means myStack > toCall + ε; actions
merge within ε. So a bet never leaves rounding dust behind (in floats 0.7 × 3 = 2.0999999999999996, which
against a 2.1 stack is the all-in, not a bet leaving 4e-16), and every stack is either exactly 0 (after an
all-in or a call of one: an all-in sets the stack to 0 and a call copies the opponent's stack) or more than ε
(given a starting stack S that is 0 or more than ε).
The "chips behind", `stack > 0` and "both stacks are 0" tests below are therefore exact.

**Not facing a bet** (bets equal; postflop this only happens with bets [0, 0]): actions in this order:

1. `check` (to 0).
2. A bet for each fraction f in `bet`, ascending: amount = max(minBet, f × pot). If amount ≥ allInThreshold × stack
   (the bettor's chips behind), or amount ≥ stack, it becomes the all-in instead (both up to ε).
   Label "벳 {round(f×100)}%", or "벳 {amount}" if minBet raised it.
3. `allin` (to = stack) if addAllIn and stack > 0. Label "올인".

**Facing a bet** (toCall = max(bets) − myBet > ε): actions in this order:

1. `fold` (to 0), label "폴드".
2. `call` (to = max(bets)), label "콜". Equal stacks mean a call is always complete.
3. Raises, only if n ≤ raiseLimit, the raiser has more than toCall + ε behind, and the opponent has chips behind:
   for each f in `raise`, ascending, to = myBet + toCall + f × (pot + toCall), then at least the minimum raise
   to = max(bets) + inc. If (to − myBet) ≥ allInThreshold × myStack, or ≥ myStack (both up to ε), it becomes the all-in.
   Label "레이즈 {to rounded to 0.1}".
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

### Solution queries

`Solution.node(path)` walks from the root (`{action: i}` at action nodes, `{card}` at chance nodes) and returns a
`SolutionNode`:

- `strategy`: average strategy per action, COMBOS-indexed, 0 outside the acting player's hand list and for
  hands blocked by the board at this node.
- `ranges`: initial weight × the product of each player's own action probabilities along the path, 0 for combos
  blocked by the node's board.
- `ev[p]`: p's expected net per combo from this node on with both players on the average strategy:
  cfv_p(h) / compatibleSum(h), computed against the opponent's reach at this node. It is a counterfactual value,
  so a combo with zero own reach still gets one. NaN where the combo isn't in p's hand list, is blocked by the
  node's board, or the opponent has no compatible reach here.
- Computed lazily per node and cached; illegal paths throw.

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
or when `onProgress` returns false. A `Solution` reads the solver's live arrays: it is valid until the next
`iterate()`, after which its `node()` throws ("stale solution"). `estimateMemory` must not allocate the per-hand arrays, so the UI can refuse
a spot that won't fit before building it.

## Files

| File | Contents |
|---|---|
| `src/solver/types.ts` | Public contract (additive changes only) |
| `src/solver/hands.ts` | Per-player hand lists, card masks, same-combo maps |
| `src/solver/tree.ts` | Tree building from the rules above, `estimateMemory` |
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
   overlap (both contain the equilibrium value). `SOLVER_CROSSCHECK=1` runs many more seeds and bigger spots.
5. **Convergence**: exploitability falls and reaches the target on a realistic river spot.
6. **Solution API**: path walking, illegal paths, ranges, NaN EVs, strategy sums to 1 for in-range combos.

## Performance

Targets in Node on this repo's dev machine (4 cores, one used):

- River, ~500 combos per range, default sizes: 0.5% of pot in < 2 s.
- Turn, ~500 combos per range, default sizes, SPR ≈ 4: 1% of pot in < 30 s, memory estimate < 300 MB.
- Flop: allowed when `estimateMemory` fits; it is meant for a server or narrow ranges.

Levers, in order: avoiding allocation in the hot loop (preallocated scratch per depth), Float32Array storage,
cached sorted orders per river board, skipping zero-reach subtrees, and suit isomorphism at chance nodes when the
board and both ranges are symmetric under a suit swap (optional; it must pass the oracle cross-check).
