// Runs the fresh-trigger experiment several times, alternating the stream starting position so that
// every run really REPLACES the trigger (CloudFormation only replaces it when the position changes).
// The stack must currently be on the position that is NOT first in the list.
//
// Usage: node scripts/run-fresh-trigger-series.mjs <outfile> [POSITION ...]
//   default order: TRIM_HORIZON LATEST TRIM_HORIZON LATEST TRIM_HORIZON   (ends on the correct setting)
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';

const [outfile, ...rest] = process.argv.slice(2);
const positions = rest.length ? rest : ['TRIM_HORIZON', 'LATEST', 'TRIM_HORIZON', 'LATEST', 'TRIM_HORIZON'];
mkdirSync(dirname(outfile), { recursive: true });
writeFileSync(outfile, `# fresh-trigger series: ${positions.join(' -> ')}\n# started ${new Date().toISOString()}\n`);

const summary = [];
positions.forEach((position, i) => {
  const header = `\n${'='.repeat(30)} RUN ${i + 1} of ${positions.length}: StreamStartingPosition=${position} (${new Date().toISOString()}) ${'='.repeat(30)}\n`;
  process.stdout.write(header);
  appendFileSync(outfile, header);
  const r = spawnSync(
    'npx vitest run tests/fresh-trigger --testTimeout=1200000 --hookTimeout=300000 --no-file-parallelism --reporter=verbose',
    { shell: true, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', FRESH_TRIGGER_POSITION: position } },
  );
  const text = (r.stdout ?? '') + (r.stderr ?? '');
  process.stdout.write(text);
  appendFileSync(outfile, text + `\n--- run ${i + 1} exit code: ${r.status}\n`);
  const result = text.split('\n').find((l) => l.includes('RESULT position='));
  summary.push(`run ${i + 1} ${position}: exit ${r.status}; ${result ? result.replace(/.*RESULT /, '') : 'no RESULT line'}`);
});
const s = `\n# SUMMARY\n${summary.map((x) => '# ' + x).join('\n')}\n`;
process.stdout.write(s);
appendFileSync(outfile, s);
