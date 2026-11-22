# Poker Coach

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

Deploys happen in CI on every push to `main`, followed by a smoke test that rolls the deploy back if the app isn't behind the login wall.

## Budget

Every app shares one free Cloudflare pool per day (resets 00:00 UTC). This app's rough cost:

- **Solo:** about 2 requests per ranked play, plus a few per run.
- **Turn-based:** 1 request to join, plus 1 request per 20 moves. The room sleeps between moves and costs nothing while idle.
