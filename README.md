# packs-data

Data only: the solver chart packs of [PubAJ](https://github.com/bk-git-hub/My-GTO) (AGPL-3.0-or-later), solved by the
project's own postflop solver (`src/solver` on master). Never merged into master. The app reads it through jsDelivr
pinned to a full commit SHA (raw.githubusercontent.com as the fallback); `public/packs/data.json` on master names the
commit and the catalog's sha256.

- `packs/manifest.json`: the catalog (v2): one entry per pack, with the sha256 of its file list.
- `packs/<pack>/v<k>/index-<sha16>.json`: a pack's file list (content-addressed).
- `packs/<pack>/v<k>/flop-<board>.json`: one flop's strategies; a file at a path never changes.

Written by the presolve workflow (`.github/workflows/presolve.yml` on master, `scripts/packs-ingest.mjs` and
`scripts/presolve.mjs --rebuild-manifest`). Format: `docs/solver-packs.md` on master. Do not edit by hand.
