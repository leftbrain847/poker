# Poker Coach

A poker trainer for the 6-max no-limit hold'em **Double Up** (top half paid, rising antes). You play against
bots of chosen styles (GTO, TAG, LAG, Nit, Calling station, Maniac) and skill (1–5). A coach shows, for every
decision:

- **Balanced (GTO):** how an equilibrium player plays your exact hand here (frequencies).
- **Max exploit:** each option's ICM EV against this table as it really is, and the best one.
- **By player type:** how the best play and EV gaps change against each archetype.

Modes: **Live** (advice before you act), **Quiz** (act first, then see the grade), **Off** (stats only).

**How the numbers are made** (also in the app under "How the coach works"):

- Every outcome is scored by ICM (Malmuth–Harville), so bubble factors and risk premiums are built in.
- Short stacks: an ICM push/fold equilibrium solved live (fictitious play over 169 hands with exact card
  removal; `src/poker/nash.ts`). Checked against published heads-up Nash (10bb: 58% push, 37% call).
- Deeper stacks and postflop: an approximation of a solver (opening widths by position, ante and ICM;
  value-to-bluff ratios from bet size; ICM-adjusted minimum defence). Labelled "Approximation" in the app.
- Exploits: styles are deviations from balanced play; ranges narrow by Bayes after every action; the
  coach best-responds with one street of look-ahead.
- Preflop all-in equities come from `src/poker/preflop-equity.data.ts`, built by `npm run gen:equity`
  (Monte Carlo, 160k trials per matchup; spot-checked against exact enumeration).

Built on [app_builder](https://github.com/leftbrain847/app_builder).

- **Friends:** behind your Cloudflare login at `/<id>/` on your apps hostname (see `platform/platform.config.json`).
- **Google Play:** only if `targets.play.enabled` is true in `app.config.json`. Tag `vX.Y.Z` to build and upload to the internal track.

## Run

```sh
npm ci
npm run dev      # local dev server
npm test         # the rules' tests
```

| Command | Does |
| --- | --- |
| `npm run dev` | local dev server (no login, no host) |
| `npm test` | the rules' tests |
| `npm run worker:dev` | the full Worker locally (uses no Cloudflare quota) |
| `npm run build:play` | the offline Play bundle, checked for network code |
| `npm run build:demo` | the sprint demo: one self-contained page in `dist/demo/page.html` |
| `npm run gen:equity` | rebuild the preflop equity table (about 4 min on 4 cores) |

Deploys happen in CI on every push to `main`, followed by a smoke test that rolls the deploy back if the app isn't behind the login wall.

## Budget

Every app shares one free Cloudflare pool per day (resets 00:00 UTC). This app's rough cost:

- **Solo:** about 2 requests per ranked play, plus a few per run.
- **Turn-based:** 1 request to join, plus 1 request per 20 moves. The room sleeps between moves and costs nothing while idle.
