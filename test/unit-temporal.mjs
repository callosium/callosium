// Unit tests for the content-level dated-event extractor (bodyEventDates) — the
// event-time layer that lets `recent` surface a note whose real movement is a
// dated event in its PROSE while the file's own date is stale or bulk-stamped.
// Run: node test/unit-temporal.mjs
import { bodyEventDates, parsePeriod, noteDateInfo } from '../src/recall/temporal.ts';

let pass = 0, fail = 0;
const U = Date.UTC;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
};
// default window: 4–19 Jul 2026 (month is 0-based → 6 = July)
const F = U(2026, 6, 4), T = U(2026, 6, 19);
const isos = (text, from = F, to = T) => bodyEventDates(text, from, to).map((e) => e.iso);

// ── positives ──────────────────────────────────────────────────────────────
check('U1 bare prose (date + wikilink same line)',
  isos('required the Self Assessment Questionnaire, filled 7 Jul 2026 ([[Acme DPIA Self Assessment]]), pending review'),
  ['2026-07-07']);
check('U2 Month D, YYYY', bodyEventDates('discovery engagement conducted on March 9, 2026 here', U(2026, 2, 1), U(2026, 2, 31)).map((e) => e.iso), ['2026-03-09']);
check('U3 ISO bare', isos('anchor bumped to 2026-07-15 today'), ['2026-07-15']);
check('U4 no-comma Month D YYYY', bodyEventDates('FINAL Sep 25 2025 clarifications', U(2025, 8, 1), U(2025, 8, 30)).map((e) => e.iso), ['2025-09-25']);
check('U5 changelog headings newest-first',
  isos('## 17 July 2026\nx\n## 16 July 2026\ny\n## 15 July 2026\nz'),
  ['2026-07-17', '2026-07-16', '2026-07-15']);
check('sentence-final period kept', isos('shipped it on 7 Jul 2026.'), ['2026-07-07']);
check('colon-then-space kept', isos('7 Jul 2026: shipped it'), ['2026-07-07']);
check('Arabic body, Latin date', isos('تم ملء الاستبيان 7 Jul 2026 والحمد لله'), ['2026-07-07']);

// ── negatives (all use IN-WINDOW dates so the GUARD, not the window, is proven) ─
check('U6 wikilink target', isos('see [[Session 7 July 2026]] for detail'), []);
check('U7 inline code', isos('query `since:2026-07-14` in the log'), []);
check('U8 fenced code', isos('```\n"date":"2026-07-10"\n```'), []);
check('U9 md-link target / URL', isos('[report](https://x.io/2026-07-10/r) here'), []);
check('U10 filename glue (.md)', isos('Analysis 2026-07-10.md is ready'), []);
check('U10b video serial', isos('00000186-VIDEO-2026-07-10-12-52-58.mp4 clip'), []);
check('U11 frontmatter date (bulk-defeat guard)', isos('---\nupdated: 2026-07-15\n---\n# X\nno body dates here'), []);
check('U12 no-year prose (meeting index)', isos('- Mar 26: [[Acme Security Protocol Summary]]'), []);
check('U13 slash date (ambiguous, skipped)', isos('Proposal Date: 22/12/2025 and Last Updated 7/2/2026'), []);
check('MAINTENANCE merged-from', isos('## Opportunity files (merged from "Acme Opportunities", 7 Jul 2026) more'), []);
check('MAINTENANCE renamed-from', isos('Renamed from `Untitled document.md` (Google export default name) on 7 Jul 2026'), []);
check('MAINTENANCE vault-dedupe', isos('the superseded v1.docx was removed in the 7 Jul 2026 vault dedupe'), []);
check('MAINTENANCE health-check', isos('Adopted during the 7 Jul 2026 vault health check (previously unlinked)'), []);
check('MAINTENANCE merged mid-snippet (word cut by snippet window)',
  isos('## Opportunity files (merged from "Acme Regional Discovery Questions" earlier full list, 7 Jul 2026) rest'), []);

// ── window / calendar guards ─────────────────────────────────────────────────
check('U14 out-of-window low bound', isos('moved 13 Jun 2026 recap'), []);
check('U14b future/deadline (> now upper bound)', bodyEventDates('submission due 30 Jul 2026', F, U(2026, 6, 18)).map((e) => e.iso), []);
check('U18 invalid calendar', isos('bad 2026-13-40 and also 31 Feb 2026 here'), []);

// ── edges ────────────────────────────────────────────────────────────────────
check('U15 dedup one per ISO', isos('moved 7 Jul 2026 and again 7 Jul 2026 and [[x 07 Jul 2026]]'), ['2026-07-07']);
{
  const body = ['2026-07-05', '2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09', '2026-07-10', '2026-07-11', '2026-07-12'].map((d) => `did work ${d} today`).join('\n');
  check('U16 cap=5 newest', bodyEventDates(body, F, T).map((e) => e.iso), ['2026-07-12', '2026-07-11', '2026-07-10', '2026-07-09', '2026-07-08']);
}
{
  const filler = 'x'.repeat(20050);
  check('U17 beyond 20k not scanned', isos('start\n' + filler + '\nmoved 7 Jul 2026'), []);
  check('U17b within 20k scanned', isos('moved 7 Jul 2026\n' + filler), ['2026-07-07']);
}
{
  // control bytes + a newline injected around the date must be collapsed away
  const input = 'moved 7 Jul 2026' + String.fromCharCode(0, 7) + '\ndone';
  const ev = bodyEventDates(input, F, T);
  const snip = ev[0]?.snippet ?? '';
  const hasCtrl = [...snip].some((ch) => { const c = ch.codePointAt(0); return c < 0x20 || c === 0x7f; });
  check('U19 snippet single line, no control bytes', hasCtrl, false);
  check('U19b event still found', ev.map((e) => e.iso), ['2026-07-07']);
}
{
  check('U21 BOM+CRLF frontmatter strip', bodyEventDates('﻿---\r\nupdated: 2026-01-01\r\n---\r\n# t\r\nmoved 7 Jul 2026', F, T).map((e) => e.iso), ['2026-07-07']);
}

// ── cookbook-review fixes ────────────────────────────────────────────────────
// #2/#4 mkUTC now validates day-of-month (no silent rollover into a phantom event)
check('F1 "31 Jun 2026" rolls over -> rejected (in-window)', bodyEventDates('milestone 31 Jun 2026 done', U(2026, 6, 1), U(2026, 6, 19)).map((e) => e.iso), []);
check('F1b "31 Apr 2026" rejected', bodyEventDates('closed 31 Apr 2026 here', U(2026, 3, 20), U(2026, 4, 10)).map((e) => e.iso), []);
check('F1c "29 Feb 2026" (non-leap) rejected', bodyEventDates('due 29 Feb 2026', U(2026, 1, 20), U(2026, 2, 10)).map((e) => e.iso), []);
check('F1d valid "28 Feb 2026" kept', bodyEventDates('due 28 Feb 2026', U(2026, 1, 20), U(2026, 2, 5)).map((e) => e.iso), ['2026-02-28']);
// #3 MAINTENANCE_RE narrowed: a real dated event is not dropped by a nearby ordinary word
check('F2 real event + unrelated "superseded" is KEPT', isos('DPIA filled 7 Jul 2026. The legacy schema was later superseded.'), ['2026-07-07']);
check('F2b "merged into" / "renamed to" no longer suppress', isos('Acme merged into Globex; the deal closed 7 Jul 2026.'), ['2026-07-07']);
check('F2c structural "merged from" still dropped', isos('## files (merged from "X Opportunities", 7 Jul 2026)'), []);
check('F2d structural "vault dedupe" still dropped', isos('the old file was removed in the 7 Jul 2026 vault dedupe'), []);
// #5 a day RANGE keeps its end date (leading hyphen preceded by a DIGIT)
check('F3 date range "5-7 Jul 2026" -> 7 Jul', isos('the summit ran 5-7 Jul 2026 downtown'), ['2026-07-07']);
check('F3-2 wider range "15-17 Jul 2026" -> 17 Jul', isos('workshop 15-17 Jul 2026 held'), ['2026-07-17']);
check('F3b ISO serial still rejected (trailing guard)', isos('clip 2026-07-10-12-52-58 rec'), []);
// re-review: a hyphen-prefixed serial/ID whose ISO date is the TERMINAL segment
// (letter before the '-') is a reference, not an event — must be rejected
check('F3c ISO serial "INC-2026-07-10" rejected', isos('ticket INC-2026-07-10 filed today'), []);
check('F3d ISO serial "PO-2026-07-14" rejected', isos('raised PO-2026-07-14 with vendor'), []);
check('F3e ISO serial "REF-2026-07-10" rejected', isos('see REF-2026-07-10 in tracker'), []);
check('F3f DMY serial "REF-7 Jul 2026" rejected', isos('REF-7 Jul 2026 filed in tracker'), []);
// #1 ReDoS: masking must stay LINEAR (not O(n^2)) on pathological unclosed "[" /
// "](" runs. Assert the RATIO (machine-independent), never a wall-clock budget
// (flaky across CI runners — the bug this test previously had).
{
  // (a) a no-digit run can't hold a date, so masking is skipped entirely → free.
  const t0 = process.hrtime.bigint();
  const nd = isos('['.repeat(20000));
  const ndMs = Number(process.hrtime.bigint() - t0) / 1e6;
  check('F4 no-digit "[" run: no event + skipped fast', nd.length === 0 && ndMs < 100, true);
  // (b) a date-bearing run hits the bounded mask; 4x the data must cost ~4x
  // (linear), not ~16x (quadratic). min-of-5 per size + warmup keeps it stable.
  const mk = (n) => '1 ' + '['.repeat(n); // leading digit → masking runs
  const best = (s) => { let m = Infinity; for (let i = 0; i < 5; i++) { const a = process.hrtime.bigint(); bodyEventDates(s, F, T); const d = Number(process.hrtime.bigint() - a) / 1e6; if (d < m) m = d; } return m; };
  best(mk(4000)); best(mk(16000)); // warm up JIT
  const t5 = best(mk(5000)), t20 = best(mk(20000));
  check('F4b masking scales linearly (4x data < 8x time), not quadratically', (t20 / t5) < 8, true);
  // (c) correctness preserved: an event before a "[" run is still found.
  check('F4c event before a "[" run still found', isos('moved 7 Jul 2026 ' + '['.repeat(2000)), ['2026-07-07']);
}

// ── parsePeriod: English (unchanged) + Arabic (P2 #6) ────────────────────────
const NOW = U(2026, 6, 24);
const per = (q) => { const p = parsePeriod(q, NOW); return p ? p.label : null; };
check('P-en last week', per('what did I do last week'), 'last week');
check('P-en last 3 days', per('notes from the last 3 days'), 'last 3 days');
check('P-en topical → null', per('what is the espresso ratio'), null);
check('P-ar yesterday (أمس)', per('ماذا فعلت أمس'), 'yesterday');
check('P-ar last week (الأسبوع الماضي)', per('ماذا عملت الأسبوع الماضي'), 'last week');
check('P-ar last month (الشهر الماضي)', per('الشهر الماضي'), 'last month');
check('P-ar recently (مؤخراً)', per('ما الذي تغيّر مؤخراً'), 'recently');
check('P-ar آخر ٧ أيام (Arabic-Indic digits)', per('آخر ٧ أيام'), 'last 7 days');
check('P-ar آخر أسبوعين', per('آخر أسبوعين'), 'last two weeks');
check('P-ar topical → null', per('ما هي نسبة الإسبريسو'), null);
check('P-ar daily (اليومية) NOT today', per('راجع المهام اليومية'), null);
check('P-ar fifth (الخامس) NOT yesterday', per('اقرأ الفصل الخامس'), null);
check('P-ar standalone اليوم still today', per('ماذا فعلت اليوم'), 'today');
check('P-ar standalone أمس still yesterday', per('ماذا حدث أمس'), 'yesterday');

// ── noteDateInfo — how a note gets its DATE ──────────────────────────────────
// This function had ZERO coverage, which is why two HIGH date bugs shipped in it.
// It decides what "what happened last week" returns, so being wrong here means
// answering confidently with the wrong notes.
const di = (p, text = '') => noteDateInfo(p, text);
const isoOf = (r) => (r ? new Date(r.ms).toISOString().slice(0, 10) : null);

// BUG 1: only the FIRST "D Word YYYY" match in the filename was examined, so a
// title whose first match is not a month ("Phase 2 rollout 2026") took the slot
// and the real trailing date our own memory/log namer appends was never seen.
check('date after a non-month "D Word YYYY" is still found',
  isoOf(di('Memory/Claude/2026/07 Jul/Phase 2 rollout 2026 - 26 Jul 2026.md')), '2026-07-26');
check('a plain trailing date still works',
  isoOf(di('Memory/Claude/2026/07 Jul/Session 26 Jul 2026.md')), '2026-07-26');

// BUG 2: the /YYYY/MM Mon/ folder date is always day 1 of the month and was
// evaluated BEFORE frontmatter, so a month-granular guess overrode a day-precise
// `updated:` stamp — and was then reported as high confidence.
const fm = '---\nupdated: 2026-07-19\n---\n\nbody\n';
check('day-precise frontmatter beats the day-1 folder date',
  isoOf(di('Memory/Claude/2026/07 Jul/Note.md', fm)), '2026-07-19');
check('and it is attributed to frontmatter, not the path',
  di('Memory/Claude/2026/07 Jul/Note.md', fm)?.source, 'front');
check('the folder date is still used when nothing else dates the note',
  isoOf(di('Memory/Claude/2026/07 Jul/Note.md', 'no frontmatter here\n')), '2026-07-01');
check('an undated note returns null', di('Knowledge/Espresso.md', 'no dates at all\n'), null);

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
