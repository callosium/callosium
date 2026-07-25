// Copies the runtime's non-TS files into dist/ after tsc emit. The dashboard
// server resolves ui.html and assets/ RELATIVE TO ITS OWN FILE, so they must
// sit next to dist/dashboard/server.js exactly as they do next to the source.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pairs = [
  ['src/dashboard/ui.html', 'dist/dashboard/ui.html'],
  ['src/dashboard/assets', 'dist/dashboard/assets'],
];

for (const [from, to] of pairs) {
  const src = path.join(root, from);
  const dst = path.join(root, to);
  const st = await fs.stat(src);
  if (st.isDirectory()) {
    // recursive: assets/fonts/*.woff2 ships with the build, not just flat files
    const cp = async (s, d) => {
      await fs.mkdir(d, { recursive: true });
      for (const f of await fs.readdir(s, { withFileTypes: true })) {
        const sp = path.join(s, f.name), dp = path.join(d, f.name);
        if (f.isDirectory()) await cp(sp, dp);
        else await fs.copyFile(sp, dp);
      }
    };
    await cp(src, dst);
  } else {
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.copyFile(src, dst);
  }
  console.log('copied', from, '->', to);
}
