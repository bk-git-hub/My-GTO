# Notes for coding agents

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
