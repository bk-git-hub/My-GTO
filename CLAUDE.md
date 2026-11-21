# Notes for coding agents

## What the app is for (the user's goal; every piece of work serves it)

> "수학적 근거에 기반한 차트에 +- 핸드레인지랑 벳 범위를 갖고 9 웨이 플레이 해보는거. 플레이가 다 끝나면 기본적으로
> 차트기반 채점을 하고 필요시 ai코칭"

- **Play:** whole 9-handed hands at the AI 테이블 against 펍아재 bots. Every bot decision, preflop and postflop,
  heads-up and multiway, comes from our computed charts (our own solvers), shifted by each bot's adjustable
  +/- hand ranges and bet-size ranges. Plain rules are only a stopgap where no computed chart exists yet, and the
  app labels them (근사, 차트 없음).
- **After the hand:** chart-based grading by default (each hero decision against the computed chart: frequencies,
  grade, confidence). AI coaching only when the user asks for it.
- **Coverage of what really happens at a 9-handed BB-ante pub tournament comes first.** Every position pair, IP
  callers, limped pots and limpers (pub players limp a lot, so lines an equilibrium never reaches still need
  charts), multi-caller and 3-way pots, 3-bet pots, at tournament depths. Heads-up BTN vs BB alone is not enough:
  "허구한날 상위 블라인드레벨 아니면 나오지도 않을 버튼 빅 헤즈업밖에 없으니 답답한거지".
- **Computed charts, not drills:** "드릴은 의미 없을것같고 결국 그래서 필요한건 계산된 차트인거임".
- **Tournaments only:** "100bb캐시는 더이상 계산 하지말고 토너쪽으로 올인해".
- Charts come from our own solvers, not commercial or third-party chart data. Say plainly what is solved, what
  is approximate, and how confident it is.

## The 아재 (the app's character)

- **He is completely bald.** No hair on his head: no hair at the sides, no strand on top. He has a mustache,
  eyebrows (they carry his expressions), black sunglasses, a red polka-dot shirt and a gold chain. The user found
  the old bald-on-top look with hair at the sides hurtful, so every drawing of him stays fully bald: the 빠른 기록
  reactions (`src/features/log/AjaeReaction.tsx`), the launch splash's J♥ (`index.html`), the app icon
  (`public/icons/icon.svg`, then `node scripts/make-icons.mjs`), and any new move, screen or picture of him.
- `src/features/log/AjaeReaction.test.tsx` enforces it ("is bald everywhere he appears"). It renders every tier's
  every move, the splash and the icon, and fails if anything in the hair brown `#3b2a1e` is not the mustache or a
  brow. New art must pass it as it is; do not loosen the test to fit a drawing.
- His animations use no words, Korean or English: only drawings and symbols (?, notes, stars, bursts, steam, the
  anger mark).
