// Writes the frontend's runtime settings (config.json) from the deployed stack's outputs.
// The file holds only PUBLIC identifiers: no secrets and no AWS credentials.
//
//   node scripts/frontend-config.mjs          -> frontend/public/config.json  (real API URL, for vite preview)
//   node scripts/frontend-config.mjs --dev    -> same, but apiUrl is "/api" and frontend/.env.local gets the
//                                               proxy target, so `npm run dev` needs no CORS setup
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stackOutputs } from './lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function buildConfig(out, { dev = false } = {}) {
  return {
    apiUrl: dev ? '/api' : out.ApiUrl,
    region: out.Region,
    userPoolId: out.UserPoolId,
    userPoolClientId: out.UserPoolClientId,
    currency: 'USD',
  };
}

export function writeConfig(file, config) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dev = process.argv.includes('--dev');
  const out = stackOutputs();
  const file = resolve(root, 'frontend/public/config.json');
  writeConfig(file, buildConfig(out, { dev }));
  console.log(`wrote ${file}`);
  if (dev) {
    writeFileSync(resolve(root, 'frontend/.env.local'), `API_PROXY_TARGET=${out.ApiUrl}\n`);
    console.log('wrote frontend/.env.local (API_PROXY_TARGET). Now run: npm --prefix frontend run dev');
  }
}
