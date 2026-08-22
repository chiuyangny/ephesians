# krengbible Cloudflare Worker

Source for the Worker at `krengbible.pauljkim22.workers.dev`.  This repo is the source of truth, and `wrangler.toml` is configured with the account id, worker name, KV binding and crons — deploying is one command from this directory.

## What changed in the Korean search rewrite

**Before:** `/search/ko` looped through up to 1189 chapters, doing a serial `KV.get()` per chapter.  Cold queries took 10s+; pagination beyond the first page took 30–50s; verses in never-visited chapters were silently un-searchable.

**After:** A pre-built flat index lives in KV at `nkrv_search_index` — one JSON blob, roughly 5 MB, containing every verse as `[bookIdx, chapter, verse, cleanText]`.  The Worker loads it once per isolate (cold start ~100ms) into a module-level cache, then every query is in-memory `includes()` + `slice()`.  Sub-100ms per query regardless of page.

If the index hasn't been built yet, `/search/ko` returns HTTP 503 with `{"error":"index_not_built"}` rather than silently returning partial results.  This is intentional — if you ever wipe the KV namespace, search visibly breaks until you rebuild.

## Required env vars / bindings

- `COMMENTARY_KV` — KV namespace binding, declared in `wrangler.toml`
- `ESV_TOKEN` — ESV API token
- `ANTHROPIC_KEY` — Anthropic API key
- `API_BIBLE_KEY` — api.bible key, for the KLB and other api.bible translations
- `ADMIN_SECRET` — any random string; gates every `/admin/*` endpoint below

The VOTD preview email adds `RESEND_KEY`, `VOTD_EMAIL_FROM` and `VOTD_EMAIL_TO`,
same mechanism.  If any is unset the cron still stages the photo and skips the
mail — staging must not depend on mail working.  `VOTD_PUBLIC_ORIGIN` is
optional, and only needed if the Worker moves to a custom domain, since a cron
has no request to read its own host from.

Everything except `COMMENTARY_KV` is a secret: `wrangler secret put NAME`.

## Deploying

From this directory:

```bash
npx wrangler deploy
```

That is the whole thing — `wrangler.toml` carries the account id, worker name, KV
binding and cron triggers, so there is nothing to pass on the command line.  The
old dashboard copy-paste workflow is gone; do not reintroduce it.

Authentication is either an interactive `wrangler login` (works on a laptop) or a
`CLOUDFLARE_API_TOKEN` environment variable (the only option in a headless or
cloud session).  Mint a scoped token with **Workers Scripts: Edit** and **Workers
KV Storage: Edit** — not the Global API Key.  This repo is public, so the token
lives in your shell or your cloud environment's variables, never in a file here.

Deploying from a Claude Code cloud or phone session additionally needs
`api.cloudflare.com` on the environment's network allowlist; the default Trusted
level does not include it.  See the root `CLAUDE.md` for the exact setup.

Secrets are set separately and persist across deploys:

```bash
wrangler secret put ESV_TOKEN
wrangler secret put ANTHROPIC_KEY
wrangler secret put ADMIN_SECRET
```

## Building the English (ESV) search index

The English search now uses the same flat-index architecture as Korean, replacing the ESV `passage/search` API (which was a relevance-ranked black box that dropped obvious matches like Psalm 119:105 for "lamp").

Chunk size 250 chapters at a time, same as Korean.  Each chunk fetches the chapters from the ESV API (concurrency 8 to be polite).  After all chunks land, merge.

```bash
# Chunk 1: chapters 0-249
curl "https://krengbible.pauljkim22.workers.dev/admin/build-en-index?secret=YOUR_SECRET&from=0&size=250"

# Chunks 2-5
curl "https://krengbible.pauljkim22.workers.dev/admin/build-en-index?secret=YOUR_SECRET&from=250&size=250"
curl "https://krengbible.pauljkim22.workers.dev/admin/build-en-index?secret=YOUR_SECRET&from=500&size=250"
curl "https://krengbible.pauljkim22.workers.dev/admin/build-en-index?secret=YOUR_SECRET&from=750&size=250"
curl "https://krengbible.pauljkim22.workers.dev/admin/build-en-index?secret=YOUR_SECRET&from=1000&size=250"

# Merge once all chunks are done
curl "https://krengbible.pauljkim22.workers.dev/admin/merge-en-index?secret=YOUR_SECRET"
```

Each chunk takes 60–120s the first time (it's calling ESV ~250 times in parallel batches).  Subsequent chunks reuse the per-chapter cache (`esv_{book}_{chapter}` keys) unless you pass `&refetch=1`.

After merge, `/search/en` returns sub-second substring matches across the whole Bible — Psalm 119:105 will now show up for "lamp", and any other previously-missing matches.

## Building the Korean search index (first time, or after a wipe)

The Bible has 1189 chapters.  Building the index means walking each one, ensuring it's cached in KV, and writing flat verse tuples into chunk keys.  We do it in chunks so a single request stays well under the Worker CPU limit.

Replace `YOUR_SECRET` with your `ADMIN_SECRET` value below.  Default chunk size is 250 chapters.

```bash
# Chunk 1: chapters 0-249
curl "https://krengbible.pauljkim22.workers.dev/admin/build-index?secret=YOUR_SECRET&from=0&size=250"

# Chunk 2
curl "https://krengbible.pauljkim22.workers.dev/admin/build-index?secret=YOUR_SECRET&from=250&size=250"

# Chunk 3
curl "https://krengbible.pauljkim22.workers.dev/admin/build-index?secret=YOUR_SECRET&from=500&size=250"

# Chunk 4
curl "https://krengbible.pauljkim22.workers.dev/admin/build-index?secret=YOUR_SECRET&from=750&size=250"

# Chunk 5 (final — covers 1000-1188)
curl "https://krengbible.pauljkim22.workers.dev/admin/build-index?secret=YOUR_SECRET&from=1000&size=250"
```

Each chunk response tells you `nextFrom` (or `null` if done) so you can copy/paste the next URL straight from the JSON output.  If a chunk fetches a lot of un-cached chapters from bskorea.or.kr it can take 30–90 seconds.  Mostly-cached chunks finish in a few seconds.

When `done: true` shows up, run merge:

```bash
curl "https://krengbible.pauljkim22.workers.dev/admin/merge-index?secret=YOUR_SECRET"
```

This concatenates every `nkrv_search_chunk_*` key into the final `nkrv_search_index`.  Expected output: `totalVerses: ~31000`.

## Checking status

```bash
curl "https://krengbible.pauljkim22.workers.dev/admin/index-status?secret=YOUR_SECRET"
```

Returns the current index size, chunk count, and whether the current isolate has it cached.

## Rebuilding after Bible-text changes

If you ever change verse text (you almost certainly won't), re-run the chunked build with `&refetch=1` to force re-fetch from bskorea.or.kr instead of using the per-chapter KV cache.  Then merge again.

## Routes summary

| Route | Purpose | Notes |
|---|---|---|
| `/esv/?q=...` | ESV passage lookup | Passthrough to the ESV API |
| `/nkrv/{book}/{ch}` | Korean (개역개정) chapter | KV-cached forever |
| `/apibible/{translation}/{book}/{ch}` | api.bible chapter (KLB and others) | KV-cached forever |
| `/intro/{n}` | AI book intro | KV-cached forever |
| `/commentary/{book}/{ch}` | AI chapter commentary | KV-cached forever |
| `/qt-reflection/...` | Daily QT reflection | Warmed by the 08:00 UTC cron |
| `/search/ko?q=&offset=` | Korean search | Pre-built index — fast |
| `/search/en?q=&page=` | English (ESV) search | Pre-built index — fast |
| `/search/kjv?q=` | KJV search | Pre-built index — fast |
| `/search/apibible/{translation}` | api.bible translation search | Pre-built index — fast |
| `/votd` | Verse of the day | KV-cached until midnight ET |
| `/votd/next`, `/votd/reroll`, `/votd/reject`, `/votd/queue-add` | VOTD queue control | Backs `votd.html` |

All four search routes share one architecture: a flat `[bookIdx, chapter, verse,
text]` index in KV, loaded once per isolate into a module-level cache, then
scanned in memory.  None of them calls an upstream search API per query.

### Admin routes

Every one requires `?secret=YOUR_ADMIN_SECRET`.

| Route | Purpose |
|---|---|
| `/admin/build-index`, `/admin/merge-index` | Korean search index |
| `/admin/build-en-index`, `/admin/merge-en-index` | ESV search index |
| `/admin/build-apibible-index`, `/admin/merge-apibible-index` | api.bible search index |
| `/admin/index-status` | Inspect index size, chunk count, isolate cache state |
| `/admin/wipe-apibible-cache` | Drop cached api.bible chapters |
| `/admin/warm-esv`, `/admin/warm-nkt`, `/admin/warm-saebeon` | Pre-warm chapter caches |
| `/admin/votd-board`, `/admin/votd-chooser`, `/admin/votd-next`, `/admin/votd-act`, `/admin/votd-lowcheck` | VOTD staging and review |

## Crons

Declared in `wrangler.toml`, dispatched from `scheduled()` on `event.cron`:

| Schedule | What it does |
|---|---|
| `0 8 * * *` | Warms the daily QT cache.  08:00 UTC gives every timezone, as far out as UTC+14, at least a two-hour head start before their local midnight |
| `0 16 * * *` | Stages tomorrow's VOTD photo so it can be previewed and re-rolled before going live.  Noon EDT / 11am EST — crons are UTC-only, so the DST hour is accepted, not corrected |
