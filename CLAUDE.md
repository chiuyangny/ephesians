# krengbible-web

Bilingual Korean/English Bible reader.  This repo is the **website** (krengbible.com) plus the **Cloudflare Worker source** that both the website and the iOS app call.

## The two repos

krengbible is two repos, and work often crosses between them.

| Repo | What it holds | Visibility |
|---|---|---|
| `jpk02/krengbible` (this one) | The website `index.html`, the Worker source in `worker/`, the daily-QT page, VOTD tooling | **Public** — never commit a secret here |
| `jpk02/krengbible-app` | The Expo/React Native iOS app, Firebase Functions, Firestore rules, and the Insights authoring pipeline | Private |

There is also `jpk02/krengbible-mobile`, an abandoned earlier attempt.  Ignore it.

Several scripts in the app repo expect the two checkouts to be **siblings** — `scripts/extractInsights.js` reads `../krengbible/index.html`.  Clone them as `krengbible/` and `krengbible-app/` in the same parent directory.

## Deployment surfaces

Four things ship independently.  Know which one a change touches before you start.

| Surface | Lives in | How it deploys |
|---|---|---|
| Website | `index.html`, `daily/`, `votd.html` | Push to `main` — GitHub Pages serves it, no CI step |
| Cloudflare Worker | `worker/index.js` | `wrangler deploy` from `worker/` (see below) |
| iOS app | app repo | EAS build, or an OTA bundle — see `RELEASING.md` there |
| Firebase | app repo | Auth, Firestore, Cloud Functions, rules |

The website is a single 2.7 MB `index.html` — CSS, a Firebase module script, and one large inline `<script>`.  Editing it means editing that file.

## Firebase

Project `krengbible`, shared by the website and the app.  Auth is email/password with verification and a reauth-gated delete-account path.  Firestore holds reading progress, notes, highlights and folders.

Both `index.html` and `daily/index.html` initialize Firebase separately, and both force Firestore into long-polling (`experimentalForceLongPolling: true`, `useFetchStreams: false`).  That is not incidental — Safari kept killing the WebChannel streams mid-session, which breaks `getDocs`, `setDoc` and `onSnapshot` alike since they all ride the same transport.  Do not "clean this up" back to streaming.

Firestore rules and indexes live in the app repo, not here.

## Working from a cloud or phone session

Cloud sessions (claude.ai/code, the mobile app) run in an Anthropic-hosted VM whose outbound network is governed by the environment's **Network access** level.  On the default **Trusted** level, npm and GitHub work, and everything else is refused with a 403 at the proxy.

What that means in practice:

- **Website changes work fully.**  Edit, verify, commit, push — GitHub Pages deploys with no further access needed.
- **Worker deploys need setup.**  `api.cloudflare.com` is not on the Trusted list.
- **You cannot check the live site or the live Worker** from a session unless those hosts are allowlisted.

### Enabling Worker deploys from a phone session

Two changes, both made once, in the environment dialog at claude.ai/code (select the cloud icon above the message box, then the settings icon on the environment):

1. **Network access** → **Custom**, with **Also include default list of common package managers** checked, and these in **Allowed domains**:

   ```
   api.cloudflare.com
   krengbible.pauljkim22.workers.dev
   krengbible.com
   ```

   The first is what `wrangler` calls.  The other two let a session verify the deploy actually worked and hit the `/admin/*` routes.

2. **Environment variables** → add a Cloudflare API token:

   ```
   CLOUDFLARE_API_TOKEN=...
   ```

   Mint it at Cloudflare → My Profile → API Tokens with **Workers Scripts: Edit** and **Workers KV Storage: Edit** on the krengbible account.  Use a scoped token, not the Global API Key.  It goes in the environment dialog only — this repo is public, so it must never reach a file here.

Note that environment variables are visible to anyone using that environment, so keep this on a personal environment rather than an organization-shared one.

With both in place, a deploy from a phone session is:

```bash
cd worker
npx wrangler deploy
```

`wrangler.toml` already carries the account id, worker name and KV binding, so there is nothing to pass.  `npx wrangler` installs cleanly on the Trusted list (npm is allowlisted), so the token and the domain are genuinely the only two gaps.

## The Worker

Source is `worker/index.js`, deployed to `krengbible.pauljkim22.workers.dev`.  `worker/README.md` has the full route table and the search-index runbook.

Bindings and secrets, per `wrangler.toml`:

- `COMMENTARY_KV` — KV namespace (dashboard name is `BIBLE_COMMENTARY`)
- `ESV_TOKEN`, `ANTHROPIC_KEY`, `ADMIN_SECRET` — via `wrangler secret put NAME`
- `RESEND_KEY`, `VOTD_EMAIL_FROM`, `VOTD_EMAIL_TO` — VOTD preview email; if unset the cron still stages the photo and skips the mail
- `VOTD_PUBLIC_ORIGIN` — optional, only if the Worker moves to a custom domain

Two crons: `0 8 * * *` warms the daily QT cache, `0 16 * * *` stages tomorrow's VOTD photo for preview and re-roll.  Both dispatch from `scheduled()` on `event.cron`.

To bust the KV cache for one chapter:

```bash
wrangler kv key delete --binding=COMMENTARY_KV "nkrv_1_1" --remote
```

### Korean search architecture

Korean full-text search uses a **pre-built flat index** in KV at `nkrv_search_index` — a JSON array of `[bookIdx, chapter, verse, cleanText]` tuples for all ~31k verses.  The Worker loads it once per isolate into a module-level cache, then every `/search/ko` query is in-memory `includes()` + `slice()`.

**Do not** revert `/search/ko` to a per-chapter KV scan — that was the old 10s–50s implementation.  If the index is missing, `/search/ko` returns HTTP 503 `{"error":"index_not_built"}` by design, so a wiped namespace fails loudly instead of returning partial results.

English search uses the same architecture (`/admin/build-en-index`), which replaced the ESV `passage/search` API after it dropped obvious matches like Psalm 119:105 for "lamp".

Rebuild instructions for both are in `worker/README.md`.

## Chapter Insights

The Insights feature is the long-running work across both repos.  Its current state is easy to get wrong, so read this section before touching anything Insights-related.

### Where authoring happens now

**The app repo is the source of truth for authoring.**  `INSIGHTS_AUTHORING.md` there carries the card contract, and `scripts/insights/` carries the tooling — `injectInsights.js`, `checkChapter.js`, `auditInsights.js`, `findDuplicateCards.js`, `reviewChapter.js`, plus `REVIEW_PROTOCOL.md` and a review ledger.

The data itself still lives in this repo, in the `INSIGHTS_SAMPLE` const inside the main inline `<script>` in `index.html`, keyed `"{bookNumber}_{chapter}"`.  The app pulls it across with `scripts/extractInsights.js`, which evaluates `INSIGHTS_SAMPLE` out of `../krengbible/index.html` and writes the app's `src/data/insights.ts`.  Re-run that after adding chapters here.

### What is actually written

`INSIGHTS_SAMPLE` holds 403 chapters: Genesis through 2 Chronicles (books 1–14), complete.  Nothing beyond 2 Chronicles.

An earlier pass covering Psalms and much of the New Testament was **withdrawn**, not shipped — its Korean did not meet the bar.  Do not treat older notes claiming "Matthew complete, Mark complete, Luke in progress" as current; that work is gone.  The books 1–14 corpus is a from-scratch rewrite in the house voice.

### The two-key gate

Cards are switched **off** on both surfaces, behind two keys that must agree:

- Website: `INSIGHT_CARDS_ENABLED = false` and `INSIGHT_ENABLED_CHAPTERS` at `index.html:8629`
- App: `INSIGHT_CARDS_ENABLED` and `ENABLED_CHAPTERS` in `src/components/InsightsPanel.tsx:201`

The boolean alone is not safe to flip.  `INSIGHTS_SAMPLE` still holds rows from the old pass, so enabling it without an allowlist would serve the withdrawn Korean for every chapter at once.  The allowlist is what makes the boolean flippable later.

Both allowlists currently hold **Genesis 1–15 only** — a chapter is added to either one only once **both** its English and its Korean have been replaced by the new authored batch.  Keep the two lists identical, key for key.  Changing one without the other is the bug this design exists to prevent.

### Card format

```js
"2_33": {
  cards: [
    {
      kicker_en: "Short label, title case",
      kicker_ko: "짧은 라벨",
      title_en: "Full question a reader would actually ask (33:1-6)?",
      title_ko: "독자가 실제로 물을 만한 질문",
      body_en: "Answer in ~250-320 words.  Use \\n\\n between paragraphs.  Two spaces between sentences.",
      body_ko: "자연스러운 한국어 흐름.  성경 인용은 개역개정 표현."
    }
  ]
}
```

The authoritative contract — including the title rules, the banned summary-prompt endings, and the uniform-format checklist every card must meet — is in the app repo's `INSIGHTS_AUTHORING.md`.  Read it before drafting.  The short version:

- **Voice**: Reformed-evangelical held *implicitly*.  Never write the words "Reformed", "Calvinist" or "the Reformed reading".  Just give the reading.
- **Titles** must be a genuine question the passage raises — why, what does this mean, how can this be — ending with the passage range and a question mark.  Not a summary prompt.  The body must answer the question asked, and say "the text does not say" when that is the honest answer.
- **Kickers**: short, title case, no ending period, no quotes.
- **Korean**: 개역개정 phrasing, standard Korean Presbyterian vocabulary (언약, 섭리, 그리스도, 메시아, 칭의, 성화, 원시복음).  Natural Korean, not an English calque.
- **Cards per chapter**: 2–4, by density.

`INSIGHTS_INDEX.md` in this repo lists every anchored concept by chapter.  Read it before drafting to avoid re-anchoring something already covered.

### Injecting into index.html

**Do not hand-escape card prose into a template literal.**  A `body_en`/`body_ko` is a long string full of quoted scripture; typing `\"` by hand across hundreds of lines silently drops a backslash somewhere and corrupts the file in a way that only surfaces later.  This has actually happened.

Instead, write the cards as a separate module exporting real JS values — plain template literals, real quote characters, no manual escaping — and have the injector `JSON.stringify()` each field when assembling the insertion.  That makes correct escaping mechanical rather than manual.

```js
// _cards.js — real JS strings, no manual escaping
module.exports = [
  { kicker_en: "...", kicker_ko: "...", title_en: "...", title_ko: "...",
    body_en: `... "quoted scripture" is just a literal quote here ...`,
    body_ko: `... 마찬가지로 그냥 그대로 쓰면 된다 ...` },
];

// _inject.js
const fs = require('fs');
const path = require('path');
const cards = require('./_cards.js');
const file = path.join(__dirname, 'index.html');
let src = fs.readFileSync(file, 'utf8');

const cardsText = cards.map((c) => {
  const fields = Object.entries(c).map(([k, v]) => `        ${k}: ${JSON.stringify(v)}`).join(',\n');
  return `      {\n${fields}\n      }`;
}).join(',\n');
const data = `,\n  "14_NN": {\n    cards: [\n${cardsText}\n    ]\n  }`;

const pat = /(\n  \}\n)\};\n/;
if (!pat.test(src)) { console.error('anchor not found'); process.exit(1); }
src = src.replace(pat, `$1${data}\n};\n`);
fs.writeFileSync(file, src, 'utf8');
console.log('OK');
```

The file uses plain LF line endings.  Save both scripts in the repo root, run the injector with `node`, then delete both.

After injecting, check that the key appears exactly once:

```bash
grep -c '"14_12":' index.html
```

A forgotten prior pass can silently duplicate a key — JS lets the later one win, but the dead first copy bloats the file unnoticed.  This bug has been found and fixed here before.

### Verification after injection

Always run this before committing.  It is what catches an escaping mistake or a missing comma before it ships.

```bash
node -e "
const s=require('fs').readFileSync('index.html','utf8');
const re=/<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/g;
let m,i=0;
while((m=re.exec(s))){
  const tag=s.slice(m.index,m.index+m[0].indexOf('>')+1);
  if(tag.includes('src=')||tag.includes('type=\"module\"')){ i++; continue; }
  try { new Function(m[1]); console.log('script',i,'ok'); } catch(e){ console.log('script',i,'FAIL:',e.message); }
  i++;
}
"
```

Then re-run `extractInsights.js` from the app repo so the app picks up the new chapters, and append the new anchored concepts to `INSIGHTS_INDEX.md`.

## Prose conventions (user-strict)

These apply to card text, commit messages, documentation and chat alike.

- **Two spaces between sentences**, always.  Strict preference.
- **Title-case headings**, never ALL CAPS.
- **No emojis** unless explicitly requested.
- **Honest pushback over validation** — surface tradeoffs rather than rubber-stamping.
