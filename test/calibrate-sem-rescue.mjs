// Calibrate RETRIEVAL_SCHEMA.semanticRescueMin — the cosine floor at which the
// semantic lane may confirm an answer whose named term is absent from the vault.
//
//   CALLOSIUM_GATE_PROBE=1 node test/calibrate-sem-rescue.mjs "<brain>" \
//     test/scenarios-v4-final.json test/scenarios-paraphrase.json
//
// The threshold separates two populations that lexical absent-mass CANNOT tell
// apart (both are one absent high-idf word plus filler):
//   negative family   nonsense entities   → must stay REFUSED
//   paraphrase family real notes, synonym → must be ANSWERED
// So we measure the top note's cosine on both and print where they separate.
//
// EXACT SWEEP, TWO PASSES. Every query runs twice: once with the cosine door
// shut (threshold 2 — unreachable) and once with it wide open (threshold -1).
// The cosine itself is deterministic and identical in both passes, so the
// outcome at any threshold T is simply "open-pass result if score ≥ T, else
// shut-pass result". That replays every candidate T exactly — including the
// SECOND honesty refusal further down recall() (the weak-scattered-matches
// branch), which a gate-1-only simulation would have quietly assumed away.
//
// One residual approximation: a refused query re-runs itself with its weakest
// word dropped, and that RELAXED query has its own cosine, which a mid-sweep
// threshold could treat differently than either pass did. So the sweep picks the
// candidate; the authoritative number is a real full-bench run at that value.

import { promises as fs } from 'node:fs';
import { Vault } from '../src/core/vault.ts';
import { loadTexts, recall, _gateProbe } from '../src/recall/engine.ts';
import { buildGraph } from '../src/graph/index.ts';
import { loadEmbeddings, semanticLaneScored } from '../src/recall/semantic.ts';

if (!_gateProbe) throw new Error('set CALLOSIUM_GATE_PROBE=1');

const brainPath = process.argv[2];
const files = process.argv.slice(3);
if (!files.length) throw new Error('pass at least one scenarios json');

const vault = Vault.open(brainPath);
const texts = await loadTexts(vault);
const { index: graph } = await buildGraph(vault);
const emb = await loadEmbeddings(vault);
if (!emb) throw new Error('no embeddings for this brain — build them first (node test/build-embeddings.mjs <brain>)');
console.error(`embeddings: ${emb.chunks.length} chunks`);

// Only the two families the threshold arbitrates between.
const WANT = new Set(['negative', 'paraphrase']);
const scenarios = [];
for (const f of files) {
  const { scenarios: ss } = JSON.parse(await fs.readFile(f, 'utf8'));
  scenarios.push(...ss.filter((s) => WANT.has(s.family)));
}
const nNeg = scenarios.filter((s) => s.family === 'negative').length;
const nPar = scenarios.filter((s) => s.family === 'paraphrase').length;
console.error(`${scenarios.length} scenarios (${nNeg} negative, ${nPar} paraphrase)`);

/** A family's own definition of a good outcome. */
const scored = (s, a) =>
  s.family === 'negative'
    ? { ok: !a.found, answered: a.found }
    : { ok: a.found && (a.results ?? []).slice(0, 5).some((r) => r.path === s.target), answered: a.found };

async function pass(threshold, label) {
  process.env.CALLOSIUM_SEM_RESCUE_MIN = String(threshold);
  const out = [];
  let done = 0;
  for (const s of scenarios) {
    _gateProbe.log.length = 0;
    const a = await recall(s.question, texts, graph, false, emb);
    // log[0] is THIS query's own gate decision: recall() only recurses after the
    // gate (drop-tokens relaxation), and neither family is a comparison split.
    const g = _gateProbe.log[0] ?? null;
    out.push({ family: s.family, ...scored(s, a), g });
    if (++done % 250 === 0) console.error(`  ${label}: ${done}/${scenarios.length}`);
  }
  return out;
}

console.error('pass 1/2 — cosine door SHUT (current shipped behavior)');
const shut = await pass(2, 'shut');
console.error('pass 2/2 — cosine door OPEN (rescue whenever the lane is eligible)');
const open = await pass(-1, 'open');

const rows = scenarios.map((s, i) => ({
  family: s.family,
  score: shut[i].g?.semTopScore ?? 0,
  absentMass: shut[i].g?.absentMass ?? 0,
  gateFires: shut[i].g?.gateFires ?? false,
  semEligible: shut[i].g?.semEligible ?? false,
  shut: shut[i],
  open: open[i],
}));
const neg = rows.filter((r) => r.family === 'negative');
const par = rows.filter((r) => r.family === 'paraphrase');

/** Queries the threshold can actually move: the two passes disagree. */
const contested = (rs) => rs.filter((r) => r.shut.ok !== r.open.ok || r.shut.answered !== r.open.answered);

const quantiles = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
  return { n: s.length, min: s[0], p05: q(0.05), p25: q(0.25), p50: q(0.5), p75: q(0.75), p95: q(0.95), p99: q(0.99), max: s[s.length - 1] };
};
const show = (label, qs) =>
  console.log(
    qs
      ? `${label.padEnd(24)} n=${String(qs.n).padStart(5)}  min=${qs.min.toFixed(3)} p05=${qs.p05.toFixed(3)} p25=${qs.p25.toFixed(3)} p50=${qs.p50.toFixed(3)} p75=${qs.p75.toFixed(3)} p95=${qs.p95.toFixed(3)} p99=${qs.p99.toFixed(3)} max=${qs.max.toFixed(3)}`
      : `${label.padEnd(24)} (none)`,
  );

console.log('\n════════ SEMANTIC-RESCUE THRESHOLD CALIBRATION ════════');
console.log(`Brain: ${brainPath}`);
console.log(`\n— TOP-NOTE COSINE, ALL QUERIES —`);
show('negative (nonsense)', quantiles(neg.map((r) => r.score)));
show('paraphrase (synonym)', quantiles(par.map((r) => r.score)));

const cNeg = contested(neg), cPar = contested(par);
console.log(`\n— TOP-NOTE COSINE, CONTESTED ONLY (the two passes disagree) —`);
show('negative contested', quantiles(cNeg.map((r) => r.score)));
show('paraphrase contested', quantiles(cPar.map((r) => r.score)));
console.log(
  `contested share: negative ${cNeg.length}/${neg.length} (${((cNeg.length / Math.max(neg.length, 1)) * 100).toFixed(1)}%), ` +
    `paraphrase ${cPar.length}/${par.length} (${((cPar.length / Math.max(par.length, 1)) * 100).toFixed(1)}%)`,
);

const at = (r, T) => (r.score >= T ? r.open : r.shut);
const rateOk = (rs, T) => (rs.filter((r) => at(r, T).ok).length / Math.max(rs.length, 1)) * 100;
const rateAnswered = (rs, T) => (rs.filter((r) => at(r, T).answered).length / Math.max(rs.length, 1)) * 100;

// The floor defaults to the shut-door rate MEASURED IN THIS RUN, not to a number
// quoted from an older report card. A remembered figure can have been measured on
// a different embedder — or, as happened here, on a brain whose embedding cache
// was version-stale and therefore had no semantic lane at all. Measure the
// baseline, then require the change not to fall below it. CALIB_NEG_FLOOR
// overrides when a deliberate trade is on the table.
const shutNegBaseline = (neg.filter((r) => r.shut.ok).length / Math.max(neg.length, 1)) * 100;
const GATE = Number(process.env.CALIB_NEG_FLOOR ?? shutNegBaseline);
console.log(`\n— SWEEP —   (negatives refused must stay ≥ ${GATE.toFixed(1)}%${process.env.CALIB_NEG_FLOOR ? ' — overridden' : ' — this run’s measured baseline'})`);
console.log('threshold   negatives refused     paraphrase pass (top-5)   paraphrase answered');
let best = null;
for (let i = 70; i <= 100; i++) {
  const T = i / 100;
  const negRef = rateOk(neg, T), parPass = rateOk(par, T), parAns = rateAnswered(par, T);
  const ok = negRef >= GATE;
  console.log(`  ${T.toFixed(2)}       ${negRef.toFixed(1)}%${ok ? ' ✓' : ' ✗'}               ${parPass.toFixed(1)}%                    ${parAns.toFixed(1)}%`);
  if (ok && (!best || parPass > best.parPass || (parPass === best.parPass && T > best.T))) best = { T, negRef, parPass, parAns };
}
const shutNeg = rateOk(neg, Infinity), shutPar = rateOk(par, Infinity), shutParAns = rateAnswered(par, Infinity);
console.log(`\nbaseline (door shut = shipped): negatives refused ${shutNeg.toFixed(1)}%, paraphrase pass ${shutPar.toFixed(1)}%, answered ${shutParAns.toFixed(1)}%`);
console.log(`door wide open:                negatives refused ${rateOk(neg, -1).toFixed(1)}%, paraphrase pass ${rateOk(par, -1).toFixed(1)}%, answered ${rateAnswered(par, -1).toFixed(1)}%`);
console.log(
  best
    ? `\nBEST threshold keeping negatives ≥ ${GATE.toFixed(1)}%: ${best.T.toFixed(2)} → negatives refused ${best.negRef.toFixed(1)}%, paraphrase pass ${best.parPass.toFixed(1)}% (baseline ${shutPar.toFixed(1)}%), answered ${best.parAns.toFixed(1)}%`
    : `\nNO threshold keeps negatives ≥ ${GATE.toFixed(1)}% — SHIP NOTHING, keep the absent-mass guard as shipped.`,
);

// ── the ceiling above the gate ────────────────────────────────────────────
// A threshold can only rescue an answer retrieval already surfaced. If the
// semantic lane doesn't rank the right note in its head, no honesty rule
// reaches it — so measure that separately, or a disappointing sweep gets blamed
// on the gate when the gap is upstream.
const parScen = scenarios.filter((s) => s.family === 'paraphrase' && s.target);
if (parScen.length) {
  const ranks = [];
  for (const s of parScen) {
    const lane = (await semanticLaneScored(emb, s.question, 200)).filter(([p]) => texts.texts.has(p));
    const i = lane.findIndex(([p]) => p === s.target);
    ranks.push({ rank: i < 0 ? Infinity : i + 1, gap: i < 0 ? null : lane[0][1] - lane[i][1] });
  }
  const pc = (f) => ((ranks.filter(f).length / ranks.length) * 100).toFixed(1);
  const gaps = ranks.filter((r) => r.gap !== null).map((r) => r.gap).sort((a, b) => a - b);
  console.log(`\n— UPSTREAM CEILING: where the paraphrase target sits in the semantic lane (n=${ranks.length}) —`);
  console.log(`  rank 1 ${pc((r) => r.rank === 1)}%   top-3 ${pc((r) => r.rank <= 3)}%   top-10 ${pc((r) => r.rank <= 10)}%   top-50 ${pc((r) => r.rank <= 50)}%   missing ${pc((r) => r.rank === Infinity)}%`);
  if (gaps.length) console.log(`  cosine gap lane#1 − target: min=${gaps[0].toFixed(3)} med=${gaps[Math.floor(gaps.length / 2)].toFixed(3)} max=${gaps[gaps.length - 1].toFixed(3)}`);
  console.log(`  (the rescue is gated on the top note being in the lane's TOP 3 — that share is the hard ceiling on anything this threshold can recover)`);
}

if (process.env.CALIB_DUMP) {
  await fs.writeFile(process.env.CALIB_DUMP, JSON.stringify(rows));
  console.error(`wrote ${rows.length} probed rows → ${process.env.CALIB_DUMP}`);
}
