// krengbible Cloudflare Worker
//
// Routes:
//   /esv/?q=...                           -> ESV API passage lookup (passthrough)
//   /intro/{bookNum}                      -> AI-generated book intro (cached in COMMENTARY_KV)
//   /commentary/{bookNum}/{chapter}       -> AI-generated chapter commentary (cached)
//   /qt-reflection/{bookNum}/{chapter}/{verseStart}/{verseEnd}
//                                          -> AI-generated QT reflection scoped to a verse range (cached)
//   /woori/{book}/{chapter}               -> 우리말성경 chapter (KV only; imported, not scraped)
//   /search/ko?q=...&offset=...           -> Korean full-text search (FAST: uses pre-built index)
//   /search/en?q=...&page=...             -> English full-text search (FAST: uses pre-built index)
//   /votd[?date=YYYY-MM-DD]              -> Verse of the day + photo.  `date` picks a
//                                          specific ET date, clamped to the last 3 days;
//                                          readers ask for local-date-minus-one so every
//                                          timezone rolls at its OWN midnight.
//   /votd/next                            -> Tomorrow's STAGED photo (public, read-only, never rolls)
//   /admin/votd-next?date=YYYY-MM-DD      -> (X-Admin-Secret) re-roll the photo for a date.  Allowed over
//                                            the same window /votd serves — ET-today-minus-2 forward — so
//                                            any photo a reader can still be shown can still be changed.
//   /votd/reroll?date=...&t=<hmac>        -> One-tap re-roll from the preview email.  HMAC of the date,
//                                            keyed by ADMIN_SECRET — scoped to one day, secret never in URL.
//                                            Same window as /admin/votd-next.
//   /nkrv/{book}/{chapter}                -> Korean Bible (NKRV), cached per chapter
//   /admin/warm-esv?from=N&size=M&concurrency=N (X-Admin-Secret header, not ?secret= — keeps it out of URL logs)
//                                                   -> Pre-fetch every ESV chapter into KV (live /esv/
//                                                      cache, not the search index) so no request has
//                                                      to call Crossway live.  Chunked, run repeatedly.
//   /admin/warm-saebeon?from=N&size=M&concurrency=N (X-Admin-Secret header) -> same, for 새번역 (live /saebeon/
//                                                      cache).  Each chapter here is a bskorea.or.kr scrape
//                                                      PLUS an Anthropic call to translate headings, so it's
//                                                      slower per-chapter than warm-esv — lower default
//                                                      concurrency.  Chunked, run repeatedly.
//   /admin/build-index?secret=...&from=N&size=M     -> (re)build the Korean search index.  Chunked.
//   /admin/merge-index?secret=...                   -> Merge KO chunks -> nkrv_search_index.
//   /admin/build-en-index?secret=...&from=N&size=M  -> (re)build the ESV English search index.  Chunked.
//   /admin/merge-en-index?secret=...                -> Merge EN chunks -> esv_search_index.
//   /admin/index-status?secret=...                  -> Status of both indexes + api.bible cache counts.
//   /admin/wipe-apibible-cache?secret=...[&translationId=...]
//                                                   -> Delete cached api.bible chapters + chunks + index.
//   /admin/build-apibible-index?secret=...&translationId=...&from=N&size=M
//                                                   -> (re)build the api.bible search index for one translation.
//                                                      Chunked.  Side effect: warms per-chapter KV cache.
//   /admin/merge-apibible-index?secret=...&translationId=...
//                                                   -> Merge per-translation chunks -> apibible_search_index_{id}.
//   /apibible/{translationId}/{bookNum}/{chapter}   -> api.bible chapter fetch (NLT/NIV/MSG).
//                                                      30-day KV TTL.  FUMS token returned for client to ping.
//   /search/apibible/{translationId}?q=...&page=...
//                                                   -> Per-translation search.  Uses pre-built index when
//                                                      available (instant); falls back to live api.bible search
//                                                      when not built.
//
// Search index formats:
//   nkrv_search_index : JSON array of [bookIdx, chapter, verse, text] tuples for the Korean Bible.
//   esv_search_index  : JSON array of [bookIdx, chapter, verse, text] tuples for the ESV Bible.
//   bookIdx is 0-based, verse is the original label.
//
// During build we write partial chunks to KV keys (nkrv_search_chunk_N / esv_search_chunk_N), then
// the matching /admin/merge-* endpoint reads them all and writes the final index blob.

import { getReadingForDate } from './dailyPlan.js';

const BOOK_NAMES_EN = [
  'Genesis','Exodus','Leviticus','Numbers','Deuteronomy','Joshua','Judges','Ruth',
  '1 Samuel','2 Samuel','1 Kings','2 Kings','1 Chronicles','2 Chronicles','Ezra','Nehemiah',
  'Esther','Job','Psalms','Proverbs','Ecclesiastes','Song of Solomon','Isaiah','Jeremiah',
  'Lamentations','Ezekiel','Daniel','Hosea','Joel','Amos','Obadiah','Jonah',
  'Micah','Nahum','Habakkuk','Zephaniah','Haggai','Zechariah','Malachi',
  'Matthew','Mark','Luke','John','Acts','Romans','1 Corinthians','2 Corinthians',
  'Galatians','Ephesians','Philippians','Colossians','1 Thessalonians','2 Thessalonians',
  '1 Timothy','2 Timothy','Titus','Philemon','Hebrews','James',
  '1 Peter','2 Peter','1 John','2 John','3 John','Jude','Revelation'
];
const BOOK_NAMES_KO = [
  '창세기','출애굽기','레위기','민수기','신명기','여호수아','사사기','룻기',
  '사무엘상','사무엘하','열왕기상','열왕기하','역대상','역대하','에스라','느헤미야',
  '에스더','욥기','시편','잠언','전도서','아가','이사야','예레미야',
  '예레미야애가','에스겔','다니엘','호세아','요엘','아모스','오바댜','요나',
  '미가','나훔','하박국','스바냐','학개','스가랴','말라기',
  '마태복음','마가복음','누가복음','요한복음','사도행전','로마서','고린도전서','고린도후서',
  '갈라디아서','에베소서','빌립보서','골로새서','데살로니가전서','데살로니가후서',
  '디모데전서','디모데후서','디도서','빌레몬서','히브리서','야고보서',
  '베드로전서','베드로후서','요한일서','요한이서','요한삼서','유다서','요한계시록'
];
const BOOK_CHAPTERS = [50,40,27,36,34,24,21,4,31,24,22,25,29,36,10,13,10,42,150,31,12,8,66,52,5,48,12,14,3,9,1,4,7,3,3,3,2,14,4,28,16,24,21,28,16,16,13,6,6,4,4,5,3,6,4,3,1,13,5,5,3,5,1,1,1,22];
const NKRV_CODES = [
  "gen","exo","lev","num","deu","jos","jdg","rut",
  "1sa","2sa","1ki","2ki","1ch","2ch","ezr","neh",
  "est","job","psa","pro","ecc","sng","isa","jer",
  "lam","ezk","dan","hos","jol","amo","oba","jnh",
  "mic","nam","hab","zep","hag","zec","mal",
  "mat","mrk","luk","jhn","act","rom","1co","2co",
  "gal","eph","php","col","1th","2th","1ti","2ti",
  "tit","phm","heb","jas","1pe","2pe","1jn","2jn",
  "3jn","jud","rev"
];

// USFM book codes (uppercase) — what api.bible expects in chapter IDs like "GEN.1".
// Differs from NKRV_CODES only by case and JON vs JNH (Jonah).
const USFM_CODES = [
  "GEN","EXO","LEV","NUM","DEU","JOS","JDG","RUT",
  "1SA","2SA","1KI","2KI","1CH","2CH","EZR","NEH",
  "EST","JOB","PSA","PRO","ECC","SNG","ISA","JER",
  "LAM","EZK","DAN","HOS","JOL","AMO","OBA","JON",
  "MIC","NAM","HAB","ZEP","HAG","ZEC","MAL",
  "MAT","MRK","LUK","JHN","ACT","ROM","1CO","2CO",
  "GAL","EPH","PHP","COL","1TH","2TH","1TI","2TI",
  "TIT","PHM","HEB","JAS","1PE","2PE","1JN","2JN",
  "3JN","JUD","REV"
];

// Whitelist of api.bible translation IDs the app is authorized to fetch.
// Keep this list explicit: any ID not in here returns 403 even with a valid key.
// abbreviation/name are used for the in-response identification and downstream attribution.
const API_BIBLE_TRANSLATIONS = {
  'd6e14a625393b4da-01': { abbreviation: 'NLT', name: 'New Living Translation' },
  '78a9f6124f344018-01': { abbreviation: 'NIV', name: 'New International Version' },
  '6f11a7de016f942e-01': { abbreviation: 'MSG', name: 'The Message' },
  // KLB (현대인의 성경 / Korean Living Bible, 1985) — a KOREAN translation served
  // through /apibible like the English ones; the app lists it under its Korean
  // translations.  MSG stays whitelisted (no longer selectable in the app, but
  // keeping the entry preserves its cache and costs nothing).
  'e959e47176271f18-01': { abbreviation: 'KLB', name: 'Korean Living Bible' }
  // KJV is intentionally NOT here.  It's public domain, so routing it through
  // api.bible only spent quota for text we can serve ourselves — see the
  // dedicated /kjv route, which reads no-TTL KV populated from a public-domain
  // dataset and never calls api.bible at all.
};

// 30 days, in seconds — matches api.bible's required cache-refresh cadence.
const API_BIBLE_CACHE_TTL = 30 * 24 * 60 * 60;

// ---- Module-level search index cache (per isolate) ----
// SEARCH_INDEX: the parsed array of [b, c, v, t] tuples once loaded.
// SEARCH_INDEX_PROMISE: in-flight load promise so concurrent requests share one KV read.
let SEARCH_INDEX = null;
let SEARCH_INDEX_PROMISE = null;
let EN_SEARCH_INDEX = null;
let EN_SEARCH_INDEX_PROMISE = null;
// KJV flat search index, same shape as EN_SEARCH_INDEX, retained per isolate.
// KJV is public domain and served from KV we populate ourselves (see the /kjv
// route) — it never touches api.bible, so it has no quota, no FUMS, no TTL.
let KJV_SEARCH_INDEX = null;
let KJV_SEARCH_INDEX_PROMISE = null;
// Per-translation api.bible index cache: { [translationId]: tuples[] }.
// Same shape as EN_SEARCH_INDEX; loaded lazily, retained for the isolate's lifetime.
const APIBIBLE_INDEXES = Object.create(null);
const APIBIBLE_INDEX_PROMISES = Object.create(null);

async function getSearchIndex(env) {
  if (SEARCH_INDEX) return SEARCH_INDEX;
  if (SEARCH_INDEX_PROMISE) return SEARCH_INDEX_PROMISE;
  SEARCH_INDEX_PROMISE = (async () => {
    const raw = await env.COMMENTARY_KV.get('nkrv_search_index');
    if (!raw) {
      SEARCH_INDEX_PROMISE = null;
      return null;
    }
    try {
      SEARCH_INDEX = JSON.parse(raw);
    } catch (e) {
      SEARCH_INDEX = null;
    }
    SEARCH_INDEX_PROMISE = null;
    return SEARCH_INDEX;
  })();
  return SEARCH_INDEX_PROMISE;
}

// ---- Per-Korean-version search indexes ----
// The scraped Korean versions each get their own flat index in KV
// (`{prefix}_search_index`), built the same way as NKRV.  NKRV keeps its
// original getSearchIndex path untouched (lowest risk); SAEBEON/NKT load
// through a small per-prefix cache.  KLB is NOT here — it searches via
// api.bible (/search/apibible) instead.  `fetch` is the version's
// fetchAndCache*, `verseKey` its per-chapter KV cache key (for refetch busting).
const KO_INDEX_CONFIG = {
  NKRV:    { prefix: 'nkrv',    fetch: fetchAndCacheNkrv,    verseKey: (b, c) => `nkrv_v4_${b}_${c}` },
  SAEBEON: { prefix: 'saebeon', fetch: fetchAndCacheSaebeon, verseKey: (b, c) => `saebeon_v1_${b}_${c}` },
  NKT:     { prefix: 'nkt',     fetch: fetchAndCacheNkt,     verseKey: (b, c) => `nkt_v1_${b}_${c}` },
  WOORI:   { prefix: 'woori',   fetch: fetchAndCacheWoori,   verseKey: (b, c) => `woori_${b}_${c}` },
};
function koIndexConfig(v) {
  return KO_INDEX_CONFIG[String(v || 'NKRV').toUpperCase()] || KO_INDEX_CONFIG.NKRV;
}

const KO_INDEX_CACHE = new Map();   // prefix -> parsed tuple array
const KO_INDEX_PROMISE = new Map(); // prefix -> in-flight load promise

async function getKoSearchIndexByPrefix(env, prefix) {
  // NKRV keeps its dedicated, already-proven loader untouched.
  if (prefix === 'nkrv') return getSearchIndex(env);
  if (KO_INDEX_CACHE.has(prefix)) return KO_INDEX_CACHE.get(prefix);
  if (KO_INDEX_PROMISE.has(prefix)) return KO_INDEX_PROMISE.get(prefix);
  const p = (async () => {
    const raw = await env.COMMENTARY_KV.get(`${prefix}_search_index`);
    let idx = null;
    if (raw) { try { idx = JSON.parse(raw); } catch (e) { idx = null; } }
    if (idx) KO_INDEX_CACHE.set(prefix, idx);
    KO_INDEX_PROMISE.delete(prefix);
    return idx;
  })();
  KO_INDEX_PROMISE.set(prefix, p);
  return p;
}
function bustKoSearchIndex(prefix) {
  if (prefix === 'nkrv') { SEARCH_INDEX = null; SEARCH_INDEX_PROMISE = null; return; }
  KO_INDEX_CACHE.delete(prefix);
  KO_INDEX_PROMISE.delete(prefix);
}

async function getEnSearchIndex(env) {
  if (EN_SEARCH_INDEX) return EN_SEARCH_INDEX;
  if (EN_SEARCH_INDEX_PROMISE) return EN_SEARCH_INDEX_PROMISE;
  EN_SEARCH_INDEX_PROMISE = (async () => {
    const raw = await env.COMMENTARY_KV.get('esv_search_index');
    if (!raw) {
      EN_SEARCH_INDEX_PROMISE = null;
      return null;
    }
    try {
      EN_SEARCH_INDEX = JSON.parse(raw);
    } catch (e) {
      EN_SEARCH_INDEX = null;
    }
    EN_SEARCH_INDEX_PROMISE = null;
    return EN_SEARCH_INDEX;
  })();
  return EN_SEARCH_INDEX_PROMISE;
}

// ---- HTML -> verses parser for bskorea.or.kr (extracted so /admin/build-index can reuse it) ----
// Korean consonant footnote markers (ㄱ ㄴ ㄷ ㄹ ㅁ ㅂ ㅅ ㅇ ㅈ ㅊ ㅋ ㅌ ㅍ ㅎ)
// are bskorea's SECOND, independent marker alphabet — used for cross-
// references (관주), kept visually distinct from the digit markers
// (1) 2) 3)...) used for translation notes, specifically so the two
// don't collide within the same chapter.  Offset by +100 (rather than
// reusing 1..14 directly) so the two alphabets land in disjoint key
// ranges once normalized to numbers — confirmed via 1 Corinthians 1,
// which has BOTH a digit-1 translation note (v13, "Greek: or
// 'immersion'") and a consonant-ㄱ cross-reference (v19, Isaiah
// 29:14) in the same chapter.  Mapping both to bare "1" clobbered the
// v13 note with the v19 cross-ref everywhere key "1" was used — every
// occurrence of "baptism" in 13-17 showed the Isaiah reference instead
// of its own footnote.  The offset is internal-only (a lookup key, not
// displayed — see ChapterPane's renderSegs, which renders a generic
// marker icon regardless of the key's value), so it's safe.
const KO_FN_LETTER_TO_NUM = {
  'ㄱ': 101, 'ㄴ': 102, 'ㄷ': 103, 'ㄹ': 104, 'ㅁ': 105, 'ㅂ': 106, 'ㅅ': 107,
  'ㅇ': 108, 'ㅈ': 109, 'ㅊ': 110, 'ㅋ': 111, 'ㅌ': 112, 'ㅍ': 113, 'ㅎ': 114
};

// bskorea's cross-reference anchors encode a target verse as
// "BGAE" + 3-char NKRV book code + 3-digit chapter + 3-digit verse,
// e.g. "BGAEmrk002001" -> Mark 2:1.  All NKRV_CODES entries are
// exactly 3 characters, so this is fixed-width and safe to parse.
function parseTarRef(tar) {
  const m = /^BGAE([a-z0-9]{3})(\d{3})(\d{3})$/.exec(tar);
  if (!m) return null;
  const bookIdx = NKRV_CODES.indexOf(m[1]);
  if (bookIdx === -1) return null;
  return { bookIdx, chapter: parseInt(m[2], 10), verse: parseInt(m[3], 10) };
}

// Section headings on bskorea look like:
//   <font class="smallTitle">중풍병자를 고치시다(<a TAR="BGAEmrk002001">막 2:1-12</A>; <a TAR="BGAEluk005017">눅 5:17-26</A>)</font>
// immediately followed (after a couple of <br/> tags) by the verse
// span the heading introduces.  Extract the plain title, the
// Synoptic-parallel links (both a human label and a parsed jump
// target), and the verse number the heading anchors to.
function extractHeadings(html) {
  const headings = [];
  const titleRe = /<font class="smallTitle">([\s\S]*?)<\/font>/gi;
  let m;
  while ((m = titleRe.exec(html)) !== null) {
    const block = m[1];

    const parallels = [];
    const aRe = /<a\s+TAR=["']?([^"'>]+)["']?[^>]*>([^<]+)<\/a>/gi;
    let am;
    while ((am = aRe.exec(block)) !== null) {
      parallels.push({ label: am[2].trim(), ref: parseTarRef(am[1]) });
    }

    const plainBlock = block
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .trim();
    const title = plainBlock.split('(')[0].trim();
    if (!title) continue;

    // The verse this heading introduces is the next "number" span
    // after the heading closes — look a short distance ahead rather
    // than re-parsing the whole document.
    const afterIdx = titleRe.lastIndex;
    const nextNumMatch = /<span class="number">(\d+)/.exec(html.slice(afterIdx, afterIdx + 500));
    if (nextNumMatch) {
      headings.push({ verse: parseInt(nextNumMatch[1], 10), title, parallels });
    }
  }
  return headings;
}

function parseNkrvHtml(html) {
  const divTextMap = {};
  const d2Re = /<div\b[^>]*\bid=['"]?(D_\d+_\d+)['"]?[^>]*>/gi;
  let d2Match;
  while ((d2Match = d2Re.exec(html)) !== null) {
    const divId = d2Match[1];
    const start = d2Re.lastIndex;
    const end = html.indexOf('</div>', start);
    if (end === -1) continue;
    const body = html.slice(start, end);
    const fnText = body
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim();
    if (fnText) divTextMap[divId] = fnText;
  }

  const footnotes = {};
  // Match either digit or Korean consonant footnote labels in the popup
  // anchor.  Normalize Korean letters to position numbers so the key
  // matches the inline-marker key we'll emit below.
  const popRe = /clickPopUp\('([^']+)'[^)]*\)[^<]*<font[^>]*>([ㄱ-ㅎ\d]+)\)<\/font>/gi;
  let popMatch;
  while ((popMatch = popRe.exec(html)) !== null) {
    const divId = popMatch[1];
    let fnKey = popMatch[2];
    if (/^[ㄱ-ㅎ]+$/.test(fnKey)) {
      const mapped = KO_FN_LETTER_TO_NUM[fnKey];
      if (!mapped) continue;
      fnKey = String(mapped);
    }
    if (fnKey && divId && divTextMap[divId]) footnotes[fnKey] = divTextMap[divId];
  }

  const verses = [];
  const parts = html.split('<span class="number">');
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    const numMatch = part.match(/^(\d+(?:-\d+)?)/);
    if (!numMatch) continue;
    const numStr = numMatch[1];
    const num = parseInt(numStr);
    const afterClose = part.replace(/^[\d-]+(?:&nbsp;)+<\/span>/, '');
    const end = afterClose.indexOf('</span>');
    const raw = end > -1 ? afterClose.substring(0, end) : afterClose;
    let text = raw
      .replace(/<font\b[^>]*class=["']smallTitle["'][^>]*>[\s\S]*?<\/font>/gi, '')
      .replace(/<div[^>]*>[\s\S]*?<\/div>/gi, '')
      // Extract footnote markers from bskorea's <a class=comment>...<font>N)</font></a>
      // tags BEFORE the general <a> strip below.  Marker may be digit (1, 2, ...) or
      // Korean consonant (ㄱ, ㄴ, ...); normalize Korean letters to position numbers
      // so the key matches the digit-keyed `footnotes` dict.
      .replace(
        /<a\s+class=["']?comment["']?[^>]*>[\s\S]*?<font[^>]*>([ㄱ-ㅎ\d]+)\)<\/font>[\s\S]*?<\/a>/gi,
        (_, marker) => {
          let key = marker;
          if (/^[ㄱ-ㅎ]+$/.test(key)) {
            const mapped = KO_FN_LETTER_TO_NUM[key];
            if (!mapped) return '';
            key = String(mapped);
          }
          return `(KN:${key})`;
        }
      )
      .replace(/<a[^>]*>[\s\S]*?<\/a>/gi, '')
      .replace(/<sup[^>]*>[\s\S]*?<\/sup>/gi, '')
      .replace(/<h[1-6][^>]*>[\s\S]*?<\/h[1-6]>/gi, '')
      .replace(/<p\b[^>]*class=["'][^"']*title[^"']*["'][^>]*>[\s\S]*?<\/p>/gi, '')
      .replace(/<div\b[^>]*class=["'][^"']*(title|head|heading)[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\(\s*\)/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim();
    // Defensive cleanup for any markers that escaped the <a class=comment>
    // pre-processing above (rare, but possible if bskorea ever renders
    // markers as plain text).  Negative lookbehind on the digit regex
    // prevents re-matching digits already inside an emitted "(KN:N)" —
    // `\d*` (variable-length, V8 supports this) rather than a fixed
    // "(KN:" is required once N can be 2-3 digits (consonant-derived
    // keys are now offset by +100, see KO_FN_LETTER_TO_NUM): a fixed
    // 4-char lookbehind only blocks a match starting immediately after
    // "(KN:", so for "(KN:101)" the engine could still start a fresh
    // \d+ match one character later at "01)" (preceded by "KN:1", not
    // "(KN:") and mangle it into "(KN:1(KN:01)".
    text = text.replace(/([ㄱ-ㅎ])\)\s*/g, (_, ch) => {
      const n = KO_FN_LETTER_TO_NUM[ch];
      return n ? `(KN:${n})` : '';
    });
    text = text.replace(/(?<!\(KN:\d*)(\d+)\)\s*/g, '(KN:$1)');
    // bskorea places footnote anchors BEFORE the annotated word; the marker
    // belongs AFTER the word per Korean Bible convention.  Swap each
    // "(KN:N)WORD" → "WORD(KN:N)" so consumers can render markers inline
    // without further post-processing.
    text = text.replace(/^\(KN:(\d+)\)(\S+)/, '$2(KN:$1)');
    text = text.replace(/(\s)\(KN:(\d+)\)(\S+)/g, '$1$3(KN:$2)');
    const verseLabel = numStr.includes('-') ? numStr : num;
    if (text.length > 1) verses.push({ verse: verseLabel, text });
  }

  const headings = extractHeadings(html);

  return { verses, footnotes, headings };
}

// ---- ESV headings + cross-references (best-effort, additive) ----
// Fetches the SAME passage from ESV's HTML endpoint (separate from the
// proven text-endpoint fetch used for verses/footnotes, which this
// never touches) purely to harvest section headings and cross-refs.
// Uses HTMLRewriter (Workers' native streaming HTML parser) rather
// than regex, since we don't have a verified copy of ESV's exact
// output markup to test against — HTMLRewriter degrades gracefully
// (matches nothing, returns empty arrays) if a selector doesn't hit,
// rather than throwing on malformed-regex-assumptions.  `verse-num`
// is confirmed from ESV's own docs example; the heading tag level
// (h2/h3/h4) and crossref container class are reasonable but
// UNVERIFIED guesses — check real output after deploying and refine
// the selectors below if headings/crossrefs come back empty.
// `ok: false` tells the caller the fetch didn't actually succeed (still
// throttled after retries, or a network error) — as opposed to `ok: true`
// with an empty headings array, which means ESV genuinely has no heading
// there.  That distinction matters because fetchAndCacheEsv writes this
// into a no-TTL forever cache: silently treating "throttled" the same as
// "no headings" would permanently bake a false-empty result into the
// cache the moment ESV rate-limits a request — which is exactly what
// happened (Romans 11 cached with an empty English headings array while
// the Korean side, fetched separately, kept its real ones).
async function fetchEsvHeadingsAndCrossrefs(q, env) {
  const htmlUrl = 'https://api.esv.org/v3/passage/html/?q=' + encodeURIComponent(q)
    + '&include-headings=true&include-subheadings=true&include-crossrefs=true'
    + '&include-footnotes=false&include-verse-numbers=true'
    + '&include-passage-references=false&include-audio-link=false'
    + '&include-css-link=false&include-copyright=false&include-short-copyright=false'
    + '&include-chapter-numbers=false&include-book-titles=false';

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const resp = await fetch(htmlUrl, { headers: { Authorization: 'Token ' + env.ESV_TOKEN } });
      if (resp.status === 429) {
        const wait = 500 * Math.pow(2, attempt);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      if (!resp.ok) return { headings: [], crossrefs: [], ok: false };
      const data = await resp.json();
      const htmlStr = data.passages && data.passages[0];
      if (!htmlStr) return { headings: [], crossrefs: [], ok: false };
      const parsed = await parseEsvHtmlForHeadingsAndCrossrefs(htmlStr);
      return { ...parsed, ok: true };
    } catch (e) {
      const wait = 500 * Math.pow(2, attempt);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  return { headings: [], crossrefs: [], ok: false };
}

// Cross-references were tried and removed — ESV's include-crossrefs
// pulls their full Cross-reference System (40-50+ per chapter is
// common; their API has no lighter option, checked the docs), and
// there's no principled cap to apply that isn't arbitrary.  Keeping
// this fetch for headings only; `crossrefs` stays in the response
// shape as an always-empty array rather than removing the field, so
// this is a one-line revert if it comes back later.
async function parseEsvHtmlForHeadingsAndCrossrefs(htmlStr) {
  const headings = [];
  let pendingHeading = null;
  let headingBuf = '';
  let inHeading = false;
  // ESV embeds cross-reference / footnote markers inside a heading as a
  // nested <sup> (e.g. "A Psalm of <sup ...>b</sup>Asaph."), and the text
  // handler below fires for EVERY descendant text node — so without this
  // the marker letter gets glued into the title ("A Psalm of bAsaph.").
  // Track sup depth and skip its text while collecting the heading.
  let supDepth = 0;

  const rewriter = new HTMLRewriter()
    .on('h2, h3, h4', {
      // Finalize on the heading's own end tag, not on lastInTextNode —
      // ESV wraps the divine name in a nested <span class="divine-name">
      // (e.g. "Seek the <span>Lord</span> and Live"), and lastInTextNode
      // fires per text NODE, which ends at that nested span's boundary
      // and would truncate the title before "and Live".
      element(el) {
        inHeading = true;
        headingBuf = '';
        el.onEndTag(() => {
          const title = headingBuf.replace(/\s+/g, ' ').trim();
          if (title) pendingHeading = title;
          inHeading = false;
        });
      },
      text(t) {
        if (inHeading && supDepth === 0) headingBuf += t.text;
      }
    })
    // Suppress marker text (cross-ref / footnote superscripts) inside a
    // heading.  Registered globally but only consulted while inHeading.
    .on('sup', {
      element(el) {
        supDepth++;
        el.onEndTag(() => {
          if (supDepth > 0) supDepth--;
        });
      }
    })
    .on('b.verse-num', {
      element(el) {
        const id = el.getAttribute('id') || '';
        // Format is "v{2-digit book}{3-digit chapter}{3-digit verse}-{instance}",
        // e.g. "v43011035-1" = John(43) 11:35, instance 1.  The trailing
        // "-N" is a paragraph-fragment index (almost always 1), NOT the
        // verse number — the verse is the last 3 digits of the 8-digit
        // OSIS-style code before the dash.
        const m = /^v\d{2}\d{3}(\d{3})-\d+$/.exec(id);
        if (!m) return;
        const verse = parseInt(m[1], 10);
        if (pendingHeading) {
          headings.push({ verse, title: pendingHeading });
          pendingHeading = null;
        }
      }
    });

  await rewriter.transform(new Response(htmlStr)).text();
  return { headings, crossrefs: [] };
}

// ---- ESV fetch + cache, shared by the live /esv/ route and the
// /admin/warm-esv batch job.  Cache-hit short-circuits before any
// network call — the admin warmer relies on this to skip chapters
// that are already warm without burning a request on them. ----
async function fetchAndCacheEsv(q, wantsExtras, env) {
  // Cache forever per query — ESV text is static.  Key is versioned so
  // response-shape changes (e.g. adding headings) bust every
  // previously-cached chapter automatically instead of silently
  // serving the old shape forever with no invalidation path.  Bump
  // this version string whenever the /esv/ response shape changes.
  // extras is part of the key too — an extras=0 (lite) and extras=1
  // (full) response for the same query are genuinely different
  // shapes, and sharing one cache slot would mean whichever fetched
  // first "poisons" the other with a response missing fields it
  // expects.
  // v5: the headings/crossrefs fetch now retries on 429 instead of
  // silently returning empty on the first throttle — v4 entries may have
  // been cached with a false-empty headings array if that fetch got
  // throttled while the main text fetch happened to succeed (confirmed:
  // Romans 11's English headings went missing this way).  Bumping so
  // every chapter gets one more chance at a real fetch.
  // v6: heading parser now strips cross-ref / footnote <sup> markers that
  // were being glued into titles (e.g. Psalm 73 "A Psalm of bAsaph.").
  // Bump busts every cached heading so corrupted ones re-fetch clean.
  const cacheKey = 'esv_raw_v6_' + (wantsExtras ? 'x1_' : 'x0_') + q;
  if (env.COMMENTARY_KV) {
    const cached = await env.COMMENTARY_KV.get(cacheKey);
    if (cached) return { ok: true, cached: true, body: cached };
  }

  const esvUrl = 'https://api.esv.org/v3/passage/text/?q=' + encodeURIComponent(q)
    + '&include-headings=false&include-footnotes=true&include-verse-numbers=true'
    + '&include-short-copyright=false&include-passage-references=false'
    + '&indent-paragraphs=0&indent-poetry=false&include-chapter-numbers=false'
    + '&indent-psalm-doxology=false&line-length=0';

  // Retry on 429 with exponential backoff.  ESV sometimes returns 200 OK
  // with a {"detail":"Request was throttled..."} body — treat that as a
  // throttle too and retry, so a soft-throttle doesn't leak to the client.
  let data = null, lastStatus = 0;
  for (let attempt = 0; attempt < 5; attempt++) {
    const esvResp = await fetch(esvUrl, { headers: { Authorization: 'Token ' + env.ESV_TOKEN } });
    lastStatus = esvResp.status;
    if (esvResp.ok) {
      const parsed = await esvResp.json();
      if (!parsed.passages || !parsed.passages[0]) {
        if (parsed.detail || parsed.error || parsed.message) {
          const wait = 500 * Math.pow(2, attempt);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
      }
      data = parsed;
      break;
    }
    if (esvResp.status === 429) {
      const wait = 500 * Math.pow(2, attempt); // 500ms, 1s, 2s, 4s, 8s
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    const body = await esvResp.text();
    return { ok: false, error: 'esv_status_' + esvResp.status, status: 502, detail: body };
  }
  if (!data || !data.passages || !data.passages[0]) {
    return { ok: false, error: 'esv_throttled', status: 503, lastStatus };
  }

  const extra = wantsExtras
    ? await fetchEsvHeadingsAndCrossrefs(q, env)
    : { headings: [], crossrefs: [], ok: true };
  data.headings = extra.headings;
  data.crossrefs = extra.crossrefs;

  const body = JSON.stringify(data);
  // Only commit to the forever cache once the headings fetch actually
  // succeeded (or wasn't requested) — see fetchEsvHeadingsAndCrossrefs's
  // comment.  If it's still throttled after retries, return the text to
  // this caller anyway (better than erroring out over a missing extra)
  // but leave the cache slot empty so the next request tries again
  // instead of being stuck with a false-empty result forever.
  if (env.COMMENTARY_KV && (!wantsExtras || extra.ok)) {
    await env.COMMENTARY_KV.put(cacheKey, body);
  }
  return { ok: true, cached: false, body };
}

// version defaults to 'GAE' (개역개정/NKRV) — bskorea.or.kr's own
// korbibReadpage.php serves several Korean translations off the same
// script via this query param (found via the site's own 역본 선택
// dropdown): GAE=개역개정, HAN=개역한글, SAE=표준새번역 (an older,
// different edition — do not confuse with SAENEW), SAENEW=새번역,
// COG=공동번역, COGNEW=공동번역 개정판.  Book codes (NKRV_CODES) are
// shared across every version — confirmed by loading the same
// book=mat URL under both GAE and SAENEW and getting matching content
// in each version's own wording, so no separate code table is needed
// per translation.
async function fetchChapterFromBskorea(bookNum, chapter, version = 'GAE') {
  const book = NKRV_CODES[bookNum - 1];
  const url = `https://www.bskorea.or.kr/bible/korbibReadpage.php?version=${version}&book=${book}&chap=${chapter}`;
  const resp = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
      "Accept-Language": "ko-KR,ko;q=0.9",
      "Referer": "https://www.bskorea.or.kr/"
    }
  });
  if (!resp.ok) throw new Error(`bskorea ${resp.status} for ${book} ${chapter} (${version})`);
  const html = await resp.text();
  return parseNkrvHtml(html);
}

// NKRV (Korean) section headings are the app's canonical section
// structure — they're the ones that carry Synoptic-parallel links, and
// they're what an English reader should see too rather than losing the
// structure entirely.  ESV's own headings are shown natively alongside
// them (see ChapterPane), but only NKRV's need a translation path.
// Cached per unique title string (not per chapter) since headings do
// repeat across the canon ("기도" etc), so the one-time translation
// cost is amortized across every chapter that shares a title.
//
// `ok: false` on the returned object (mirrors fetchEsvHeadingsAndCrossrefs)
// means the translation genuinely failed after retries — some entries
// may be missing `titleEn`.  Caller must NOT write this into a no-TTL
// forever cache, same reasoning as the ESV headings bug: a throttled
// translation call must never permanently bake in a missing/wrong title.
async function translateHeadingsToEnglish(headings, env) {
  if (!headings || headings.length === 0) return { headings: headings || [], ok: true };

  const results = new Array(headings.length);
  const toTranslate = [];
  for (let i = 0; i < headings.length; i++) {
    const cacheKey = `heading_tr_v1_en_${headings[i].title}`;
    const cached = env.COMMENTARY_KV ? await env.COMMENTARY_KV.get(cacheKey) : null;
    if (cached) results[i] = cached;
    else toTranslate.push(i);
  }
  if (toTranslate.length === 0) {
    return { headings: headings.map((h, i) => ({ ...h, titleEn: results[i] })), ok: true };
  }

  const prompt = `Translate the following Korean Bible section headings into concise, natural English Bible section-heading style (the kind used in the ESV or NIV — short title-case phrase, no verse numbers, no explanation, no quotation marks).

Respond with ONLY a JSON array of strings, same order, no markdown, no preamble:

${toTranslate.map((idx, k) => `${k + 1}. ${headings[idx].title}`).join('\n')}`;

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 500,
          messages: [{ role: 'user', content: prompt }]
        })
      });
      if (resp.status === 429) {
        await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
        continue;
      }
      if (!resp.ok) break;
      const aiData = await resp.json();
      const text = aiData.content?.[0]?.text || '[]';
      const clean = text.replace(/^```json\s*/, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();
      const arr = JSON.parse(clean);
      if (!Array.isArray(arr) || arr.length !== toTranslate.length) break;
      for (let k = 0; k < toTranslate.length; k++) {
        const i = toTranslate[k];
        const translated = String(arr[k] || '').trim();
        if (!translated) continue;
        results[i] = translated;
        if (env.COMMENTARY_KV) {
          await env.COMMENTARY_KV.put(`heading_tr_v1_en_${headings[i].title}`, translated);
        }
      }
      const allDone = toTranslate.every((i) => results[i]);
      return { headings: headings.map((h, i) => ({ ...h, titleEn: results[i] })), ok: allDone };
    } catch (e) {
      await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
    }
  }
  return { headings: headings.map((h, i) => ({ ...h, titleEn: results[i] })), ok: false };
}

// ---- NKRV fetch + cache, shared by the live /nkrv/ route, the search-
// index builder, and /qt-reflection.  Three separate call sites used to
// each do their own fetch+cache — exactly the kind of duplication that
// let the ESV heading-poisoning bug slip through one of three spots
// unnoticed.  One shared path now, so heading translation can't be
// skipped by whichever caller happens to populate the cache first. ----
async function fetchAndCacheNkrv(bookNum, chapter, env) {
  // v4: fixed a footnote-key collision in parseNkrvHtml — digit
  // markers (1) 2) 3)...) and Korean-consonant markers (ㄱ) ㄴ)...)
  // are bskorea's two independent marker alphabets, but both used to
  // normalize into the same numeric key space, so a chapter using both
  // (e.g. 1 Corinthians 1: v13's digit-1 "Greek: or 'immersion'" note
  // vs. v19's consonant-ㄱ Isaiah 29:14 cross-reference) had the later
  // one silently clobber the earlier one everywhere that key appeared.
  // Consonant keys are now offset by +100 so the two never collide.
  // Bumped so every already-cached chapter (no TTL) gets re-parsed
  // instead of serving the old, possibly-clobbered footnote text
  // forever.
  const verseKey = `nkrv_v4_${bookNum}_${chapter}`;
  if (env.COMMENTARY_KV) {
    const cached = await env.COMMENTARY_KV.get(verseKey);
    if (cached) return { ok: true, cached: true, data: JSON.parse(cached) };
  }
  const data = await fetchChapterFromBskorea(bookNum, chapter);
  if (data.verses.length === 0) {
    return { ok: false, error: 'parse_failed' };
  }
  const { headings: translatedHeadings, ok: translateOk } = await translateHeadingsToEnglish(data.headings, env);
  data.headings = translatedHeadings;
  if (env.COMMENTARY_KV && translateOk) {
    await env.COMMENTARY_KV.put(verseKey, JSON.stringify(data));
  }
  return { ok: true, cached: false, data };
}

// ---- 새번역 (Saebeonyeok / RNKSV) fetch + cache -- second Korean
// translation, same bskorea.or.kr source and parser as NKRV above,
// just version=SAENEW instead of GAE (see fetchChapterFromBskorea's
// comment).  Not wired into the search index or /qt-reflection yet —
// those stay NKRV-only until/unless this translation needs them too;
// this is just the live per-chapter fetch, same scope as /nkrv/ alone
// before search+reflection were added on top of it. ----
async function fetchAndCacheSaebeon(bookNum, chapter, env) {
  const verseKey = `saebeon_v1_${bookNum}_${chapter}`;
  if (env.COMMENTARY_KV) {
    const cached = await env.COMMENTARY_KV.get(verseKey);
    if (cached) return { ok: true, cached: true, data: JSON.parse(cached) };
  }
  const data = await fetchChapterFromBskorea(bookNum, chapter, 'SAENEW');
  if (data.verses.length === 0) {
    return { ok: false, error: 'parse_failed' };
  }
  const { headings: translatedHeadings, ok: translateOk } = await translateHeadingsToEnglish(data.headings, env);
  data.headings = translatedHeadings;
  if (env.COMMENTARY_KV && translateOk) {
    await env.COMMENTARY_KV.put(verseKey, JSON.stringify(data));
  }
  return { ok: true, cached: false, data };
}

// ---- 새한글성경 (New Korean Translation, NKT) — the 2024 KBS translation ----
// Unlike GAE/SAENEW (scraped from the legacy korbibReadpage.php reader, which
// does NOT serve 새한글), NKT lives on bskorea's newer Angular platform at
// bible.bskorea.or.kr, addressed by USFM code (e.g. GEN.1).  Verses are in the
// prerendered HTML but the host (CloudFront) 403s a bare fetch — it needs
// browser-like headers.  See parseNktHtml for the markup shape.
async function fetchChapterFromNktPlatform(bookNum, chapter) {
  const book = USFM_CODES[bookNum - 1];
  const url = `https://bible.bskorea.or.kr/bible/NKT/${book}.${chapter}`;
  const resp = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "ko-KR,ko;q=0.9",
      "Referer": "https://bible.bskorea.or.kr/"
    }
  });
  if (!resp.ok) throw new Error(`nkt ${resp.status} for ${book} ${chapter}`);
  // Book + chapter are passed through so the parser can bind its anchors to
  // the chapter we ASKED for — see parseNktHtml.
  return parseNktHtml(await resp.text(), book, chapter);
}

// Parse a bible.bskorea.or.kr NKT chapter page.  Each verse is anchored by
// id="NKT.<BOOK>.<CHAP>.<V>", and a single verse's text can be SPLIT across
// several <ibep-verse-text-renderer> segments (새한글's poetic line breaks), so
// we concatenate the distinct segments per verse number in document order
// (deduping identical strings so a repeated pane can't double the text).
// Returns the same shape as parseNkrvHtml, minus headings/footnotes (not
// extracted for NKT yet).
//
// `book` and `chapter` are the USFM code and chapter we requested, and the
// anchor pattern is built to match THOSE.  It used to wildcard both, keying
// only off the trailing verse number, which was wrong twice over:
//
//   1. A page carrying more than one chapter's anchors merged them.  Joel is
//      the clear case — 새한글 follows the Hebrew division where 2:28-32 is its
//      own chapter 3, that chapter's markup sits on the same page, and its
//      verses 1-5 were concatenated onto chapter 2's verses 1-5.  요엘 2:1 read
//      as its own text followed by "내가 내 영을 모든 생명체 위에 쏟아부어 주겠다"
//      — the Acts 2 passage, silently glued onto an unrelated verse.
//   2. A chapter that does not exist (Joel 4, Genesis 51) makes the platform
//      serve its default page, which is GEN.1.  Wildcard anchors matched it
//      happily, so the route returned Genesis 1 as though it were the chapter
//      asked for — and fetchAndCacheNkt then WROTE that to KV.  Scoped
//      anchors find nothing on that page, so the fetch reports parse_failed
//      and caches nothing.
function parseNktHtml(html, book, chapter) {
  const stripTags = (s) => s
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/​/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Escaped even though USFM codes are plain A-Z0-9 — the value reaches here
  // from a route parameter, and a pattern built from input is not the place to
  // rely on that staying true.
  const esc = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const anchor = new RegExp(`\\bid="NKT\\.${esc(book)}\\.${esc(chapter)}\\.(\\d+)"`, 'g');
  const segs = {};
  let m;
  while ((m = anchor.exec(html)) !== null) {
    const v = parseInt(m[1], 10);
    const after = html.slice(m.index, m.index + 12000);
    const r = /<ibep-verse-text-renderer[^>]*>([\s\S]*?)<\/ibep-verse-text-renderer>/.exec(after);
    if (!r) continue;
    const t = stripTags(r[1]);
    if (!t) continue;
    (segs[v] = segs[v] || []).push(t);
  }

  const verses = [];
  for (const v of Object.keys(segs).map(Number).sort((a, b) => a - b)) {
    const seen = new Set();
    const parts = [];
    for (const t of segs[v]) if (!seen.has(t)) { seen.add(t); parts.push(t); }
    const text = parts.join(' ')
      .replace(/\s+/g, ' ')
      .replace(/“\s+/g, '“')
      .replace(/\s+”/g, '”')
      .trim();
    if (text) verses.push({ verse: v, text });
  }
  return { verses, footnotes: {}, headings: [] };
}

// ---- 새한글 (NKT) -> canonical verse numbering ----
//
// 새한글 follows the Hebrew versification, which numbers a psalm's
// superscription as verse 1 and, in a number of other places, draws a chapter's
// first verse further in.  The app, 개역개정 and the ESV all use the canonical
// numbering, and a note or highlight is stored against a bare verse number — so
// left alone, a highlight made in 새한글 lands on the wrong line the moment you
// switch translations.
//
// Every entry here has the SAME verse count as the canonical chapter and simply
// starts N higher, which makes the mapping pure subtraction.  Chapters whose
// chapter BOUNDARY differs (Joel 2, Malachi 4, Hosea 1 and 43 others) are NOT
// here: a count cannot say which verses moved, and guessing misattributes
// scripture.  They are listed under "review" in worker/nktVersification.json.
//
// Derived offline from the 1,189 cached nkt_v1_* chapters against the app's
// VERSE_COUNTS — not by re-scraping.
const NKT_VERSE_SHIFT = {
  '1_32':1, '4_17':15, '4_30':1, '5_13':1, '5_23':1, '9_21':1, '9_24':1, '10_19':1,
  '11_5':14, '12_12':1, '16_10':1, '19_3':1, '19_4':1, '19_5':1, '19_6':1, '19_7':1,
  '19_8':1, '19_9':1, '19_12':1, '19_18':1, '19_19':1, '19_20':1, '19_21':1, '19_22':1,
  '19_30':1, '19_31':1, '19_34':1, '19_36':1, '19_38':1, '19_39':1, '19_40':1, '19_41':1,
  '19_42':1, '19_44':1, '19_45':1, '19_46':1, '19_47':1, '19_48':1, '19_49':1, '19_51':2,
  '19_52':2, '19_53':1, '19_54':2, '19_55':1, '19_56':1, '19_57':1, '19_58':1, '19_59':1,
  '19_60':2, '19_61':1, '19_62':1, '19_63':1, '19_64':1, '19_65':1, '19_67':1, '19_68':1,
  '19_69':1, '19_70':1, '19_75':1, '19_76':1, '19_77':1, '19_80':1, '19_81':1, '19_83':1,
  '19_84':1, '19_85':1, '19_88':1, '19_89':1, '19_92':1, '19_102':1, '19_108':1, '19_140':1, '19_142':1,
  '22_7':1, '26_21':5, '27_6':1, '28_2':2, '28_12':1, '28_14':1, '32_2':1, '34_2':1,
  '38_2':4, '39_4':18,
};

// Rewrites a fetched NKT chapter into canonical numbering.
//
// Guarded on the chapter actually starting where the shift says it does, which
// makes this idempotent: a chapter already stored canonically (Joel 2 was
// repaired in place) passes through untouched, and re-running it can never
// double-shift.
function nktToCanonical(bookNum, chapter, data) {
  const offset = NKT_VERSE_SHIFT[`${bookNum}_${chapter}`];
  if (!offset || !data || !Array.isArray(data.verses) || data.verses.length === 0) return data;
  if (data.verses[0].verse !== offset + 1) return data;
  return { ...data, verses: data.verses.map((v) => ({ ...v, verse: v.verse - offset })) };
}

// NKT fetch + cache, mirroring fetchAndCacheSaebeon.  No heading-translation
// step (NKT headings aren't extracted), so the cache write is unconditional.
// ---- 우리말성경 chapter read ----
// Licensed, and imported into KV wholesale from the publisher's own text rather
// than scraped a chapter at a time — so unlike NKRV/새번역/새한글 there is no
// upstream to fall back to.  A miss means the import has not run for that
// chapter, and saying so beats inventing a fetch that cannot succeed.
//
// Same signature as the scraping fetchers so KO_INDEX_CONFIG can hold it and
// /admin/build-index works unchanged; `cached` is always true because KV is the
// only source there is.
async function fetchAndCacheWoori(bookNum, chapter, env) {
  if (!env.COMMENTARY_KV) return { ok: false, error: 'kv_unset' };
  const stored = await env.COMMENTARY_KV.get(`woori_${bookNum}_${chapter}`, 'json');
  if (!stored) return { ok: false, error: 'woori_not_imported' };
  return { ok: true, cached: true, data: stored };
}

async function fetchAndCacheNkt(bookNum, chapter, env) {
  const verseKey = `nkt_v1_${bookNum}_${chapter}`;
  if (env.COMMENTARY_KV) {
    const cached = await env.COMMENTARY_KV.get(verseKey);
    if (cached) return { ok: true, cached: true, data: JSON.parse(cached) };
  }
  const data = await fetchChapterFromNktPlatform(bookNum, chapter);
  if (data.verses.length === 0) {
    return { ok: false, error: 'parse_failed' };
  }
  if (env.COMMENTARY_KV) {
    await env.COMMENTARY_KV.put(verseKey, JSON.stringify(data));
  }
  return { ok: true, cached: false, data };
}

// Generates (or returns the cached) QT reflection for one (book,
// chapter, verseStart, verseEnd) tuple.  Extracted from the
// /qt-reflection HTTP handler so the scheduled() cron trigger below
// can pre-warm today's/tomorrow's reading without going through an
// HTTP round-trip.  Returns { ok, status?, json } — json is always the
// stringified body to send/cache, status is only set on failure.
async function getOrCreateQtReflection(bookNum, chapter, verseStart, verseEnd, env) {
  // Regenerate the meditation for each fresh OCCURRENCE of a passage
  // rather than caching one copy forever: the QT plan cycles roughly
  // every ~10 years, and when a passage comes back around the reader
  // should get a NEW reflection, not the decade-old one.  Keying the
  // cache by year gives exactly one (Opus) generation per occurrence —
  // the first request in a calendar year — while still serving that
  // day's cached copy on every later request that day.  `latestKey`
  // holds the most recent successful reflection for the passage,
  // year-independent: the fallback served when a fresh generation fails
  // (e.g. API credits exhausted) so the reader still sees something.
  const base = `${bookNum}_${chapter}_${verseStart}_${verseEnd}`;
  const year = new Date().getUTCFullYear();
  const cacheKey = `qt_reflection_v4_${base}_${year}`;
  const latestKey = `qt_reflection_latest_${base}`;

  const cached = env.COMMENTARY_KV ? await env.COMMENTARY_KV.get(cacheKey) : null;
  if (cached) return { ok: true, json: cached, cached: true };

  async function fallbackOrError(status, errJson) {
    const saved = env.COMMENTARY_KV ? await env.COMMENTARY_KV.get(latestKey) : null;
    if (saved) return { ok: true, json: saved, cached: true, fallback: true };
    return { ok: false, status, json: errJson };
  }

  const nkrvResult = await fetchAndCacheNkrv(bookNum, chapter, env);
  if (!nkrvResult.ok) {
    return { ok: false, status: 502, json: JSON.stringify({ error: nkrvResult.error || 'nkrv_fetch_failed' }) };
  }
  const nkrvData = nkrvResult.data;

  const versesInRange = (nkrvData.verses || []).filter(v => {
    const n = typeof v.verse === 'string' ? parseInt(v.verse, 10) : v.verse;
    return n >= verseStart && n <= verseEnd;
  });
  const passageKo = versesInRange
    .map(v => `${v.verse}. ${v.text.replace(/\(KN:\d+\)/g, '')}`)
    .join(' ');

  const bookName = BOOK_NAMES_EN[bookNum-1];
  const bookNameKo = BOOK_NAMES_KO[bookNum-1];
  const refLabel = verseStart === verseEnd
    ? `${bookName} ${chapter}:${verseStart}`
    : `${bookName} ${chapter}:${verseStart}-${verseEnd}`;

  const prompt = `You are writing a short daily Quiet Time (QT) devotional reflection in the Reformed/evangelical tradition (Calvin, Sproul, Keller, Piper) — warm, pastoral, Christ-centered, practically applicable.

Write a reflection specifically on ${refLabel} — these exact verses only, not the surrounding chapter.

Passage text (Korean, for your reference, use it to ground the reflection in what these specific verses actually say):
"""
${passageKo}
"""

Write a devotional reflection on THIS PASSAGE SPECIFICALLY, broken into 4-6 SHORT paragraphs — each paragraph just 1-2 sentences, one idea per paragraph (e.g. observation, the text's context, a theological point, a practical application, a closing thought — as separate paragraphs, not combined). Favor more, shorter paragraphs over fewer, longer ones; this is read on a phone screen where dense blocks are hard to read. Then provide a Korean translation using 존댓말 (formal polite -습니다/-ㅂ니다 speech level), with the same paragraph breaks.

Respond in this exact JSON format, no markdown, no preamble. Each paragraph is its OWN array element — do not put multiple paragraphs in one string, and do not include newline characters inside a string:
{
  "reflection_en": ["paragraph 1", "paragraph 2", "paragraph 3", "paragraph 4"],
  "reflection_ko": ["문단 1", "문단 2", "문단 3", "문단 4"]
}`;

  const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      // Daily QT meditation runs on Opus for higher-quality reflections
      // (the rest of the AI endpoints stay on Haiku).  Cached forever in
      // KV, so each unique passage is an Opus call exactly once.
      model: 'claude-opus-4-8',
      max_tokens: 2500,
      messages: [{role:'user', content: prompt}]
    })
  });

  if (!aiResp.ok) {
    const err = await aiResp.text();
    // Generation failed (e.g. credits exhausted) — serve the last saved
    // reflection for this passage if there is one, rather than erroring.
    return await fallbackOrError(500, JSON.stringify({ error: 'ai_failed', detail: err }));
  }

  const aiData = await aiResp.json();
  const text = aiData.content?.[0]?.text || '{}';
  const cleanText = text.replace(/^```json\s*/,'').replace(/^```\s*/,'').replace(/```\s*$/,'').trim();

  let reflection;
  try { reflection = JSON.parse(cleanText); }
  catch (e) { return await fallbackOrError(500, JSON.stringify({ error: 'parse_failed', raw: text })); }

  reflection.book_en = bookName;
  reflection.book_ko = bookNameKo;
  reflection.chapter = chapter;
  reflection.verseStart = verseStart;
  reflection.verseEnd = verseEnd;

  const result = JSON.stringify(reflection);
  if (env.COMMENTARY_KV) {
    await env.COMMENTARY_KV.put(cacheKey, result);   // this year's occurrence
    await env.COMMENTARY_KV.put(latestKey, result);  // fallback for future failures
    // And record that we HAVE this one, so a passage typed later can find it.
    // Every reflection was already kept forever under latestKey;  what was
    // missing is any way to enumerate them — a stored reflection could only be
    // retrieved by knowing its exact verse tuple in advance.
    await addToQtIndex(bookNum, chapter, verseStart, verseEnd, env);
  }
  return { ok: true, json: result, cached: false };
}

// ===== The archive of reflections we hold =====
//
// One index PER BOOK rather than one big one.  A lookup always knows its book
// (you cannot type a passage without naming one), so this reads a single small
// key instead of a list that grows without bound;  and it keeps the
// read-modify-write below scoped to one book, which is what makes the race
// small enough to accept.
//
// That race is real and deliberately tolerated: two generations for the SAME
// book landing together can lose one entry.  The consequence is bounded — the
// reflection itself is still stored under its own key and still served on an
// exact request, it is merely undiscoverable by overlap until the index is
// rebuilt.  /admin/rebuild-qt-index rebuilds from the reflection keys
// themselves, which are the authority;  the index is only ever a finding aid.
function qtIndexKey(bookNum) {
  return `qt_index_b${bookNum}`;
}

async function readQtIndex(bookNum, env) {
  if (!env.COMMENTARY_KV) return [];
  const raw = await env.COMMENTARY_KV.get(qtIndexKey(bookNum));
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

async function addToQtIndex(bookNum, chapter, verseStart, verseEnd, env) {
  const entries = await readQtIndex(bookNum, env);
  if (entries.some((e) => e[0] === chapter && e[1] === verseStart && e[2] === verseEnd)) return;
  entries.push([chapter, verseStart, verseEnd]);
  await env.COMMENTARY_KV.put(qtIndexKey(bookNum), JSON.stringify(entries));
}

/**
 * How much of a STORED reflection's range a typed range covers.
 *
 * The denominator is the stored range, not the typed one, for the same reason
 * the client uses: someone typing a whole chapter has covered a nine-verse
 * reflection completely and should get it, while someone typing three verses
 * of a sixteen-verse reflection has not — handing them that one would be
 * answering about thirteen verses they are not reading.
 */
function qtOverlapFraction(typed, entry) {
  const [chapter, verseStart, verseEnd] = entry;
  if (typed.chapter !== chapter) return 0;
  const lo = Math.max(typed.verseStart, verseStart);
  const hi = Math.min(typed.verseEnd, verseEnd);
  if (hi < lo) return 0;
  const len = verseEnd - verseStart + 1;
  if (len <= 0) return 0;
  return (hi - lo + 1) / len;
}

const QT_MATCH_THRESHOLD = 2 / 3;

// Strip (KN:NN) markers from a verse for clean search display.
function cleanForSearch(text) {
  return text.replace(/\(KN:\d+\)/g, '').replace(/\s+/g, ' ').trim();
}

// Convert a chapter's verse array to flat [b, c, v, text] tuples.
function chapterToTuples(bookIdx, chapter, verses) {
  const out = [];
  for (const v of verses) {
    out.push([bookIdx, chapter, v.verse, cleanForSearch(v.text)]);
  }
  return out;
}

// ---- /admin/build-index — builds one phase of the search index ----
// Query params:
//   secret:  must match env.ADMIN_SECRET
//   from:    0-based "chapter ordinal" to start at (default 0)
//   size:    how many chapters to process in this call (default 250)
//   refetch: if "1", re-fetch chapters from bskorea even if KV-cached (slower)
//
// Flat chapter ordinal mapping:
//   ordinal 0       = Genesis 1
//   ordinal 1       = Genesis 2
//   ordinal 50      = Exodus 1
//   ...
//   ordinal 1188    = Revelation 22 (last)  (total: 1189)
//
// Each call writes a chunk to KV key `nkrv_search_chunk_${from}` (so re-running with the same
// `from` overwrites that chunk).  Once all chunks exist, call /admin/merge-index to concatenate.
function ordinalToBookChapter(ordinal) {
  let acc = 0;
  for (let b = 0; b < BOOK_CHAPTERS.length; b++) {
    if (ordinal < acc + BOOK_CHAPTERS[b]) return [b, ordinal - acc + 1];
    acc += BOOK_CHAPTERS[b];
  }
  return null;
}

const TOTAL_CHAPTERS = BOOK_CHAPTERS.reduce((a,b)=>a+b, 0);

async function handleBuildIndex(env, url, cors) {
  const secret = url.searchParams.get('secret');
  if (!env.ADMIN_SECRET || secret !== env.ADMIN_SECRET) {
    return new Response(JSON.stringify({error:'forbidden'}), {status:403, headers:{...cors,'Content-Type':'application/json'}});
  }
  const from = Math.max(0, parseInt(url.searchParams.get('from') || '0'));
  const size = Math.min(400, Math.max(1, parseInt(url.searchParams.get('size') || '250')));
  const refetch = url.searchParams.get('refetch') === '1';
  const cfg = koIndexConfig(url.searchParams.get('v')); // NKRV (default) | SAEBEON | NKT
  // Parallel fetches per batch.  Default 12 for cache-hit-heavy rebuilds; pass
  // a low value when building from cold (SAEBEON's uncached chapters each do an
  // Anthropic heading-translation call, which rate-limits at high concurrency).
  const concurrency = Math.min(12, Math.max(1, parseInt(url.searchParams.get('concurrency') || '12')));

  const tuples = [];
  let fetched = 0, fromCache = 0, errored = 0;
  const errors = [];

  const ordinals = [];
  for (let o = from; o < Math.min(from + size, TOTAL_CHAPTERS); o++) ordinals.push(o);

  // Process in waves to limit concurrency.
  for (let i = 0; i < ordinals.length; i += concurrency) {
    const batch = ordinals.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(async (ord) => {
      const [bookIdx, chapter] = ordinalToBookChapter(ord);
      try {
        // refetch=1 means "ignore cache", which fetchAndCacheNkrv can't
        // do internally — bust the entry first so its own cache check
        // is a genuine miss.
        if (refetch && env.COMMENTARY_KV) {
          await env.COMMENTARY_KV.delete(cfg.verseKey(bookIdx + 1, chapter));
        }
        const result = await cfg.fetch(bookIdx + 1, chapter, env);
        if (!result.ok) throw new Error(result.error || `${cfg.prefix}_fetch_failed`);
        if (result.cached) fromCache++; else fetched++;
        const verses = result.data.verses || [];
        return chapterToTuples(bookIdx, chapter, verses);
      } catch (e) {
        errored++;
        errors.push({ord, bookIdx, chapter, msg: String(e.message || e)});
        return [];
      }
    }));
    for (const r of results) for (const t of r) tuples.push(t);
  }

  // Write the chunk under a key that encodes the version + starting ordinal.
  // Pad so lex order matches numeric.
  const chunkKey = `${cfg.prefix}_search_chunk_${String(from).padStart(5, '0')}`;
  if (env.COMMENTARY_KV) {
    await env.COMMENTARY_KV.put(chunkKey, JSON.stringify(tuples));
  }

  const nextFrom = from + size;
  const done = nextFrom >= TOTAL_CHAPTERS;
  const vq = `&v=${cfg.prefix.toUpperCase()}`;
  return new Response(JSON.stringify({
    ok: true,
    version: cfg.prefix,
    chunkKey,
    processedOrdinals: ordinals.length,
    verseCount: tuples.length,
    fetchedLive: fetched,
    fromKvCache: fromCache,
    errored,
    errors: errors.slice(0, 10),
    nextFrom: done ? null : nextFrom,
    nextUrl: done ? null : `/admin/build-index?secret=...${vq}&from=${nextFrom}&size=${size}`,
    totalChapters: TOTAL_CHAPTERS,
    done
  }, null, 2), {headers:{...cors,'Content-Type':'application/json'}});
}

// ---- /admin/warm-esv — pre-fetch every ESV chapter into KV so the
// live /esv/ route and bulk offline-download both hit cache instead
// of calling Crossway's API on every request.  Chunked like
// build-index; run repeatedly with an advancing `from` until `done`.
// Low default concurrency (2) — this is a one-time background job,
// not latency-sensitive, so there's no reason to hammer ESV's rate
// limit; fetchAndCacheEsv's own retry-with-backoff absorbs 429s.
async function handleWarmEsv(env, url, cors, request) {
  // Header-preferred (X-Admin-Secret) so the secret doesn't land in
  // Cloudflare's URL-based access logs the way the other /admin/*
  // endpoints' ?secret= query param does; query param still accepted
  // for parity with those.
  const secret = request.headers.get('X-Admin-Secret') || url.searchParams.get('secret');
  if (!env.ADMIN_SECRET || secret !== env.ADMIN_SECRET) {
    return new Response(JSON.stringify({error:'forbidden'}), {status:403, headers:{...cors,'Content-Type':'application/json'}});
  }
  const from = Math.max(0, parseInt(url.searchParams.get('from') || '0'));
  const size = Math.min(200, Math.max(1, parseInt(url.searchParams.get('size') || '50')));
  const concurrency = Math.min(4, Math.max(1, parseInt(url.searchParams.get('concurrency') || '2')));

  const ordinals = [];
  for (let o = from; o < Math.min(from + size, TOTAL_CHAPTERS); o++) ordinals.push(o);

  let warmed = 0, alreadyCached = 0, errored = 0;
  const errors = [];

  for (let i = 0; i < ordinals.length; i += concurrency) {
    const batch = ordinals.slice(i, i + concurrency);
    await Promise.all(batch.map(async (ord) => {
      const [bookIdx, chapter] = ordinalToBookChapter(ord);
      const book = BOOK_NAMES_EN[bookIdx];
      const q = book + ' ' + chapter;
      try {
        const result = await fetchAndCacheEsv(q, true, env);
        if (!result.ok) {
          errored++;
          errors.push({ q, error: result.error });
          return;
        }
        if (result.cached) alreadyCached++; else warmed++;
      } catch (e) {
        errored++;
        errors.push({ q, error: e.message });
      }
    }));
  }

  const nextFrom = from + size < TOTAL_CHAPTERS ? from + size : null;
  return new Response(JSON.stringify({
    from, size, warmed, alreadyCached, errored,
    errors: errors.slice(0, 20),
    totalChapters: TOTAL_CHAPTERS,
    nextFrom,
    nextUrl: nextFrom === null ? null : `/admin/warm-esv?from=${nextFrom}&size=${size} (with X-Admin-Secret header)`,
    done: nextFrom === null
  }, null, 2), {headers:{...cors,'Content-Type':'application/json'}});
}

// ---- /admin/warm-saebeon — same job as /admin/warm-esv, but for
// 새번역.  Each uncached chapter here is TWO slow calls in sequence
// (a live bskorea.or.kr scrape, then an Anthropic call to translate
// headings — see fetchAndCacheSaebeon/translateHeadingsToEnglish),
// so leaving this to the app's own client-side bulk-download loop
// means every one of 1189 chapters pays that full cold-path cost on
// whichever device downloads first.  Concurrency defaults lower than
// warm-esv's (1 vs 2) since each unit of work here is itself two
// sequential network calls rather than one.
async function handleWarmSaebeon(env, url, cors, request) {
  const secret = request.headers.get('X-Admin-Secret') || url.searchParams.get('secret');
  if (!env.ADMIN_SECRET || secret !== env.ADMIN_SECRET) {
    return new Response(JSON.stringify({error:'forbidden'}), {status:403, headers:{...cors,'Content-Type':'application/json'}});
  }
  const from = Math.max(0, parseInt(url.searchParams.get('from') || '0'));
  const size = Math.min(100, Math.max(1, parseInt(url.searchParams.get('size') || '25')));
  const concurrency = Math.min(3, Math.max(1, parseInt(url.searchParams.get('concurrency') || '1')));

  const ordinals = [];
  for (let o = from; o < Math.min(from + size, TOTAL_CHAPTERS); o++) ordinals.push(o);

  let warmed = 0, alreadyCached = 0, errored = 0;
  const errors = [];

  for (let i = 0; i < ordinals.length; i += concurrency) {
    const batch = ordinals.slice(i, i + concurrency);
    await Promise.all(batch.map(async (ord) => {
      const [bookIdx, chapter] = ordinalToBookChapter(ord);
      const bookNum = bookIdx + 1;
      try {
        const result = await fetchAndCacheSaebeon(bookNum, chapter, env);
        if (!result.ok) {
          errored++;
          errors.push({ bookNum, chapter, error: result.error });
          return;
        }
        if (result.cached) alreadyCached++; else warmed++;
      } catch (e) {
        errored++;
        errors.push({ bookNum, chapter, error: e.message });
      }
    }));
  }

  const nextFrom = from + size < TOTAL_CHAPTERS ? from + size : null;
  return new Response(JSON.stringify({
    from, size, warmed, alreadyCached, errored,
    errors: errors.slice(0, 20),
    totalChapters: TOTAL_CHAPTERS,
    nextFrom,
    nextUrl: nextFrom === null ? null : `/admin/warm-saebeon?from=${nextFrom}&size=${size} (with X-Admin-Secret header)`,
    done: nextFrom === null
  }, null, 2), {headers:{...cors,'Content-Type':'application/json'}});
}

// ---- /admin/warm-nkt — same as warm-saebeon but for 새한글 (NKT).  Each
// uncached chapter is a single bskorea-platform scrape (no heading-translation
// step), so concurrency defaults a touch higher.
async function handleWarmNkt(env, url, cors, request) {
  const secret = request.headers.get('X-Admin-Secret') || url.searchParams.get('secret');
  if (!env.ADMIN_SECRET || secret !== env.ADMIN_SECRET) {
    return new Response(JSON.stringify({error:'forbidden'}), {status:403, headers:{...cors,'Content-Type':'application/json'}});
  }
  const from = Math.max(0, parseInt(url.searchParams.get('from') || '0'));
  const size = Math.min(100, Math.max(1, parseInt(url.searchParams.get('size') || '25')));
  const concurrency = Math.min(4, Math.max(1, parseInt(url.searchParams.get('concurrency') || '2')));

  const ordinals = [];
  for (let o = from; o < Math.min(from + size, TOTAL_CHAPTERS); o++) ordinals.push(o);

  let warmed = 0, alreadyCached = 0, errored = 0;
  const errors = [];

  for (let i = 0; i < ordinals.length; i += concurrency) {
    const batch = ordinals.slice(i, i + concurrency);
    await Promise.all(batch.map(async (ord) => {
      const [bookIdx, chapter] = ordinalToBookChapter(ord);
      const bookNum = bookIdx + 1;
      try {
        const result = await fetchAndCacheNkt(bookNum, chapter, env);
        if (!result.ok) {
          errored++;
          errors.push({ bookNum, chapter, error: result.error });
          return;
        }
        if (result.cached) alreadyCached++; else warmed++;
      } catch (e) {
        errored++;
        errors.push({ bookNum, chapter, error: e.message });
      }
    }));
  }

  const nextFrom = from + size < TOTAL_CHAPTERS ? from + size : null;
  return new Response(JSON.stringify({
    from, size, warmed, alreadyCached, errored,
    errors: errors.slice(0, 20),
    totalChapters: TOTAL_CHAPTERS,
    nextFrom,
    nextUrl: nextFrom === null ? null : `/admin/warm-nkt?from=${nextFrom}&size=${size} (with X-Admin-Secret header)`,
    done: nextFrom === null
  }, null, 2), {headers:{...cors,'Content-Type':'application/json'}});
}

async function handleMergeIndex(env, url, cors) {
  const secret = url.searchParams.get('secret');
  if (!env.ADMIN_SECRET || secret !== env.ADMIN_SECRET) {
    return new Response(JSON.stringify({error:'forbidden'}), {status:403, headers:{...cors,'Content-Type':'application/json'}});
  }
  if (!env.COMMENTARY_KV) return new Response(JSON.stringify({error:'no_kv'}), {status:500, headers:{...cors,'Content-Type':'application/json'}});

  const cfg = koIndexConfig(url.searchParams.get('v')); // NKRV (default) | SAEBEON | NKT
  const chunkPrefix = `${cfg.prefix}_search_chunk_`;
  const indexKey = `${cfg.prefix}_search_index`;

  // List all chunk keys for this version.
  const chunks = [];
  let cursor = undefined;
  let safety = 0;
  while (true) {
    const list = await env.COMMENTARY_KV.list({ prefix: chunkPrefix, cursor, limit: 1000 });
    for (const k of list.keys) chunks.push(k.name);
    if (list.list_complete || !list.cursor) break;
    cursor = list.cursor;
    if (++safety > 50) break;
  }
  chunks.sort();

  if (chunks.length === 0) {
    return new Response(JSON.stringify({error:'no_chunks', hint:`run /admin/build-index?v=${cfg.prefix.toUpperCase()} first`}), {status:400, headers:{...cors,'Content-Type':'application/json'}});
  }

  const merged = [];
  for (const key of chunks) {
    const raw = await env.COMMENTARY_KV.get(key);
    if (!raw) continue;
    try {
      const arr = JSON.parse(raw);
      for (const t of arr) merged.push(t);
    } catch (e) { /* skip */ }
  }

  const payload = JSON.stringify(merged);
  await env.COMMENTARY_KV.put(indexKey, payload);

  // Bust the per-isolate cache for this version (this isolate at least).
  bustKoSearchIndex(cfg.prefix);

  return new Response(JSON.stringify({
    ok: true,
    version: cfg.prefix,
    chunksRead: chunks.length,
    totalVerses: merged.length,
    indexBytes: payload.length,
    storedAt: indexKey
  }, null, 2), {headers:{...cors,'Content-Type':'application/json'}});
}

// Wipe every cached api.bible chapter in KV, plus the related index chunks and
// flat index for the scope.  Exists for compliance with api.bible's 72-hour
// deletion rule on termination and as a manual reset.  Protected by ADMIN_SECRET.
async function handleWipeApiBibleCache(env, url, cors) {
  const secret = url.searchParams.get('secret');
  if (!env.ADMIN_SECRET || secret !== env.ADMIN_SECRET) {
    return new Response(JSON.stringify({error:'forbidden'}), {status:403, headers:{...cors,'Content-Type':'application/json'}});
  }
  if (!env.COMMENTARY_KV) return new Response(JSON.stringify({error:'no_kv'}), {status:500, headers:{...cors,'Content-Type':'application/json'}});

  const tId = url.searchParams.get('translationId') || null;
  const prefixes = [];
  if (tId) {
    prefixes.push(`apibible_raw_${tId}_`);
    prefixes.push(`apibible_search_chunk_${tId}_`);
  } else {
    prefixes.push('apibible_raw_');
    prefixes.push('apibible_search_chunk_');
  }

  let deleted = 0;
  for (const prefix of prefixes) {
    let cursor = undefined, safety = 0;
    while (true) {
      const list = await env.COMMENTARY_KV.list({ prefix, cursor, limit: 1000 });
      for (const k of list.keys) {
        await env.COMMENTARY_KV.delete(k.name);
        deleted++;
      }
      if (list.list_complete || !list.cursor) break;
      cursor = list.cursor;
      if (++safety > 100) break;
    }
  }

  // Also delete the merged flat index(es).
  if (tId) {
    await env.COMMENTARY_KV.delete(`apibible_search_index_${tId}`);
    APIBIBLE_INDEXES[tId] = null;
    APIBIBLE_INDEX_PROMISES[tId] = null;
  } else {
    for (const id of Object.keys(API_BIBLE_TRANSLATIONS)) {
      await env.COMMENTARY_KV.delete(`apibible_search_index_${id}`);
      APIBIBLE_INDEXES[id] = null;
      APIBIBLE_INDEX_PROMISES[id] = null;
    }
  }

  return new Response(JSON.stringify({
    ok: true,
    deleted,
    prefixes,
    scope: tId ? `translation=${tId}` : 'all api.bible cache + indexes'
  }, null, 2), {headers:{...cors,'Content-Type':'application/json'}});
}

async function handleIndexStatus(env, url, cors) {
  const secret = url.searchParams.get('secret');
  if (!env.ADMIN_SECRET || secret !== env.ADMIN_SECRET) {
    return new Response(JSON.stringify({error:'forbidden'}), {status:403, headers:{...cors,'Content-Type':'application/json'}});
  }
  if (!env.COMMENTARY_KV) return new Response(JSON.stringify({error:'no_kv'}), {status:500, headers:{...cors,'Content-Type':'application/json'}});

  const idx = await env.COMMENTARY_KV.get('nkrv_search_index');
  let indexInfo = null;
  if (idx) {
    try {
      const arr = JSON.parse(idx);
      indexInfo = { verses: arr.length, bytes: idx.length };
    } catch (e) {
      indexInfo = { verses: 0, bytes: idx.length, parseError: true };
    }
  }

  // Count chunks.
  let chunkCount = 0;
  let cursor = undefined;
  let safety = 0;
  while (true) {
    const list = await env.COMMENTARY_KV.list({ prefix: 'nkrv_search_chunk_', cursor, limit: 1000 });
    chunkCount += list.keys.length;
    if (list.list_complete || !list.cursor) break;
    cursor = list.cursor;
    if (++safety > 50) break;
  }

  // EN index info.
  const enIdx = await env.COMMENTARY_KV.get('esv_search_index');
  let enIndexInfo = null;
  if (enIdx) {
    try {
      const arr = JSON.parse(enIdx);
      enIndexInfo = { verses: arr.length, bytes: enIdx.length };
    } catch (e) {
      enIndexInfo = { verses: 0, bytes: enIdx.length, parseError: true };
    }
  }
  let enChunkCount = 0;
  let cursor2 = undefined;
  let safety2 = 0;
  while (true) {
    const list = await env.COMMENTARY_KV.list({ prefix: 'esv_search_chunk_', cursor: cursor2, limit: 1000 });
    enChunkCount += list.keys.length;
    if (list.list_complete || !list.cursor) break;
    cursor2 = list.cursor;
    if (++safety2 > 50) break;
  }

  // api.bible state — per translation: cached chapter count + chunk count + index status.
  const apiBibleDetail = {};
  for (const tid of Object.keys(API_BIBLE_TRANSLATIONS)) {
    const abbr = API_BIBLE_TRANSLATIONS[tid].abbreviation;
    // Count cached raw chapters.
    let rawCount = 0, cursor3 = undefined, safety3 = 0;
    while (true) {
      const list = await env.COMMENTARY_KV.list({ prefix: `apibible_raw_${tid}_`, cursor: cursor3, limit: 1000 });
      rawCount += list.keys.length;
      if (list.list_complete || !list.cursor) break;
      cursor3 = list.cursor;
      if (++safety3 > 10) break;
    }
    // Count search chunks.
    let chunkCt = 0, cursor4 = undefined, safety4 = 0;
    while (true) {
      const list = await env.COMMENTARY_KV.list({ prefix: `apibible_search_chunk_${tid}_`, cursor: cursor4, limit: 1000 });
      chunkCt += list.keys.length;
      if (list.list_complete || !list.cursor) break;
      cursor4 = list.cursor;
      if (++safety4 > 10) break;
    }
    // Check merged index.
    const idx = await env.COMMENTARY_KV.get(`apibible_search_index_${tid}`);
    let indexInfo = null;
    if (idx) {
      try {
        const arr = JSON.parse(idx);
        indexInfo = { verses: arr.length, bytes: idx.length };
      } catch (e) {
        indexInfo = { verses: 0, bytes: idx.length, parseError: true };
      }
    }
    apiBibleDetail[abbr] = {
      translationId: tid,
      cachedChapters: rawCount,
      searchChunks: chunkCt,
      index: indexInfo,
      moduleCache: { loaded: !!APIBIBLE_INDEXES[tid], verses: APIBIBLE_INDEXES[tid] ? APIBIBLE_INDEXES[tid].length : 0 }
    };
  }
  const apiBibleCounts = { _total: 0 };
  for (const abbr of Object.keys(apiBibleDetail)) {
    apiBibleCounts[abbr] = apiBibleDetail[abbr].cachedChapters;
    apiBibleCounts._total += apiBibleDetail[abbr].cachedChapters;
  }

  return new Response(JSON.stringify({
    ko: {
      index: indexInfo,
      chunkCount,
      moduleCache: { loaded: !!SEARCH_INDEX, verses: SEARCH_INDEX ? SEARCH_INDEX.length : 0 }
    },
    en: {
      index: enIndexInfo,
      chunkCount: enChunkCount,
      moduleCache: { loaded: !!EN_SEARCH_INDEX, verses: EN_SEARCH_INDEX ? EN_SEARCH_INDEX.length : 0 }
    },
    apibible: {
      cachedChapters: apiBibleCounts,
      ttlSeconds: API_BIBLE_CACHE_TTL,
      perTranslation: apiBibleDetail,
      translations: Object.fromEntries(
        Object.entries(API_BIBLE_TRANSLATIONS).map(([id, t]) => [t.abbreviation, id])
      )
    },
    totalChapters: TOTAL_CHAPTERS
  }, null, 2), {headers:{...cors,'Content-Type':'application/json'}});
}

// Korean book abbreviations as Korean publishers actually print them,
// index-aligned with BOOK_NAMES_KO.  Needed because a printed reference is
// almost never the full book name — "창 12:1-9", not "창세기 12:1-9".
const BOOK_ABBR_KO = [
  '창','출','레','민','신','수','삿','룻',
  '삼상','삼하','왕상','왕하','대상','대하','스','느',
  '에','욥','시','잠','전','아','사','렘',
  '애','겔','단','호','욜','암','옵','욘',
  '미','나','합','습','학','슥','말',
  '마','막','눅','요','행','롬','고전','고후',
  '갈','엡','빌','골','살전','살후',
  '딤전','딤후','딛','몬','히','약',
  '벧전','벧후','요일','요이','요삼','유','계'
];

// Korean book name or abbreviation -> 1-indexed book number, or 0.
//
// Full names are tried BEFORE abbreviations, longest first.  Order matters:
// "요한일서" starts with "요", and matching the abbreviation first would file
// 1 John under John.  Same trap for 사무엘상/사, 고린도전서/고전, 데살로니가전서/살전.
function koBookNum(name) {
  const n = (name || '').trim();
  if (!n) return 0;
  const full = BOOK_NAMES_KO.indexOf(n);
  if (full >= 0) return full + 1;
  const abbr = BOOK_ABBR_KO.indexOf(n);
  if (abbr >= 0) return abbr + 1;
  return 0;
}

// Same, but tolerant of whatever Hangul the match ran into on its left.
//
// The probe's capture is greedy over Hangul, so a reference printed with no
// space after a label — "본문창세기 12:1-9" — arrives as "본문창세기" and
// resolves to nothing.  Trying successively shorter SUFFIXES finds the book
// inside it.  Longest first, because the short forms are prefixes of the long
// ones: give up early on 요한일서 and it resolves as 요.
function koBookNumLoose(text) {
  const n = (text || '').trim();
  for (let i = 0; i < n.length; i++) {
    const num = koBookNum(n.slice(i));
    if (num) return { bookNum: num, matched: n.slice(i) };
  }
  return { bookNum: 0, matched: '' };
}

// ===== Daily reading schedule =====
//
// A published Korean daily-reading schedule gives one passage per day.  We take
// the REFERENCE only — book, chapter, verses, which is a citation of scripture
// — and generate the reflection from our own NKRV text through the existing
// /qt-reflection pipeline.  No prose from the source is parsed, stored or
// shown, and nothing in the app names it.
//
// WHY THE DATE IS A LABEL, NOT A MOMENT
//
// The schedule is published against a KOREAN calendar date.  Readers are not
// all in Korea, so "today's reading" has to mean "the reading published for
// the date the reader is on", not "whatever Korea is showing right now" —
// otherwise a reader in New York gets tomorrow's passage all evening.  So each
// day is stored under its KST date string and looked up by the CLIENT's own
// local date.  Two readers on the same local date get the same passage
// wherever they are.
//
// The cron runs at 15:10 UTC = 00:10 KST, so a KST date is captured minutes
// after it is published — hours before that same date begins anywhere west of
// Korea, which is everywhere our readers are.  Timezones at UTC+10 and east
// briefly precede the fetch;  they fall back to the app's own plan, which is
// what they had before this existed.

/** The KST calendar date, as a label.  Shifting by +9h and reading UTC fields
 *  gives Korea's date without any timezone database. */
function kstDateStamp(offsetDays = 0) {
  const d = new Date(Date.now() + 9 * 3600 * 1000 + offsetDays * 86400000);
  return d.toISOString().slice(0, 10);
}

const DAILY_READING_PREFIX = 'daily_reading_';
// Long enough that a missed cron or two is invisible, bounded so the namespace
// does not accumulate a key per day forever.
const DAILY_READING_TTL = 90 * 86400;

/**
 * Fetch and parse the day's reference.
 *
 * Decoding is explicit and non-negotiable: the source serves EUC-KR, and
 * Response.text() assumes UTF-8, which turns every Hangul byte into a
 * replacement character.  Measured on the live page: 2997 replacement
 * characters via UTF-8, 0 via EUC-KR.  That failure does not throw — it just
 * yields text no pattern matches — so it is decoded deliberately rather than
 * left to a default.
 *
 * Returns { ok, reading } or { ok: false, error }.  It refuses to guess: the
 * page carries exactly ONE scripture reference (the day's heading), so
 * anything other than exactly one match means the markup moved and the answer
 * would be a guess.  Failing loudly there beats silently pinning the wrong
 * passage into a dated, cached key.
 */
async function fetchDailyReading() {
  let res;
  try {
    res = await fetch('https://www.duranno.com/qt/view/bible.asp', {
      headers: {
        'User-Agent': 'krengbible-qt/1.0 (+https://krengbible.com)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ko-KR,ko;q=0.9',
      },
      redirect: 'follow',
    });
  } catch (e) {
    return { ok: false, error: 'fetch_failed', detail: String(e && e.message || e) };
  }
  if (!res.ok) return { ok: false, error: 'bad_status', status: res.status };

  const buf = await res.arrayBuffer();
  let html;
  try {
    html = new TextDecoder('euc-kr').decode(buf);
  } catch (e) {
    return { ok: false, error: 'decode_failed', detail: String(e && e.message || e) };
  }

  // Cross-chapter FIRST: a reading like 창 12:1-13:4 also matches the plain
  // colon-range pattern, as 12:1-13, which is a real range and silently wrong.
  // Trying the more specific shape first is what stops that.
  const cross = html.match(/([가-힣]{1,7})\s*(\d{1,3})\s*[:：]\s*(\d{1,3})\s*[-~–—]\s*(\d{1,3})\s*[:：]\s*(\d{1,3})/);
  if (cross) {
    const { bookNum } = koBookNumLoose(cross[1]);
    if (bookNum) {
      return { ok: true, reading: {
        bookNum, chapter: +cross[2], verseStart: +cross[3],
        endChapter: +cross[4], verseEnd: +cross[5],
      } };
    }
  }

  const re = /([가-힣]{1,7})\s*(\d{1,3})\s*[:：]\s*(\d{1,3})\s*[-~–—]\s*(\d{1,3})/g;
  const found = [];
  let m;
  while ((m = re.exec(html))) {
    const { bookNum } = koBookNumLoose(m[1]);
    if (!bookNum) continue;
    found.push({ bookNum, chapter: +m[2], verseStart: +m[3], verseEnd: +m[4] });
  }
  if (found.length !== 1) {
    return { ok: false, error: 'ambiguous_or_missing', matches: found.length };
  }
  const r = found[0];
  if (r.verseEnd < r.verseStart) return { ok: false, error: 'reversed_range' };
  return { ok: true, reading: r };
}

/**
 * Capture one KST date's reading and warm its reflection.
 *
 * Write-once per date: a date already captured is never re-fetched, because
 * the page only ever shows the CURRENT Korean day.  Asking it later, for a
 * date that has rolled past, would answer with a different day's passage and
 * overwrite a correct entry with a wrong one — the same write-once hazard the
 * VOTD route documents.
 */
async function captureDailyReading(dateStamp, env, { force = false } = {}) {
  if (!env.COMMENTARY_KV) return { ok: false, error: 'no_kv' };
  const key = DAILY_READING_PREFIX + dateStamp;
  if (!force) {
    const existing = await env.COMMENTARY_KV.get(key);
    if (existing) return { ok: true, cached: true, reading: JSON.parse(existing) };
  }

  const got = await fetchDailyReading();
  if (!got.ok) return got;
  const reading = got.reading;

  // The reflection pipeline is per-chapter.  For a cross-chapter reading, the
  // reflection covers the FIRST chapter's portion, and that sub-range is
  // recorded so the app can state what the reflection is actually about
  // instead of implying it covers the whole span.
  const scope = reading.endChapter && reading.endChapter !== reading.chapter
    ? { chapter: reading.chapter, verseStart: reading.verseStart, verseEnd: 200 }
    : { chapter: reading.chapter, verseStart: reading.verseStart, verseEnd: reading.verseEnd };

  const stored = { ...reading, scope, capturedAt: Date.now() };
  await env.COMMENTARY_KV.put(key, JSON.stringify(stored), { expirationTtl: DAILY_READING_TTL });

  // Warm it, so the first reader to type this passage gets a cached answer
  // rather than paying for a live generation.  One generation per day.
  const warm = await getOrCreateQtReflection(
    reading.bookNum, scope.chapter, scope.verseStart, scope.verseEnd, env,
  );
  return { ok: true, reading: stored, warmed: warm.ok };
}

// ---- /admin/auth-check ----
//
// Answers "why is every admin route saying forbidden" without anyone having
// to paste a secret into a chat window, and without this endpoint being able
// to leak one.
//
// What it reports and why each is safe:
//   configured      whether ADMIN_SECRET exists on this Worker at all.  When
//                   it does not, EVERY admin route refuses every value — the
//                   guard is `!env.ADMIN_SECRET || ...` — and no amount of
//                   retrying the right secret will ever work.  This is the
//                   one fact that cannot be deduced from outside.
//   receivedLength  the length of what the CALLER just sent.  Their own input.
//   matches         the same yes/no every admin route already gives by
//                   answering 200 or 403.  Nothing new.
//   trimmedMatches  whether it would match after trimming.  Only meaningful
//                   to someone who already holds the value, so it reveals
//                   nothing — but it catches the trailing newline a paste on
//                   a phone adds, which is invisible and otherwise presents
//                   as a simply wrong secret.
//
// Deliberately NOT reported: the configured secret's length or any part of
// its content.  Length would be a genuine (if small) leak to someone who does
// not have it, and it is not needed — trimmedMatches covers the case that
// length would have diagnosed.
function handleAuthCheck(env, url, cors) {
  const received = url.searchParams.get('secret') || '';
  const configured = typeof env.ADMIN_SECRET === 'string' && env.ADMIN_SECRET.length > 0;
  return new Response(JSON.stringify({
    configured,
    receivedLength: received.length,
    matches: configured && received === env.ADMIN_SECRET,
    trimmedMatches: configured && received.trim() === env.ADMIN_SECRET.trim(),
    hint: !configured
      ? 'ADMIN_SECRET is not set on this Worker.  Every /admin/* route will refuse every value until it is.  Add it under Settings -> Variables and Secrets as an encrypted Secret (a plain-text Variable is removed by the next wrangler deploy), then click Deploy in the dashboard — saving the field alone does not apply it.'
      : 'ADMIN_SECRET is set.  If matches is false but trimmedMatches is true, the value has stray whitespace on one side — the comparison below already tolerates that, so retry.  If both are false, the value sent is genuinely a different string.',
  }, null, 2), {headers:{...cors,'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
}

// ---- /admin/reading-probe ----
//
// Diagnostic ONLY.  Reports what the Worker's own fetch() receives from the
// external site that publishes a Korean daily-reading schedule, so the
// scraper can be written against what Cloudflare actually gets rather than
// against what a browser renders.
//
// It exists because those three things differ, and the difference is the
// whole risk in this feature:  a Korean site may refuse a datacenter IP,
// require a session cookie, or serve EUC-KR that text() silently mangles
// into replacement characters.  Each of those looks like "the parser is
// broken" from the outside, and none is fixable by changing the parser.
//
// It reports STRUCTURE, not content:  bounded context windows around each
// candidate reference, enough to tell which one is the day's reading and
// which are quotations inside the surrounding prose.  What this informs
// takes the passage REFERENCE only — book, chapter, verses — which is a
// citation of scripture, not of anyone's writing.  The reflection is
// generated from our own NKRV text by the existing pipeline, and no prose
// from the source is parsed, stored, or shown.
async function handleReadingProbe(env, url, cors) {
  // Trimmed on both sides:  a secret pasted on a phone routinely carries a
  // trailing newline, which is invisible and rejects as though it were simply
  // the wrong value.  Trimming cannot weaken the check — no secret of ours has
  // meaningful leading or trailing whitespace.
  const secret = (url.searchParams.get('secret') || '').trim();
  if (!env.ADMIN_SECRET || secret !== env.ADMIN_SECRET.trim()) {
    return new Response(JSON.stringify({error:'forbidden'}), {status:403, headers:{...cors,'Content-Type':'application/json'}});
  }

  const target = url.searchParams.get('url') || 'https://www.duranno.com/qt/view/bible.asp';
  // Only ever the one source host.  Without this the endpoint is an open
  // proxy that
  // fetches anything on the Worker's behalf, behind one shared secret.
  let host = '';
  try { host = new URL(target).hostname; } catch (e) {
    return new Response(JSON.stringify({error:'bad_url'}), {status:400, headers:{...cors,'Content-Type':'application/json'}});
  }
  if (host !== 'www.duranno.com' && host !== 'duranno.com') {
    return new Response(JSON.stringify({error:'host_not_allowed', host}), {status:400, headers:{...cors,'Content-Type':'application/json'}});
  }

  let res;
  try {
    res = await fetch(target, {
      headers: {
        // A plain Workers fetch sends no UA at all, which is the single most
        // likely thing to get refused.  This says what we are without
        // pretending to be a browser.
        'User-Agent': 'krengbible-qt/1.0 (+https://krengbible.com)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ko-KR,ko;q=0.9',
      },
      redirect: 'follow',
    });
  } catch (e) {
    return new Response(JSON.stringify({error:'fetch_failed', detail: String(e && e.message || e)}, null, 2),
      {status:502, headers:{...cors,'Content-Type':'application/json'}});
  }

  const contentType = res.headers.get('content-type') || '';
  const buf = await res.arrayBuffer();

  // Decode twice and let the caller see which one is sane.  A charset
  // mismatch does not throw — it yields U+FFFD, so it is counted, not
  // guessed at.
  const utf8 = new TextDecoder('utf-8').decode(buf);
  const badUtf8 = (utf8.match(/\uFFFD/g) || []).length;
  let eucKr = null, badEucKr = null, eucKrError = null;
  try {
    eucKr = new TextDecoder('euc-kr').decode(buf);
    badEucKr = (eucKr.match(/\uFFFD/g) || []).length;
  } catch (e) {
    eucKrError = String(e && e.message || e);
  }
  // Fewer replacement characters wins;  ties go to UTF-8.
  const useEucKr = eucKr !== null && badEucKr < badUtf8;
  const html = useEucKr ? eucKr : utf8;

  const titleMatch = html.match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i);
  const declared = html.match(/charset\s*=\s*["']?\s*([\w-]+)/i);

  // Every shape a Korean publisher prints a reference in.  Which one this
  // page uses is exactly what is unknown, so all of them are tried and the
  // caller picks.
  const PATTERNS = [
    { name: 'colon-range',   re: /([가-힣]{1,7})\s*(\d{1,3})\s*[:：]\s*(\d{1,3})\s*[-~–—]\s*(\d{1,3})/g },
    { name: 'jang-jeol',     re: /([가-힣]{1,7})\s*(\d{1,3})\s*장\s*(\d{1,3})\s*[-~–—]\s*(\d{1,3})\s*절/g },
    { name: 'colon-single',  re: /([가-힣]{1,7})\s*(\d{1,3})\s*[:：]\s*(\d{1,3})(?![\s]*[-~–—:：\d])/g },
    { name: 'jang-only',     re: /([가-힣]{1,7})\s*(\d{1,3})\s*장(?!\s*\d)/g },
    // Cross-chapter, e.g. 창 12:1-13:4.  Listed because published daily
    // readings do span chapters, and our /qt-reflection route does not.
    { name: 'cross-chapter', re: /([가-힣]{1,7})\s*(\d{1,3})\s*[:：]\s*(\d{1,3})\s*[-~–—]\s*(\d{1,3})\s*[:：]\s*(\d{1,3})/g },
  ];

  const MAX_CANDIDATES = 40;
  const candidates = [];
  for (const { name, re } of PATTERNS) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(html)) && candidates.length < MAX_CANDIDATES) {
      const { bookNum, matched } = koBookNumLoose(m[1]);
      if (!bookNum) continue;
      const at = m.index;
      const c = {
        pattern: name,
        raw: m[0].replace(/\s+/g, ' ').trim(),
        book: BOOK_NAMES_KO[bookNum - 1],
        bookNum,
        // What actually resolved, so a wrong book is visible rather than
        // inferred from the raw text.
        matchedName: matched,
        at,
        // Bounded window — enough to tell a heading from a quotation inside
        // the commentary, not enough to be a copy of anything.
        context: html.slice(Math.max(0, at - 80), at + 80).replace(/\s+/g, ' ').trim(),
      };
      if (name === 'cross-chapter') {
        c.chapter = +m[2]; c.verseStart = +m[3];
        c.endChapter = +m[4]; c.verseEnd = +m[5];
      } else if (name === 'jang-only') {
        c.chapter = +m[2];
      } else if (name === 'colon-single') {
        c.chapter = +m[2]; c.verseStart = +m[3]; c.verseEnd = +m[3];
      } else {
        c.chapter = +m[2]; c.verseStart = +m[3]; c.verseEnd = +m[4];
      }
      candidates.push(c);
    }
  }

  return new Response(JSON.stringify({
    target,
    fetch: {
      status: res.status,
      contentType,
      bytes: buf.byteLength,
      declaredCharset: declared ? declared[1] : null,
      decodedAs: useEucKr ? 'euc-kr' : 'utf-8',
      replacementChars: { utf8: badUtf8, eucKr: badEucKr, eucKrError },
    },
    title: titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : null,
    // A near-empty body with a 200 is the signature of a page whose content
    // arrives by script, which would mean scraping the HTML never works and
    // the underlying data endpoint has to be found instead.
    looksEmpty: buf.byteLength < 2000,
    candidateCount: candidates.length,
    truncated: candidates.length >= MAX_CANDIDATES,
    candidates,
    // charset stated explicitly: this body is mostly Korean, and a bare
    // application/json lets a browser fall back to Latin-1 and render every
    // Hangul character as mojibake — which reads as a broken scrape rather
    // than a display problem, and would send the next hour chasing an
    // encoding bug that is not in the parser.
  }, null, 2), {headers:{...cors,'Content-Type':'application/json; charset=utf-8'}});
}

// ---- /search/en — fast in-memory search over the pre-built ESV index ----
async function handleEnglishSearch(env, url, cors) {
  const q = url.searchParams.get('q');
  // Pagination: ESV-style "page" param (1-based), 20 per page, for backward compat with the client.
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
  const pageSize = 20;
  const offset = (page - 1) * pageSize;
  if (!q || q.trim().length < 2) {
    return new Response(JSON.stringify({results:[], hasMore:false}), {headers:{...cors,'Content-Type':'application/json'}});
  }

  const index = await getEnSearchIndex(env);
  if (!index) {
    return new Response(JSON.stringify({
      results: [],
      hasMore: false,
      error: 'index_not_built',
      hint: 'Run /admin/build-en-index then /admin/merge-en-index'
    }), {status:503, headers:{...cors,'Content-Type':'application/json'}});
  }

  // Case-insensitive substring filter.
  const term = q.trim().toLowerCase();
  const matches = [];
  for (let i = 0; i < index.length; i++) {
    const t = index[i][3];
    if (t.toLowerCase().indexOf(term) !== -1) matches.push(index[i]);
  }

  const slice = matches.slice(offset, offset + pageSize);
  const results = slice.map(([b, c, v, text]) => ({
    book: b,
    chapter: c,
    verse: v,
    text,
    ref: BOOK_NAMES_EN[b] + ' ' + c + ':' + v
  }));
  const hasMore = (offset + pageSize) < matches.length;

  // Count unique books across all matches (for a results-overview header on the client).
  const bookSet = new Set();
  for (const m of matches) bookSet.add(m[0]);

  return new Response(JSON.stringify({
    results,
    hasMore,
    nextPage: hasMore ? (page + 1) : -1,
    total: matches.length,
    bookCount: bookSet.size
  }), {headers:{...cors,'Content-Type':'application/json'}});
}

// ---- KJV chapter handler ----
// Route: GET /kjv/{bookNum}/{chapter}
//
// KJV is public domain, so unlike NLT/NIV it does NOT go through api.bible.
// Its text was imported once into KV under no-TTL keys (kjv_{bookNum}_{chapter})
// from a public-domain dataset — the same reason the Korean translations have
// their own routes.  There is no upstream to fetch on a miss: a missing key
// means the import hasn't run, so we say so with a 404 rather than pretending.
//
// The stored value is the SAME {data:{content:"[1]...[2]..."}} shape the app's
// parseApibible already handles, so the client reuses that parser unchanged.
async function handleKjvChapter(env, cors, bookNum, chapter) {
  const respHeaders = { ...cors, 'Content-Type': 'application/json' };
  const bookIdx = bookNum - 1;
  if (bookIdx < 0 || bookIdx >= BOOK_CHAPTERS.length) {
    return new Response(JSON.stringify({ error: 'bad_book', bookNum }), { status: 400, headers: respHeaders });
  }
  if (chapter < 1 || chapter > BOOK_CHAPTERS[bookIdx]) {
    return new Response(JSON.stringify({ error: 'bad_chapter', bookNum, chapter, max: BOOK_CHAPTERS[bookIdx] }), {
      status: 400, headers: respHeaders,
    });
  }
  if (!env.COMMENTARY_KV) {
    return new Response(JSON.stringify({ error: 'kv_unset' }), { status: 503, headers: respHeaders });
  }
  const cached = await env.COMMENTARY_KV.get(`kjv_${bookNum}_${chapter}`, 'json');
  if (!cached) {
    return new Response(JSON.stringify({ error: 'kjv_not_imported', bookNum, chapter }), {
      status: 404, headers: respHeaders,
    });
  }
  return new Response(JSON.stringify({
    data: cached.data,
    meta: {},
    fumsToken: null,
    cached: true,
    translation: { abbreviation: 'KJV', name: 'King James Version' },
  }), { headers: respHeaders });
}

// ---- KJV search ----
// Route: GET /search/kjv?q=...&page=...
// Identical in-memory flat-index scan as /search/en, over kjv_search_index.
async function getKjvSearchIndex(env) {
  if (KJV_SEARCH_INDEX) return KJV_SEARCH_INDEX;
  if (KJV_SEARCH_INDEX_PROMISE) return KJV_SEARCH_INDEX_PROMISE;
  KJV_SEARCH_INDEX_PROMISE = (async () => {
    const raw = await env.COMMENTARY_KV.get('kjv_search_index');
    if (!raw) { KJV_SEARCH_INDEX_PROMISE = null; return null; }
    try { KJV_SEARCH_INDEX = JSON.parse(raw); } catch (e) { KJV_SEARCH_INDEX = null; }
    KJV_SEARCH_INDEX_PROMISE = null;
    return KJV_SEARCH_INDEX;
  })();
  return KJV_SEARCH_INDEX_PROMISE;
}

async function handleKjvSearch(env, url, cors) {
  const q = url.searchParams.get('q');
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
  const pageSize = 20;
  const offset = (page - 1) * pageSize;
  if (!q || q.trim().length < 2) {
    return new Response(JSON.stringify({ results: [], hasMore: false }), { headers: { ...cors, 'Content-Type': 'application/json' } });
  }
  const index = await getKjvSearchIndex(env);
  if (!index) {
    return new Response(JSON.stringify({ results: [], hasMore: false, error: 'index_not_built' }), {
      status: 503, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
  const term = q.trim().toLowerCase();
  const matches = [];
  for (let i = 0; i < index.length; i++) {
    if (index[i][3].toLowerCase().indexOf(term) !== -1) matches.push(index[i]);
  }
  const slice = matches.slice(offset, offset + pageSize);
  const results = slice.map(([b, c, v, text]) => ({
    book: b, chapter: c, verse: v, text, ref: BOOK_NAMES_EN[b] + ' ' + c + ':' + v,
  }));
  const hasMore = (offset + pageSize) < matches.length;
  const bookSet = new Set();
  for (const m of matches) bookSet.add(m[0]);
  return new Response(JSON.stringify({
    results, hasMore, nextPage: hasMore ? (page + 1) : -1, total: matches.length, bookCount: bookSet.size,
  }), { headers: { ...cors, 'Content-Type': 'application/json' } });
}

// ---- api.bible chapter handler ----
// Route: GET /apibible/{translationId}/{bookNum}/{chapter}
//   - translationId must be in API_BIBLE_TRANSLATIONS whitelist
//   - bookNum is 1-66 (matches BOOKS array indexing)
//   - chapter is the integer chapter number
// Returns: { data: {...api.bible chapter data}, meta: {...api.bible meta},
//   fumsToken: string|null, cached: bool, translation: {abbreviation, name} }
//
// Cache strategy:
//   - 30-day TTL per the api.bible policy (cached content must be refreshed every 30 days)
//   - Key: apibible_raw_{translationId}_{usfmCode}.{chapter}
//   - Cached entries omit the FUMS token (each fresh API call gets its own token; cached reads
//     fire FUMS without a token, per the FUMS spec for previously-fetched content).
/**
 * Strip regex fragments out of api.bible verse text.
 *
 * KLB 2 Samuel 24:13 arrives from api.bible ending `주십시오.” (?=.*?것)` — a
 * lookahead that has no business in scripture and rendered verbatim in the
 * reader.  It is upstream, not ours: `apibible_raw_*` stores their payload
 * untouched, and nothing else in this worker writes those keys.
 *
 * Applied on the way OUT rather than at fetch time, deliberately.  The bad
 * text is already sitting in 1,189 cached chapters with a 30-day TTL, and
 * sanitising the response repairs every one of them on the next read — no KV
 * rewrite, no deletes, and no api.bible calls against a metered quota.
 *
 * Deliberately narrow: only a `(?...)` group whose body is regex syntax.  A
 * plain parenthetical is ordinary punctuation and must survive, so the `?`
 * plus a lookahead/non-capturing sigil is what qualifies.  A survey of all
 * 1,189 cached KLB chapters found exactly one match, so this is a scalpel and
 * not a filter — if it ever starts removing more, something changed upstream
 * and is worth looking at rather than silently cleaning.
 */
// ---- 현대인의 성경 (KLB): section headings glued onto the previous verse ----
//
// api.bible IGNORES `include-titles: false` for this Bible.  Section titles
// arrive appended to the end of the preceding verse with nothing but a space
// between them, so 1 Kings 2:9 reads
//
//     "...처리하여라.” 다윗의 죽음"
//
// and the title renders as a dangling fragment.  There is no marker in the
// payload to key off.
//
// WHY THIS IS ANCHORED TO KNOWN HEADING POSITIONS
//   Detecting them by shape alone — trailing text with no full stop — matches
//   1,090 verses across the Bible, and almost all are real scripture: KLB
//   verses routinely end mid-sentence and run into the next one ("아브라함이
//   '내가 여기 있습니다' 하고 대답하자").  A rule that eats 1,090 verses to fix
//   11 is far worse than the bug.
//
//   So a fragment is only removed when a section genuinely BEGINS at the next
//   verse.  Those positions come from bskorea's own markup, parsed by
//   extractHeadings() for NKRV, captured here once rather than looked up per
//   request — it costs no reads and no api.bible calls.  Verse numbers only;
//   what the section is called is irrelevant, and KLB words its titles
//   differently from NKRV anyway.
//
//   Verified over all 1,189 cached chapters / 30,379 verses: 11 removals,
//   every one a genuine title, none longer than 18 characters.
//
// Key "bookNum_chapter" -> verse numbers a section starts at (verse 1 omitted:
// nothing precedes it in the chapter).
const KLB_TRANSLATION_ID = 'e959e47176271f18-01';
const KLB_HEADING_VERSES = {"1_2":"4","1_3":"22","1_4":"16,25","1_6":"9","1_8":"20","1_9":"18","1_11":"10,27","1_12":"10","1_13":"14","1_14":"17","1_18":"16","1_19":"12,23,30","1_21":"8,22","1_22":"20","1_25":"12,19,27","1_26":"26,34","1_27":"46","1_28":"6,10","1_29":"21,31","1_30":"25","1_31":"43","1_32":"13","1_35":"16,23,27","1_36":"20,31","1_37":"12","1_41":"37","1_42":"26","1_44":"14","1_46":"28","1_47":"13,27","1_50":"15,22","2_2":"11","2_4":"18","2_5":"22","2_6":"2,14,28","2_7":"8,14","2_8":"16,20","2_9":"8,13","2_10":"21","2_12":"15,21,29,37,43","2_13":"11,17","2_15":"19,22","2_17":"8","2_18":"13","2_20":"18,22","2_21":"12,28","2_22":"16","2_23":"10,14,20","2_24":"12","2_25":"10,23,31","2_27":"9,20","2_28":"15,31","2_29":"38","2_30":"11,17,22,34","2_31":"12,18","2_33":"7,12","2_34":"10,29","2_35":"4,20,30","2_36":"2,8","2_37":"10,17,25","2_38":"8,9,21","2_39":"8,22,32","2_40":"34","3_5":"14","3_6":"8,14,24","3_7":"11,22,28,35,37","3_10":"8,12","3_13":"47","3_14":"33","3_15":"19","3_17":"10","3_22":"17","3_23":"4,9,15,23,26,33","3_24":"5,10","3_25":"8,13","3_26":"3","3_27":"26,28,30","4_1":"47","4_3":"5,14,40","4_4":"21,29,34","4_5":"5,11","4_6":"22","4_8":"5","4_9":"15","4_10":"11","4_11":"4,31","4_14":"11,26,39","4_15":"32,37","4_16":"36,41","4_18":"8,21,25","4_19":"11","4_20":"14,22","4_21":"4,10,21","4_22":"21,36,41","4_23":"13,27","4_24":"10","4_27":"12","4_28":"9,11,16,26","4_29":"7,12","4_31":"13,25","4_33":"50","4_34":"16","4_35":"9","5_1":"9,19,34","5_2":"26","5_3":"12,23","5_4":"15,41,44","5_5":"22","5_6":"10","5_7":"12","5_8":"11","5_10":"12","5_11":"8","5_12":"29","5_14":"3,22","5_15":"12,19","5_16":"9,13,18","5_17":"14","5_18":"9,15","5_19":"14,15","5_21":"10,15,18,22","5_22":"13","5_23":"9,15","5_24":"5","5_25":"5,11,17","5_26":"16","5_27":"11","5_28":"20","5_31":"9,14,30","6_1":"10","6_5":"2,13","6_8":"30","6_10":"16","6_11":"16","6_12":"7","6_13":"8,15,24,29","6_14":"6","6_15":"13,20","6_16":"5","6_17":"14","6_18":"11","6_19":"10,17,24,32,40,49","6_21":"43","6_22":"10","6_24":"29","7_1":"8,11,16,22,27","7_2":"6,11","7_3":"7,12,31","7_8":"29","7_10":"3,6","7_11":"34","7_12":"8,13","7_15":"9","7_16":"4,23","7_20":"17,36","8_1":"6","9_1":"9,19","9_2":"12,18,22,27","9_4":"2,12,19","9_6":"19","9_7":"3","9_9":"25","9_10":"17","9_11":"12","9_14":"16,24,47","9_15":"10,32,34","9_16":"14","9_17":"12,41,55","9_18":"6,17","9_23":"15","9_25":"2","9_28":"3","10_1":"17","10_2":"8,12","10_3":"2,6,22,31","10_5":"6,13,17","10_7":"18","10_12":"16,24,26","10_13":"23","10_14":"25","10_15":"13","10_16":"5,15","10_17":"15","10_18":"19","10_19":"9,16,24,31,40","10_20":"23","10_21":"15","10_23":"8","11_1":"5,11","11_2":"10,13,26,36","11_3":"16","11_4":"20","11_6":"14","11_7":"13,23,27,40","11_8":"12,22,54,62","11_9":"10,15","11_10":"14","11_11":"14,26,41","11_12":"21,25","11_13":"11,33","11_14":"19,21","11_15":"9,25,33","11_16":"8,15,21,29","11_17":"8","11_18":"41","11_19":"19","11_20":"22,35","11_22":"29,41,51","12_2":"19","12_4":"8,38","12_6":"8,24","12_7":"3","12_8":"7,16,25","12_9":"14,27,30","12_10":"12,15,18,32","12_11":"17","12_13":"10,14,22","12_14":"17,23","12_15":"8,13,17,23,27,32","12_17":"7,24","12_18":"13","12_19":"8,20,35","12_20":"12,16","12_21":"19","12_22":"3","12_23":"21,24,28,31,36","12_24":"8,18","12_25":"8,18,22,27","13_1":"28,34,43","13_2":"3,9,18,25,42","13_3":"10","13_4":"11,24","13_5":"11,18,23,25","13_6":"16,31,49,54","13_7":"6,13,14,20,30","13_8":"29","13_9":"10,14,17,28,35","13_11":"10","13_12":"8,16,19,23","13_14":"8","13_15":"25","13_16":"7,37","13_17":"16","13_20":"4","13_22":"2","13_24":"20","13_26":"20,29","13_27":"16,25,32","13_29":"10,26","14_1":"14","14_2":"17","14_3":"15","14_5":"2,11","14_6":"12","14_7":"11","14_9":"13,29","14_11":"5,13,18","14_12":"13","14_16":"7,11","14_17":"10","14_18":"28","14_19":"4","14_20":"31","14_22":"10","14_23":"16","14_24":"15,23","14_25":"5,17","14_26":"16","14_28":"8,16,22","14_29":"20","14_30":"13,23","14_32":"24,27,32","14_33":"10,14,21","14_34":"8,29","14_35":"20","14_36":"5,9,11,22","15_1":"5","15_3":"8","15_6":"13,19","15_7":"11,27","15_8":"15,21,24,31","15_10":"18","16_5":"14","16_6":"15","16_7":"5,73","16_11":"25","16_12":"8,12,22,27,44","17_2":"19","17_5":"9","17_9":"20","18_1":"13","18_2":"11","18_13":"20","18_32":"6","18_42":"7,10","20_1":"7,20","20_6":"20","20_31":"10","21_1":"12","21_2":"12,18","21_4":"13","21_5":"10","21_8":"9","21_9":"13","21_11":"9","21_12":"9","23_1":"2,21","23_2":"5","23_3":"13,16","23_4":"2","23_5":"8","23_7":"10","23_8":"5,9,16","23_9":"8","23_10":"5,20,24,28","23_11":"10","23_14":"3,21,24,28","23_17":"12","23_19":"16","23_21":"11,13","23_22":"15","23_25":"6,9","23_26":"20","23_28":"9,14,23","23_29":"9,15","23_30":"8,18,27","23_32":"9","23_33":"7,17","23_37":"8,21","23_40":"12","23_41":"21","23_42":"10,14,18","23_43":"8,14,22","23_44":"9,21","23_45":"9,20","23_48":"12,17","23_49":"8","23_50":"4","23_51":"17","23_52":"13","23_54":"11","23_56":"9","23_57":"14","23_58":"13","23_59":"9,16","23_63":"7,15","23_65":"17","24_1":"4,11","24_2":"4,9,14,20,26","24_3":"6,19,23","24_4":"5,11,19,23","24_5":"10,20","24_6":"9,16,22","24_7":"16,29","24_8":"4,18","24_9":"17","24_10":"12,17","24_11":"18","24_12":"7,14","24_13":"12,15","24_14":"19","24_15":"10","24_16":"14,16,19","24_17":"12,19","24_18":"13,18","24_20":"7","24_21":"11","24_22":"10,13,20,24","24_23":"9,33","24_25":"15","24_29":"24","24_31":"15,23,31","24_32":"16,36","24_34":"8","24_36":"11,20,27","24_37":"11","24_38":"14","24_39":"11,15","24_40":"7,13","24_42":"7","24_46":"13,27","24_48":"11,26,36","24_49":"7,23,28,34","24_50":"6,11,17,21","24_51":"15,20,25,33,41,50,54,59","24_52":"12,24","26_3":"16,22","26_7":"14","26_11":"14,22","26_12":"17,21","26_13":"17","26_14":"12","26_16":"23,35,44,53,60","26_17":"11,22","26_20":"33,45","26_22":"17,23","26_23":"22,36","26_24":"15","26_25":"8,12","26_28":"20,25","26_29":"17","26_30":"20","26_32":"17","26_33":"10,21,23,30","26_34":"7","26_36":"16","26_37":"15","26_38":"17","26_39":"21","26_40":"5,17,20,24,28,32,35,38,48","26_41":"12,21","26_42":"15","26_43":"13,18","26_44":"4,9,15","26_45":"9,18","26_46":"13,16,19","26_47":"13","26_48":"23,30","27_2":"14,25,46","27_3":"8,19,24","27_4":"19,34","27_5":"13","27_7":"9,15","27_8":"15","27_9":"20","27_11":"2,20","28_1":"2,10","28_2":"2,14","28_4":"6,11","28_5":"8","28_7":"8","28_9":"10","28_10":"9","28_11":"12","28_12":"7","28_14":"4,9","29_1":"2","29_2":"12,18,28","29_3":"14","30_1":"3","30_2":"4,6","30_3":"9","30_4":"4","30_5":"4","30_7":"4,7,10","30_9":"11","31_1":"2,10,15,17","32_1":"17","33_1":"2,8","33_4":"6","33_5":"2,10","33_6":"6","33_7":"7,14","34_1":"2","35_1":"2,5,12","36_1":"2","36_2":"4","36_3":"14","37_1":"12","38_1":"7,18","38_5":"5","38_6":"9","38_7":"8","38_8":"18","38_9":"9","38_11":"4","38_13":"7","39_1":"2,6","39_2":"10,17","39_3":"7,13","40_1":"18","40_2":"13,19","40_3":"13","40_4":"12,18,23","40_5":"13,17,21,27,33,38,43","40_6":"5,16,19","40_7":"7,13,15,28","40_8":"5,14,18,23,28","40_9":"9,14,18,27,32,35","40_10":"2,16,24,34,40","40_11":"2,20,25","40_12":"9,22,38,46","40_13":"10,31,34,36,44,51,53","40_14":"13,22,34","40_15":"21,29,32","40_16":"5,13,21","40_17":"14,22,24","40_18":"15,21","40_19":"13,16","40_20":"17,20,29","40_21":"12,18,23,33","40_22":"15,23,34,41","40_23":"37","40_24":"3,15,29,32","40_25":"14,31","40_26":"6,14,17,31,36,47,57,69","40_27":"3,11,27,32,45,57,62","40_28":"11,16","41_1":"9,12,14,16,21,29,35,40","41_2":"13,18,23","41_3":"7,13,20,31","41_4":"10,21,26,30,33,35","41_5":"21","41_6":"7,14,30,45,53","41_7":"24,31","41_8":"11,14,22,27","41_9":"2,14,30,33,38","41_10":"13,17,32,35,46","41_11":"12,15,20,27","41_12":"13,18,28,35,38,41","41_13":"3,14,24,28","41_14":"3,10,12,22,27,32,43,51,53,66","41_15":"6,16,21,33,42","41_16":"9,12,14,19","42_1":"5,26,39,46,57,67","42_2":"8,22,41","42_3":"21,23","42_4":"14,16,31,38,42","42_5":"12,17,27","42_6":"6,12,20,27,39,46","42_7":"11,18,36","42_8":"4,9,16,19,22,26,40","42_9":"7,10,18,28,37,44,46,49,51,57","42_10":"17,21,25,38","42_11":"14,27,29,33,37","42_12":"13,22,35,49,54","42_13":"6,10,18,22,31","42_14":"7,15,25","42_15":"8,11","42_16":"14,19","42_17":"11,20","42_18":"9,15,18,31,35","42_19":"11,28,45","42_20":"9,19,27,41,45","42_21":"5,10,20,29,34","42_22":"7,14,24,35,39,47,54,63,66","42_23":"8,13,26,44,50","42_24":"13,36,50","43_1":"19,29,35,43","43_2":"13,23","43_3":"22,31","43_4":"43","43_5":"19,30","43_6":"16,22,60","43_7":"10,25,37,45,53","43_8":"12,21,31","43_9":"13,35","43_10":"7,22","43_11":"17,45","43_12":"9,12,20,37,44","43_13":"21,31,36","43_14":"25","43_16":"25","43_18":"12,15,19,25,28,39","43_19":"17,28,31,38","43_20":"11,19,24,30","43_21":"15","44_1":"6,12","44_2":"14,43","44_3":"11","44_4":"23,32","44_5":"12,17","44_6":"8","44_7":"54","44_8":"2,4,26","44_9":"20,23,26,32,36","44_10":"24,44","44_11":"19","44_12":"20","44_13":"4,13","44_14":"8","44_15":"22,36","44_16":"6,11,16","44_17":"10,16","44_18":"18,24","44_19":"21","44_20":"7,13,17","44_21":"17,27,37","44_22":"2,30","44_23":"12,31","44_24":"10,24","44_25":"13","44_26":"24","44_27":"27","44_28":"11,16","45_1":"8,18","45_2":"17","45_3":"9,19","45_5":"12","45_6":"15","45_8":"18,31","45_9":"19,30","45_10":"16","45_11":"13,25","45_12":"14","45_13":"8,11","45_14":"13","45_15":"14,22","45_16":"21","46_1":"10,18","46_2":"6","46_6":"12","46_7":"25","46_10":"23","46_11":"2,17","46_12":"12","46_14":"26","46_15":"12,35","46_16":"13","47_1":"12","47_2":"5,12","47_4":"16","47_5":"11","47_6":"14","47_7":"2","47_8":"16","47_11":"16","47_12":"11","48_1":"6,11","48_2":"11","48_3":"15,23","48_4":"8,21","48_5":"2,16","48_6":"11","49_1":"3,15","49_2":"11","49_3":"14","49_4":"17,25","49_5":"15,22","49_6":"5,10,21","50_1":"3,12","50_2":"12,19","50_3":"17","50_4":"2,10,21","51_1":"3,9,24","51_2":"6,20","51_3":"18","51_4":"2,7","52_1":"2","52_2":"17","52_4":"13","52_5":"12","53_1":"3","53_2":"13","53_3":"6,16","54_1":"3,12","54_3":"14","54_4":"6","54_6":"3,11","55_1":"3","55_2":"14","55_4":"9,19","56_1":"5","56_2":"15","56_3":"12","57_1":"4,8,23","58_2":"5","58_4":"14","58_5":"11","58_6":"13","58_9":"23","58_10":"19","58_12":"14","58_13":"20","59_1":"2,9,12,19","59_2":"14","59_3":"13","59_4":"11,13","59_5":"7","60_1":"3,13","60_2":"11,18","60_3":"8","60_4":"12","60_5":"12","61_1":"12","62_1":"5","62_2":"7,18","62_3":"13","62_4":"7","62_5":"13","63_1":"4,12","64_1":"5,13","65_1":"3,17,24","66_1":"9","66_2":"8,12,18","66_3":"7,14","66_7":"5","66_8":"6","66_11":"15","66_14":"6,14,17","66_19":"11","66_20":"7,11","66_21":"9","66_22":"6"};

// Sentence end, then a short quote-free run at the very end of the verse.  The
// 25-char cap and the quote exclusion were added after a first pass let two
// real verses through (DAN 11:1, ISA 59:15) — a title never carries quotation
// marks, reported speech always does.
const KLB_TRAILING_TITLE = /([.!?][”"\u2019]?)\s+([^.!?\u201c\u201d"'\u2018\u2019]{2,25})$/;

/** Remove section titles that api.bible appended to the previous verse. */
function stripKlbHeadings(content, bookNum, chapter) {
  if (typeof content !== 'string') return content;
  const spec = KLB_HEADING_VERSES[`${bookNum}_${chapter}`];
  if (!spec) return content;
  const starts = new Set(spec.split(',').map(Number));
  return content
    .split(/(?=\[\d+(?:-\d+)?\])/)
    .map((seg) => {
      const m = /^(\s*\[(\d+)(?:-\d+)?\]\s*)([\s\S]*?)(\s*)$/.exec(seg);
      if (!m) return seg;
      if (!starts.has(Number(m[2]) + 1)) return seg;
      const hit = KLB_TRAILING_TITLE.exec(m[3]);
      if (!hit) return seg;
      return m[1] + m[3].slice(0, hit.index + hit[1].length) + m[4];
    })
    .join('');
}

const API_BIBLE_REGEX_ARTIFACT = /\s*\(\?[=!:<][^)]{0,60}\)/g;

function sanitizeApiBibleContent(data, translationId, bookNum, chapter) {
  if (!data || typeof data.content !== 'string') return data;
  let cleaned = data.content.replace(API_BIBLE_REGEX_ARTIFACT, '');
  // KLB only — the other api.bible translations do not carry inline titles,
  // and the heading table is keyed to this Bible's versification.
  if (translationId === KLB_TRANSLATION_ID) {
    cleaned = stripKlbHeadings(cleaned, bookNum, chapter);
  }
  return cleaned === data.content ? data : { ...data, content: cleaned };
}

async function handleApiBibleChapter(env, url, cors, translationId, bookNum, chapter) {
  // Validate authorization
  const translation = API_BIBLE_TRANSLATIONS[translationId];
  if (!translation) {
    return new Response(JSON.stringify({error: 'translation_not_authorized', translationId}), {
      status: 403, headers: {...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store'}
    });
  }
  // Validate book/chapter
  const bookIdx = bookNum - 1;
  if (bookIdx < 0 || bookIdx >= USFM_CODES.length) {
    return new Response(JSON.stringify({error: 'bad_book', bookNum}), {
      status: 400, headers: {...cors, 'Content-Type': 'application/json'}
    });
  }
  if (chapter < 1 || chapter > BOOK_CHAPTERS[bookIdx]) {
    return new Response(JSON.stringify({error: 'bad_chapter', book: USFM_CODES[bookIdx], chapter, max: BOOK_CHAPTERS[bookIdx]}), {
      status: 400, headers: {...cors, 'Content-Type': 'application/json'}
    });
  }
  if (!env.API_BIBLE_KEY) {
    return new Response(JSON.stringify({error: 'api_bible_key_unset'}), {
      status: 503, headers: {...cors, 'Content-Type': 'application/json'}
    });
  }

  const usfmCode = USFM_CODES[bookIdx];
  const chapterId = `${usfmCode}.${chapter}`;
  const cacheKey = `apibible_raw_${translationId}_${chapterId}`;

  // no-store on the response so browsers and edge don't keep their own copies.
  // Our KV is the canonical cache, and a stale entry in the browser would prevent
  // us from honoring api.bible's 30-day refresh + 24-hour update-on-request rules.
  const respHeaders = {
    ...cors,
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store, must-revalidate'
  };

  // Try KV cache first
  if (env.COMMENTARY_KV) {
    const cached = await env.COMMENTARY_KV.get(cacheKey, 'json');
    if (cached) {
      return new Response(JSON.stringify({
        data: sanitizeApiBibleContent(cached.data, translationId, bookNum, chapter),
        meta: cached.meta || {},
        fumsToken: null, // never reuse a stored FUMS token; cached reads fire FUMS without one
        cached: true,
        translation
      }), { headers: respHeaders });
    }
  }

  // Fetch fresh from api.bible
  // Query params per api.bible /v1/bibles/{id}/chapters/{chapterId} spec.
  // NOTE: do NOT include `use-org-id` here — that param belongs to the verses
  // endpoint and api.bible 400s on it for chapters.
  const params = new URLSearchParams({
    'content-type': 'text',
    'include-notes': 'false',
    'include-titles': 'false',
    'include-chapter-numbers': 'false',
    'include-verse-numbers': 'true',
    'include-verse-spans': 'false'
  });
  const apiUrl = `https://rest.api.bible/v1/bibles/${translationId}/chapters/${chapterId}?${params}`;

  const resp = await fetch(apiUrl, { headers: { 'api-key': env.API_BIBLE_KEY } });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    return new Response(JSON.stringify({error: 'apibible_status_' + resp.status, body: body.slice(0, 500)}), {
      status: 502, headers: respHeaders
    });
  }
  const apiData = await resp.json();
  if (!apiData?.data?.content) {
    return new Response(JSON.stringify({error: 'apibible_empty_response', apiData}), {
      status: 502, headers: respHeaders
    });
  }

  // Persist to KV with 30-day TTL.  We store only data + meta — NOT the FUMS token,
  // since FUMS tokens are per-request and shouldn't be replayed from cache.
  if (env.COMMENTARY_KV) {
    const toStore = JSON.stringify({ data: apiData.data, meta: apiData.meta || {} });
    await env.COMMENTARY_KV.put(cacheKey, toStore, { expirationTtl: API_BIBLE_CACHE_TTL });
  }

  // FUMS token from api.bible's response — front-end will ping fums.api.bible/f3 with it
  const fumsToken = apiData.meta?.fums || apiData.meta?.fumsId || null;

  return new Response(JSON.stringify({
    data: sanitizeApiBibleContent(apiData.data, translationId, bookNum, chapter),
    meta: apiData.meta || {},
    fumsToken,
    cached: false,
    translation
  }), { headers: respHeaders });
}

// ---- /search/apibible/{translationId}?q=...&page=... ----
// Per-translation full-text search.  Prefers the pre-built flat index in KV
// (instant) and falls back to api.bible's live search endpoint when the index
// isn't built yet.  Once the index is built, this path makes ZERO api.bible
// calls per query — same property as /search/en for ESV.
async function handleApiBibleSearch(env, url, cors, translationId) {
  const translation = API_BIBLE_TRANSLATIONS[translationId];
  if (!translation) {
    return new Response(JSON.stringify({error: 'translation_not_authorized'}), {
      status: 403, headers: {...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store'}
    });
  }
  const q = url.searchParams.get('q');
  if (!q || q.trim().length < 2) {
    return new Response(JSON.stringify({results: [], hasMore: false}), {
      headers: {...cors, 'Content-Type': 'application/json'}
    });
  }
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
  const pageSize = 20;
  const offset = (page - 1) * pageSize;
  const respHeaders = {
    ...cors,
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store, must-revalidate'
  };

  // -- Fast path: pre-built flat index --
  const index = await getApiBibleSearchIndex(env, translationId);
  if (index) {
    const term = q.trim().toLowerCase();
    const matches = [];
    for (let i = 0; i < index.length; i++) {
      const t = index[i][3];
      if (t.toLowerCase().indexOf(term) !== -1) matches.push(index[i]);
    }
    const slice = matches.slice(offset, offset + pageSize);
    const results = slice.map(([b, c, v, text]) => ({
      book: b,
      chapter: c,
      verse: v,
      text,
      ref: `${BOOK_NAMES_EN[b]} ${c}:${v}`
    }));
    const hasMore = (offset + pageSize) < matches.length;
    const bookSet = new Set();
    for (const m of matches) bookSet.add(m[0]);
    return new Response(JSON.stringify({
      results,
      hasMore,
      nextPage: hasMore ? (page + 1) : -1,
      total: matches.length,
      bookCount: bookSet.size,
      fumsToken: null, // indexed reads don't consume new FUMS tokens
      translation: translation.abbreviation,
      source: 'index'
    }), { headers: respHeaders });
  }

  // -- Fallback: live api.bible search (used until the index is built) --
  if (!env.API_BIBLE_KEY) {
    return new Response(JSON.stringify({error: 'api_bible_key_unset'}), {
      status: 503, headers: respHeaders
    });
  }
  const params = new URLSearchParams({
    query: q.trim(),
    limit: String(pageSize),
    offset: String(offset)
  });
  const apiUrl = `https://rest.api.bible/v1/bibles/${translationId}/search?${params}`;
  const resp = await fetch(apiUrl, { headers: { 'api-key': env.API_BIBLE_KEY } });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    return new Response(JSON.stringify({error: 'apibible_search_status_' + resp.status, body: body.slice(0, 300)}), {
      status: 502, headers: respHeaders
    });
  }
  const data = await resp.json();
  const apiVerses = data?.data?.verses || [];
  const results = [];
  const bookSet = new Set();
  for (const v of apiVerses) {
    const bookIdx = USFM_CODES.indexOf(v.bookId);
    if (bookIdx < 0) continue;
    const m = String(v.id).match(/^[A-Z0-9]+\.(\d+)\.(\d+)/);
    if (!m) continue;
    const chapter = parseInt(m[1]);
    const verse = parseInt(m[2]);
    results.push({
      book: bookIdx,
      chapter,
      verse,
      text: v.text,
      ref: v.reference || `${BOOK_NAMES_EN[bookIdx]} ${chapter}:${verse}`
    });
    bookSet.add(bookIdx);
  }
  const total = data?.data?.total || results.length;
  const hasMore = (offset + pageSize) < total;
  const fumsToken = data?.meta?.fums || data?.meta?.fumsId || null;
  return new Response(JSON.stringify({
    results,
    hasMore,
    nextPage: hasMore ? (page + 1) : -1,
    total,
    bookCount: bookSet.size,
    fumsToken,
    translation: translation.abbreviation,
    source: 'live'
  }), { headers: respHeaders });
}

// ---- api.bible chapter content parser (text format with [N] / [N-M] markers) ----
// Returns [{verse: N, text: '...'}].  For grouped verses [N-M], stores the text
// once under the first verse number (M-N other verses get no entry — matches
// the front-end "↑ continued above" approach for display consistency).
function parseApiBibleChapterContent(content) {
  if (!content) return [];
  // Same upstream artifact the chapter route strips — see
  // sanitizeApiBibleContent.  Applied here too so a search-index rebuild does
  // not bake a regex fragment into the indexed text (and, through it, into
  // search results and their snippets).
  content = content.replace(API_BIBLE_REGEX_ARTIFACT, '');
  const out = [];
  const segments = content.split(/(?=\[\d+(?:-\d+)?\])/);
  for (const seg of segments) {
    const trimmed = seg.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^\[(\d+)(?:-\d+)?\]\s*([\s\S]*)/);
    if (!m) continue;
    const verseStart = parseInt(m[1]);
    let text = m[2].replace(/\s+/g, ' ').trim();
    if (text.length < 2) continue;
    out.push({ verse: verseStart, text });
  }
  return out;
}

async function getApiBibleSearchIndex(env, translationId) {
  if (APIBIBLE_INDEXES[translationId]) return APIBIBLE_INDEXES[translationId];
  if (APIBIBLE_INDEX_PROMISES[translationId]) return APIBIBLE_INDEX_PROMISES[translationId];
  APIBIBLE_INDEX_PROMISES[translationId] = (async () => {
    const key = `apibible_search_index_${translationId}`;
    const raw = await env.COMMENTARY_KV.get(key);
    if (!raw) {
      APIBIBLE_INDEX_PROMISES[translationId] = null;
      return null;
    }
    try {
      APIBIBLE_INDEXES[translationId] = JSON.parse(raw);
    } catch (e) {
      APIBIBLE_INDEXES[translationId] = null;
    }
    APIBIBLE_INDEX_PROMISES[translationId] = null;
    return APIBIBLE_INDEXES[translationId];
  })();
  return APIBIBLE_INDEX_PROMISES[translationId];
}

// Fetch a chapter directly from api.bible for index building.  Returns the
// parsed [{verse, text}] list, or throws on failure.  Used both by the live
// chapter handler (via cache) and by the index builder.  Includes a small
// 429-aware retry like fetchChapterFromEsv.
async function fetchChapterFromApiBible(translationId, usfmCode, chapter, env) {
  const chapterId = `${usfmCode}.${chapter}`;
  const params = new URLSearchParams({
    'content-type': 'text',
    'include-notes': 'false',
    'include-titles': 'false',
    'include-chapter-numbers': 'false',
    'include-verse-numbers': 'true',
    'include-verse-spans': 'false'
  });
  const apiUrl = `https://rest.api.bible/v1/bibles/${translationId}/chapters/${chapterId}?${params}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const resp = await fetch(apiUrl, { headers: { 'api-key': env.API_BIBLE_KEY } });
    if (resp.ok) {
      const data = await resp.json();
      if (!data?.data?.content) throw new Error(`empty content for ${chapterId}`);
      return { data: data.data, meta: data.meta || {} };
    }
    if (resp.status === 429) {
      const wait = 500 * Math.pow(2, attempt); // 500ms, 1s, 2s, 4s, 8s
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    const body = await resp.text().catch(() => '');
    throw new Error(`status ${resp.status} for ${chapterId}: ${body.slice(0, 200)}`);
  }
  throw new Error(`429 retries exhausted for ${chapterId}`);
}

// Walk a slice of the canonical chapter ordinals and either reuse the cached
// chapter or call api.bible.  Writes a flat-tuple chunk to KV.  Mirrors
// handleBuildEnIndex but is per-translation.
async function handleBuildApiBibleIndex(env, url, cors) {
  const secret = url.searchParams.get('secret');
  if (!env.ADMIN_SECRET || secret !== env.ADMIN_SECRET) {
    return new Response(JSON.stringify({error:'forbidden'}), {status:403, headers:{...cors,'Content-Type':'application/json'}});
  }
  const translationId = url.searchParams.get('translationId');
  if (!translationId || !API_BIBLE_TRANSLATIONS[translationId]) {
    return new Response(JSON.stringify({
      error: 'translation_required',
      hint: 'Pass &translationId={id}',
      authorized: Object.fromEntries(Object.entries(API_BIBLE_TRANSLATIONS).map(([k,v])=>[v.abbreviation,k]))
    }), {status:400, headers:{...cors,'Content-Type':'application/json'}});
  }
  if (!env.API_BIBLE_KEY) {
    return new Response(JSON.stringify({error:'api_bible_key_unset'}), {status:503, headers:{...cors,'Content-Type':'application/json'}});
  }

  const from = Math.max(0, parseInt(url.searchParams.get('from') || '0'));
  const size = Math.min(400, Math.max(1, parseInt(url.searchParams.get('size') || '250')));
  const refetch = url.searchParams.get('refetch') === '1';
  const concurrency = 2; // be polite to api.bible

  const tuples = [];
  let fetched = 0, fromCache = 0, errored = 0;
  const errors = [];

  const ordinals = [];
  for (let o = from; o < Math.min(from + size, TOTAL_CHAPTERS); o++) ordinals.push(o);

  for (let i = 0; i < ordinals.length; i += concurrency) {
    const batch = ordinals.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(async (ord) => {
      const [bookIdx, chapter] = ordinalToBookChapter(ord);
      const usfm = USFM_CODES[bookIdx];
      const chapterId = `${usfm}.${chapter}`;
      const cacheKey = `apibible_raw_${translationId}_${chapterId}`;
      try {
        let chapterPayload = null;
        if (!refetch && env.COMMENTARY_KV) {
          const cached = await env.COMMENTARY_KV.get(cacheKey, 'json');
          if (cached) { chapterPayload = cached; fromCache++; }
        }
        if (!chapterPayload) {
          chapterPayload = await fetchChapterFromApiBible(translationId, usfm, chapter, env);
          if (env.COMMENTARY_KV) {
            // Store WITHOUT the FUMS token; same shape as the on-demand chapter handler.
            const toStore = JSON.stringify({ data: chapterPayload.data, meta: chapterPayload.meta });
            await env.COMMENTARY_KV.put(cacheKey, toStore, { expirationTtl: API_BIBLE_CACHE_TTL });
          }
          fetched++;
        }
        const verses = parseApiBibleChapterContent(chapterPayload.data.content);
        return verses.map(v => [bookIdx, chapter, v.verse, v.text]);
      } catch (e) {
        errored++;
        errors.push({ ord, bookIdx, chapter, chapterId, msg: String(e.message || e) });
        return [];
      }
    }));
    for (const r of results) for (const t of r) tuples.push(t);
  }

  const chunkKey = `apibible_search_chunk_${translationId}_${String(from).padStart(5, '0')}`;
  if (env.COMMENTARY_KV) {
    await env.COMMENTARY_KV.put(chunkKey, JSON.stringify(tuples));
  }

  const nextFrom = from + size;
  const done = nextFrom >= TOTAL_CHAPTERS;
  return new Response(JSON.stringify({
    ok: true,
    translation: API_BIBLE_TRANSLATIONS[translationId].abbreviation,
    chunkKey,
    processedOrdinals: ordinals.length,
    verseCount: tuples.length,
    fetchedFromApi: fetched,
    fromKvCache: fromCache,
    errored,
    errors: errors.slice(0, 10),
    nextFrom: done ? null : nextFrom,
    nextUrl: done ? null : `/admin/build-apibible-index?secret=...&translationId=${translationId}&from=${nextFrom}&size=${size}`,
    totalChapters: TOTAL_CHAPTERS,
    done
  }, null, 2), {headers:{...cors,'Content-Type':'application/json'}});
}

async function handleMergeApiBibleIndex(env, url, cors) {
  const secret = url.searchParams.get('secret');
  if (!env.ADMIN_SECRET || secret !== env.ADMIN_SECRET) {
    return new Response(JSON.stringify({error:'forbidden'}), {status:403, headers:{...cors,'Content-Type':'application/json'}});
  }
  if (!env.COMMENTARY_KV) return new Response(JSON.stringify({error:'no_kv'}), {status:500, headers:{...cors,'Content-Type':'application/json'}});
  const translationId = url.searchParams.get('translationId');
  if (!translationId || !API_BIBLE_TRANSLATIONS[translationId]) {
    return new Response(JSON.stringify({error:'translation_required'}), {status:400, headers:{...cors,'Content-Type':'application/json'}});
  }

  const chunkPrefix = `apibible_search_chunk_${translationId}_`;
  const chunks = [];
  let cursor = undefined;
  let safety = 0;
  while (true) {
    const list = await env.COMMENTARY_KV.list({ prefix: chunkPrefix, cursor, limit: 1000 });
    for (const k of list.keys) chunks.push(k.name);
    if (list.list_complete || !list.cursor) break;
    cursor = list.cursor;
    if (++safety > 50) break;
  }
  chunks.sort();

  if (chunks.length === 0) {
    return new Response(JSON.stringify({error:'no_chunks', hint:'run /admin/build-apibible-index first'}), {status:400, headers:{...cors,'Content-Type':'application/json'}});
  }

  const merged = [];
  for (const key of chunks) {
    const raw = await env.COMMENTARY_KV.get(key);
    if (!raw) continue;
    try {
      const arr = JSON.parse(raw);
      for (const t of arr) merged.push(t);
    } catch (e) { /* skip */ }
  }

  const indexKey = `apibible_search_index_${translationId}`;
  const payload = JSON.stringify(merged);
  await env.COMMENTARY_KV.put(indexKey, payload);

  APIBIBLE_INDEXES[translationId] = null;
  APIBIBLE_INDEX_PROMISES[translationId] = null;

  return new Response(JSON.stringify({
    ok: true,
    translation: API_BIBLE_TRANSLATIONS[translationId].abbreviation,
    chunksRead: chunks.length,
    totalVerses: merged.length,
    indexBytes: payload.length,
    storedAt: indexKey
  }, null, 2), {headers:{...cors,'Content-Type':'application/json'}});
}

// ---- ESV chapter fetch + parse for the English index ----
// Returns { verses: [{verse: N, text: '...'}], headings: {} }.
function parseEsvPassageText(passage) {
  if (!passage) return [];
  const lines = passage.split('\n');
  const passageLines = [];
  let inFn = false;
  for (const l of lines) {
    if (!inFn && /^\s*Footnotes?\s*$/i.test(l)) { inFn = true; continue; }
    if (!inFn) passageLines.push(l);
  }
  const joined = passageLines.join(' ');
  const verses = [];
  // Split on [N] verse markers.  First chunk before any [N] is heading/intro — discard.
  const segments = joined.split(/(?=\[\d+\])/);
  for (const seg of segments) {
    const s = seg.trim();
    if (!s) continue;
    const m = s.match(/^\[(\d+)\]\s*([\s\S]*)/);
    if (!m) continue;
    const num = parseInt(m[1]);
    let text = m[2]
      .replace(/\s+/g, ' ')
      .replace(/\s*Footnotes?\s*$/i, '')
      .trim();
    if (text.length > 1) verses.push({ verse: num, text });
  }
  return verses;
}

async function fetchChapterFromEsv(bookNum, chapter, env) {
  const book = BOOK_NAMES_EN[bookNum - 1];
  // Ask for the entire chapter; ESV understands "Genesis 1" form.
  const q = book + ' ' + chapter;
  const esvUrl = 'https://api.esv.org/v3/passage/text/?q=' + encodeURIComponent(q)
    + '&include-headings=false&include-footnotes=false&include-verse-numbers=true'
    + '&include-short-copyright=false&include-passage-references=false'
    + '&indent-paragraphs=0&indent-poetry=false&include-chapter-numbers=false'
    + '&indent-psalm-doxology=false&line-length=0';
  // Retry on 429 with exponential backoff.  ESV is conservative on burst rate.
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const resp = await fetch(esvUrl, { headers: { Authorization: 'Token ' + env.ESV_TOKEN } });
    if (resp.ok) {
      const data = await resp.json();
      if (!data.passages || !data.passages[0]) throw new Error(`No passage for ${q}`);
      return parseEsvPassageText(data.passages[0]);
    }
    if (resp.status === 429) {
      const wait = 500 * Math.pow(2, attempt); // 500ms, 1s, 2s, 4s, 8s
      await new Promise(r => setTimeout(r, wait));
      lastErr = `ESV 429 for ${q}`;
      continue;
    }
    throw new Error(`ESV ${resp.status} for ${q}`);
  }
  throw new Error(lastErr || `ESV retries exhausted for ${q}`);
}

function enChapterToTuples(bookIdx, chapter, verses) {
  const out = [];
  for (const v of verses) {
    out.push([bookIdx, chapter, v.verse, v.text]);
  }
  return out;
}

async function handleBuildEnIndex(env, url, cors) {
  const secret = url.searchParams.get('secret');
  if (!env.ADMIN_SECRET || secret !== env.ADMIN_SECRET) {
    return new Response(JSON.stringify({error:'forbidden'}), {status:403, headers:{...cors,'Content-Type':'application/json'}});
  }
  const from = Math.max(0, parseInt(url.searchParams.get('from') || '0'));
  const size = Math.min(400, Math.max(1, parseInt(url.searchParams.get('size') || '250')));
  const refetch = url.searchParams.get('refetch') === '1';
  const concurrency = 2; // be polite to ESV API — they rate-limit aggressively on burst

  const tuples = [];
  let fetched = 0, fromCache = 0, errored = 0;
  const errors = [];

  const ordinals = [];
  for (let o = from; o < Math.min(from + size, TOTAL_CHAPTERS); o++) ordinals.push(o);

  for (let i = 0; i < ordinals.length; i += concurrency) {
    const batch = ordinals.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(async (ord) => {
      const [bookIdx, chapter] = ordinalToBookChapter(ord);
      const key = `esv_${bookIdx + 1}_${chapter}`;
      try {
        let verses = null;
        if (!refetch && env.COMMENTARY_KV) {
          const cached = await env.COMMENTARY_KV.get(key);
          if (cached) {
            verses = JSON.parse(cached);
            fromCache++;
          }
        }
        if (!verses) {
          verses = await fetchChapterFromEsv(bookIdx + 1, chapter, env);
          if (env.COMMENTARY_KV) await env.COMMENTARY_KV.put(key, JSON.stringify(verses));
          fetched++;
        }
        return enChapterToTuples(bookIdx, chapter, verses);
      } catch (e) {
        errored++;
        errors.push({ord, bookIdx, chapter, msg: String(e.message || e)});
        return [];
      }
    }));
    for (const r of results) for (const t of r) tuples.push(t);
  }

  const chunkKey = `esv_search_chunk_${String(from).padStart(5, '0')}`;
  if (env.COMMENTARY_KV) {
    await env.COMMENTARY_KV.put(chunkKey, JSON.stringify(tuples));
  }

  const nextFrom = from + size;
  const done = nextFrom >= TOTAL_CHAPTERS;
  return new Response(JSON.stringify({
    ok: true,
    chunkKey,
    processedOrdinals: ordinals.length,
    verseCount: tuples.length,
    fetchedFromEsv: fetched,
    fromKvCache: fromCache,
    errored,
    errors: errors.slice(0, 10),
    nextFrom: done ? null : nextFrom,
    nextUrl: done ? null : `/admin/build-en-index?secret=...&from=${nextFrom}&size=${size}`,
    totalChapters: TOTAL_CHAPTERS,
    done
  }, null, 2), {headers:{...cors,'Content-Type':'application/json'}});
}

async function handleMergeEnIndex(env, url, cors) {
  const secret = url.searchParams.get('secret');
  if (!env.ADMIN_SECRET || secret !== env.ADMIN_SECRET) {
    return new Response(JSON.stringify({error:'forbidden'}), {status:403, headers:{...cors,'Content-Type':'application/json'}});
  }
  if (!env.COMMENTARY_KV) return new Response(JSON.stringify({error:'no_kv'}), {status:500, headers:{...cors,'Content-Type':'application/json'}});

  const chunks = [];
  let cursor = undefined;
  let safety = 0;
  while (true) {
    const list = await env.COMMENTARY_KV.list({ prefix: 'esv_search_chunk_', cursor, limit: 1000 });
    for (const k of list.keys) chunks.push(k.name);
    if (list.list_complete || !list.cursor) break;
    cursor = list.cursor;
    if (++safety > 50) break;
  }
  chunks.sort();

  if (chunks.length === 0) {
    return new Response(JSON.stringify({error:'no_chunks', hint:'run /admin/build-en-index first'}), {status:400, headers:{...cors,'Content-Type':'application/json'}});
  }

  const merged = [];
  for (const key of chunks) {
    const raw = await env.COMMENTARY_KV.get(key);
    if (!raw) continue;
    try {
      const arr = JSON.parse(raw);
      for (const t of arr) merged.push(t);
    } catch (e) { /* skip */ }
  }

  const payload = JSON.stringify(merged);
  await env.COMMENTARY_KV.put('esv_search_index', payload);

  EN_SEARCH_INDEX = null;
  EN_SEARCH_INDEX_PROMISE = null;

  return new Response(JSON.stringify({
    ok: true,
    chunksRead: chunks.length,
    totalVerses: merged.length,
    indexBytes: payload.length,
    storedAt: 'esv_search_index'
  }, null, 2), {headers:{...cors,'Content-Type':'application/json'}});
}

// ---- /search/ko — fast in-memory search over the pre-built index ----
async function handleKoreanSearch(env, url, cors) {
  const q = url.searchParams.get('q');
  const offset = parseInt(url.searchParams.get('offset') || '0');
  const pageSize = 20;
  if (!q || q.trim().length < 1) {
    return new Response(JSON.stringify({results:[], hasMore:false}), {headers:{...cors,'Content-Type':'application/json'}});
  }

  // Which Korean version's index to search (NKRV default; KLB never reaches
  // here — the app routes it to /search/apibible).
  const cfg = koIndexConfig(url.searchParams.get('v'));
  const index = await getKoSearchIndexByPrefix(env, cfg.prefix);
  if (!index) {
    // Fall back to a clear error rather than silently scanning KV.  This makes index-build status visible.
    return new Response(JSON.stringify({
      results: [],
      hasMore: false,
      error: 'index_not_built',
      version: cfg.prefix,
      hint: `Run /admin/build-index?v=${cfg.prefix.toUpperCase()} then /admin/merge-index?v=${cfg.prefix.toUpperCase()}`
    }), {status:503, headers:{...cors,'Content-Type':'application/json'}});
  }

  const term = q.trim();
  const matches = [];
  // Linear filter.  ~31k verses, includes() is fast.
  for (let i = 0; i < index.length; i++) {
    const t = index[i][3];
    if (t.indexOf(term) !== -1) matches.push(index[i]);
  }

  const slice = matches.slice(offset, offset + pageSize);
  const results = slice.map(([b, c, v, text]) => ({
    book: b,
    chapter: c,
    verse: v,
    text,
    ref: BOOK_NAMES_KO[b] + ' ' + c + ':' + v
  }));
  const hasMore = (offset + pageSize) < matches.length;
  const bookSet = new Set();
  for (const m of matches) bookSet.add(m[0]);
  return new Response(JSON.stringify({
    results,
    hasMore,
    nextOffset: hasMore ? (offset + pageSize) : -1,
    total: matches.length,
    bookCount: bookSet.size
  }), {headers:{...cors,'Content-Type':'application/json'}});
}

// ---- VOTD photo selection (module scope so both the live /votd route and
// the noon staging cron use the SAME topics, filters, and thresholds).  These
// used to live inside the /votd handler; they were hoisted when photo staging
// was added, so a previewed photo is chosen by exactly the rules that would
// have chosen it at midnight.  Duplicating them would let preview and live
// drift apart, which is the one thing a preview must not do.
//
// Topics lean toward bright, clear-sky scenes (sunrise / golden hour / blue
// sky / sunny) — the first line of defense against a gloomy overcast shot,
// backed up by the isGloomy re-roll below.  The SUBJECT being agricultural is
// fine and wanted; what is not wanted is human construction in frame, which
// VOTD_MANMADE below rejects.  That split matters: 'wheat field' as a topic
// with 'barn' as a reject gives open grain under sky, where rejecting 'field'
// outright would throw away the whole category.
//
// BALANCE.  This list used to be six field queries out of twelve, plus a
// seventh ('pasture rolling hills') that returns fields anyway, against ONE
// sky topic and none at all about the sun — which is why the board came back
// roughly nine-tenths fields.  Weighted now toward sky, sun and hills, with
// fields and water kept as the minority they should be:
//
//     sun 3 · hills 4 · pasture 4 · flock 3 · plains 2 · flowers 3 · grain 1
//
// NAME A SCENE, NOT A TEXTURE.  Every topic's head noun is a place with depth
// and a foreground — landscape, valley, countryside, hillside, vista, pasture,
// meadow, plains.  Light belongs in the modifiers.  An earlier version led
// with the sky itself ('cloudscape bright blue sky daytime') and Unsplash
// answered it literally: photographs OF sky, which are a texture and make a
// poor backdrop for a verse.  If you add a topic, check it names somewhere a
// person could stand.
//
// Note the list IS the distribution — a topic is drawn at random per fetch —
// so changing the mix here is how you change what the picker shows.
//
// Two words to avoid when editing: anything in VOTD_GLOOMY_KEYWORDS ('dusk',
// 'twilight', 'dramatic sky', 'grey'...) will have the returned photo rejected
// by its own tags, so a 'dusk over the hills' topic quietly yields nothing.
const VOTD_TOPICS = [
  // sun
  'scenic landscape golden hour sunlight',
  'sunrise over green valley landscape',
  'sunbeams over rolling countryside',
  // hills
  'rolling green hills scenic landscape',
  'mountain valley landscape clear day',
  'green hillside overlooking valley',
  'scenic highland vista sunlight',
  // pasture
  'green pasture rolling countryside scenic',
  'lush pasture valley sunlight landscape',
  'open pastureland scenic horizon',
  'spring pasture green fields landscape',
  // flock
  'sheep grazing green pasture landscape',
  'flock of sheep rolling hills scenic',
  'lambs in green meadow spring landscape',
  // plains
  'vast open plains scenic horizon',
  'wide grassland plain landscape sunny',
  // flowers
  'wildflower meadow scenic landscape',
  'flower field rolling hills sunlight',
  'poppy meadow landscape spring',
  // grain
  'golden wheat field landscape sunrise'
];

/** `k` DISTINCT topics.  A refill that draws every photo from one topic comes
 *  back as thirty variations of the same scene, which is what a single random
 *  pick per call produced.  Fewer photos from more topics costs exactly the
 *  same number of requests. */
function votdPickTopics(k) {
  const pool = [...VOTD_TOPICS];
  const out = [];
  while (out.length < k && pool.length) {
    out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  return out;
}

// Anything in the photo's description/tags that hints at a person being in
// frame.  Unsplash has no native no-people filter, so we re-roll if any of
// these show up in the metadata of the returned photo.
const VOTD_PEOPLE_KEYWORDS = [
  'person','people','human','man','woman','boy','girl','child','kid',
  'baby','family','group','crowd','farmer','shepherd','hiker','rider',
  'face','portrait','silhouette','model','tourist','traveler'
];
// Anything hinting at a grey / overcast / stormy sky — we re-roll to keep
// VOTD backgrounds bright and hopeful.  Deliberately omits 'mist'/'clouds'
// (a misty sunrise or puffy white clouds are fine); targets the genuinely
// dreary signals.
const VOTD_GLOOMY_KEYWORDS = [
  'overcast','storm','stormy','gloomy','moody','bleak','ominous',
  'dreary','grey','gray','fog','foggy','rain','rainy','drizzle',
  'thunder','dusk','twilight','dark clouds','dramatic sky','night'
];
const votdMetaText = (pd) => [
  pd.description || '',
  pd.alt_description || '',
  ...(pd.tags || []).map(t => (t && t.title) || ''),
  ...(pd.tags_preview || []).map(t => (t && t.title) || '')
].join(' ').toLowerCase();
const votdHasPeople = (pd) =>
  VOTD_PEOPLE_KEYWORDS.some(k => new RegExp(`\\b${k}\\b`).test(votdMetaText(pd)));
const votdIsGloomy = (pd) =>
  VOTD_GLOOMY_KEYWORDS.some(k => new RegExp(`\\b${k}\\b`).test(votdMetaText(pd)));

// Human construction in frame.  Deliberately NOT 'field' / 'pasture' /
// 'harvest' / 'farm land as a subject' — an open grain field under sky is
// exactly what we want; a barn, a fence line, or a village in the shot is not.
// Listing 'farm' itself would reject most harvest photos on their tags alone,
// so the structures are named instead of the land use.
const VOTD_MANMADE_KEYWORDS = [
  'barn','house','houses','building','buildings','village','town','city','urban',
  'street','road','highway','fence','wall','gate','tractor','windmill','mill',
  'church','tower','bridge','boat','ship','dock','pier','lighthouse','ruins',
  'castle','architecture','roof','cabin','hut','shed','car','vehicle','train',
  'pylon','powerline','rooftop','skyline','bench','fencepost'
];
const votdIsManmade = (pd) =>
  VOTD_MANMADE_KEYWORDS.some(k => new RegExp(`\\b${k}\\b`).test(votdMetaText(pd)));

// Unsplash+ — the paid tier, and unusable here.  `photos/random` mixes these
// in with the free library, and the file served for one is a PREVIEW with
// "Unsplash+" tiled across the whole frame.  Nothing in the keyword or
// brightness filters looks at licensing, so one went live on 2026-08-06 with
// the watermark sitting over the verse.
//
// Tested on the URL rather than on any `plus` / `premium` flag, because the
// URL is what decides the actual bytes: plus.unsplash.com serves the
// watermarked preview, images.unsplash.com does not.  The flags are checked
// too, but only as a second line — they are undocumented on this endpoint and
// may simply be absent.
const votdIsPlusUrl = (url) => {
  const s = String(url || '');
  return /(^|\/\/)plus\.unsplash\.com/.test(s) || /premium_photo-/.test(s);
};

/** Raw Unsplash payload, as it arrives from the API. */
const votdIsPlus = (pd) =>
  votdIsPlusUrl(pd && pd.urls && pd.urls.regular) ||
  votdIsPlusUrl(pd && pd.urls && pd.urls.raw) ||
  (pd && (pd.plus === true || pd.premium === true)) ||
  ((pd && pd.user && pd.user.username) || '') === 'plus';

/** A stored record — a queue entry, a used-log entry, a recycle candidate.
 *  These keep only the normalized fields, so the credit is checked as well:
 *  every Unsplash+ photo is attributed to the "Unsplash+ Community" account. */
const votdRecordIsPlus = (rec) =>
  votdIsPlusUrl(rec && rec.url) ||
  /unsplash\+/i.test((rec && rec.credit) || '') ||
  /\/@plus\b/.test((rec && rec.creditLink) || '');

// A photo's stable identity across the queue, the used log, and the reject
// list.  The Unsplash image slug is present in every stored `url`, including
// for photos rolled at random where the short id was never captured.
const votdSlug = (url) => (String(url || '').match(/photo-[\w-]+/) || [null])[0];

/** The queue, with any Unsplash+ entry queued before the filter existed
 *  dropped.  Shared by the board and by staging so the two cannot disagree
 *  about what is actually servable. */
async function votdReadQueue(env) {
  const raw = await votdReadJson(env, 'votd_queue', []);
  return Array.isArray(raw) ? raw.filter((q) => q && !votdRecordIsPlus(q)) : [];
}

/** Read a JSON KV key, defaulting rather than throwing on absent/corrupt. */
async function votdReadJson(env, key, fallback) {
  if (!env.COMMENTARY_KV) return fallback;
  const raw = await env.COMMENTARY_KV.get(key);
  if (raw === null) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}
/** Queue / used / rejected are long-lived — written without a TTL. */
async function votdWriteJson(env, key, value) {
  if (!env.COMMENTARY_KV) return;
  await env.COMMENTARY_KV.put(key, JSON.stringify(value));
}

// Brightness gate — the keyword filters miss photos that are simply dark
// (deep-shadow forest, dim sunset) without any 'gloomy' tag.  Unsplash
// returns a dominant color per photo; reject when its perceived luminance
// (0..255) is low.  Threshold 108 keeps bright sky/field/golden-hour tones
// and drops genuinely dark frames.
const VOTD_DARK_THRESHOLD = 108;
const votdHexLuminance = (hex) => {
  if (!hex || typeof hex !== 'string') return 255; // unknown -> don't reject
  const m = hex.replace('#', '');
  if (m.length < 6) return 255;
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  if ([r, g, b].some(Number.isNaN)) return 255;
  return 0.299 * r + 0.587 * g + 0.114 * b;
};
const votdTooDark = (pd) => votdHexLuminance(pd.color) < VOTD_DARK_THRESHOLD;

/**
 * Fetch up to `count` random photos in ONE Unsplash call.
 *
 * Was one photo per request, which made the picker board cost up to 80 calls to
 * fill ten slots — against a demo key's 50/hour ceiling, so a SINGLE board
 * render could exhaust the whole quota and every later fetch 403'd.  Rejecting
 * a few photos in a row guaranteed it, and because a failure returned null
 * indistinguishably from "nothing matched", the board just came back short with
 * no explanation.  `count` (max 30) collapses that to one or two calls.
 *
 * Returns the reason on failure so callers can say WHY rather than showing an
 * unexplained short list.
 */
const votdFetchPhotos = async (count, env, topic) => {
  const key = env && env.VOTD_UNSPLASH_KEY;
  // Was hardcoded here — in a public repo, so anyone could spend the quota.
  // Set with: wrangler secret put VOTD_UNSPLASH_KEY
  if (!key) return { photos: [], error: 'no-key' };
  // Callers filling several rounds pass a DIFFERENT topic each time, so one
  // draw cannot make the whole bench a single scene.  Unnamed = random, which
  // is right for the one-off re-roll in votdRollPhoto.
  const t = topic || VOTD_TOPICS[Math.floor(Math.random() * VOTD_TOPICS.length)];
  const n = Math.max(1, Math.min(30, count | 0));
  let r;
  try {
    r = await fetch(
      `https://api.unsplash.com/photos/random?query=${encodeURIComponent(t)}` +
      `&orientation=landscape&content_filter=high&count=${n}&client_id=${key}`
    );
  } catch {
    return { photos: [], error: 'network' };
  }
  if (r.status === 403) {
    // Unsplash spends 403 for BOTH an exhausted quota and a bad key; the
    // remaining-count header is what tells them apart.
    const remaining = r.headers.get('x-ratelimit-remaining');
    const limit = r.headers.get('x-ratelimit-limit');
    return {
      photos: [],
      error: remaining === '0' ? 'rate-limit' : 'forbidden',
      limit: limit ? Number(limit) : null,
    };
  }
  if (!r.ok) return { photos: [], error: `http-${r.status}` };
  let j;
  try {
    j = await r.json();
  } catch {
    return { photos: [], error: 'bad-json' };
  }
  // `count` makes the endpoint return an array; without it, a bare object.
  return { photos: Array.isArray(j) ? j : [j], error: null };
};

const votdFetchOnePhoto = async (env) => (await votdFetchPhotos(1, env)).photos[0] || null;

/**
 * Roll one acceptable VOTD photo, or null for the solid-color card.
 * `first` lets the live route hand in the photo it already fetched in
 * parallel with the verse, so a cold day still costs one round trip.
 * Re-rolls on people, gloomy tags, OR a too-dark dominant color; up to 6
 * tries, since VOTD fires once a day and the calls are cheap.  A people-shot
 * or a still-too-dark frame is never acceptable — drop to the color card.  A
 * gloomy-tagged-but-bright shot that survived the retries is kept (better
 * than no photo).
 */
async function votdRollPhoto(first, seen, env) {
  // `seen` is a Set of slugs already used or explicitly rejected — a repeat is
  // re-rolled like any other miss, so the daily photo keeps moving even once
  // the good-topic pool starts repeating itself.
  const isRepeat = (pd) => !!(seen && seen.has(votdSlug(pd?.urls?.regular)));
  const unusable = (pd) =>
    votdIsPlus(pd) || votdHasPeople(pd) || votdIsGloomy(pd) || votdTooDark(pd) ||
    votdIsManmade(pd) || isRepeat(pd);
  let pd = first ?? await votdFetchOnePhoto(env);
  let attempts = 1;
  while (pd && unusable(pd) && attempts < 8) {
    pd = await votdFetchOnePhoto(env);
    attempts++;
  }
  // Unsplash+, people, darkness, construction and repeats are never
  // acceptable; a gloomy-TAGGED but bright frame that survived the retries is
  // still kept, as before.
  if (pd && (votdIsPlus(pd) || votdHasPeople(pd) || votdTooDark(pd) || votdIsManmade(pd) || isRepeat(pd))) pd = null;
  if (!pd) return null;
  return votdNormalize(pd);
}

/** Unsplash payload -> the record shape stored in KV and rendered by clients. */
function votdNormalize(pd) {
  const url = pd.urls?.regular || null;
  return {
    url,
    color: pd.color || '#555555',
    credit: pd.user?.name || null,
    creditLink: pd.user?.links?.html || null,
    slug: votdSlug(url),
    id: pd.id || null,
    alt: pd.alt_description || '',
  };
}

/** ET calendar date, `YYYY-MM-DD`, `offsetDays` from now. */
function votdDateET(offsetDays = 0) {
  return new Date(Date.now() + offsetDays * 86400000)
    .toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/**
 * Seconds from now until the END of the given ET date — the TTL a photo key
 * for that date needs.  Staging tomorrow at noon means a ~36h TTL, which is
 * why this cannot reuse the live route's secondsUntilMidnight.
 */
function votdSecondsUntilEndOf(dateET) {
  const now = new Date();
  const nextDay = new Date(`${dateET}T00:00:00Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const endLocal = new Date(nextDay.toISOString().slice(0, 10) + 'T00:00:00');
  const nowET = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const offsetMs = now - nowET;
  const endUTC = new Date(endLocal.getTime() + offsetMs);
  return Math.max(60, Math.floor((endUTC - now) / 1000));
}

/**
 * How long a `votdverse_`/`votdphoto2_` key for an ET date must live.
 *
 * These used to expire at ET midnight, which was right when every reader was
 * served the CURRENT ET date.  Readers now ask for the ET date one day behind
 * their own local date, so a single date is in use from UTC+14's local midnight
 * (6h after that ET date began) until UTC-12 finishes its local day — a spread
 * of roughly 50 hours.  Two days past the end of the ET date covers it with
 * room to spare, and a few extra small JSON values in KV costs nothing.
 */
function votdKeyTtl(dateET) {
  return votdSecondsUntilEndOf(dateET) + 2 * 86400;
}

/**
 * Write the verse for an ET date, if it does not already have one.
 *
 * WHY THIS EXISTS
 *
 * A date's verse was only ever stored as a SIDE EFFECT of a reader missing.
 * Readers ask for the ET date one day behind their own local date, which is a
 * dated request — and dated requests are deliberately read-only, because
 * upstream serves only its current verse and letting a dated request populate
 * from it would pin the wrong verse under a write-once key.  So a miss falls
 * back to the current ET date and the write-once path stores the verse THERE.
 *
 * That makes population alternate.  On a day whose key is missing, the reader
 * misses, falls back, and populates today.  The next day their request hits
 * that key and is served — no miss, so nothing populates that day, and the
 * day after misses again.  Every miss shows the reader the current verse
 * rather than the one they asked for, so the verse appears to stop changing
 * for a day at a time.
 *
 * Nothing wrote a date's key on purpose.  This does, from the cron that
 * already runs, so every date has its verse before anyone asks for it and no
 * reader ever lands on the fallback.
 *
 * TODAY's date, not tomorrow's, unlike the photo staged beside it.  A photo
 * can be chosen a day ahead because we choose it;  the verse cannot, because
 * upstream only ever serves its current one — which is the same reason a
 * dated request may not populate.  Writing today's key is exactly what the
 * write-once path does when a reader happens to trigger it;  this only makes
 * it happen reliably.
 *
 * Never overwrites.  The key stays write-once: if a reader already populated
 * today, that value stands, and this returns without touching upstream.
 */
async function votdEnsureVerse(dateET, env) {
  if (!env.COMMENTARY_KV) return { ok: false, reason: 'no_kv' };
  const verseKey = `votdverse_${dateET}`;
  const existing = await env.COMMENTARY_KV.get(verseKey);
  if (existing) return { ok: true, already: true };

  let data = null;
  try {
    const res = await fetch('https://labs.bible.org/api/?passage=votd&type=json', {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    });
    data = await res.json();
  } catch (e) {
    return { ok: false, reason: 'fetch_failed', detail: String(e && e.message || e) };
  }
  // An empty or malformed answer is not written.  A bad value under a
  // write-once key outlives the request that made it;  leaving the key absent
  // means the next reader falls back, which is the behaviour this is
  // replacing and is recoverable.
  if (!Array.isArray(data) || data.length === 0) return { ok: false, reason: 'empty_upstream' };
  await env.COMMENTARY_KV.put(verseKey, JSON.stringify(data), { expirationTtl: votdKeyTtl(dateET) });
  return { ok: true, written: true, verses: data.length };
}

/**
 * Public origin used in emailed links.  A cron has no inbound request to read
 * the host from, so it cannot be derived — set VOTD_PUBLIC_ORIGIN if the
 * worker ever moves behind a custom domain.
 */
const VOTD_ORIGIN_FALLBACK = 'https://krengbible.pauljkim22.workers.dev';

/**
 * One-tap re-roll links go in an email, so the admin secret cannot travel in
 * the URL — the whole reason /admin/* prefers the X-Admin-Secret header is to
 * keep it out of Cloudflare's URL logs, and mailing it would undo that twice
 * over (logs plus the reader's inbox forever).
 *
 * Instead the link carries an HMAC of the DATE it is for, keyed by the same
 * secret.  That makes it scoped and self-expiring: a token only ever unlocks
 * the one day it was minted for, and that day stops being re-rollable once it
 * has finished rolling out to every timezone.  A leaked link is worth at most
 * one day's photo, and the secret itself is never derivable from it.
 */
async function votdRerollToken(dateET, env) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(env.ADMIN_SECRET || ''),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`votd-reroll:${dateET}`));
  // 128 bits is far past what a single-day, single-purpose token needs; the
  // rest is dropped only to keep the link short enough to tap comfortably.
  return [...new Uint8Array(sig)].slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Length-independent compare, so a wrong token cannot be narrowed by timing. */
function votdSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Email the staged photo with a one-tap re-roll link.
 *
 * Sender, recipient, and API key are all env-provided: this repo is public,
 * so an address hardcoded here would be scraped.  Missing any of them makes
 * this a no-op rather than an error — staging is the job that matters, and it
 * must not fail because mail is unconfigured.
 */
/** Roll `n` distinct, acceptable candidates for the daily chooser email. */
async function votdRollCandidates(n, seen, env) {
  const picks = [];
  const taken = new Set(seen);
  // Batched: 30 per call rather than one, so filling this costs a couple of
  // requests instead of dozens.  Bounded rounds so a quota failure returns
  // promptly rather than retrying into a wall.
  const topics = votdPickTopics(3);
  for (let round = 0; round < topics.length && picks.length < n; round++) {
    const { photos, error } = await votdFetchPhotos(15, env, topics[round]);
    if (error) break;
    for (const pd of photos) {
      if (picks.length >= n) break;
      if (!pd || !pd.urls) continue;
      if (votdIsPlus(pd) || votdHasPeople(pd) || votdIsGloomy(pd) || votdTooDark(pd) || votdIsManmade(pd)) continue;
      const slug = votdSlug(pd.urls.regular);
      if (!slug || taken.has(slug)) continue;
      taken.add(slug);
      picks.push(votdNormalize(pd));
    }
  }
  // Parked so the emailed links can resolve a slug back to a full record —
  // the email itself carries only slugs, never whole photo objects in a URL.
  //
  // MERGED, not overwritten.  This used to replace the key outright, which
  // threw away the picker's bench (see VOTD_BENCH) every time the daily email
  // ran — the board would be deep one minute and back to ten the next, for no
  // reason the user could see.  Keeping both means the emailed slugs still
  // resolve and the bench survives.
  const parked = await votdReadJson(env, 'votd_candidates', []);
  const merged = [...picks];
  const known = new Set(picks.map((p) => p.slug));
  for (const c of Array.isArray(parked) ? parked : []) {
    if (merged.length >= VOTD_BENCH) break;
    if (!c || !c.slug || known.has(c.slug)) continue;
    known.add(c.slug);
    merged.push(c);
  }
  await votdWriteJson(env, 'votd_candidates', merged);
  return picks;
}

/**
 * The picker board: exactly `n` live candidates, plus the queue.
 *
 * Candidates persist in KV rather than being re-rolled per request, so the
 * grid is stable while you look at it — only the photo you act on changes.
 * Anything that has since been queued, used, or blocked is dropped and
 * backfilled, which is what keeps ten in view after an X.
 */
/**
 * The bench behind the board, and when to top it up.
 *
 * The board used to hold exactly the ten it displayed, so EVERY pick dropped
 * it to nine and the next render went straight back to Unsplash.  The demo key
 * allows 50 requests an hour and a render costs up to three, so a real picking
 * session — which is a dozen taps in a couple of minutes — exhausted the quota
 * within about sixteen actions.  After that every fetch 403s, the backfill
 * breaks out, and the board simply shrinks with each pick: "as I choose photos
 * it's not getting replaced, showing less and less."
 *
 * Keeping a deeper bench than we display fixes it at the cause.  Top up to
 * BENCH, then serve picks off the bench until it falls past REFILL_AT — about
 * eighteen picks with no Unsplash call at all, instead of one call per pick.
 * The refill itself is no more expensive than before: still at most three
 * requests, just far less often.
 */
const VOTD_BENCH = 30;
const VOTD_REFILL_AT = 12;

async function votdBoard(env, n = 10) {
  const used = await votdReadJson(env, 'votd_used', {});
  const rejected = await votdReadJson(env, 'votd_rejected', {});
  const queue = await votdReadQueue(env);
  const seen = new Set([
    ...Object.keys(used || {}), ...Object.keys(rejected || {}),
    ...(queue || []).map((q) => q.slug),
  ]);

  // `votd_candidates` is persisted, so it can still hold Unsplash+ photos
  // parked before this filter existed — screen them here too, or the board
  // goes on offering a watermarked photo it can no longer stage.
  let cands = (await votdReadJson(env, 'votd_candidates', []) || [])
    .filter((c) => c && c.slug && !seen.has(c.slug) && !votdRecordIsPlus(c));

  const have = new Set(cands.map((c) => c.slug));
  // Batched backfill.  The old loop made up to n*8 = 80 single-photo calls to
  // refill ten slots, which on a 50/hour demo key meant one board render could
  // exhaust the entire quota — after which every fetch 403'd and the board
  // silently came back short.  Three rounds of 30 is at most three calls.
  let fetchError = null;
  // Top up only when the BENCH runs low, not every time the board is one
  // short — see VOTD_REFILL_AT.  Refilling per pick is what burned the quota.
  if (cands.length < VOTD_REFILL_AT) {
    // Three rounds of 15 across three DIFFERENT topics rather than one round
    // of 30 from one.  Same request count, but the bench ends up mixed instead
    // of thirty near-identical frames from whichever topic happened to win.
    const topics = votdPickTopics(3);
    for (let round = 0; round < topics.length && cands.length < VOTD_BENCH; round++) {
      const { photos, error } = await votdFetchPhotos(15, env, topics[round]);
      if (error) { fetchError = error; break; }
      for (const pd of photos) {
        if (cands.length >= VOTD_BENCH) break;
        if (!pd || !pd.urls) continue;
        if (votdIsPlus(pd) || votdHasPeople(pd) || votdIsGloomy(pd) || votdTooDark(pd) || votdIsManmade(pd)) continue;
        const slug = votdSlug(pd.urls.regular);
        if (!slug || seen.has(slug) || have.has(slug)) continue;
        have.add(slug);
        cands.push(votdNormalize(pd));
      }
    }
  }
  await votdWriteJson(env, 'votd_candidates', cands);
  return {
    // Show n, keep the rest on the bench for the next pick to draw from.
    candidates: cands.slice(0, n),
    /** Bench depth, so the picker can say when a refill is due or failing. */
    bench: cands.length,
    queue: queue || [],
    usedCount: Object.keys(used || {}).length,
    rejectedCount: Object.keys(rejected || {}).length,
    // Why the board is short, when it is.  Without this a quota failure looks
    // identical to "nothing matched the filters", which is exactly the
    // confusion that made a half-empty board impossible to diagnose.
    short: cands.length < n,
    error: fetchError,
  };
}

/** HMAC for a one-tap email action.  Scoped to the action AND its value, so a
 *  token minted to queue one photo cannot be replayed to reject another. */
async function votdActionToken(action, value, env) {
  if (!env.ADMIN_SECRET) return '';
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(env.ADMIN_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`votd-${action}:${value}`));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

/** The noon chooser email: what is staged for tomorrow, ten candidates to
 *  queue or block, and the current queue so the backlog is visible. */
async function votdSendChooserEmail(dateET, staged, env) {
  if (!env.RESEND_KEY || !env.VOTD_EMAIL_TO || !env.VOTD_EMAIL_FROM) return;
  const origin = env.VOTD_PUBLIC_ORIGIN || VOTD_ORIGIN_FALLBACK;
  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
  const thumb = (u) => esc(String(u).replace(/&w=\d+/, '&w=400'));

  const usedMap = await votdReadJson(env, 'votd_used', {});
  const rejectedMap = await votdReadJson(env, 'votd_rejected', {});
  const queue = await votdReadQueue(env);
  const seen = new Set([...Object.keys(usedMap || {}), ...Object.keys(rejectedMap || {}), ...(queue || []).map(q => q.slug)]);
  const cands = await votdRollCandidates(10, seen, env);

  const rows = [];
  for (const c of cands) {
    const qTok = await votdActionToken('queue', c.slug, env);
    const rTok = await votdActionToken('reject', c.slug, env);
    rows.push(
      `<tr><td style="padding:0 0 18px">` +
      `<img src="${thumb(c.url)}" alt="" style="width:100%;max-width:520px;border-radius:10px;display:block">` +
      `<p style="font-size:12px;color:#666;margin:6px 0 8px">${esc(c.credit || 'Unknown')} · ${esc(c.color)} · ${esc(c.alt.slice(0, 60))}</p>` +
      `<a href="${origin}/votd/queue-add?slug=${encodeURIComponent(c.slug)}&t=${qTok}" ` +
      `style="display:inline-block;background:#111;color:#fff;padding:8px 14px;border-radius:7px;` +
      `text-decoration:none;font-size:13px;margin-right:8px">Add to queue</a>` +
      `<a href="${origin}/votd/reject?slug=${encodeURIComponent(c.slug)}&t=${rTok}" ` +
      `style="display:inline-block;background:#eee;color:#900;padding:8px 14px;border-radius:7px;` +
      `text-decoration:none;font-size:13px">✕ Never show</a>` +
      `</td></tr>`
    );
  }

  const queueList = (queue || []).length
    ? `<ol style="font-size:13px;color:#333;padding-left:18px;margin:0 0 20px">` +
      queue.map(q => `<li style="margin-bottom:4px">${esc(q.credit || 'Unknown')} — ${esc((q.alt || '').slice(0, 55))}</li>`).join('') +
      `</ol>`
    : `<p style="font-size:13px;color:#900;margin:0 0 20px">Queue is empty — tomorrow will auto-roll.</p>`;

  const stagedBlock = staged
    ? `<img src="${thumb(staged.url)}" alt="" style="width:100%;max-width:520px;border-radius:10px;display:block">` +
      `<p style="font-size:12px;color:#666;margin:6px 0 20px">${esc(staged.credit || 'Unknown')} · ${esc(staged.color)}</p>`
    : `<p style="font-size:13px;color:#900;margin:0 0 20px">Nothing staged — midnight will roll on its own.</p>`;

  const html =
    `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:560px">` +
    `<p style="font-size:15px;margin:0 0 10px"><b>Tomorrow (${esc(dateET)})</b></p>` +
    stagedBlock +
    `<p style="font-size:15px;margin:0 0 8px"><b>Queued (${(queue || []).length})</b></p>` +
    queueList +
    `<p style="font-size:15px;margin:0 0 12px"><b>Add to the queue</b> — tap as many as you like; ` +
    `each is added on its own, so you can pick several.</p>` +
    `<table style="width:100%;border-collapse:collapse">${rows.join('')}</table>` +
    `</div>`;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.RESEND_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.VOTD_EMAIL_FROM, to: [env.VOTD_EMAIL_TO],
      subject: `VOTD — ${esc(dateET)} staged, ${(queue || []).length} queued, 10 to choose from`,
      html
    })
  }).catch(() => {});
}

/**
 * Nudge when the queue is nearly dry.  Sent AFTER staging, so the count is
 * what remains for the days beyond tomorrow — at 1 there is a day of slack,
 * at 0 the next day auto-rolls or recycles.
 *
 * Deliberately silent above the threshold: the whole reason the daily chooser
 * email was turned off is that a mail you receive every day stops being read.
 * This one only arrives when it needs an action.
 */
const VOTD_LOW_QUEUE = 2;
async function votdWarnLowQueue(dateET, staged, env, forceCount) {
  if (!env.RESEND_KEY || !env.VOTD_EMAIL_TO || !env.VOTD_EMAIL_FROM) return;
  // `forceCount` exists only so the admin test route can exercise this exact
  // function without touching the queue — an earlier version blanked
  // votd_queue and restored it afterwards, which would have destroyed the
  // real queue had the worker been killed mid-request.
  // Filtered, so "the queue is nearly dry" counts only what can actually be
  // staged — an unservable Unsplash+ entry must not mask a real shortage.
  const queue = await votdReadQueue(env);
  const n = typeof forceCount === 'number' ? forceCount : (queue || []).length;
  if (n >= VOTD_LOW_QUEUE) return;

  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
  const picker = 'https://krengbible.com/votd.html';
  const left = n === 0
    ? 'The queue is now <b>empty</b>. After tomorrow the photo will be auto-rolled, or recycled from ones already used.'
    : 'That leaves <b>1 photo</b> queued — enough for one more day.';
  const stagedLine = staged
    ? `<p style="font-size:14px;margin:0 0 6px">Tomorrow (${esc(dateET)}) is set: ` +
      `${esc(staged.credit || 'Unknown')}${staged.alt ? ' — ' + esc(staged.alt) : ''}.</p>`
    : `<p style="font-size:14px;margin:0 0 6px">Nothing could be staged for ${esc(dateET)}.</p>`;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.RESEND_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.VOTD_EMAIL_FROM, to: [env.VOTD_EMAIL_TO],
      subject: n === 0 ? 'VOTD queue is empty' : 'VOTD queue is down to 1',
      html:
        `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:520px">` +
        stagedLine +
        `<p style="font-size:14px;margin:0 0 18px">${left}</p>` +
        `<a href="${picker}" style="display:inline-block;background:#111;color:#fff;` +
        `padding:11px 18px;border-radius:8px;text-decoration:none;font-size:14px">Pick more photos</a>` +
        `</div>`
    })
  }).catch(() => {});   // mail failing must never take the cron down with it
}

async function votdSendPreviewEmail(dateET, photo, env) {
  if (!env.RESEND_KEY || !env.VOTD_EMAIL_TO || !env.VOTD_EMAIL_FROM) return;
  const origin = env.VOTD_PUBLIC_ORIGIN || VOTD_ORIGIN_FALLBACK;
  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));

  let html;
  if (photo) {
    const token = await votdRerollToken(dateET, env);
    const reroll = `${origin}/votd/reroll?date=${encodeURIComponent(dateET)}&t=${token}`;
    html =
      `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:560px">` +
      `<p style="font-size:15px;margin:0 0 12px">Verse-of-the-Day photo for <b>${esc(dateET)}</b></p>` +
      `<img src="${esc(photo.url)}" alt="" style="width:100%;border-radius:12px;display:block">` +
      `<p style="font-size:13px;color:#666;margin:10px 0 18px">` +
      `${esc(photo.credit || 'Unknown')} · ${esc(photo.color)}</p>` +
      `<p style="font-size:14px;margin:0 0 18px">This goes live at midnight ET on its own — ` +
      `no reply needed if you like it.</p>` +
      `<a href="${reroll}" style="display:inline-block;background:#111;color:#fff;` +
      `padding:11px 18px;border-radius:8px;text-decoration:none;font-size:14px">Get a different photo</a>` +
      `</div>`;
  } else {
    // Worth one line rather than silence: the fallback is graceful (midnight
    // rolls as it always did), but a preview system failing quietly every day
    // is how you find out months later.
    html =
      `<div style="font-family:-apple-system,Segoe UI,sans-serif">` +
      `<p>No photo could be staged for <b>${esc(dateET)}</b> — every roll came back ` +
      `unusable, or Unsplash was unreachable.</p>` +
      `<p>Nothing is broken: with nothing staged, /votd rolls at midnight the way it ` +
      `always has. There is just no preview today.</p></div>`;
  }

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.RESEND_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.VOTD_EMAIL_FROM,
      to: [env.VOTD_EMAIL_TO],
      subject: photo ? `VOTD photo for ${dateET}` : `VOTD photo for ${dateET} — none staged`,
      html
    })
  }).catch(() => {});  // mail failing must never take the cron down with it
}

/**
 * Choose and store the photo for an ET date.  Writing `votdphoto2_<date>`
 * ahead of time is the whole mechanism: when that date arrives, /votd sees a
 * non-null key, `needPhoto` is false, and it serves this photo instead of
 * rolling a fresh one.  No change to the read path was needed.
 */
/**
 * Record a photo as used, keeping enough of it to serve again.
 *
 * The log stores the WHOLE record — url, color, credit, creditLink, alt — not
 * just a slug and a date.  Without the url a past photo is only a tombstone
 * saying "don't suggest this", which is useless on the day the well runs dry.
 * `dates` accumulates every run rather than being overwritten, so recycling
 * can pick the least-recently-seen photo instead of an arbitrary one.
 */
async function votdMarkUsed(env, photo, dateET, note) {
  const used = await votdReadJson(env, 'votd_used', {});
  const slug = photo.slug || votdSlug(photo.url);
  if (!slug) return;
  const prev = used[slug] || {};
  const dates = Array.isArray(prev.dates) ? prev.dates.slice() : (prev.date ? [prev.date] : []);
  if (!dates.includes(dateET)) dates.push(dateET);
  used[slug] = {
    url: photo.url || prev.url || null,
    color: photo.color || prev.color || '#555555',
    credit: photo.credit ?? prev.credit ?? null,
    creditLink: photo.creditLink ?? prev.creditLink ?? null,
    alt: photo.alt || prev.alt || '',
    dates,
    date: dates[dates.length - 1],   // kept for anything reading the old shape
    note,
  };
  await votdWriteJson(env, 'votd_used', used);
}

/** The least-recently-run past photo, for when nothing fresh is available.
 *
 *  Unsplash+ entries are excluded rather than merely un-queued: the log is
 *  permanent, so a watermarked photo that ran once before the filter existed
 *  would otherwise come back here every time the queue ran dry. */
function votdOldestUsed(usedMap, rejectedMap) {
  const last = (e) => (Array.isArray(e.dates) && e.dates.length ? e.dates[e.dates.length - 1] : (e.date || ''));
  return Object.entries(usedMap || {})
    .filter(([slug, e]) => e && e.url && !(rejectedMap || {})[slug] && !votdRecordIsPlus(e))
    .sort((a, b) => (last(a[1]) < last(b[1]) ? -1 : last(a[1]) > last(b[1]) ? 1 : 0))
    .map(([slug, e]) => ({ ...e, slug }))[0] || null;
}

async function votdStagePhoto(dateET, env) {
  const write = async (photo) => {
    if (!env.COMMENTARY_KV) return;
    await env.COMMENTARY_KV.put(
      `votdphoto2_${dateET}`,
      JSON.stringify({ url: photo.url, color: photo.color, credit: photo.credit, creditLink: photo.creditLink }),
      { expirationTtl: votdKeyTtl(dateET) }
    );
  };

  // An approved photo waiting in the queue always wins over a fresh roll —
  // that is the whole point of queueing.  Taken from the head and removed, so
  // the same photo can never be staged twice even if staging runs again.
  const queue = await votdReadQueue(env);
  if (queue.length) {
    const next = queue.shift();
    if (env.COMMENTARY_KV) {
      await write(next);
      await votdWriteJson(env, 'votd_queue', queue);
      await votdMarkUsed(env, next, dateET, 'from queue');
    }
    return next;
  }

  const usedMap = await votdReadJson(env, 'votd_used', {});
  const rejectedMap = await votdReadJson(env, 'votd_rejected', {});
  const seen = new Set([...Object.keys(usedMap || {}), ...Object.keys(rejectedMap || {})]);
  const photo = await votdRollPhoto(null, seen, env);

  // Only stage a REAL photo.  votdRollPhoto returns null both when every roll
  // was a people-shot / too dark AND when Unsplash could not be reached at
  // all, and staging that null would pin a solid-colour card to the whole day
  // over what might be a momentary outage at noon.
  if (photo && env.COMMENTARY_KV) {
    await write(photo);
    await votdMarkUsed(env, photo, dateET, 'auto-rolled');
    return photo;
  }

  // Nothing fresh survived the filters.  Rather than fall through to a solid
  // colour card, re-run the photo that has gone the longest without being
  // seen — a repeat from months ago beats no photograph at all, and this is
  // the whole reason the log keeps full records.  Blocked photos stay blocked.
  const recycled = votdOldestUsed(usedMap, rejectedMap);
  if (recycled && env.COMMENTARY_KV) {
    await write(recycled);
    await votdMarkUsed(env, recycled, dateET, 'recycled');
    return recycled;
  }

  // Genuinely nothing to serve — leave the key absent so midnight falls back
  // to exactly the old behaviour: roll on first request.
  return null;
}

export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      // The VOTD picker page on krengbible.com sends the admin secret as a
      // request header rather than a query param, so it never lands in a URL
      // or an access log.  A custom header makes the request preflighted,
      // which fails without this.
      "Access-Control-Allow-Headers": "X-Admin-Secret, Content-Type",
      "Cache-Control": "public, max-age=86400"
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    const url = new URL(request.url);
    const path = url.pathname;

    // ---- ESV passthrough ----
    if (path.startsWith('/esv/')) {
      const q = url.searchParams.get('q');
      if (!q) return new Response(JSON.stringify({error:'missing q'}), {status:400, headers:{...cors,"Content-Type":"application/json"}});

      const respHeaders = {
        ...cors,
        "Content-Type": "application/json",
        "Cache-Control": "no-store, must-revalidate"
      };
      const wantsExtras = url.searchParams.get('extras') !== '0';
      const result = await fetchAndCacheEsv(q, wantsExtras, env);
      if (!result.ok) {
        return new Response(JSON.stringify({error: result.error, lastStatus: result.lastStatus, q}), {
          status: result.status || 503, headers: respHeaders
        });
      }
      return new Response(result.body, { headers: respHeaders });
    }

    // ---- /intro/{bookNum} ----
    if (path.startsWith('/intro/')) {
      const parts = path.match(/\/intro\/(\d+)/);
      if (!parts) return new Response(JSON.stringify({error:'bad path'}), {status:400, headers:{...cors,'Content-Type':'application/json'}});
      const bookNum = +parts[1];
      const cacheKey = `intro_${bookNum}`;

      const cached = env.COMMENTARY_KV ? await env.COMMENTARY_KV.get(cacheKey) : null;
      if (cached) return new Response(cached, {headers:{...cors,'Content-Type':'application/json'}});

      const bookName = BOOK_NAMES_EN[bookNum-1];
      const bookNameKo = BOOK_NAMES_KO[bookNum-1];

      const prompt = `You are a Bible scholar writing an accessible book introduction in the Reformed/evangelical tradition (Calvin, Sproul, Keller, Piper).

Write a book introduction for ${bookName} with these sections:

1. **Overview** (3-4 sentences): What this book is about, its central message, and why it matters.
2. **Historical Background** (3-4 sentences): Author, date, audience, historical setting, and how it fits in the canon.
3. **Key Themes** (provide exactly 4 themes, each with a title and 2-sentence explanation).
4. **Geographic Context** (2-3 sentences): Key locations in the book and their significance. Then provide an array of up to 5 map locations relevant to this book with name, lat, lng, and a one-sentence description.

Then provide Korean translations of all sections. Use 존댓말 (formal polite -습니다/-ㅂ니다 speech level) for all Korean text.

Respond in this exact JSON format with no markdown, no preamble:
{
  "overview_en": "...",
  "background_en": "...",
  "themes_en": [{"title": "...", "desc": "..."}, {"title": "...", "desc": "..."}, {"title": "...", "desc": "..."}, {"title": "...", "desc": "..."}],
  "geo_en": "...",
  "map_locations": [{"name": "...", "name_ko": "...", "lat": 0.0, "lng": 0.0, "desc": "...", "desc_ko": "..."}],
  "overview_ko": "...",
  "background_ko": "...",
  "themes_ko": [{"title": "...", "desc": "..."}, {"title": "...", "desc": "..."}, {"title": "...", "desc": "..."}, {"title": "...", "desc": "..."}],
  "geo_ko": "..."
}`;

      const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 4000,
          messages: [{role:'user', content: prompt}]
        })
      });

      if (!aiResp.ok) {
        const err = await aiResp.text();
        return new Response(JSON.stringify({error:'ai_failed', detail: err}), {status:500, headers:{...cors,'Content-Type':'application/json'}});
      }

      const aiData = await aiResp.json();
      const text = aiData.content?.[0]?.text || '{}';
      const cleanText = text.replace(/^```json\s*/,'').replace(/^```\s*/,'').replace(/```\s*$/,'').trim();

      let intro;
      try { intro = JSON.parse(cleanText); }
      catch(e) { return new Response(JSON.stringify({error:'parse_failed', raw: cleanText}), {status:500, headers:{...cors,'Content-Type':'application/json'}}); }

      intro.book_en = bookName;
      intro.book_ko = bookNameKo;

      const result = JSON.stringify(intro);
      if (env.COMMENTARY_KV) await env.COMMENTARY_KV.put(cacheKey, result);
      return new Response(result, {headers:{...cors,'Content-Type':'application/json'}});
    }

    // ---- /commentary/{bookNum}/{chapter} ----
    if (path.startsWith('/commentary/')) {
      const parts = path.match(/\/commentary\/(\d+)\/(\d+)/);
      if (!parts) return new Response(JSON.stringify({error:'bad path'}), {status:400, headers:{...cors,'Content-Type':'application/json'}});
      const bookNum = +parts[1], chapter = +parts[2];
      const cacheKey = `commentary_${bookNum}_${chapter}`;

      const cached = env.COMMENTARY_KV ? await env.COMMENTARY_KV.get(cacheKey) : null;
      if (cached) return new Response(cached, {headers:{...cors,'Content-Type':'application/json'}});

      const bookName = BOOK_NAMES_EN[bookNum-1];
      const bookNameKo = BOOK_NAMES_KO[bookNum-1];

      const prompt = `You are a Bible teacher writing accessible commentary in the tradition of Reformed/evangelical scholars like John Calvin, Matthew Henry, R.C. Sproul, Tim Keller, and John Piper. Your commentary emphasizes Scripture's authority, God's sovereignty, Christ-centered interpretation, and practical application.

Write commentary for ${bookName} chapter ${chapter} with these two sections:

1. **Summary** (2-3 sentences): What happens in this chapter in plain language anyone can understand. Start with the content itself — do NOT open by naming the book and chapter ("${bookName} ${chapter} describes…", "In ${bookName} ${chapter}, …"). The reader is already looking at the chapter heading.

2. **Reflection** (3-4 sentences): Key theological themes and one practical takeaway for a modern reader. Keep it warm, pastoral, and grounded in the text.

Then provide Korean translations of each section. Use 존댓말 (formal polite -습니다/-ㅂ니다 speech level) for all Korean text.

Respond in this exact JSON format:
{
  "summary_en": "...",
  "reflection_en": "...",
  "summary_ko": "...",
  "reflection_ko": "..."
}

Only output valid JSON, no markdown, no preamble.`;

      const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 2000,
          messages: [{role:'user', content: prompt}]
        })
      });

      if (!aiResp.ok) {
        const err = await aiResp.text();
        return new Response(JSON.stringify({error:'ai_failed', detail: err}), {status:500, headers:{...cors,'Content-Type':'application/json'}});
      }

      const aiData = await aiResp.json();
      const text = aiData.content?.[0]?.text || '{}';

      let commentary;
      const cleanText = text.replace(/^```json\s*/,'').replace(/^```\s*/,'').replace(/```\s*$/,'').trim();
      try { commentary = JSON.parse(cleanText); }
      catch(e) { return new Response(JSON.stringify({error:'parse_failed', raw: text}), {status:500, headers:{...cors,'Content-Type':'application/json'}}); }

      commentary.book_en = bookName;
      commentary.book_ko = bookNameKo;
      commentary.chapter = chapter;

      const result = JSON.stringify(commentary);
      if (env.COMMENTARY_KV) await env.COMMENTARY_KV.put(cacheKey, result);
      return new Response(result, {headers:{...cors,'Content-Type':'application/json'}});
    }

    // ---- /qt-reflection/{bookNum}/{chapter}/{verseStart}/{verseEnd} ----
    // Same idea as /commentary but scoped to a specific verse range —
    // /commentary is chapter-level, so the Daily QT feature (which
    // reads a few verses at a time, not a whole chapter per day) was
    // showing the same reflection on every QT day that landed in the
    // same chapter.  This generates and caches one reflection per
    // (book, chapter, verseStart, verseEnd) tuple instead.
    // ---- /qt-reflection/match?book=&chapter=&verseStart=&verseEnd= ----
    //
    // "Do we already have a reflection covering this?"  Ordered BEFORE the
    // tuple route below, which claims the whole /qt-reflection/ prefix and
    // would otherwise answer this with bad-path.
    //
    // Every reflection ever generated is kept, so this grows into an archive:
    // a passage typed today can be answered by one written for the reading
    // plan years ago, at no cost and with no new generation.  Nothing here
    // creates a reflection — a miss is a miss, and the caller falls back to
    // asking for one by exact range if it wants one.
    if (path === '/qt-reflection/match') {
      const bookNum = parseInt(url.searchParams.get('book') || '', 10);
      const chapter = parseInt(url.searchParams.get('chapter') || '', 10);
      const verseStart = parseInt(url.searchParams.get('verseStart') || '', 10);
      const verseEnd = parseInt(url.searchParams.get('verseEnd') || '', 10);
      if (!bookNum || !chapter || !verseStart || !verseEnd || verseEnd < verseStart) {
        return new Response(JSON.stringify({error:'bad_range'}), {status:400, headers:{...cors,'Content-Type':'application/json; charset=utf-8'}});
      }
      const entries = await readQtIndex(bookNum, env);
      const typed = { chapter, verseStart, verseEnd };
      let best = null, bestFraction = 0;
      for (const e of entries) {
        const f = qtOverlapFraction(typed, e);
        // Strictly greater, so the FIRST of equally good matches wins rather
        // than the last — otherwise the answer depends on insertion order.
        if (f >= QT_MATCH_THRESHOLD && f > bestFraction) { best = e; bestFraction = f; }
      }
      if (!best) {
        return new Response(JSON.stringify({error:'no_match'}), {status:404, headers:{...cors,'Content-Type':'application/json; charset=utf-8','Cache-Control':'public, max-age=300'}});
      }
      const saved = await env.COMMENTARY_KV.get(`qt_reflection_latest_${bookNum}_${best[0]}_${best[1]}_${best[2]}`);
      if (!saved) {
        // Indexed but absent — the index is a finding aid, not the authority.
        return new Response(JSON.stringify({error:'no_match'}), {status:404, headers:{...cors,'Content-Type':'application/json; charset=utf-8'}});
      }
      return new Response(saved, {headers:{...cors,'Content-Type':'application/json; charset=utf-8','Cache-Control':'public, max-age=3600'}});
    }

    if (path.startsWith('/qt-reflection/')) {
      const qtParts = path.match(/\/qt-reflection\/(\d+)\/(\d+)\/(\d+)\/(\d+)/);
      if (!qtParts) return new Response(JSON.stringify({error:'bad path'}), {status:400, headers:{...cors,'Content-Type':'application/json'}});
      const qtResult = await getOrCreateQtReflection(+qtParts[1], +qtParts[2], +qtParts[3], +qtParts[4], env);
      return new Response(qtResult.json, {status: qtResult.status || 200, headers:{...cors,'Content-Type':'application/json'}});
    }

    // ---- Admin endpoints (must precede /search) ----
    if (path === '/admin/build-index') return handleBuildIndex(env, url, cors);
    if (path === '/admin/warm-esv') return handleWarmEsv(env, url, cors, request);
    if (path === '/admin/warm-saebeon') return handleWarmSaebeon(env, url, cors, request);
    if (path === '/admin/warm-nkt') return handleWarmNkt(env, url, cors, request);
    if (path === '/admin/merge-index') return handleMergeIndex(env, url, cors);
    if (path === '/admin/build-en-index') return handleBuildEnIndex(env, url, cors);
    if (path === '/admin/merge-en-index') return handleMergeEnIndex(env, url, cors);
    if (path === '/admin/index-status') return handleIndexStatus(env, url, cors);
    if (path === '/admin/auth-check') return handleAuthCheck(env, url, cors);
    // Run the verse population the 16:00 cron does, on demand.  Exists so the
    // fix can be exercised without waiting a day for the cron — and it is
    // safe to call repeatedly, since votdEnsureVerse never overwrites a key
    // that already has a verse.
    if (path === '/admin/votd-ensure-verse') {
      const secret = (url.searchParams.get('secret') || '').trim();
      if (!env.ADMIN_SECRET || secret !== env.ADMIN_SECRET.trim()) {
        return new Response(JSON.stringify({error:'forbidden'}), {status:403, headers:{...cors,'Content-Type':'application/json; charset=utf-8'}});
      }
      const date = url.searchParams.get('date') || votdDateET(0);
      // clear=1 DELETES the date's verse instead of writing one.
      //
      // The key is write-once, which is right — a date's verse must not change
      // under readers who have already seen it.  But a key written for the
      // WRONG day has no other way out: backfilling two dates in one sitting
      // stores the same upstream verse under both, since upstream only ever
      // serves its current one.  Clearing the later date lets it be populated
      // when that day actually arrives, which is the only moment upstream has
      // the right verse to give.
      if (url.searchParams.get('clear') === '1') {
        if (!env.COMMENTARY_KV) {
          return new Response(JSON.stringify({error:'no_kv'}), {status:500, headers:{...cors,'Content-Type':'application/json; charset=utf-8'}});
        }
        const had = await env.COMMENTARY_KV.get(`votdverse_${date}`);
        await env.COMMENTARY_KV.delete(`votdverse_${date}`);
        return new Response(JSON.stringify({ date, cleared: true, hadVerse: !!had }, null, 2),
          {headers:{...cors,'Content-Type':'application/json; charset=utf-8'}});
      }
      const out = await votdEnsureVerse(date, env);
      return new Response(JSON.stringify({ date, ...out }, null, 2),
        {status: out.ok ? 200 : 502, headers:{...cors,'Content-Type':'application/json; charset=utf-8'}});
    }
    // Rebuild the per-book indexes from the stored reflections, which are the
    // authority.  Repairs an entry lost to a concurrent write, and backfills
    // every reflection generated before the index existed.
    if (path === '/admin/rebuild-qt-index') {
      const secret = (url.searchParams.get('secret') || '').trim();
      if (!env.ADMIN_SECRET || secret !== env.ADMIN_SECRET.trim()) {
        return new Response(JSON.stringify({error:'forbidden'}), {status:403, headers:{...cors,'Content-Type':'application/json; charset=utf-8'}});
      }
      const byBook = new Map();
      let cursor, scanned = 0, safety = 0;
      while (true) {
        const page = await env.COMMENTARY_KV.list({ prefix: 'qt_reflection_latest_', cursor, limit: 1000 });
        for (const k of page.keys) {
          const m = k.name.match(/^qt_reflection_latest_(\d+)_(\d+)_(\d+)_(\d+)$/);
          if (!m) continue;
          scanned++;
          const b = +m[1];
          if (!byBook.has(b)) byBook.set(b, []);
          byBook.get(b).push([+m[2], +m[3], +m[4]]);
        }
        if (page.list_complete || !page.cursor) break;
        cursor = page.cursor;
        if (++safety > 50) break;
      }
      for (const [b, entries] of byBook) {
        await env.COMMENTARY_KV.put(qtIndexKey(b), JSON.stringify(entries));
      }
      return new Response(JSON.stringify({
        ok: true, scanned, books: byBook.size,
        perBook: Object.fromEntries([...byBook].map(([b, e]) => [b, e.length])),
      }, null, 2), {headers:{...cors,'Content-Type':'application/json; charset=utf-8'}});
    }
    // Manual capture, for testing and for backfilling a date a cron missed.
    if (path === '/admin/capture-reading') {
      const secret = (url.searchParams.get('secret') || '').trim();
      if (!env.ADMIN_SECRET || secret !== env.ADMIN_SECRET.trim()) {
        return new Response(JSON.stringify({error:'forbidden'}), {status:403, headers:{...cors,'Content-Type':'application/json; charset=utf-8'}});
      }
      const date = url.searchParams.get('date') || kstDateStamp();
      const out = await captureDailyReading(date, env, { force: url.searchParams.get('force') === '1' });
      return new Response(JSON.stringify({ date, ...out }, null, 2),
        {status: out.ok ? 200 : 502, headers:{...cors,'Content-Type':'application/json; charset=utf-8'}});
    }
    // ---- /daily-readings?date=YYYY-MM-DD ----
    //
    // The window the client should match a typed passage against: the given
    // date and the KST dates either side of it.
    //
    // One date is not enough, and the reason is a clock, not a preference.
    // Korea's date rolls at 15:00 UTC — 11am in New York — so for half of a
    // US reader's waking day the published schedule is showing the NEXT
    // Korean date.  Someone who looks at it after lunch and types in what
    // they saw is holding tomorrow's reference by our local-date reckoning,
    // and matching only their own date would miss it and pay for a fresh
    // generation of a passage already warmed.  The day before covers the
    // mirror case: someone reading in the morning, or east of Korea, or just
    // catching up on yesterday.
    //
    // Three KV reads, in parallel, cached for an hour — the entries are tiny
    // and only the newest of them can still change.
    if (path === '/daily-readings') {
      const date = url.searchParams.get('date') || '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return new Response(JSON.stringify({error:'bad_date'}), {status:400, headers:{...cors,'Content-Type':'application/json; charset=utf-8'}});
      }
      const base = Date.parse(date + 'T00:00:00Z');
      if (Number.isNaN(base)) {
        return new Response(JSON.stringify({error:'bad_date'}), {status:400, headers:{...cors,'Content-Type':'application/json; charset=utf-8'}});
      }
      const dates = [-1, 0, 1].map((d) => new Date(base + d * 86400000).toISOString().slice(0, 10));
      const raws = env.COMMENTARY_KV
        ? await Promise.all(dates.map((d) => env.COMMENTARY_KV.get(DAILY_READING_PREFIX + d)))
        : dates.map(() => null);
      const readings = {};
      dates.forEach((d, i) => {
        if (!raws[i]) return;
        try { readings[d] = JSON.parse(raws[i]); } catch (e) { /* a corrupt entry is simply absent */ }
      });
      return new Response(JSON.stringify({ date, readings }, null, 2), {
        headers: {...cors,'Content-Type':'application/json; charset=utf-8','Cache-Control':'public, max-age=3600'},
      });
    }

    // ---- /daily-reading?date=YYYY-MM-DD ----
    //
    // Read-only, and deliberately so: it never captures on demand.  The page
    // only ever shows Korea's CURRENT day, so a request for some other date
    // would answer with the wrong passage and pin it under that date's key.
    // Capture belongs to the cron, which runs when the page is showing the
    // date it is writing.  A miss is a miss;  the app falls back to its own
    // plan, which is what it used before this existed.
    if (path === '/daily-reading') {
      const date = url.searchParams.get('date') || '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return new Response(JSON.stringify({error:'bad_date'}), {status:400, headers:{...cors,'Content-Type':'application/json; charset=utf-8'}});
      }
      const raw = env.COMMENTARY_KV ? await env.COMMENTARY_KV.get(DAILY_READING_PREFIX + date) : null;
      if (!raw) {
        return new Response(JSON.stringify({error:'not_captured'}), {status:404, headers:{...cors,'Content-Type':'application/json; charset=utf-8','Cache-Control':'public, max-age=300'}});
      }
      return new Response(raw, {headers:{...cors,'Content-Type':'application/json; charset=utf-8','Cache-Control':'public, max-age=3600'}});
    }
    if (path === '/admin/reading-probe') return handleReadingProbe(env, url, cors);
    if (path === '/admin/wipe-apibible-cache') return handleWipeApiBibleCache(env, url, cors);
    if (path === '/admin/build-apibible-index') return handleBuildApiBibleIndex(env, url, cors);
    if (path === '/admin/merge-apibible-index') return handleMergeApiBibleIndex(env, url, cors);

    // ---- api.bible chapter fetch (NLT / NIV / MSG) ----
    //   /apibible/{translationId}/{bookNum}/{chapter}
    const apb = path.match(/^\/apibible\/([^/]+)\/(\d+)\/(\d+)\/?$/);
    if (apb) {
      const translationId = apb[1];
      const bookNum = parseInt(apb[2]);
      const chapter = parseInt(apb[3]);
      return handleApiBibleChapter(env, url, cors, translationId, bookNum, chapter);
    }

    // ---- api.bible per-translation search ----
    //   /search/apibible/{translationId}?q=...&page=...
    const apbs = path.match(/^\/search\/apibible\/([^/]+)\/?$/);
    if (apbs) {
      return handleApiBibleSearch(env, url, cors, apbs[1]);
    }

    // ---- /search/ko (fast) ----
    if (path.startsWith('/search/ko')) return handleKoreanSearch(env, url, cors);

    // ---- /search/en (fast in-memory index) ----
    if (path.startsWith('/search/en')) return handleEnglishSearch(env, url, cors);

    // ---- /search/kjv (fast in-memory index, public-domain KJV) ----
    if (path.startsWith('/search/kjv')) return handleKjvSearch(env, url, cors);

    // ---- /kjv/{bookNum}/{chapter} (public domain, KV-only, no api.bible) ----
    const kjvm = path.match(/^\/kjv\/(\d+)\/(\d+)\/?$/);
    if (kjvm) return handleKjvChapter(env, cors, parseInt(kjvm[1]), parseInt(kjvm[2]));

    // ---- /votd/reroll — one-tap re-roll from the preview email ----
    // Like /votd/next, MUST precede the startsWith('/votd') block below.
    //
    // Authenticated by an HMAC of the date rather than the admin secret, so
    // the link is safe to sit in an inbox: it unlocks exactly one day, and
    // only while that day is still in the future.  Returns HTML, not JSON —
    // this is opened by tapping a button in a mail client, and landing on a
    // wall of JSON would be a poor answer to "show me another".
    if (path === '/votd/reroll') {
      const date = url.searchParams.get('date') || '';
      const token = url.searchParams.get('t') || '';
      const page = (title, body, status = 200) => new Response(
        `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:560px;margin:40px auto;padding:0 20px">` +
        `<h2 style="font-size:18px;margin:0 0 14px">${title}</h2>${body}</div>`,
        { status, headers: { ...cors, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }
      );

      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return page('Bad link', '<p>That date is not valid.</p>', 400);
      const expected = await votdRerollToken(date, env);
      if (!env.ADMIN_SECRET || !votdSafeEqual(token, expected)) {
        return page('Link not valid', '<p>This re-roll link is not valid for that date.</p>', 403);
      }
      // The floor is votdDateET(-2), matching the clamp /votd itself serves to
      // — that is not a coincidence, it is the same fact from both ends: any
      // date /votd will still hand a reader is a date whose photo can still be
      // seen, and therefore one worth being able to change.
      //
      // Not votdDateET(0), and not -1 either.  Readers ask for their OWN local
      // date minus one (votdOnce.ts), so which ET date a reader is being
      // served depends on where they are: a reader in UTC-12 late in their day
      // is on ET_today - 2, while one in UTC+14 at their midnight is on
      // ET_today.  A guard at -1 refuses the westmost readers' photo, which is
      // the one they are looking at.
      //
      // Re-staging a date already in use does mean a reader who loaded the
      // card earlier keeps the old photo until their next launch, while a
      // later load gets the new one.  That is the accepted cost of being able
      // to replace a photo you have actually seen.
      if (date < votdDateET(-2)) {
        return page('Too late', `<p>${date} has finished rolling out to every timezone, so its photo can no longer be changed.</p>`, 400);
      }

      const photo = await votdStagePhoto(date, env);
      if (!photo) {
        return page('No usable photo',
          `<p>Every roll came back unusable just now. Nothing was changed — tap again to retry.</p>` +
          `<p><a href="/votd/reroll?date=${encodeURIComponent(date)}&t=${expected}">Try again</a></p>`);
      }
      return page(`New photo for ${date}`,
        `<img src="${photo.url}" alt="" style="width:100%;border-radius:12px;display:block">` +
        `<p style="font-size:13px;color:#666;margin:10px 0 18px">${photo.credit || 'Unknown'} · ${photo.color}</p>` +
        `<p style="font-size:14px">This is now the photo for ${date}. It goes live at midnight ET.</p>` +
        `<p><a href="/votd/reroll?date=${encodeURIComponent(date)}&t=${expected}" ` +
        `style="display:inline-block;background:#111;color:#fff;padding:11px 18px;border-radius:8px;` +
        `text-decoration:none;font-size:14px">Get a different photo</a></p>`);
    }

    // ---- /votd/queue-add and /votd/reject — one-tap actions from the
    // chooser email.  Like /votd/reroll, these MUST precede the /votd block
    // below, which matches on startsWith('/votd').  Each link carries an HMAC
    // scoped to its action AND slug, so a queue link cannot be replayed as a
    // reject, and neither works without ADMIN_SECRET. ----
    if (path === '/votd/queue-add' || path === '/votd/reject') {
      const action = path === '/votd/queue-add' ? 'queue' : 'reject';
      const slug = url.searchParams.get('slug') || '';
      const token = url.searchParams.get('t') || '';
      // Local copy: the identical helper inside the two email builders is
      // function-scoped and not visible here.
      const esc = (v) => String(v ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
      const page = (title, body) => new Response(
        `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:520px;margin:40px auto;padding:0 18px">` +
        `<h2 style="font-size:19px">${title}</h2>${body}</div>`,
        { headers: { ...cors, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }
      );
      const expected = await votdActionToken(action, slug, env);
      if (!env.ADMIN_SECRET || !slug || !votdSafeEqual(token, expected)) {
        return page('Link not valid', '<p>That link is expired or malformed.</p>');
      }
      const cands = await votdReadJson(env, 'votd_candidates', []);
      const rec = (cands || []).find((c) => c.slug === slug);
      if (!rec) return page('Photo not found', '<p>That photo is no longer in the current suggestion set.</p>');

      // Every one of these messages names THE PHOTO, never the photographer.
      // Blocking, queueing and the used log are all keyed on the image slug,
      // so saying "Kyle Yen will not be suggested again" describes the wrong
      // thing entirely — other photos by that photographer are still fair
      // game, and the copy has to make that obvious.
      const desc = (r) => esc(r.alt ? `"${r.alt}"` : 'This photo');
      const by = (r) => (r.credit ? ` <span style="color:#666">by ${esc(r.credit)}</span>` : '');
      if (action === 'reject') {
        const rejected = await votdReadJson(env, 'votd_rejected', {});
        rejected[slug] = { credit: rec.credit, alt: rec.alt, at: new Date().toISOString() };
        await votdWriteJson(env, 'votd_rejected', rejected);
        return page('Photo blocked',
          `<p>${desc(rec)}${by(rec)} will not be suggested again.</p>` +
          `<p style="font-size:13px;color:#666">Only this photo is blocked — other photos ` +
          `${rec.credit ? 'by ' + esc(rec.credit) + ' ' : ''}can still appear.</p>`);
      }
      // An older email can still carry a slug minted before this filter
      // existed.  Its token is valid, so nothing else here would stop it.
      if (votdRecordIsPlus(rec)) {
        return page('Not available',
          `<p>${desc(rec)}${by(rec)} is an Unsplash+ photo, so the file served for it ` +
          `carries a tiled "Unsplash+" watermark. It cannot be used.</p>`);
      }
      const queue = await votdReadJson(env, 'votd_queue', []);
      if (queue.some((q) => q.slug === slug)) {
        return page('Already queued', `<p>${desc(rec)}${by(rec)} is already in the queue (${queue.length} waiting).</p>`);
      }
      const used = await votdReadJson(env, 'votd_used', {});
      if (used[slug]) {
        return page('Already used', `<p>${desc(rec)}${by(rec)} ran on ${esc(used[slug].date)}. Not re-queued.</p>`);
      }
      queue.push({ ...rec, source: 'email', addedAt: new Date().toISOString() });
      await votdWriteJson(env, 'votd_queue', queue);
      return page('Queued',
        `<img src="${esc(String(rec.url).replace(/&w=\d+/, '&w=420'))}" alt="" style="width:100%;border-radius:10px">` +
        `<p>${desc(rec)}${by(rec)} added — ${queue.length} now queued.</p>`);
    }

    // ---- /admin/votd-board and /admin/votd-act — the picker page's API ----
    // Both are secret-gated and return the SAME board shape, so the page can
    // render one response type and every action is a single round trip that
    // leaves the grid topped back up to ten.
    if (path === '/admin/votd-board' || path === '/admin/votd-act') {
      const secret = request.headers.get('X-Admin-Secret') || url.searchParams.get('secret');
      const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
        status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
      });
      if (!env.ADMIN_SECRET || secret !== env.ADMIN_SECRET) return json({ error: 'forbidden' }, 403);

      if (path === '/admin/votd-act') {
        const action = url.searchParams.get('action');
        const slug = url.searchParams.get('slug') || '';
        // A queued photo is deliberately absent from the candidate grid, so
        // unqueue has to resolve against the queue instead — looking only in
        // candidates would make undo impossible for the exact photos it is
        // meant to undo.
        const cands = await votdReadJson(env, 'votd_candidates', []);
        const queued = await votdReadJson(env, 'votd_queue', []);

        // Reorder carries a whole slug list instead of one `slug`, so it is
        // resolved before the single-record lookup below — which would
        // otherwise reject it as an unknown slug.
        if (action === 'reorder') {
          // Whole new order, not a swap: idempotent, and it cannot half-apply.
          // Refused unless the submitted slugs are exactly a permutation of
          // what is queued right now, so a stale tab showing a photo that has
          // since been staged or removed can't resurrect or drop it.
          const want = (url.searchParams.get('slugs') || '').split(',').filter(Boolean);
          const have = (queued || []).map((q) => q.slug);
          const same = want.length === have.length && new Set(want).size === want.length
            && want.every((s) => have.includes(s));
          if (!same) return json({ error: 'queue changed since this view — reload' }, 409);
          await votdWriteJson(env, 'votd_queue', want.map((s) => queued.find((q) => q.slug === s)));
          return json(await votdBoard(env, 10));
        }

        const rec = (cands || []).find((c) => c.slug === slug)
          || (queued || []).find((q) => q.slug === slug);
        if (!rec) return json({ error: 'unknown slug' }, 400);

        if (action === 'reject') {
          const rejected = await votdReadJson(env, 'votd_rejected', {});
          rejected[slug] = { credit: rec.credit, alt: rec.alt, at: new Date().toISOString() };
          await votdWriteJson(env, 'votd_rejected', rejected);
        } else if (action === 'queue') {
          const queue = await votdReadJson(env, 'votd_queue', []);
          const used = await votdReadJson(env, 'votd_used', {});
          if (!queue.some((q) => q.slug === slug) && !used[slug]) {
            queue.push({ ...rec, source: 'picker', addedAt: new Date().toISOString() });
            await votdWriteJson(env, 'votd_queue', queue);
          }
        } else if (action === 'unqueue') {
          // Undo, for a mis-tap.  Removing from the queue does NOT block the
          // photo — it simply goes back to being suggestible.
          const queue = await votdReadJson(env, 'votd_queue', []);
          await votdWriteJson(env, 'votd_queue', queue.filter((q) => q.slug !== slug));
        } else {
          return json({ error: 'bad action' }, 400);
        }
      }
      return json(await votdBoard(env, 10));
    }

    // ---- /admin/votd-lowcheck — run the low-queue check on demand ----
    // Same call the cron makes, so it verifies the real path rather than a
    // parallel one.  Silent when the queue is healthy; ?force=1 sends anyway,
    // which is the only way to confirm mail delivery without first draining
    // the queue.
    if (path === '/admin/votd-lowcheck') {
      const secret = request.headers.get('X-Admin-Secret') || url.searchParams.get('secret');
      const json = (o, s = 200) => new Response(JSON.stringify(o), {
        status: s, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
      });
      if (!env.ADMIN_SECRET || secret !== env.ADMIN_SECRET) return json({ error: 'forbidden' }, 403);

      const date = votdDateET(1);
      const queue = await votdReadJson(env, 'votd_queue', []);
      const n = (queue || []).length;
      const raw = env.COMMENTARY_KV ? await env.COMMENTARY_KV.get(`votdphoto2_${date}`) : null;
      let staged = null;
      try { staged = raw ? JSON.parse(raw) : null; } catch { staged = null; }
      const mailable = !!(env.RESEND_KEY && env.VOTD_EMAIL_TO && env.VOTD_EMAIL_FROM);

      if (url.searchParams.get('force') === '1') {
        // Real function, real email body — only the count is overridden, so
        // the queue in KV is never written to.
        await votdWarnLowQueue(date, staged, env, 0);
        return json({ queued: n, threshold: VOTD_LOW_QUEUE, mailable, sent: mailable, forced: true });
      }
      await votdWarnLowQueue(date, staged, env);
      return json({ queued: n, threshold: VOTD_LOW_QUEUE, mailable, sent: mailable && n < VOTD_LOW_QUEUE });
    }

    // ---- /admin/votd-chooser — send the chooser email on demand ----
    // The cron sends it once a day at noon; this exists so the mail path can
    // be tested (and the queue reviewed) without waiting for 16:00 UTC.  Does
    // NOT stage anything — it reports whatever is already staged for the
    // target date, so calling it repeatedly is harmless.
    if (path === '/admin/votd-chooser') {
      const secret = request.headers.get('X-Admin-Secret') || url.searchParams.get('secret');
      if (!env.ADMIN_SECRET || secret !== env.ADMIN_SECRET) {
        return new Response(JSON.stringify({ error: 'forbidden' }), {
          status: 403, headers: { ...cors, 'Content-Type': 'application/json' }
        });
      }
      const date = url.searchParams.get('date') || votdDateET(1);
      const raw = env.COMMENTARY_KV ? await env.COMMENTARY_KV.get(`votdphoto2_${date}`) : null;
      let staged = null;
      try { staged = raw ? JSON.parse(raw) : null; } catch { staged = null; }
      const mailable = !!(env.RESEND_KEY && env.VOTD_EMAIL_TO && env.VOTD_EMAIL_FROM);
      await votdSendChooserEmail(date, staged, env);
      const queue = await votdReadJson(env, 'votd_queue', []);
      return new Response(JSON.stringify({
        date, staged: !!staged, queued: (queue || []).length, mailable,
        note: mailable ? 'email sent' : 'RESEND_KEY / VOTD_EMAIL_FROM / VOTD_EMAIL_TO not all set — nothing sent'
      }), { headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }

    // ---- /votd/next — read tomorrow's STAGED photo (public, read-only) ----
    // MUST be tested before the /votd block below: that block matches with
    // startsWith('/votd'), so it would otherwise swallow this path.
    //
    // Never rolls.  `staged:false` means the noon cron has not run yet (or the
    // worker was deployed mid-day); it is a plain "nothing chosen yet", not an
    // error, and tomorrow's /votd will roll normally at midnight as it always
    // has.  Deliberately unauthenticated: reading which photo is queued is
    // harmless, while ROLLING costs an Unsplash call and is what /admin
    // protects.
    if (path === '/votd/next') {
      const date = votdDateET(1);
      let photo = null, staged = false;
      if (env.COMMENTARY_KV) {
        const raw = await env.COMMENTARY_KV.get(`votdphoto2_${date}`);
        if (raw !== null) {
          staged = true;
          try { photo = JSON.parse(raw); } catch { photo = null; }
        }
      }
      return new Response(JSON.stringify({ date, staged, photo }), {
        // no-store: a preview that can be re-rolled must never be read from a
        // stale edge cache, or an approved photo could be reported wrongly.
        headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
      });
    }

    // ---- /admin/votd-next — re-roll the staged photo for a date ----
    // ?date=YYYY-MM-DD to target a specific ET date (default: tomorrow).
    // Overwrites votdphoto2_<date>, so calling it repeatedly is how a photo
    // gets rejected until an acceptable one appears.  Safe to run right up to
    // midnight; after that the date has gone live and this would be editing a
    // photo readers are already seeing, so it refuses a past date.
    if (path === '/admin/votd-next') {
      const secret = request.headers.get('X-Admin-Secret') || url.searchParams.get('secret');
      if (!env.ADMIN_SECRET || secret !== env.ADMIN_SECRET) {
        return new Response(JSON.stringify({ error: 'forbidden' }), {
          status: 403, headers: { ...cors, 'Content-Type': 'application/json' }
        });
      }
      const date = url.searchParams.get('date') || votdDateET(1);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return new Response(JSON.stringify({ error: 'bad date' }), {
          status: 400, headers: { ...cors, 'Content-Type': 'application/json' }
        });
      }
      // votdDateET(-2) — the oldest date /votd will still serve.  See the
      // matching guard in /votd/reroll for why this is neither 0 nor -1.
      if (date < votdDateET(-2)) {
        return new Response(JSON.stringify({ error: 'date already past' }), {
          status: 400, headers: { ...cors, 'Content-Type': 'application/json' }
        });
      }
      const photo = await votdStagePhoto(date, env);
      // staged reflects whether anything was actually written — see
      // votdStagePhoto for why a failed roll writes nothing at all.
      return new Response(JSON.stringify({ date, staged: !!photo, photo }), {
        headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
      });
    }

    // ---- /votd ----
    if (path.startsWith('/votd')) {
      const now = new Date();
      const currentET = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      // `date` lets a caller ask for a specific ET date rather than the current
      // one.  Readers use it to run exactly one day behind: at their local
      // midnight they request the previous ET date, which has existed for at
      // least six hours even in UTC+14, so the whole world rolls over at its
      // OWN midnight while still seeing the same verse on the same local date.
      //
      // Clamped to the last three ET days, and that clamp is the safety
      // property, not a nicety.  A cold key is populated from labs.bible.org,
      // which serves only its own current verse — so honouring a FUTURE date
      // would write today's verse under tomorrow's write-once key and pin the
      // wrong verse for everyone, permanently.  Past dates cannot do that.
      const requested = url.searchParams.get('date');
      // Upper bound is ET+1, not ET.  A reader asks for their OWN local date
      // now, and everywhere east of Eastern that date runs ahead of the ET
      // one — Korea at its local midnight is still the previous ET day, so
      // its "today" reads as a future ET date and a tighter clamp refused it.
      //
      // The original reason for refusing a future date was that populating it
      // from upstream would pin the wrong verse under a write-once key.  That
      // hazard was closed separately when dated requests were made READ-ONLY:
      // they never populate anything now, they fall back.  So the clamp no
      // longer has to carry that job, and can be as wide as real readers need.
      let dated = !!requested && /^\d{4}-\d{2}-\d{2}$/.test(requested)
        && requested <= votdDateET(1) && requested >= votdDateET(-2);
      let today = dated ? requested : currentET;
      // Verse and photo are cached under SEPARATE keys so refreshing the
      // photo (or redeploying photo logic) never re-rolls the verse.  The
      // verse is written once per day and then left alone — labs.bible.org's
      // votd rotates through the day, so first-fetch-of-the-day wins and
      // stays fixed via its own write-once key.  (Old combined `votd4_` key
      // is now unused; it just expires.)
      let verseKey = `votdverse_${today}`;
      let photoKey = `votdphoto2_${today}`;

      const tomorrowDateET = new Date(now.getTime() + 86400000).toLocaleDateString('en-CA', {timeZone:'America/New_York'});
      const midnightET = new Date(`${tomorrowDateET}T00:00:00`);
      const nowET = new Date(now.toLocaleString('en-US', {timeZone:'America/New_York'}));
      const offsetMs = now - nowET;
      const midnightUTC = new Date(midnightET.getTime() + offsetMs);
      const secondsUntilMidnight = Math.max(60, Math.floor((midnightUTC - now) / 1000));
      let votdData = null;
      // photoRaw: null = not cached yet; any JSON string (including "null",
      // the color-card sentinel) = already resolved for today.
      let photoRaw = null;
      const readKeys = async (vk, pk) => {
        if (!env.COMMENTARY_KV) return;
        const [vRaw, pRaw] = await Promise.all([
          env.COMMENTARY_KV.get(vk),
          env.COMMENTARY_KV.get(pk),
        ]);
        votdData = null;
        if (vRaw) { try { votdData = JSON.parse(vRaw); } catch { votdData = null; } }
        photoRaw = pRaw;
      };
      await readKeys(verseKey, photoKey);

      // A DATED request must never populate from upstream.  labs.bible.org
      // serves only its own current verse, so filling a missing past key from
      // it would store today's verse under that date — and the key is
      // write-once, so the wrong verse would then be pinned for everyone
      // reading that date.  The clamp above stops a FUTURE date from doing
      // this;  a past date whose key has expired or was never written is the
      // same hazard from the other side.
      //
      // So when the requested date has no verse, fall back to the current ET
      // date and let the normal write-once path own it.  The reader gets a
      // real verse instead of a fabricated one;  the only cost is that they
      // see today's rather than the day they asked for.
      if (dated && !votdData) {
        dated = false;
        today = currentET;
        verseKey = `votdverse_${today}`;
        photoKey = `votdphoto2_${today}`;
        await readKeys(verseKey, photoKey);
      }

      // Built after the fallback above, so `dated` is final.
      //
      //   - fell back to the current ET date: expires when that date rolls.
      //   - dated, and old enough that its photo can no longer be re-rolled:
      //     genuinely immutable, cache for an hour.
      //   - dated, but still inside the re-roll window: NOT immutable any more.
      //     This used to be lumped in with the immutable case on the reasoning
      //     that a past date's key is write-once — true of the VERSE, and true
      //     of the photo too until /admin/votd-next started accepting dates
      //     back to votdDateET(-2).  A re-rolled photo then sat behind an hour
      //     of edge and browser cache, so the picker that had just changed it
      //     re-read the old one and readers launching in that window still got
      //     it.  A minute keeps bursts of launches coalescing while making a
      //     re-roll visible almost at once.
      const rerollable = dated && today >= votdDateET(-2);
      const votdHeaders = { ...cors, "Content-Type": "application/json",
        "Cache-Control": `public, max-age=${dated ? (rerollable ? 60 : 3600) : secondsUntilMidnight}` };

      const needVerse = !votdData;
      const needPhoto = photoRaw === null;

      // Both parts already resolved for today -> assemble and return.
      if (!needVerse && !needPhoto) {
        let cachedPhoto = null;
        try { cachedPhoto = JSON.parse(photoRaw); } catch { cachedPhoto = null; }
        return new Response(JSON.stringify({ verses: votdData, photo: cachedPhoto }), { headers: votdHeaders });
      }

      // Topics lean toward bright, clear-sky scenes (sunrise / golden
      // Topics, people/gloomy/dark filters, and the Unsplash fetch now live at
      // module scope (see votdRollPhoto) so the noon staging cron picks a photo
      // by exactly these rules.  Only the parallel first-fetch stays here, to
      // overlap the photo call with the verse call on a fully-cold day.
      // Fetch only the missing piece(s), in parallel — the first photo
      // attempt overlaps the verse fetch so we don't pay for the retry
      // loop on a fully-cold day.
      const [verseResp, firstPhotoResp] = await Promise.allSettled([
        needVerse
          ? fetch('https://labs.bible.org/api/?passage=votd&type=json', {
              headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" }
            })
          : Promise.resolve(null),
        needPhoto ? votdFetchOnePhoto(env) : Promise.resolve(null),
      ]);

      // ---- Verse (write-once for the day) ----
      if (needVerse) {
        votdData = verseResp.status === 'fulfilled' && verseResp.value
          ? await verseResp.value.json()
          : [];
        if (env.COMMENTARY_KV && Array.isArray(votdData) && votdData.length) {
          await env.COMMENTARY_KV.put(verseKey, JSON.stringify(votdData), { expirationTtl: votdKeyTtl(today) });
        }
      }

      // ---- Photo (cached independently; bustable without touching verse) ----
      let photo = null;
      if (needPhoto) {
        // Hand votdRollPhoto the photo already fetched alongside the verse, so
        // a cold day still costs one round trip before any re-roll.
        photo = await votdRollPhoto(
          firstPhotoResp.status === 'fulfilled' ? firstPhotoResp.value : null,
          null,
          env
        );
        // Cache the photo — or the null "color card" sentinel — so we don't
        // re-roll on every request.  Deleting THIS key alone refreshes the
        // photo while leaving the verse fixed.
        if (env.COMMENTARY_KV) {
          await env.COMMENTARY_KV.put(photoKey, JSON.stringify(photo), { expirationTtl: votdKeyTtl(today) });
        }
      } else {
        try { photo = JSON.parse(photoRaw); } catch { photo = null; }
      }

      const result = JSON.stringify({ verses: votdData || [], photo });
      return new Response(result, { headers: votdHeaders });
    }

    // ---- 새번역 (Saebeonyeok) chapter fetch -- checked before the NKRV
    // block below since that block's fallback bare /{book}/{chapter}
    // pattern doesn't match a /saebeon/ prefix, but needs to run first
    // so /saebeon/... doesn't fall through to the "Use /nkrv/..." error. ----
    const saebeonMatch = path.match(/\/saebeon\/(\d+)\/(\d+)/);
    if (saebeonMatch) {
      const bookNum = +saebeonMatch[1], chapter = +saebeonMatch[2];
      try {
        const result = await fetchAndCacheSaebeon(bookNum, chapter, env);
        if (!result.ok) {
          return new Response(JSON.stringify({error: result.error || 'saebeon_fetch_failed'}), {headers:{...cors,"Content-Type":"application/json"}});
        }
        return new Response(JSON.stringify(result.data), {headers:{...cors,"Content-Type":"application/json","Cache-Control":"public, max-age=2592000, stale-while-revalidate=86400"}});
      } catch (e) {
        return new Response(JSON.stringify({error: e.message}), {status:500, headers:{...cors,"Content-Type":"application/json"}});
      }
    }

    // ---- 우리말성경 chapter — KV only, see fetchAndCacheWoori.  Like /nkt it
    // must run before the nkrv fallback so it does not fall through to the
    // "Use /nkrv/..." error. ----
    const wooriMatch = path.match(/^\/woori\/(\d+)\/(\d+)\/?$/);
    if (wooriMatch) {
      const bookNum = +wooriMatch[1], chapter = +wooriMatch[2];
      const result = await fetchAndCacheWoori(bookNum, chapter, env);
      if (!result.ok) {
        return new Response(JSON.stringify({ error: result.error, bookNum, chapter }), {
          status: result.error === 'kv_unset' ? 503 : 404,
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(result.data), {
        headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=2592000, stale-while-revalidate=86400' },
      });
    }

    // ---- 새한글성경 (NKT) chapter fetch — bskorea's new platform, see
    // fetchAndCacheNkt.  Must run before the nkrv fallback so /nkt/... doesn't
    // fall through to the "Use /nkrv/..." error. ----
    const nktMatch = path.match(/\/nkt\/(\d+)\/(\d+)/);
    if (nktMatch) {
      const bookNum = +nktMatch[1], chapter = +nktMatch[2];
      try {
        const result = await fetchAndCacheNkt(bookNum, chapter, env);
        if (!result.ok) {
          return new Response(JSON.stringify({error: result.error || 'nkt_fetch_failed'}), {headers:{...cors,"Content-Type":"application/json"}});
        }
        // Normalised on the way OUT, not on the way in: KV keeps the numbering
        // 새한글 actually publishes, so the mapping stays reviewable and a
        // correction here needs no re-scrape of anything.
        const canonical = nktToCanonical(bookNum, chapter, result.data);
        return new Response(JSON.stringify(canonical), {headers:{...cors,"Content-Type":"application/json","Cache-Control":"public, max-age=2592000, stale-while-revalidate=86400"}});
      } catch (e) {
        return new Response(JSON.stringify({error: e.message}), {status:500, headers:{...cors,"Content-Type":"application/json"}});
      }
    }

    // ---- Korean Bible (nkrv) chapter fetch ----
    let bookNum, chapter;
    const m  = path.match(/\/nkrv\/(\d+)\/(\d+)/);
    const m2 = path.match(/^\/(\d+)\/(\d+)/);
    if (m)       { bookNum = +m[1];  chapter = +m[2]; }
    else if (m2) { bookNum = +m2[1]; chapter = +m2[2]; }
    else return new Response(JSON.stringify({error:"Use /nkrv/{book}/{chapter}"}), {status:400, headers:{...cors,"Content-Type":"application/json"}});

    try {
      const nkrvResult = await fetchAndCacheNkrv(bookNum, chapter, env);
      if (!nkrvResult.ok) {
        return new Response(JSON.stringify({error: nkrvResult.error || 'nkrv_fetch_failed'}), {headers:{...cors,"Content-Type":"application/json"}});
      }
      return new Response(JSON.stringify(nkrvResult.data), {headers:{...cors,"Content-Type":"application/json","Cache-Control":"public, max-age=2592000, stale-while-revalidate=86400"}});
    } catch (e) {
      return new Response(JSON.stringify({error: e.message}), {status:500, headers:{...cors,"Content-Type":"application/json"}});
    }
  },

  // Cron trigger (see wrangler.toml's [triggers] — runs 08:00 UTC daily).
  // Pre-warms the QT reflection cache for TOMORROW's reading (by UTC
  // date) so the first person to open the app on any given calendar
  // day, in any timezone, hits a warm cache instead of triggering a
  // live AI generation.  08:00 UTC gives >=2h lead time even for the
  // earliest timezone (UTC+14) to reach that date's local midnight —
  // see dailyPlan.js's own comment for the full timezone-coverage math.
  // getReadingForDate's bookIdx is 0-indexed; the /qt-reflection route
  // (and getOrCreateQtReflection) wants a 1-indexed book number.
  async scheduled(event, env, ctx) {
    // TWO triggers now, so this must dispatch on which one fired — without
    // the check, adding the noon cron would have silently doubled the QT
    // warm-up as well.
    //
    // 16:00 UTC — stage tomorrow's VOTD photo so it can be previewed and
    // re-rolled during the day.  That is noon in EDT and 11am in EST; the
    // exact hour does not matter, only that it lands during waking hours on
    // the day BEFORE, with time to reject a photo before midnight ET.
    // Cloudflare crons are UTC-only, so the one-hour DST drift is accepted
    // rather than worked around.
    // 15:10 UTC = 00:10 KST — capture the Korean day's reading minutes after it
    // is published, which is hours before that same date starts anywhere west
    // of Korea.  See captureDailyReading for why this is write-once per date
    // and why the fetch cannot be deferred to a reader's request.
    // 09:00 UTC — write TOMORROW's verse, before any timezone has entered
    // that date.  A local date begins earliest at UTC+14, which is 10:00 UTC
    // the day before, so this lands with an hour in hand;  everywhere west
    // has many more.  That is what lets a reader ask for their own local date
    // and always find it written, instead of asking for yesterday's to be
    // sure it exists.
    //
    // The verse stored is whatever upstream is serving when this runs.  It
    // cannot be that date's own verse — upstream only ever serves its current
    // one, and by the time it rotates, half the world is already on the date.
    // So a date's verse is defined as "what upstream had the morning before",
    // fixed once and identical for every reader on that date.
    if (event.cron === '0 9 * * *') {
      ctx.waitUntil(votdEnsureVerse(votdDateET(1), env));
      return;
    }
    if (event.cron === '10 15 * * *') {
      ctx.waitUntil(captureDailyReading(kstDateStamp(), env));
      return;
    }
    if (event.cron === '0 16 * * *') {
      const date = votdDateET(1);
      ctx.waitUntil(
        // Stage tomorrow, from the queue if anything is waiting.
        //
        // The daily email is OFF: the picker page at krengbible.com/votd.html
        // does the same job better — full-resolution photos, backfill as you
        // act, and a reorderable queue — so a ten-photo email every day is
        // just noise.  Nothing about the email path was deleted: re-enable by
        // chaining .then((photo) => votdSendChooserEmail(date, photo, env))
        // here, and /admin/votd-chooser still sends one on demand.
        //
        // The one mail that DOES go out is the low-queue nudge, which stays
        // silent unless the queue has fallen below VOTD_LOW_QUEUE.
        votdStagePhoto(date, env).then((photo) => votdWarnLowQueue(date, photo, env))
      );
      // And today's VERSE, which nothing wrote on purpose before — see
      // votdEnsureVerse.  Separate from the photo above and on a different
      // date deliberately: the photo is staged a day ahead, the verse can only
      // ever be today's.  waitUntil'd separately so a failure in one does not
      // take the other with it.
      ctx.waitUntil(votdEnsureVerse(votdDateET(0), env));
      return;
    }

    // 08:00 UTC — warm tomorrow's Daily QT reflection.
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const reading = getReadingForDate(tomorrow);
    ctx.waitUntil(
      getOrCreateQtReflection(reading.bookIdx + 1, reading.chapter, reading.verseStart, reading.verseEnd, env)
    );
  }
};
