# krengbible-web

Bilingual Korean/English Bible reader, single-page static site in `index.html`.  Backend is a Cloudflare Worker at `krengbible.pauljkim22.workers.dev`.

## Worker source

The Worker source lives at `worker/index.js` in this repo.  **Deploy with `wrangler deploy` from the `worker/` directory** — `wrangler.toml` is configured with the account id, worker name, and KV binding so the deploy is one command.  No more dashboard paste workflow.

To bust the KV cache for a single chapter (e.g., to test a worker change):

```
wrangler kv key delete --binding=COMMENTARY_KV "nkrv_1_1" --remote
```

See `worker/README.md` for routes, env vars (`COMMENTARY_KV`, `ESV_TOKEN`, `ANTHROPIC_KEY`, `ADMIN_SECRET`, `API_BIBLE_KEY`), and the search-index build runbook.

### Deploying from a cloud or phone session

`npx wrangler deploy` works from a normal machine.  It does **not** work from a
Claude Code cloud session by default: those run behind an egress proxy, and
unless the environment's network policy allows `registry.npmjs.org`, npm cannot
fetch `wrangler` at all.  The failure is `403 Forbidden - GET
https://registry.npmjs.org/wrangler`, which looks like a broken install rather
than a blocked host.  `api.cloudflare.com` itself is reachable — npm is the only
thing in the way.

Two ways through:

- **Deploy from the Actions tab** — Actions → Deploy Worker → Run workflow.
  This needs no terminal at all, runs the same `wrangler deploy` on GitHub's
  runners, and smoke-tests the six reader-facing routes before reporting
  success.  Details in `worker/README.md`.
- **Allow `registry.npmjs.org`** in the session environment's network policy,
  then the one-line command above works as written.

A deploy is only worth doing when `worker/` has actually changed.  The live
Worker's deployment timestamp can be compared against the newest `worker/`
commit; if the deploy is the later of the two, there is nothing to ship, and
re-deploying only re-bundles the same source with a newer wrangler.

### Korean search architecture

Korean full-text search uses a **pre-built flat index** stored in KV at key `nkrv_search_index` — a JSON array of `[bookIdx, chapter, verse, cleanText]` tuples for all 31k verses (~2.2 MB).  The Worker loads it once per isolate into a module-level cache (`SEARCH_INDEX`), then every `/search/ko` query is in-memory `includes()` + `slice()`.  All pages return in ~200ms.

**Do not** revert `/search/ko` to a per-chapter KV scan — that was the old (10s–50s) implementation.  If the index is missing, `/search/ko` returns HTTP 503 `{"error":"index_not_built"}` by design — fail loudly so the rebuild is visible.

To rebuild after a KV wipe or text change: run `/admin/build-index` in 5 chunks of 250 chapters, then `/admin/merge-index`.  Full instructions in `worker/README.md`.

English search delegates to ESV's own API — fast, no index needed.

## Prose conventions (user-strict)

- **Two spaces between sentences**, always.  Strict preference.
- **Title-case headings**, never ALL CAPS.
- **No emojis** unless explicitly requested.
- **Honest pushback over validation** — surface tradeoffs rather than rubber-stamping.

## Chapter Insights feature — the in-progress work

Insights tab on each chapter renders Q&A-style cards.  Data lives in the `INSIGHTS_SAMPLE` const inside the main inline `<script>` in `index.html`.  Key format: `"{bookNumber}_{chapter}"` (e.g. `"2_33"` = Exodus 33).

### Status as of this writing

- Complete: Genesis (1-50), Exodus (1-40), Leviticus (1-27), Numbers (1-36), Psalms (1-150), Galatians (1-6), Colossians (1-4)
- Matthew: **complete (1-28)**.
- Mark: **complete (1-16)**.  Heavy synoptic overlap with Matthew throughout — Mark's cards took Mark's OWN distinctive angle (compression, *euthys* pace, messianic secret, Peter-eyewitness texture, Mark-unique details/sayings absent from Matthew's parallels) rather than re-explaining content Matthew's entries already anchor.  Apply the same cross-referencing discipline to Luke and John's heavy triple/double-tradition overlap with Matthew and Mark.
- Luke: **in progress (1-13 done, 14-24 remain)**.  Luke 8+ authored on Opus (elevated quality); 1-7 on Sonnet.  Plan: finish Luke+John on Opus, then re-run all earlier (Sonnet-authored) chapters on Opus in a second pass.  Same cross-referencing discipline as Mark — Luke's cards take Luke's own distinctive angle (historian's preface, attention to women/poor/outsiders, Magnificat/Benedictus, travel-narrative material unique to Luke) rather than re-explaining Matthew/Mark-anchored content.
- John remains.
- `INSIGHTS_INDEX.md` tracks all anchored concepts.  **Read it before drafting any new chapter** to avoid duplicating questions already covered.
- When injecting a new chapter, always check `grep -c '"BOOK_CH":' index.html` afterward to confirm exactly one occurrence — a stale/forgotten prior pass can silently duplicate a key (JS lets the later one win, but the dead first copy bloats the file unnoticed).  This exact bug was found and fixed for Exodus 33-40 in this session.

### Card format

```js
"2_33": {
  cards: [
    {
      kicker_en: "Short label, title case",
      kicker_ko: "짧은 라벨",
      title_en: "Full question a reader would actually ask",
      title_ko: "독자가 실제로 물을 만한 질문",
      body_en: "Answer in ~250-320 words.  Use \\n\\n between paragraphs.  Two spaces between sentences.",
      body_ko: "자연스러운 한국어 흐름.  성경 인용은 개역개정 표현."
    }
  ]
}
```

### Style rules (these matter — earlier rounds got rejected for missing these)

- **Voice**: Reformed-evangelical perspective held *implicitly*.  Never use the words "Reformed", "Calvinist", or "the Reformed reading" in card text.  Just give the reading.
- **Question titles**: actual questions a curious reader would ask (not thematic essay headings).  Example: "Why does Pharaoh keep agreeing to release Israel when the plague hits, then reneging when it lifts?" — not "The pattern of false repentance".
- **Kicker labels**: short title case (e.g. "The mercy seat", "Bridegroom of blood", "Hardening").  Never all caps.
- **Body length**: 250-320 words per card.  Longer is OK for dense theological questions (the "I AM" card runs ~340).  Shorter is OK for narrative-only chapters.
- **Korean**: use 개역개정 verse phrasings throughout.  Standard Korean Presbyterian theological vocabulary (언약, 섭리, 그리스도, 메시아, 칭의, 성화, 원시복음).  Body should read as natural Korean, not English calque.
- **Cross-references**: scriptural is fine (Rom 9:17, Heb 11:21, John 1:14).  Vary them — don't recycle the same NT echo in every chapter.  Some heavily-used refs are listed in `INSIGHTS_INDEX.md`; prefer different ones when possible.
- **Cards per chapter**: 2-4 based on density.  Narrative-rich chapters (Ex 32 golden calf, Ex 33 face-to-face) get 3-4.  Construction-detail chapters (Ex 36-39 tabernacle building, repeating instructions from 25-31) get 1-2.

### Avoiding duplication

`INSIGHTS_INDEX.md` lists every anchored concept by chapter.  Major patterns already used:

- "God remembered" / *zakar* → anchored at Ex 2
- Divine name "I AM" → Ex 3
- "Hardened Pharaoh's heart" + compatibilism + Rom 9 → Ex 4
- Plagues vs Egyptian pantheon → Ex 7
- Pharaoh's false repentance pattern → Ex 8
- Lamb / Passover / Christ → Ex 12
- Red Sea as baptism → Ex 14
- "I AM WHO I AM" and divine name → Ex 3 (don't re-explain in later chapters)
- Tabernacle as God-dwelling-with-people → Ex 25 (later chapters can build on, not repeat)
- Aaron's failure pattern → Ex 32

If a concept appears in a later chapter where it's already been anchored, either skip the question or find a chapter-specific angle that adds something new.

### Injection pattern

New chapter data is injected into `INSIGHTS_SAMPLE` via a temporary Node script.  File uses plain LF line endings (an earlier version of this doc claimed CRLF — wrong, confirmed by direct inspection).

**Don't hand-escape the card prose into a template literal.**  A card's `body_en`/`body_ko` is a long string full of `"..."` quotes for scripture citations — manually typing `\"` throughout is exactly the kind of repetitive escaping that silently drops a backslash somewhere in a few hundred lines of prose, corrupting the file in a way that only surfaces later (this happened once, mid-session, on Matt 23's card 2).  Instead, write the cards as a **separate module exporting real JS values** (plain template literals, real quote characters, no manual escaping at all), then have the injector `JSON.stringify()` each field when assembling the insertion — this makes correct escaping mechanical instead of manual, for any content the cards happen to contain.

```js
// cards.js — real JS strings, no manual escaping
module.exports = [
  { kicker_en: "...", kicker_ko: "...", title_en: "...", title_ko: "...",
    body_en: \`... "quoted scripture" is just a literal quote here ...\`,
    body_ko: \`... 마찬가지로 그냥 그대로 쓰면 된다 ...\` },
];

// inject.js
const fs = require('fs');
const cards = require('./cards.js');
const file = '/Users/pauljuhyenkim/krengbible/index.html';
let src = fs.readFileSync(file, 'utf8');

const cardsText = cards.map((c) => {
  const fields = Object.entries(c).map(([k, v]) => \`        \${k}: \${JSON.stringify(v)}\`).join(',\\n');
  return \`      {\\n\${fields}\\n      }\`;
}).join(',\\n');
const data = \`,\\n  "40_NN": {\\n    cards: [\\n\${cardsText}\\n    ]\\n  }\`;

const pat = /(\\n  \\}\\n)\\};\\n/;
if (!pat.test(src)) { console.error('anchor not found'); process.exit(1); }
src = src.replace(pat, \`$1\${data}\\n};\\n\`);
fs.writeFileSync(file, src, 'utf8');
console.log('OK');
```

Save both as `_cards.js`/`_inject.js`, run the injector with `node`, then delete both.  Always run the verification script (below) before committing — it's what catches an escaping mistake or a missing-comma corruption before it ships.  Commit with a descriptive message listing chapter cards.  Push to `origin main`.

### Verification after injection

Always run this sanity check after injection to confirm no JS broke and chapters are present:

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

### Update the registry when done

After all chapters in a batch are pushed, append the new anchored concepts to `INSIGHTS_INDEX.md` under the appropriate Exodus chapter heading.
