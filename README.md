# Min-Max Coach data

Build, rune, and summoner meta for [Min-Max Coach](https://github.com/gutbolez/minmax-coach-releases),
published as a single `meta.json`. The app fetches this file at launch, so the
meta can change without shipping a new installer.

## How it works

`scripts/ingest.mjs` builds `meta.json` for the whole champion roster:

1. Enumerate every champion from Riot Data Dragon. Every champion gets an entry.
2. Seed each with an archetype default (summoners plus keystone) from its class,
   matching the app's built in fallback, so a champion never comes out blank.
3. Scrape the live meta from [lolalytics](https://lolalytics.com) with a headless
   browser and overlay it: the recommended summoners, keystone, and core items
   are read straight from the rendered page (the non-dimmed icons).
4. Apply `curated.json` last, so any manual override you set wins.

lolalytics renders its data inside a JavaScript app with no plain JSON API, so a
plain `fetch` gets an empty shell. A headless browser runs the page and reads the
finished, labelled build, the same thing a human sees. This is robust to their
internal data format because it reads the rendered result.

## Run it

```
npm install
npx playwright install --with-deps chromium
node scripts/ingest.mjs
```

Useful env vars:

- `TIER` (default `diamond_plus`): rank bracket to read the meta from.
- `CONCURRENCY` (default `4`): parallel pages.
- `LIMIT`: only scrape the first N champions (for a quick test).
- `HEADFUL=1`: show the browser window (debugging).

A GitHub Action (`.github/workflows/update-meta.yml`) runs this daily and commits
`meta.json` when it changes. You can also trigger it by hand from the Actions tab.

## Overriding a champion

The scrape reflects whatever lolalytics reports, which may differ from your read
of the meta. To force a value, add the champion to `curated.json`:

```json
"champions": {
  "Caitlyn": { "summoners": "Flash + Barrier", "keystone": "Press the Attack", "core": [6672, 3031, 3094], "boots": 3006 }
}
```

Anything in `curated.json` wins over the scrape. Leave it empty to let live data
drive every champion.

## Attribution

Meta sourced from lolalytics. Champion, item, rune, and summoner data from Riot
Games' Data Dragon. Not endorsed by or affiliated with Riot Games.
