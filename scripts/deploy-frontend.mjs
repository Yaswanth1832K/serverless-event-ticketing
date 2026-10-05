// Builds the frontend and publishes it: S3 (private bucket) behind CloudFront.
//   npm run deploy:frontend
//
// 1. build the app            2. write dist/config.json from the stack outputs
// 3. upload hashed assets with a long cache, index.html and config.json with no-cache
// 4. invalidate the two files that must never be stale
import { execSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aws, stackOutputs } from './lib.mjs';
import { buildConfig, writeConfig } from './frontend-config.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'frontend/dist');

const out = stackOutputs();
for (const key of ['WebBucketName', 'WebDistributionId', 'WebUrl']) {
  if (!out[key]) throw new Error(`The stack has no "${key}" output yet. Deploy the stack first (sam deploy), then run this again.`);
}

console.log('1/4 building the app…');
execSync('npm run build', { cwd: resolve(root, 'frontend'), stdio: 'inherit' });

console.log('2/4 writing config.json from the stack outputs…');
writeConfig(resolve(dist, 'config.json'), buildConfig(out));

const bucket = `s3://${out.WebBucketName}`;
console.log('3/4 uploading…');
// hashed files (assets/*): safe to cache for a year
aws(['s3', 'sync', dist, bucket, '--delete', '--exclude', 'index.html', '--exclude', 'config.json',
  '--cache-control', 'public,max-age=31536000,immutable'], { stdio: 'inherit' });
// the two files that change between deploys: always revalidate
aws(['s3', 'cp', resolve(dist, 'index.html'), `${bucket}/index.html`, '--cache-control', 'no-cache', '--content-type', 'text/html; charset=utf-8'], { stdio: 'inherit' });
aws(['s3', 'cp', resolve(dist, 'config.json'), `${bucket}/config.json`, '--cache-control', 'no-cache', '--content-type', 'application/json'], { stdio: 'inherit' });

console.log('4/4 clearing the CDN cache for index.html and config.json…');
aws(['cloudfront', 'create-invalidation', '--distribution-id', out.WebDistributionId, '--paths', '/index.html', '/config.json', '--query', 'Invalidation.Status', '--output', 'text'], { stdio: 'inherit' });

console.log(`\nDone. Open: ${out.WebUrl}`);
