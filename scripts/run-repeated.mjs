// Runs a command N times and tees everything into one output file.
// Usage: node scripts/run-repeated.mjs <times> <outfile> <command...>
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';

const [times, outfile, ...cmd] = process.argv.slice(2);
mkdirSync(dirname(outfile), { recursive: true });
writeFileSync(outfile, `# ${cmd.join(' ')}\n# started ${new Date().toISOString()}\n`);
let failed = 0;
for (let i = 1; i <= Number(times); i++) {
  const header = `\n${'='.repeat(30)} RUN ${i} of ${times} (${new Date().toISOString()}) ${'='.repeat(30)}\n`;
  process.stdout.write(header);
  appendFileSync(outfile, header);
  const r = spawnSync(cmd.join(' '), { shell: true, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  const text = (r.stdout ?? '') + (r.stderr ?? '');
  process.stdout.write(text);
  appendFileSync(outfile, text + `\n--- run ${i} exit code: ${r.status}\n`);
  if (r.status !== 0) failed++;
}
const summary = `\n# SUMMARY: ${Number(times) - failed}/${times} runs passed\n`;
process.stdout.write(summary);
appendFileSync(outfile, summary);
process.exit(failed ? 1 : 0);
