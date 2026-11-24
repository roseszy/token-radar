# Token Radar

A token launch radar for the make.fun bounty **token-radar-01** — "Build the best token launch radar".

It reads a sealed snapshot of every protocol DefiLlama tracks, works out which ones still record no token and are not a wrapped or staked product of one that trades, ranks them by what their launch would be worth, and hands in a web dashboard that shows the board, a detail view for each protocol, and the steps to farm it.

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/roseszy/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/roseszy/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

## How it works

`main.ts` (Node 22, standard library only) reads the sealed snapshot at `/input/snapshot.json` and writes:

- `board.json` — 226 ranked rows (the 40-protocol watchlist plus 186 early pre-token protocols), each with an implied value and a 6-step farm plan.
- `data.js` — the dashboard's data beside the page.
- `dashboard/` — a static page (Midnight Gold dark theme) that renders with no network.
- `screenshots/` — the board, a protocol detail view, and a filtered view.
- `dossier.json` — built with `buildDossier` from `vendor/makefun-board.ts`.

## The model (radar-2)

Implied value is derived from the snapshot's own figures only:

```
implied_value = TVL × 0.25 × growth factor × maturity factor × breadth factor
```

- **Growth factor** from the protocol's 7-day TVL change.
- **Maturity factor** from how long it has run with no token recorded.
- **Breadth factor** from how many chains it serves.

No protocol name is special-cased. The board separates protocols whose token already trades (shown in their own Live view by market cap) from those still to come. Implied values are estimates, not prices, and no launch is guaranteed.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

Then open `out/dashboard/index.html` (with `data.js` beside it).

## Results on this snapshot

- 758 protocols in the snapshot, 40 on the watchlist (floor $50M TVL).
- 226 rows scored, watchlist 40/40 covered.
- Top of the board: Steakhouse Financial $598.0M, Gauntlet $356.2M, Veda $342.4M, USDD $227.1M, Upshift $122.8M.
- Total implied value: $3.38B.
