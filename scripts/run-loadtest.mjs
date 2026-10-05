// Runs an Artillery load test against the deployed API and writes the real results to docs/test-results/.
//
//   npm run loadtest            steady mixed load (about 30 requests/second at the top, over six methods)
//   npm run loadtest:spike      sudden jump to about 3x, same mix (did not reach the per-method API limit)
//   npm run loadtest:throttle   one endpoint pushed above the API Gateway limit (50/s per method) on purpose
//
// Setup, run, evidence, clean-up:
//   1. creates 1 organizer, 8 attendees (random passwords, never printed) and 5 events with a large capacity
//   2. runs Artillery with those identities
//   3. waits for CloudWatch, then reads API / Lambda / DynamoDB errors and throttles for the same time window
//   4. checks the data: tickets sold across the events must equal the successful booking responses
//   5. removes every user and event it created (also when something fails)
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiClient, aws, deleteUser, login, purgeEvent, signUpIfNeeded, sleep, STACK, stackOutputs } from './lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] ?? 'steady';
if (!['steady', 'spike', 'throttle'].includes(mode)) throw new Error('Usage: node scripts/run-loadtest.mjs steady|spike|throttle');

const artilleryBin = resolve(root, 'loadtest/node_modules/artillery/bin/run');
if (!existsSync(artilleryBin)) {
  throw new Error('Artillery is not installed yet. Run:  npm --prefix loadtest install');
}

const resultsDir = resolve(root, 'docs/test-results');
const runtimeDir = resolve(root, 'loadtest/.runtime');
mkdirSync(resultsDir, { recursive: true });
mkdirSync(runtimeDir, { recursive: true });
const ctxFile = resolve(runtimeDir, 'ctx.json');
const rawFile = resolve(resultsDir, `stage9-loadtest-${mode}.json`);
const txtFile = resolve(resultsDir, `stage9-loadtest-${mode}.txt`);

const out = stackOutputs();
const call = apiClient(out);
const password = `Aa1${randomBytes(12).toString('hex')}`; // meets the pool policy; lives only in this process
const tag = `loadtest-${randomBytes(3).toString('hex')}`;
const organizerEmail = `${tag}-org@example.com`;
const attendeeEmails = Array.from({ length: 8 }, (_, i) => `${tag}-att${i + 1}@example.com`);
const createdEvents = [];
const lines = [];
const say = (s = '') => { console.log(s); lines.push(s); };

const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(2)}%` : 'n/a');
const ms = (v) => (v === undefined ? 'n/a' : `${v} ms`);

async function cleanup() {
  console.log('\nCleaning up the load-test users and events…');
  for (const id of createdEvents) await purgeEvent(out, id).catch((e) => console.log(`  could not purge ${id}: ${e.message}`));
  for (const email of [organizerEmail, ...attendeeEmails]) await deleteUser(out, email);
  rmSync(runtimeDir, { recursive: true, force: true });
}

async function metricSum(namespace, metric, dims, start, end, stat = 'Sum') {
  const args = ['cloudwatch', 'get-metric-statistics', '--namespace', namespace, '--metric-name', metric,
    '--start-time', start.toISOString(), '--end-time', end.toISOString(), '--period', '60', '--statistics', stat,
    '--output', 'json'];
  if (dims.length) args.push('--dimensions', ...dims);
  const points = JSON.parse(aws(args)).Datapoints;
  const values = points.map((p) => p[stat]);
  return stat === 'Maximum' ? Math.max(0, ...values) : values.reduce((a, b) => a + b, 0);
}

try {
  say(`Load test "${mode}" against stack ${STACK}   (${new Date().toISOString()})`);
  say(`API: ${out.ApiUrl}`);

  // ---- 1. setup
  say('\nSetup: creating test users and events through the real API…');
  await signUpIfNeeded(out, organizerEmail, password, 'Organizer');
  for (const e of attendeeEmails) await signUpIfNeeded(out, e, password, 'Attendee');
  const organizerToken = await login(out, organizerEmail, password);
  const attendeeTokens = [];
  for (const e of attendeeEmails) attendeeTokens.push(await login(out, e, password));

  const eventIds = [];
  for (let i = 1; i <= 5; i++) {
    const r = await call('POST', '/events', organizerToken, {
      name: `[LOADTEST] ${tag} event ${i}`, description: 'Created by the load test. Removed automatically.',
      venue: 'Load test hall', startsAt: new Date(Date.now() + 30 * 86400_000).toISOString(), priceCents: 100, capacity: 100000,
    });
    if (r.status !== 201) throw new Error(`could not create a test event: HTTP ${r.status} ${r.text}`);
    eventIds.push(r.data.eventId);
    createdEvents.push(r.data.eventId);
  }
  writeFileSync(ctxFile, JSON.stringify({ organizerToken, attendeeTokens, eventIds }));
  // the events only appear in the public list once the listing index has caught up; wait for them
  for (let i = 0; i < 20; i++) {
    const r = await call('GET', '/events');
    if (r.status === 200 && eventIds.every((id) => r.data.events?.some((e) => e.eventId === id))) break;
    await sleep(1000);
  }

  // ---- 2. run
  say(`\nRunning Artillery (loadtest/${mode}.yml)…`);
  const started = new Date();
  let artilleryFailed = null;
  try {
    execFileSync(process.execPath, [artilleryBin, 'run', resolve(root, `loadtest/${mode}.yml`), '--output', rawFile], {
      cwd: resolve(root, 'loadtest'), stdio: 'inherit',
      env: { ...process.env, API_URL: out.ApiUrl, LOADTEST_CTX: ctxFile },
    });
  } catch (e) {
    artilleryFailed = e;
  }
  const ended = new Date();
  if (!existsSync(rawFile)) throw new Error(`Artillery produced no result file${artilleryFailed ? `: ${artilleryFailed.message}` : ''}`);
  const report = JSON.parse(readFileSync(rawFile, 'utf8'));
  const agg = report.aggregate;
  const c = agg.counters;
  const rt = agg.summaries['http.response_time'] ?? {};
  const seconds = (agg.lastMetricAt - agg.firstMetricAt) / 1000;

  // ---- 3. client-side numbers
  const codes = Object.entries(c).filter(([k]) => k.startsWith('http.codes.')).map(([k, v]) => [k.slice(11), v]).sort();
  const requests = c['http.requests'] ?? 0;
  const bad5xx = codes.filter(([k]) => k.startsWith('5')).reduce((a, [, v]) => a + v, 0);
  const throttled = c['http.codes.429'] ?? 0;
  const networkErrors = Object.entries(c).filter(([k]) => k.startsWith('errors.')).reduce((a, [, v]) => a + v, 0);
  const unexpected4xx = codes.filter(([k]) => k.startsWith('4') && k !== '429').reduce((a, [, v]) => a + v, 0);

  say('\n=== Client-side results (Artillery) ===');
  say(`Duration:            ${seconds.toFixed(0)} s   (${started.toISOString()} to ${ended.toISOString()})`);
  say(`Requests sent:       ${requests}`);
  say(`Requests per second: ${(requests / seconds).toFixed(1)} average over the whole run, peak ${agg.rates?.['http.request_rate'] ?? 'n/a'} (Artillery's own rate figure)`);
  say(`Virtual users:       ${c['vusers.created'] ?? 0} created, ${c['vusers.completed'] ?? 0} completed, ${c['vusers.failed'] ?? 0} failed`);
  say(`Latency (all requests): min ${ms(rt.min)}   p50 ${ms(rt.median ?? rt.p50)}   p95 ${ms(rt.p95)}   p99 ${ms(rt.p99)}   max ${ms(rt.max)}`);
  say(`Response codes:      ${codes.map(([k, v]) => `${k}: ${v}`).join(', ') || 'none'}`);
  say(`Throttled by API Gateway (429): ${throttled} of ${requests} (${pct(throttled, requests)})`);
  say(`Server errors (5xx): ${bad5xx} (${pct(bad5xx, requests)})`);
  say(`Other 4xx (not 429): ${unexpected4xx}`);
  say(`Network errors (timeouts, resets): ${networkErrors}`);
  say(`Error rate, counting 429 + 5xx + network errors as errors: ${pct(throttled + bad5xx + networkErrors, requests)}`);

  const byEndpoint = report.aggregate.summaries ? Object.entries(report.aggregate.summaries).filter(([k]) => k.startsWith('plugins.metrics-by-endpoint.response_time.')) : [];
  if (byEndpoint.length) {
    say('\nLatency per endpoint (ms):');
    say('  endpoint'.padEnd(34) + 'count'.padStart(7) + 'p50'.padStart(7) + 'p95'.padStart(7) + 'p99'.padStart(7) + 'max'.padStart(7));
    for (const [k, s] of byEndpoint.sort()) {
      say(`  ${k.replace('plugins.metrics-by-endpoint.response_time.', '').padEnd(32)}${String(s.count).padStart(7)}${String(s.median ?? s.p50).padStart(7)}${String(s.p95).padStart(7)}${String(s.p99).padStart(7)}${String(s.max).padStart(7)}`);
    }
  }
  const perEndpointCodes = Object.entries(c).filter(([k]) => k.startsWith('plugins.metrics-by-endpoint.') && k.includes('.codes.'));
  if (perEndpointCodes.length) {
    say('\nResponse codes per endpoint:');
    for (const [k, v] of perEndpointCodes.sort()) say(`  ${k.replace('plugins.metrics-by-endpoint.', '')}: ${v}`);
  }

  // ---- 4. server-side evidence (CloudWatch lags a couple of minutes behind)
  say('\nWaiting 150 s for CloudWatch to catch up…');
  await sleep(150_000);
  const wStart = new Date(started.getTime() - 60_000);
  const wEnd = new Date(Date.now());
  const fns = JSON.parse(aws(['cloudformation', 'list-stack-resources', '--stack-name', STACK, '--query', "StackResourceSummaries[?ResourceType=='AWS::Lambda::Function'].PhysicalResourceId", '--output', 'json']));
  const apiDims = [`Name=ApiName,Value=${STACK}`, 'Name=Stage,Value=prod'];
  const tableDims = [`Name=TableName,Value=${out.TableName}`];
  let lambdaThrottles = 0; let lambdaErrors = 0; let lambdaInvocations = 0; let peakConcurrency = 0;
  for (const fn of fns) {
    const d = [`Name=FunctionName,Value=${fn}`];
    lambdaThrottles += await metricSum('AWS/Lambda', 'Throttles', d, wStart, wEnd);
    lambdaErrors += await metricSum('AWS/Lambda', 'Errors', d, wStart, wEnd);
    lambdaInvocations += await metricSum('AWS/Lambda', 'Invocations', d, wStart, wEnd);
    peakConcurrency = Math.max(peakConcurrency, await metricSum('AWS/Lambda', 'ConcurrentExecutions', d, wStart, wEnd, 'Maximum'));
  }
  const server = {
    apiCount: await metricSum('AWS/ApiGateway', 'Count', apiDims, wStart, wEnd),
    api4xx: await metricSum('AWS/ApiGateway', '4XXError', apiDims, wStart, wEnd),
    api5xx: await metricSum('AWS/ApiGateway', '5XXError', apiDims, wStart, wEnd),
    ddbReadThrottle: await metricSum('AWS/DynamoDB', 'ReadThrottleEvents', tableDims, wStart, wEnd),
    ddbWriteThrottle: await metricSum('AWS/DynamoDB', 'WriteThrottleEvents', tableDims, wStart, wEnd),
    ddbConflicts: await metricSum('AWS/DynamoDB', 'TransactionConflict', tableDims, wStart, wEnd),
    bookingSuccess: await metricSum('TicketingPlatform', 'BookingSuccess', [], wStart, wEnd),
    bookingRetries: await metricSum('TicketingPlatform', 'BookingConflictRetry', [], wStart, wEnd),
    bookingSoldOut: await metricSum('TicketingPlatform', 'BookingRejectedSoldOut', [], wStart, wEnd),
  };
  say('\n=== Server-side evidence (CloudWatch, same time window) ===');
  say(`API Gateway:   ${server.apiCount} requests counted, 4xx ${server.api4xx} (includes the 429 throttles), 5xx ${server.api5xx}`);
  say(`Lambda:        ${lambdaInvocations} invocations, ${lambdaErrors} errors, ${lambdaThrottles} throttles, peak concurrent executions ${peakConcurrency}`);
  say(`DynamoDB:      read throttle events ${server.ddbReadThrottle}, write throttle events ${server.ddbWriteThrottle}, transaction conflicts ${server.ddbConflicts}`);
  say(`Bookings:      ${server.bookingSuccess} succeeded, ${server.bookingRetries} conflict retries, ${server.bookingSoldOut} sold-out rejections`);

  // ---- 5. data integrity
  const mine = await call('GET', '/my/events', organizerToken);
  const sold = mine.status === 200 ? mine.data.events.filter((e) => eventIds.includes(e.eventId)).reduce((a, e) => a + (e.sold ?? 0), 0) : null;
  const booked201 = c['http.codes.201'] ?? 0;
  say('\n=== Data check ===');
  say(`Tickets sold across the 5 test events (from the database): ${sold}`);
  say(`Successful booking responses seen by the load generator (HTTP 201): ${booked201}`);
  say(sold === booked201 ? 'MATCH: no ticket was lost or double-counted under load.' : 'MISMATCH: investigate before trusting these results.');

  say('\n=== Honest notes ===');
  say(throttled > 0
    ? `- ${throttled} request(s) were throttled by API Gateway (HTTP 429). That is the stage limit (50 requests/second, burst 100) doing its job.`
    : '- No request was throttled by API Gateway (no HTTP 429).');
  say(lambdaThrottles + server.ddbReadThrottle + server.ddbWriteThrottle > 0
    ? `- Something behind the API WAS throttled: Lambda ${lambdaThrottles}, DynamoDB reads ${server.ddbReadThrottle}, DynamoDB writes ${server.ddbWriteThrottle}.`
    : '- Nothing behind the API was throttled: Lambda throttles 0, DynamoDB read and write throttle events 0.');
  say('- The load generator ran on one laptop on a home/campus network, so the latencies include that network. The CloudWatch Latency metric (server-side) is lower.');
  say('- Bookings were spread over 5 events. One single hot event is slower; see the concurrency test (stage 5) for that case.');
  if (artilleryFailed) say(`- Artillery exited with an error: ${artilleryFailed.message}`);

  writeFileSync(txtFile, lines.join('\n') + '\n');
  console.log(`\nSaved: ${txtFile}\n       ${rawFile}`);
  if (sold !== booked201 || bad5xx > 0 || artilleryFailed) process.exitCode = 1;
} catch (e) {
  console.error(`\nFailed: ${e.message}`);
  lines.push(`\nFAILED: ${e.message}`);
  writeFileSync(txtFile.replace('.txt', '-FAILED.txt'), lines.join('\n') + '\n');
  process.exitCode = 1;
} finally {
  await cleanup();
}
