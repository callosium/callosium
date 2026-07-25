// Objective RETRIEVAL axis: does the ENGINE surface an answer-bearing note, and
// how high? Compares the owner's own recall.mjs (his DIY engine) vs Callosium recall,
// on the gold questions, against the gold accept-paths. No LLM judge — pure
// context-recall@k + MRR (RAGAS "context recall" + rank). Isolates engine quality
// from the agent's reasoning.  node test/run-retrieval-compare.mjs
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VAULT = process.env.CALLOSIUM_BRAIN;
const RECALL_MJS = path.join(VAULT, 'Reference', 'Tools', 'recall', 'recall.mjs');
const CAL_MJS = path.join(repo, 'test', 'head2head-callosium.mjs');
const K = 5;

const { questions } = JSON.parse(await fs.readFile(path.join(repo, 'test', 'gold', 'questions.json'), 'utf8'));
const run = (file, args) => { try { return execFileSync('node', [file, ...args], { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { return e.stdout || ''; } };

// recall.mjs: ranked "  <score>  <path.md>" lines under TOP CANDIDATES
const parseDiy = (out) => {
  const lines = out.split('\n');
  const start = lines.findIndex((l) => /TOP CANDIDATES/i.test(l));
  const paths = [];
  if (start >= 0) for (const l of lines.slice(start + 1)) {
    const m = l.match(/^\s+[\d.]+\s+(.+\.md)\s*$/);
    if (m) paths.push(m[1].trim());
    else if (paths.length && l.trim() === '') break;
  }
  return paths;
};
// Callosium recall: "═ <path> [safety]" ranked lines
const parseCal = (out) => out.split('\n').map((l) => l.match(/^═\s+(.+?)\s+\[/)).filter(Boolean).map((m) => m[1].trim());

const hits = (paths, accept) =>
  paths.map((p) => accept.some((a) => (a.endsWith('.md') ? p === a : p === a || p.startsWith(a.replace(/\/$/, '') + '/'))));

let diyRecall = 0, calRecall = 0, diyMrrSum = 0, calMrrSum = 0;
const rows = [];
for (const q of questions) {
  const accept = q.accept || [];
  const diyP = parseDiy(run(RECALL_MJS, ['find', q.q])).slice(0, K);
  const calP = parseCal(run(CAL_MJS, ['recall', q.q])).slice(0, K);
  const diyHit = hits(diyP, accept), calHit = hits(calP, accept);
  const diyRank = diyHit.indexOf(true), calRank = calHit.indexOf(true);
  if (diyRank >= 0) { diyRecall++; diyMrrSum += 1 / (diyRank + 1); }
  if (calRank >= 0) { calRecall++; calMrrSum += 1 / (calRank + 1); }
  rows.push({ id: q.id, diy: diyRank >= 0 ? `#${diyRank + 1}` : 'miss', cal: calRank >= 0 ? `#${calRank + 1}` : 'miss' });
}

const n = questions.length;
console.log(`RETRIEVAL COMPARE — his recall.mjs vs Callosium recall, ${n} gold questions, top-${K}\n`);
console.log(`                     recall.mjs (DIY)   Callosium`);
console.log(`context-recall@${K}:   ${(100 * diyRecall / n).toFixed(0)}% (${diyRecall}/${n})          ${(100 * calRecall / n).toFixed(0)}% (${calRecall}/${n})`);
console.log(`MRR@${K}:             ${(diyMrrSum / n).toFixed(3)}              ${(calMrrSum / n).toFixed(3)}`);
console.log(`\nper question (rank of first answer-bearing note, or miss):`);
for (const r of rows) console.log(`  Q${String(r.id).padStart(2)}  DIY ${r.diy.padEnd(6)}  Callosium ${r.cal}`);
