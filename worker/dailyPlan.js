/**
 * Today's QT reading, for the cron that pre-warms the /qt-reflection
 * cache.
 *
 * This file used to be a hand-typed second implementation of the app's
 * src/lib/dailyPlan.ts, headed "keep this in sync by hand if the app's
 * algorithm ever changes".  It was not kept in sync — eight verses a day
 * against the app's twelve, no OT/NT/Psalms merge, no section boundaries,
 * a two-year-stale epoch, one hard-coded Advent set where the app rotates
 * four.  Nothing could notice, because a cache warmed for the wrong
 * passage looks exactly like a cold one.
 *
 * So the algorithm is not here any more.  planSchedule.generated.js holds
 * the app's OUTPUT — one full ~9.5-year rotation, emitted by that repo's
 * own test suite from the one real implementation.  What stays here is the
 * calendar: which days are Advent, which are Holy Week, and how the
 * rotation index counts around them.  That part is small, is defined by
 * the calendar rather than by the plan, and does not drift.
 *
 * FROZEN_DAYS in that same generated file holds the days the rotation does
 * not compute — the plan as published before it changed, and the bridge day
 * across the seam.  Those ship here too:  this file answers for tomorrow,
 * and tomorrow can be one of them.
 *
 * bookIdx is 0-indexed, matching index.js's BOOK_NAMES_EN / BOOK_CHAPTERS
 * order — the standard 66-book Protestant order.  Add 1 for the worker's
 * 1-indexed book-number endpoints.
 */

import {
  SCHEDULE,
  FROZEN_DAYS,
  PLAN_EPOCH,
  CHRISTMAS_SETS,
  CHRISTMAS_ROTATION_BASE_YEAR,
} from './planSchedule.generated.js';

const FROZEN_BY_DATE = new Map(FROZEN_DAYS.map((d) => [d[0], d]));

function dateKey(date) {
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${m}-${d}`;
}

const BOOK_CHAPTERS = [50,40,27,36,34,24,21,4,31,24,22,25,29,36,10,13,10,42,150,31,12,8,66,52,5,48,12,14,3,9,1,4,7,3,3,3,2,14,4,28,16,24,21,28,16,16,13,6,6,4,4,5,3,6,4,3,1,13,5,5,3,5,1,1,1,22];

// Only the four Gospels' closing chapters are read from here — everything
// else comes out of SCHEDULE — so this carries just those books' verse
// counts, not all 66.  bookIdx -> [chapter-1] -> verses.
const GOSPEL_VERSE_COUNTS = {
  39: [25,23,17,25,48,34,29,34,38,42,30,50,58,36,39,28,27,35,30,34,46,46,39,51,46,75,66,20],
  40: [45,28,35,41,43,56,37,38,50,52,33,44,37,72,47,20],
  41: [80,52,38,44,39,49,50,56,62,42,54,59,35,35,32,31,37,43,48,47,38,71,56,53],
  42: [51,25,36,54,47,71,53,59,41,42,57,50,38,31,27,33,26,40,42,31,25],
};

// ===== Calendar =====

function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

function palmSunday(year) {
  const easter = easterSunday(year);
  return new Date(easter.getFullYear(), easter.getMonth(), easter.getDate() - 7);
}

function toDayNumber(date) {
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000);
}

function isHolyWeek(date) {
  const y = date.getFullYear();
  const d = toDayNumber(date);
  return d >= toDayNumber(palmSunday(y)) && d <= toDayNumber(easterSunday(y));
}

function isChristmasDay(date) {
  return date.getMonth() === 11 && date.getDate() >= 18;
}

/** December wins even during Holy Week — the two cannot overlap in practice, but the app resolves it this way and this file must resolve it the same. */
function isGospelDay(date) {
  if (isChristmasDay(date)) return false;
  return isHolyWeek(date);
}

/**
 * Days in [PLAN_EPOCH, date) that are neither Advent nor Holy Week.
 * Advent and Holy Week DISPLACE a rotation day rather than consuming
 * one, so January resumes exactly where December left off — which is why
 * this counts rather than subtracting.
 */
function rotationDayIndex(date) {
  let count = 0;
  const cursor = new Date(PLAN_EPOCH.getFullYear(), PLAN_EPOCH.getMonth(), PLAN_EPOCH.getDate());
  const targetDayNum = toDayNumber(date);
  while (toDayNumber(cursor) < targetDayNum) {
    if (!isChristmasDay(cursor) && !isGospelDay(cursor)) count++;
    cursor.setDate(cursor.getDate() + 1);
  }
  return count;
}

// ===== Holy Week (the one reading still computed here) =====

const MATTHEW = 39, MARK = 40, LUKE = 41, JOHN = 42;

const GOSPEL_ROTATION_BASE_YEAR = 2024;
/** 2024 Mark, 2025 John, 2026 Matthew, 2027 Luke, repeats every 4 years. */
const GOSPEL_ROTATION = [MARK, JOHN, MATTHEW, LUKE];

function gospelBookIdxForYear(year) {
  const offset = (((year - GOSPEL_ROTATION_BASE_YEAR) % 4) + 4) % 4;
  return GOSPEL_ROTATION[offset];
}

/** Last N chapters of each Gospel: Triumphal Entry through Resurrection. */
const HOLY_WEEK_CHAPTER_COUNT = { [MATTHEW]: 3, [MARK]: 3, [LUKE]: 3, [JOHN]: 4 };

function splitChapterIntoDays(bookIdx, chapter, dayCount) {
  const total = GOSPEL_VERSE_COUNTS[bookIdx][chapter - 1];
  const n = Math.max(1, dayCount);
  const base = Math.floor(total / n);
  const rem = total % n;
  const slots = [];
  let v = 1;
  for (let i = 0; i < n; i++) {
    const len = Math.max(1, base + (i < rem ? 1 : 0));
    const verseStart = v;
    const verseEnd = Math.min(v + len - 1, total);
    slots.push({ bookIdx, chapter, verseStart, verseEnd });
    v = verseEnd + 1;
  }
  return slots;
}

function stretchToFit(bookIdx, chapters, totalDays) {
  if (chapters.length === 0 || totalDays <= 0) return [];
  const days = Math.max(totalDays, chapters.length);
  const verseCounts = chapters.map((c) => GOSPEL_VERSE_COUNTS[bookIdx][c - 1]);
  const totalVerses = verseCounts.reduce((s, v) => s + v, 0);
  const raw = verseCounts.map((v) => (v / totalVerses) * days);
  const dayCounts = raw.map((r) => Math.max(1, Math.floor(r)));
  let remaining = days - dayCounts.reduce((s, v) => s + v, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < order.length && remaining > 0; k++, remaining--) {
    dayCounts[order[k].i]++;
  }
  const slots = [];
  chapters.forEach((chapter, i) => {
    slots.push(...splitChapterIntoDays(bookIdx, chapter, dayCounts[i]));
  });
  return slots;
}

function resolveGospelReading(date) {
  const year = date.getFullYear();
  const bookIdx = gospelBookIdxForYear(year);
  const totalChapters = BOOK_CHAPTERS[bookIdx];
  const holyWeekChapters = HOLY_WEEK_CHAPTER_COUNT[bookIdx];

  const start = palmSunday(year);
  const chapters = Array.from(
    { length: holyWeekChapters },
    (_, i) => totalChapters - holyWeekChapters + 1 + i,
  );
  const windowDays = toDayNumber(easterSunday(year)) - toDayNumber(start) + 1; // 8
  const slots = stretchToFit(bookIdx, chapters, windowDays);
  const offset = toDayNumber(date) - toDayNumber(start);
  const slot = slots[Math.min(offset, slots.length - 1)];
  return { type: 'gospel', bookIdx: slot.bookIdx, chapter: slot.chapter, verseStart: slot.verseStart, verseEnd: slot.verseEnd };
}

function resolveChristmasReading(date) {
  const sets = CHRISTMAS_SETS;
  const offset = (((date.getFullYear() - CHRISTMAS_ROTATION_BASE_YEAR) % sets.length) + sets.length) % sets.length;
  const [bookIdx, chapter, verseStart, verseEnd] = sets[offset][date.getDate() - 18];
  return { type: 'christmas', bookIdx, chapter, verseStart, verseEnd };
}

// ===== Public API =====

/**
 * { type, bookIdx, chapter, verseStart, verseEnd, endChapter? } — endChapter
 * only when the day crosses a chapter, which the section-based plan allows so
 * a passage can end at a real narrative break instead of mid-scene.
 */
export function getReadingForDate(date) {
  if (isChristmasDay(date)) return resolveChristmasReading(date);
  if (isGospelDay(date)) return resolveGospelReading(date);

  // A frozen date is answered from the table, never from SCHEDULE — the
  // rotation would compute a different passage for it, which is the whole
  // reason it is frozen.
  const frozen = FROZEN_BY_DATE.get(dateKey(date));
  if (frozen) {
    const [, isPsalms, bookIdx, chapter, verseStart, verseEnd] = frozen;
    return { type: isPsalms ? 'psalms' : 'main', bookIdx, chapter, verseStart, verseEnd };
  }

  const [isPsalms, bookIdx, chapter, verseStart, verseEnd, endChapter] =
    SCHEDULE[rotationDayIndex(date) % SCHEDULE.length];
  return {
    type: isPsalms ? 'psalms' : 'main',
    bookIdx,
    chapter,
    verseStart,
    verseEnd,
    ...(endChapter ? { endChapter } : {}),
  };
}
