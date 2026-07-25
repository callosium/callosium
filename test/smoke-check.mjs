import { Vault } from '../src/core/vault.ts';
import { brainCheck } from '../src/check/check.ts';

const vault = Vault.open(process.argv[2]);
const r = await brainCheck(vault);
console.log(`brain check: ${r.notes} notes, ${r.edges} edges, schema=${r.schemaSource}, ${r.ms}ms`);
console.log('Findings:', JSON.stringify(r.byKind, null, 2));
for (const kind of Object.keys(r.byKind)) {
  const sample = r.findings.filter(f => f.kind === kind).slice(0, 3);
  console.log(`\n${kind}:`);
  for (const f of sample) console.log(`  ${f.path} — ${f.detail.slice(0, 110)}`);
}
