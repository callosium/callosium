// Date-range retrieval — the "what did I do yesterday / last 5 days / last two
// weeks" daily-driver. Dense retrievers over-index on TOPIC and under-encode
// TIME (they rank an April note highly for a "last 5 days" query); the fix is
// deterministic date-aware retrieval, not a model (measured: temporal intent is
// regex, not semantic — see project-callosium-temporal-intent). This is a
// SEPARATE capability from the certified recall() ranking, so it can't regress it.

const MONTHS: Record<string, number> = {
  january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2, april: 3, apr: 3, may: 4,
  june: 5, jun: 5, july: 6, jul: 6, august: 7, aug: 7, september: 8, sep: 8, sept: 8,
  october: 9, oct: 9, november: 10, nov: 10, december: 11, dec: 11,
};
const DAY = 86_400_000;

/** The note's real DATE (epoch ms) — from frontmatter, else the path/filename,
 *  else null. NOT mtime: a cloud-sync or a bulk vault-audit touches mtime, so
 *  mtime says "recent" for notes that didn't change (the exact "movement in the
 *  last two weeks" trap). Callers may fall back to mtime, but flagged. */
export type DateSource = 'name' | 'path' | 'front';
/** The note's date PLUS where it came from. A `name`/`path` date is when the
 *  work happened (a session log / memory record / dated note) — high-confidence
 *  activity. A `front` date is the frontmatter `updated` stamp, which a later
 *  edit OR a bulk vault-audit moves — so many notes sharing one `front` date is a
 *  bulk touch, not individual movement (the "what moved this fortnight" trap). */
/** Date.UTC but only for a REAL calendar date — rejects an out-of-range OR
 *  non-existent day. Date.UTC silently ROLLS OVER ("2026-13-05" → 2027-01-05,
 *  "31 Apr" → 1 May, "29 Feb 2026" (not a leap year) → 1 Mar), which would
 *  surface a nonexistent prose date as a real (possibly in-window) event. So we
 *  build the date and confirm the month/day came back unchanged. */
function mkUTC(y: number, month1: number, day: number): number | null {
  if (!(month1 >= 1 && month1 <= 12 && day >= 1 && day <= 31)) return null;
  const ms = Date.UTC(y, month1 - 1, day);
  const d = new Date(ms);
  return d.getUTCMonth() === month1 - 1 && d.getUTCDate() === day ? ms : null;
}

export function noteDateInfo(path: string, text: string): { ms: number; source: DateSource } | null {
  const base = path.split('/').pop() || '';
  const fn = base.match(/\b(\d{1,2})\s+([A-Za-z]+)\s+(20\d{2})\b/);
  if (fn && MONTHS[fn[2].toLowerCase()] != null) { const ms = mkUTC(+fn[3], MONTHS[fn[2].toLowerCase()] + 1, +fn[1]); if (ms != null) return { ms, source: 'name' }; }
  const iso = base.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) { const ms = mkUTC(+iso[1], +iso[2], +iso[3]); if (ms != null) return { ms, source: 'name' }; }
  const pm = path.match(/\/(20\d{2})\/(\d{2})\s+[A-Za-z]{3}\//);
  if (pm) { const ms = mkUTC(+pm[1], +pm[2], 1); if (ms != null) return { ms, source: 'path' }; }
  // Only the YAML FRONTMATTER block — not the whole head — so a prose body line
  // like "Date: 3 May 2026 recap" is never mistaken for the note's date.
  const fmBlock = text.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---/);
  const block = fmBlock ? fmBlock[1] : '';
  for (const key of ['updated', 'date', 'created']) {
    const m = block.match(new RegExp(`^${key}:\\s*["']?([^"'\\n]+)`, 'mi'));
    if (m) { const d = parseDateStr(m[1].trim()); if (d != null) return { ms: d, source: 'front' }; }
  }
  return null;
}

export function noteDateMs(path: string, text: string): number | null {
  return noteDateInfo(path, text)?.ms ?? null;
}

function parseDateStr(s: string): number | null {
  const iso = s.match(/^(20\d{2})-(\d{2})-(\d{2})/);
  if (iso) return mkUTC(+iso[1], +iso[2], +iso[3]);
  const dm = s.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(20\d{2})/);
  if (dm && MONTHS[dm[2].toLowerCase()] != null) return mkUTC(+dm[3], MONTHS[dm[2].toLowerCase()] + 1, +dm[1]);
  return null;
}

/** Parse a relative period expression from a question into a [from, to] window.
 *  Deterministic — no LLM. `now` passed in (the server has Date.now; workflows
 *  don't). Returns null when the question carries no time-window cue. */
/** Fold Arabic-Indic (٠-٩) and Extended/Persian (۰-۹) digits to ASCII so the numeric-N patterns
 *  below match a question typed in Arabic. No-op for ASCII text. */
function foldDigits(s: string): string {
  return s
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

export function parsePeriod(question: string, now: number): { fromMs: number; toMs: number; label: string } | null {
  const q = foldDigits(question.toLowerCase());
  const to = now + DAY; // inclusive of today
  const win = (days: number, label: string) => ({ fromMs: now - days * DAY, toMs: to, label });
  // explicit "last/past N days|weeks|months"
  const nWord: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, a: 1, couple: 2, few: 3 };
  const m = q.match(/\b(?:last|past|previous|recent)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|a|couple(?:\s+of)?|few)\s+(day|days|week|weeks|month|months)\b/);
  if (m) {
    const n = /^\d+$/.test(m[1]) ? +m[1] : (nWord[m[1].replace(/\s+of$/, '')] ?? 1);
    const unit = m[2].startsWith('week') ? 7 : m[2].startsWith('month') ? 30 : 1;
    return win(n * unit, `last ${n} ${m[2].replace(/s$/, '')}${n === 1 ? '' : 's'}`);
  }
  // Arabic "آخر N يوم/أسبوع/شهر" (last N days/weeks/months). Arabic has no \b word boundary, so we
  // anchor on the phrase itself. Runs before the English single-word checks; ASCII questions never hit it.
  const am = q.match(/(?:آخر|اخر|خلال|في\s*آخر)\s*(\d+)\s*(يوم|أيام|ايام|أسبوع|اسبوع|أسابيع|اسابيع|شهر|أشهر|اشهر|شهور)/);
  if (am) {
    const n = +am[1];
    const u = am[2];
    const unit = /(أسبوع|اسبوع|أسابيع|اسابيع)/.test(u) ? 7 : /(شهر|أشهر|اشهر|شهور)/.test(u) ? 30 : 1;
    return win(n * unit, `last ${n} ${unit === 7 ? 'weeks' : unit === 30 ? 'months' : 'days'}`);
  }
  // Arabic short words need letter-boundary lookarounds (there is no \b for Arabic): bare "امس"
  // (yesterday) is a substring of "خامس" (fifth) and "اليوم" (today) is a prefix of "اليومي/اليومية"
  // (daily) — without boundaries, ordinal/"daily" topical questions would force a false window.
  if (/\byesterday\b/.test(q) || /(?<![ء-ي])(أمس|امس)(?![ء-ي])|(البارحة|مبارح|امبارح)/.test(q)) return { fromMs: now - 2 * DAY, toMs: now, label: 'yesterday' };
  if (/\b(today|so far today)\b/.test(q) || /(?<![ء-ي])اليوم(?![ء-ي])|النهاردة/.test(q)) return { fromMs: now - DAY, toMs: to, label: 'today' };
  // two weeks BEFORE one week — Arabic "أسبوعين" (dual) starts with "أسبوع", so it must be tested first.
  if (/\b(last|past|this|previous)\s+(fortnight|two weeks)\b/.test(q) || /\btwo weeks\b/.test(q) || /(أسبوعين|اسبوعين)/.test(q)) return win(14, 'last two weeks');
  if (/\b(last|past|this|previous)\s+(week)\b/.test(q) || /(الأسبوع|الاسبوع)\s*(الماضي|الفائت|المنصرم|الحالي|ده)|آخر\s*(أسبوع|اسبوع)/.test(q)) return win(7, 'last week');
  if (/\b(last|past|this|previous)\s+month\b/.test(q) || /\bthis month\b/.test(q) || /(الشهر)\s*(الماضي|الفائت|المنصرم|الحالي|ده)|آخر\s*شهر/.test(q)) return win(31, 'last month');
  if (/\b(lately|recently|of late|these days|nowadays)\b/.test(q) || /(مؤخرا|مؤخراً|هذه\s*الأيام|هالأيام|في\s*الآونة|الآونة\s*الأخيرة)/.test(q)) return win(14, 'recently');
  return null;
}

/** A short label for a note in a timeline: its first REAL heading (skipping any
 *  `#` line inside a ``` / ~~~ code fence, which is a comment, not a heading),
 *  else the basename. */
export function noteTitle(path: string, text: string): string {
  let inFence = false;
  for (const line of text.split('\n')) {
    const t = line.trimStart();
    if (/^(```|~~~)/.test(t)) { inFence = !inFence; continue; }
    if (!inFence) { const h = line.match(/^#\s+(.+?)\s*$/); if (h) return h[1].trim().slice(0, 90); }
  }
  return (path.split('/').pop() || '').replace(/\.md$/, '');
}

// ── content-level dated-event detection (event-time, not document-time) ──────
// A note's file/frontmatter date is DOCUMENT-time: when the file was last touched.
// But the real activity — "the DPIA was filled 7 Jul" — is often an EVENT-time
// written into the PROSE, while the file's own date is stale or bulk-restamped.
// (This is the recognized event-time vs document-time gap in temporal RAG:
// document timestamps don't capture fact-level validity.) `recent` uses this to
// surface a note whose body records a dated event in the window even when its
// file date is older, and to lift a genuinely-worked-on note out of the [bulk]
// tier. Deterministic (regex, per [[project-callosium-temporal-intent]]), not a
// model. This is a SEPARATE capability from recall() ranking and never touches it.

/** Blank out spans a date must NOT be read from — fenced/inline code, wikilink
 *  targets, markdown-link targets, and URLs — PRESERVING length so a match
 *  offset still indexes the original body (snippets come from the original).
 *  Fences are marker-tracked (a ``` block only closes on a matching ```), so a
 *  fenced JSON `"date":"2026-07-07"` never leaks as an event. */
function maskNonProse(body: string): string {
  const blank = (s: string) => ' '.repeat(s.length);
  let inFence = false;
  let fenceMark = '';
  const out: string[] = [];
  for (const line of body.split('\n')) {
    const fence = line.match(/^\s*(```+|~~~+)/);
    if (fence) {
      if (!inFence) { inFence = true; fenceMark = fence[1][0]; }
      else if (fence[1][0] === fenceMark) { inFence = false; fenceMark = ''; }
      out.push(blank(line));
      continue;
    }
    if (inFence) { out.push(blank(line)); continue; }
    // A line with NO digit cannot contain a date (every pattern needs a day +
    // 4-digit year), so masking it is pointless — skip it. This makes the common
    // pathological input (a long run of "[" with no digit) O(n) for free; the
    // bounded quantifiers below still cap a crafted date-bearing "[" run.
    if (!/\d/.test(line)) { out.push(line); continue; }
    let m = line;
    // Bounded inner quantifiers: an unclosed run of "[[" / "](" would otherwise
    // backtrack O(n^2) as the global match retries at each start position. A
    // fixed cap makes each start O(cap) → linear; real wikilinks/links are far
    // shorter than the cap, so nothing legitimate is left unmasked.
    m = m.replace(/`[^`\n]+`/g, blank); // inline code (+ can't blow up: fails fast on a delimiter run)
    m = m.replace(/\[\[[^\]\n]{0,300}\]\]/g, blank); // wikilink (target may hold a filename date)
    m = m.replace(/\]\([^)\n]{0,1000}\)/g, blank); // markdown-link target (URLs can be long)
    m = m.replace(/(?:https?:\/\/|www\.)[^\s)\]>]+/gi, blank); // bare URL / autolink
    out.push(m);
  }
  return out.join('\n');
}

/** True when a date match at [start,end) in `body` is GLUED to a filename,
 *  path, or serial (so it's a reference, not a prose event): a preceding
 *  path/word char, a trailing file extension (".md"), or a trailing
 *  timestamp/serial ("-12", ":30", "T14"). Keeps sentence-final "7 Jul 2026."
 *  and "7 Jul 2026:" (period/colon not followed by a digit). */
function gluedToToken(body: string, start: number, end: number, isISO: boolean): boolean {
  const prev = start > 0 ? body[start - 1] : '';
  // Leading '-': only a MONTH-NAME date can be a day RANGE end ("summit ran 5-7
  // Jul 2026" → keep 7 Jul), and only when a DIGIT precedes the '-'. An ISO date
  // after a '-' is always a serial/ID ("INC-2026-07-10", "Q3-2026-07-10"), as is
  // a month-name date after a letter-'-' ("REF-7 Jul 2026") → glue (a reference,
  // not a prose event; the trailing guard misses these because the ISO date ends
  // the token instead of continuing with -digit/:/T).
  if (prev === '-') {
    const before = start > 1 ? body[start - 2] : '';
    if (isISO || !/\d/.test(before)) return true;
  } else if (/[A-Za-z0-9/\\._:@]/.test(prev)) {
    return true;
  }
  const next = body.slice(end, end + 2);
  return /^\.[A-Za-z0-9]/.test(next) || /^[-:T]\d/.test(next);
}

export interface BodyEvent { ms: number; iso: string; snippet: string }

// Vault-PLUMBING annotations, not user activity: a bulk vault-audit writes lines
// like "(merged from "X Opportunities", 7 Jul 2026)", "renamed from Untitled… on
// 7 Jul", "removed in the 7 Jul vault dedupe" INTO note bodies on the audit date.
// Those are structural bookkeeping — surfacing them as "real movement" is exactly
// the false positive the audit date already earns via [bulk]. A dated event whose
// context is one of these is NOT counted as movement (the note still appears via
// its own file date if it qualifies; this only stops a false tier-0 promotion).
// Deliberately UNAMBIGUOUS-STRUCTURAL only: "merged FROM"/"renamed FROM"/"vault
// <op>"/"health check"/"adopted during"/"removed in the …". Bare business words
// ("superseded", "merged into", "renamed to", "deduped") are NOT here — they wrongly
// dropped real dated events ("… signed 7 Jul; old pricing superseded"). Every real
// audit annotation still carries one of these structural phrases.
const MAINTENANCE_RE = /\b(?:merged\s+from|renamed\s+from|vault\s+(?:health|audit|dedupe|cleanup)|health\s+check|adopted\s+during|removed\s+in\s+the)\b/i;

/** Deterministic dated EVENTS found in a note's prose within [fromMs, toMs].
 *  Frontmatter-stripped, code/link/URL-masked, filename-glue-guarded, 4-digit-
 *  year required (no bare "7 Jul" → avoids false hits; the window bounds the
 *  rest). Deduped by ISO date, newest-first, capped. Scans only the first
 *  `scanChars` chars so a mega-doc can't blow the cost. Snippets are windowed
 *  and sanitized (single line, no control bytes, codepoint-safe length). */
export function bodyEventDates(text: string, fromMs: number, toMs: number, cap = 5, scanChars = 20_000): BodyEvent[] {
  const fmStripped = text.replace(/^﻿?---[\s\S]*?\r?\n---\r?\n?/, '');
  const body = fmStripped.slice(0, scanChars);
  const masked = maskNonProse(body);
  const found = new Map<string, BodyEvent>(); // iso → event (first occurrence wins)
  const record = (ms: number | null, start: number, end: number, isISO: boolean) => {
    if (ms == null || ms < fromMs || ms > toMs) return;
    if (gluedToToken(body, start, end, isISO)) return;
    // Skip vault-plumbing annotations (merge/rename/dedupe/health-check). Check a
    // context window wide enough that a "merged from "<long entity>", 7 Jul"
    // phrase before the date, or a "vault dedupe" just after it, is caught — but
    // tight enough not to reach an unrelated neighbouring sentence.
    if (MAINTENANCE_RE.test(body.slice(Math.max(0, start - 140), end + 50))) return;
    const iso = new Date(ms).toISOString().slice(0, 10);
    if (found.has(iso)) return;
    let s = body.slice(Math.max(0, start - 70), end + 70)
      .replace(/\uFEFF/g, "")
      .replace(/[\u0000-\u001F\u007F]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const cp = [...s];
    if (cp.length > 160) s = cp.slice(0, 159).join('') + '…';
    found.set(iso, { ms, iso, snippet: s });
  };
  let m: RegExpExecArray | null;
  // A: "D[th] Month[.] YYYY"  (dominant native form: "7 Jul 2026", "9 June 2026")
  const reDMY = /(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?\s+(20\d{2})/g;
  while ((m = reDMY.exec(masked))) {
    const mon = MONTHS[m[2].toLowerCase()];
    if (mon != null) record(mkUTC(+m[3], mon + 1, +m[1]), m.index, m.index + m[0].length, false);
  }
  // B: "Month[.] D[th][,] YYYY"  (imported/prose form: "March 9, 2026", "Sep 25 2025")
  const reMDY = /([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})/g;
  while ((m = reMDY.exec(masked))) {
    const mon = MONTHS[m[1].toLowerCase()];
    if (mon != null) record(mkUTC(+m[3], mon + 1, +m[2]), m.index, m.index + m[0].length, false);
  }
  // C: ISO "YYYY-MM-DD"  (frontmatter-echoed / prose ISO; code-fenced ones masked)
  const reISO = /(20\d{2})-(\d{2})-(\d{2})/g;
  while ((m = reISO.exec(masked))) {
    record(mkUTC(+m[1], +m[2], +m[3]), m.index, m.index + m[0].length, true);
  }
  return [...found.values()].sort((a, b) => b.ms - a.ms).slice(0, cap);
}
