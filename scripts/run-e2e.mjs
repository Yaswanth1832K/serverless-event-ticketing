// Runs the browser tests against the deployed site and always cleans up after itself.
//   npm run e2e         (first time only: npx playwright install chromium, inside frontend/)
// Output is saved to docs/test-results/stage8-e2e.txt
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stackOutputs } from './lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = stackOutputs();
if (!out.WebUrl) throw new Error('The website is not deployed yet (no WebUrl output). Run sam deploy and npm run deploy:frontend first.');

const resultFile = resolve(root, process.env.E2E_RESULT_FILE ?? 'docs/test-results/stage8-e2e.txt');
mkdirSync(dirname(resultFile), { recursive: true });

const run = spawnSync('npx playwright test', {
  cwd: resolve(root, 'frontend'), shell: true, encoding: 'utf8',
  env: { ...process.env, WEB_URL: out.WebUrl, NO_COLOR: '1', FORCE_COLOR: '0' },
});
const text = `# playwright against ${out.WebUrl}\n# ${new Date().toISOString()}\n\n${run.stdout ?? ''}${run.stderr ?? ''}\n# exit code: ${run.status}\n`;
writeFileSync(resultFile, text);
process.stdout.write(text);

console.log('\nCleaning up test users and events…');
spawnSync('node scripts/cleanup-e2e.mjs', { cwd: root, shell: true, stdio: 'inherit' });
process.exit(run.status ?? 1);
