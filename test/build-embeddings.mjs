// Build the semantic index for a brain (downloads the model on first run).
import { Vault } from '../src/core/vault.ts';
import { loadTexts } from '../src/recall/engine.ts';
import { buildEmbeddings } from '../src/recall/semantic.ts';
const vault = Vault.open(process.argv[2]);
const t = await loadTexts(vault, false);
const t0 = Date.now();
const idx = await buildEmbeddings(vault, t.files, t.texts, (d, tot) => { if (d % 512 === 0 || d === tot) console.error(`  ${d}/${tot} chunks`); });
console.log(`embeddings: ${idx.chunks.length} chunks, ${idx.dims} dims, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
