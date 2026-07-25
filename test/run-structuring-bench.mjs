// Structuring-quality benchmark. Two ways to run it:
//
//   node test/run-structuring-bench.mjs
//       Deterministic self-consistency check (CI-safe, no LLM): given the CORRECT
//       type for each labeled case, does the filing machinery + rules land it in
//       the right partition — and are sensitive cases gated to Private/? This is
//       the floor: it proves the rules and the router agree on the ground truth.
//
//   node test/run-structuring-bench.mjs --decisions <file.json>
//       Score a REAL LLM structuring run. <file.json> is { "<caseId>": "<filed/path.md>" }
//       — the write_note path the AI chose for each raw input. Placement is scored
//       against expectedPartition / expectedPathPrefix; privacy against Private/.
//       This is how you measure whether the LLM (not the router) structures well.
//
// The raw inputs live in test/structuring-bench.json (synthetic, safe to ship).

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Vault } from '../src/core/vault.ts';
import { loadSchema } from '../src/core/schema.ts';
import { routeNote } from '../src/filing/engine.ts';
import { generateFilingRules } from '../src/structure/map.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { cases } = JSON.parse(await fs.readFile(path.join(repo, 'test', 'structuring-bench.json'), 'utf8'));
const top = (p) => String(p).split('/')[0];

// Load the default schema (a fresh dir has no brain.json → default).
const tmp = path.join(os.tmpdir(), 'callosium-struct-bench-' + process.pid);
await fs.mkdir(tmp, { recursive: true });
const { schema } = await loadSchema(Vault.open(tmp));
const rules = generateFilingRules(schema);
await fs.rm(tmp, { recursive: true, force: true });

const dArg = process.argv.indexOf('--decisions');
const decisions = dArg >= 0 ? JSON.parse(await fs.readFile(path.resolve(process.argv[dArg + 1]), 'utf8')) : null;

let placePass = 0, placeN = 0, privPass = 0, privN = 0, explPass = 0, explN = 0;
const fails = [];

for (const c of cases) {
  if (c.mode === 'typed') {
    placeN++;
    const got = decisions
      ? top(decisions[c.id] || '')                                    // LLM's real placement
      : top(routeNote(schema, { type: c.type, title: c.title, source: 'Owner' }).path); // router's placement
    if (got === c.expectedPartition) placePass++;
    else fails.push(`PLACE ${c.id}: ${decisions ? 'AI filed to' : c.type + ' routes to'} "${got || '(none)'}", expected ${c.expectedPartition}`);
  } else if (c.mode === 'explicit') {
    explN++;
    if (decisions) {
      const p = decisions[c.id] || '';
      if (p.startsWith(c.expectedPathPrefix + '/')) explPass++;
      else fails.push(`EXPLICIT ${c.id}: AI filed to "${p || '(none)'}", expected an explicit path under ${c.expectedPathPrefix}/`);
    } else {
      // No-LLM floor: a project/hub type has no auto-home, so the router MUST fall
      // back to Inbox (which is exactly why the AI has to pass an explicit path),
      // and the rules MUST say so.
      const goesToInbox = top(routeNote(schema, { type: c.type, title: c.title, source: 'Owner' }).path) === 'Inbox';
      const rulesSayExplicit = /explicit/i.test(rules) && /\bpath\b/i.test(rules) && /no home of its own/i.test(rules);
      if (goesToInbox && rulesSayExplicit) explPass++;
      else fails.push(`EXPLICIT ${c.id}: ${c.type} did not fall back to Inbox / rules don't instruct an explicit path`);
    }
  } else if (c.mode === 'sensitive') {
    privN++;
    if (decisions) {
      if (top(decisions[c.id] || '') === c.expectedPartition) privPass++;
      else fails.push(`PRIVACY ${c.id}: AI filed sensitive "${c.topic}" to "${top(decisions[c.id] || '') || '(none)'}", expected Private`);
    } else {
      // No-LLM floor: routeNote by type can NEVER reach Private (no case for it),
      // so gating must come from the SENSITIVE rule. Assert the rules gate it.
      const gated = /## SENSITIVE/.test(rules) && /\*\*Private\/\*\*/.test(rules);
      const topicNamed = rules.toLowerCase().includes(String(c.topic).toLowerCase()) || /health|medical|intimate|identity/i.test(rules);
      if (gated && topicNamed) privPass++;
      else fails.push(`PRIVACY ${c.id}: topic "${c.topic}" not clearly gated to Private/ by the rules`);
    }
  }
}

const mode = decisions ? `LLM run (${process.argv[dArg + 1]})` : 'deterministic self-consistency (no LLM)';
console.log(`STRUCTURING BENCH — ${mode}\n`);
console.log(`Placement (typed notes → right partition):        ${placePass}/${placeN}`);
console.log(`Explicit-path (client/project/hub not auto-filed): ${explPass}/${explN}`);
console.log(`Privacy gating (sensitive → Private/):             ${privPass}/${privN}`);
if (fails.length) { console.log('\nFAILURES:'); for (const f of fails) console.log('  ✗ ' + f); }
const totalPass = placePass + explPass + privPass, totalN = placeN + explN + privN;
console.log(`\nTOTAL: ${totalPass}/${totalN}`);
if (!decisions) {
  console.log('\nThis is the deterministic FLOOR (rules ⇄ router agree on the labels). To measure');
  console.log('LLM structuring quality on the raw inputs, run an AI over them via the MCP flow and');
  console.log('score its chosen paths: node test/run-structuring-bench.mjs --decisions <id→path.json>');
}
process.exit(fails.length ? 1 : 0);
