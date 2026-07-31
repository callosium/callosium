// Regression test for the local-date / UTC-window skew (BL-10).
//
// Notes are NAMED AND STAMPED from LOCAL calendar parts (filing/engine.ts
// dateParts uses getFullYear/getMonth/getDate) and then re-read as UTC midnight
// (temporal.ts mkUTC). If parsePeriod anchors its window on the raw `now`
// timestamp instead of UTC-midnight-of-the-local-day, a user at a NEGATIVE UTC
// offset loses their own note from "today" once offset + local hour > 24. After
// ~5pm Pacific, "what did I do today" answered "nothing" about a note written an
// hour earlier.
//
// This cannot be caught by running the suite in one zone: GitHub runners are UTC,
// and UTC is immune. So each case runs in a CHILD process with TZ set, which
// makes the test fail on a UTC machine exactly as it would on a Pacific one.
//
// Both bounds are pinned: the instant (23:00 local on 30 Jul 2026) and the note's
// stamp (UTC midnight of 30 Jul 2026) are literals, so this never drifts.
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// The child imports by URL, not by path: on Windows a bare absolute path is
// rejected by the ESM loader as protocol 'c:'.
const TEMPORAL_URL = pathToFileURL(path.join(ROOT, 'src/recall/temporal.ts')).href;
let pass = 0, fail = 0;

const check = (name, ok, detail = '') => {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : `  ${detail}`));
  ok ? pass++ : fail++;
};

// Runs in a child so TZ actually applies. Returns the child's verdict.
function probe(tz) {
  const script = `
    import { parsePeriod } from ${JSON.stringify(TEMPORAL_URL)};
    // 23:00 local on 30 Jul 2026, in whatever zone TZ names. The local Date
    // constructor is what turns "23:00 here" into the right absolute instant.
    const now = new Date(2026, 6, 30, 23, 0, 0).getTime();
    // What filing/engine.ts stamps a note written at that instant: the LOCAL
    // calendar date, re-read as UTC midnight.
    const todayStamp = Date.UTC(2026, 6, 30);
    const yesterdayStamp = Date.UTC(2026, 6, 29);
    const inWindow = (w, stamp) => !!w && stamp >= w.fromMs && stamp < w.toMs;
    const t = parsePeriod('what did I do today', now);
    const y = parsePeriod('what did I do yesterday', now);
    const w = parsePeriod('what did I do in the last 7 days', now);
    console.log(JSON.stringify({
      offsetMinutes: new Date(now).getTimezoneOffset(),
      todayHolds: inWindow(t, todayStamp),
      yesterdayHolds: inWindow(y, yesterdayStamp),
      weekHolds: inWindow(w, todayStamp),
    }));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, TZ: tz },
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    return { error: (r.stderr || '').trim().split('\n').slice(-3).join(' | ') };
  }
  try {
    return JSON.parse((r.stdout || '').trim().split('\n').pop());
  } catch {
    return { error: `unparseable child output: ${(r.stdout || '').slice(0, 200)}` };
  }
}

// Negative offsets are the broken side; positive and zero are the controls that
// stayed green through three audit rounds and hid the bug.
const ZONES = [
  ['America/Los_Angeles', 'UTC-7 (PDT) — the reported failure'],
  ['America/New_York', 'UTC-4 (EDT) — minute-exact boundary in the audit'],
  ['Pacific/Honolulu', 'UTC-10 — the largest common negative offset'],
  ['UTC', 'control: immune, and what CI runs as'],
  ['Asia/Qatar', 'UTC+3 — control: why this was invisible from Doha'],
];

for (const [tz, why] of ZONES) {
  const r = probe(tz);
  if (r.error) {
    check(`${tz} (${why})`, false, r.error);
    continue;
  }
  check(`${tz} — today's note is in "today"`, r.todayHolds === true, `offset=${r.offsetMinutes}min got=${r.todayHolds}`);
  check(`${tz} — yesterday's note is in "yesterday"`, r.yesterdayHolds === true, `offset=${r.offsetMinutes}min got=${r.yesterdayHolds}`);
  check(`${tz} — today's note is in "last 7 days"`, r.weekHolds === true, `offset=${r.offsetMinutes}min got=${r.weekHolds}`);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail === 0) console.log('  ALL PASS');
process.exit(fail === 0 ? 0 : 1);
