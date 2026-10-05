// Renders every ```mermaid block in the docs to PNG files in docs/diagrams/.
//
//   one-time:  npm install --prefix tools/mermaid @mermaid-js/mermaid-cli     (kept out of the main install)
//   then:      node scripts/render-diagrams.mjs
//
// mermaid-cli needs a Chromium. By default it downloads its own; to reuse the one Playwright already
// installed, set CHROME to its chrome.exe (Windows) or chrome binary.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'docs/diagrams');
const tmp = join(root, 'tools/mermaid');
mkdirSync(outDir, { recursive: true });

const jobs = [
  ['docs/architecture-diagram.md', 'final', ['system-overview', 'data-model', 'deployment-and-delivery']],
  ['docs/02-architecture.md', '02', ['stage2-overview', 'booking-sequence', 'checkin-sequence']],
];

const puppeteerConfig = join(tmp, 'puppeteer.json');
writeFileSync(puppeteerConfig, JSON.stringify({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ['--no-sandbox'] }));
const mmdc = join(tmp, 'node_modules/.bin', process.platform === 'win32' ? 'mmdc.cmd' : 'mmdc');
const q = (s) => `"${s}"`;

let failed = 0;
for (const [file, prefix, names] of jobs) {
  const blocks = [...readFileSync(join(root, file), 'utf8').matchAll(/```mermaid\r?\n([\s\S]*?)```/g)].map((m) => m[1]);
  if (blocks.length !== names.length) console.log(`NOTE: ${file} has ${blocks.length} diagrams, expected ${names.length}`);
  blocks.forEach((src, i) => {
    const name = `${prefix}-${names[i] ?? `diagram${i + 1}`}`;
    const mmd = join(tmp, `${name}.mmd`);
    writeFileSync(mmd, src);
    try {
      execFileSync(q(mmdc), ['-i', q(mmd), '-o', q(join(outDir, `${name}.png`)), '-p', q(puppeteerConfig), '-s', '2', '-b', 'white'], { stdio: 'pipe', shell: true });
      console.log(`OK    ${name}.png`);
    } catch (e) {
      failed++;
      console.log(`FAIL  ${name}\n${String(e.stderr || e.message).split('\n').slice(0, 8).join('\n')}`);
    }
  });
}
process.exit(failed ? 1 : 0);
