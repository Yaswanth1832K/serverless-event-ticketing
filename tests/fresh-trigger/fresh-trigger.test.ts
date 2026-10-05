import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import {
  LambdaClient, ListEventSourceMappingsCommand, UpdateEventSourceMappingCommand,
  type EventSourceMappingConfiguration,
} from '@aws-sdk/client-lambda';
import {
  loadOutputs, createUser, createStaffUser, deleteUser, api, futureDate, waitForRoutes, purgeEvent,
  ticketsInDb, dlqDepth, isCounted, type Outputs, type TestUser,
} from '../integration/helpers';

// FRESH-TRIGGER EXPERIMENT. Proves (or disproves) that a check-in scanned right after a NEW stream
// trigger appears is still counted. Run it through scripts/run-fresh-trigger-series.mjs, which
// alternates the starting position: the real setting (TRIM_HORIZON) and a LATEST control.
//
// How it avoids fooling itself:
//  - A CloudFormation replacement creates the NEW trigger before it deletes the OLD one, and the old
//    one would happily deliver our scan. So the old trigger is DISABLED first and the test waits
//    until it is really Disabled. Only the new trigger can count what we scan.
//  - It does NOT wait for a canary. It scans the moment the new trigger first appears, again the
//    moment the API first reports it Enabled (the exact condition that lost a record before), and
//    once more 25 s later.
//  - "Counted" means the idempotency marker for that ticket exists, so it is exact per ticket.
const POSITION = process.env.FRESH_TRIGGER_POSITION as 'TRIM_HORIZON' | 'LATEST' | undefined;
const WAIT_FOR_COUNT_MS = 240_000;

const lambda = new LambdaClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
let out: Outputs;
let org: TestUser, buyer: TestUser, staff: TestUser;
let eventId: string;
const tickets: { ticketId: string; token: string }[] = [];
const stamp = () => new Date().toISOString().slice(11, 23);
const log = (m: string) => console.log(`[fresh-trigger ${POSITION}] ${stamp()} ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mappings(): Promise<EventSourceMappingConfiguration[]> {
  const r = await lambda.send(new ListEventSourceMappingsCommand({ FunctionName: out.streamFunction }));
  return r.EventSourceMappings ?? [];
}

async function disableOldTriggers(): Promise<Set<string>> {
  const old = await mappings();
  for (const m of old) {
    if (m.State !== 'Disabled' && m.State !== 'Disabling') {
      await lambda.send(new UpdateEventSourceMappingCommand({ UUID: m.UUID!, Enabled: false }));
    }
  }
  const deadline = Date.now() + 300_000;
  for (;;) {
    const now = await mappings();
    if (now.every((m) => m.State === 'Disabled')) break;
    if (Date.now() > deadline) throw new Error(`old trigger did not reach Disabled: ${now.map((m) => m.State)}`);
    await sleep(2000);
  }
  log(`old trigger(s) disabled: ${old.map((m) => `${m.UUID!.slice(0, 8)} (${m.StartingPosition})`).join(', ')}`);
  return new Set(old.map((m) => m.UUID!));
}

const scan = (ticket: { token: string }) => api(out, 'POST', '/checkin', staff.token, { token: ticket.token, eventId });

beforeAll(async () => {
  if (POSITION !== 'TRIM_HORIZON' && POSITION !== 'LATEST') {
    throw new Error('Set FRESH_TRIGGER_POSITION to TRIM_HORIZON or LATEST (use scripts/run-fresh-trigger-series.mjs)');
  }
  out = loadOutputs();
  [org, buyer, staff] = await Promise.all([
    createUser(out, 'Organizer', 'ft-org'),
    createUser(out, 'Attendee', 'ft-buyer'),
    createStaffUser(out, 'ft-staff'),
  ]);
  await waitForRoutes(out, buyer.token);
  const ev = await api(out, 'POST', '/events', org.token, {
    name: `FRESH-TRIGGER-TEST ${POSITION}`, description: 'Automated test. Safe to delete.', venue: 'Gate',
    startsAt: futureDate(30), priceCents: 0, capacity: 10,
  });
  expect(ev.status, ev.raw).toBe(201);
  eventId = ev.body.eventId;
  const b = await api(out, 'POST', `/events/${eventId}/book`, buyer.token, { quantity: 3 });
  expect(b.status, b.raw).toBe(201);
  for (const t of b.body.tickets) {
    const q = await api(out, 'GET', `/events/${eventId}/tickets/${t.ticketId}/qr`, buyer.token);
    expect(q.status, q.raw).toBe(200);
    tickets.push({ ticketId: t.ticketId, token: q.body.token });
  }
}, 240_000);

afterAll(async () => {
  // Never leave a trigger disabled behind (for example if the deploy failed half way).
  try {
    for (const m of await mappings()) {
      if (m.State === 'Disabled') await lambda.send(new UpdateEventSourceMappingCommand({ UUID: m.UUID!, Enabled: true }));
    }
  } catch (e) {
    console.warn(`could not re-enable triggers: ${String(e)}`);
  }
  if (eventId) await purgeEvent(out, eventId);
  await Promise.all([org, buyer, staff].filter(Boolean).map((u) => deleteUser(out, u.email)));
}, 120_000);

describe('a ticket scanned right after a NEW stream trigger appears', () => {
  it('is counted (TRIM_HORIZON) / is observed (LATEST control)', async () => {
    const oldIds = await disableOldTriggers();

    // Replace the trigger with a real deploy, running in the background while we watch.
    const deployOutput: string[] = [];
    const deploy = spawn('sam', ['deploy', '--parameter-overrides', `StreamStartingPosition=${POSITION}`], {
      shell: true, env: { ...process.env, SAM_CLI_TELEMETRY: '0', NO_COLOR: '1' },
    });
    deploy.stdout.on('data', (d) => deployOutput.push(String(d)));
    deploy.stderr.on('data', (d) => deployOutput.push(String(d)));
    const deployDone = new Promise<number>((res) => deploy.on('close', (code) => res(code ?? -1)));
    log(`sam deploy started with StreamStartingPosition=${POSITION}`);

    const scans: { label: string; ticketIndex: number; at: number; state: string; status: number }[] = [];
    const scanNow = async (label: string, ticketIndex: number, state: string) => {
      const at = Date.now();
      const r = await scan(tickets[ticketIndex]!);
      scans.push({ label, ticketIndex, at, state, status: r.status });
      log(`scan ${label}: HTTP ${r.status}, new trigger state at that moment: ${state}`);
      expect(r.status, r.raw).toBe(200);
    };

    // 1) the moment the new trigger first appears
    let newTrigger: EventSourceMappingConfiguration | undefined;
    const appearDeadline = Date.now() + 480_000;
    while (!newTrigger) {
      newTrigger = (await mappings()).find((m) => !oldIds.has(m.UUID!));
      if (newTrigger) break;
      if (Date.now() > appearDeadline) throw new Error('new trigger never appeared');
      await sleep(300);
    }
    const appearedAt = Date.now();
    log(`new trigger ${newTrigger.UUID!.slice(0, 8)} (${newTrigger.StartingPosition}) first seen, state ${newTrigger.State}`);
    expect(newTrigger.StartingPosition).toBe(POSITION);
    await scanNow('A (as soon as the trigger exists)', 0, newTrigger.State ?? '?');

    // 2) the moment the API first reports it Enabled (the condition that lost a record before)
    let enabledSeenAt = 0;
    const enabledDeadline = Date.now() + 480_000;
    for (;;) {
      const cur = (await mappings()).find((m) => m.UUID === newTrigger!.UUID);
      if (cur?.State === 'Enabled') {
        enabledSeenAt = Date.now();
        await scanNow('B (first moment the API says Enabled)', 1, cur.State);
        break;
      }
      if (Date.now() > enabledDeadline) throw new Error(`trigger never reported Enabled (state ${cur?.State})`);
      await sleep(300);
    }
    log(`trigger reported Enabled ${Math.round((enabledSeenAt - appearedAt) / 1000)}s after it first appeared`);

    // 3) a later scan, as a control that the pipeline works at all
    await sleep(25_000);
    await scanNow('C (25 s after Enabled)', 2, 'Enabled');

    const exit = await deployDone;
    log(`sam deploy finished with exit code ${exit}`);
    if (exit !== 0) console.log(deployOutput.join('').slice(-1500));
    expect(exit).toBe(0);

    // Which scans did the NEW trigger count? (marker per ticket)
    const countedAt = new Map<number, number>();
    const deadline = Date.now() + WAIT_FOR_COUNT_MS;
    while (Date.now() < deadline && countedAt.size < tickets.length) {
      for (const s of scans) {
        if (!countedAt.has(s.ticketIndex) && (await isCounted(out, eventId, tickets[s.ticketIndex]!.ticketId))) {
          countedAt.set(s.ticketIndex, Date.now());
        }
      }
      if (countedAt.size < tickets.length) await sleep(1000);
    }

    const rows = scans.map((s) => {
      const t = countedAt.get(s.ticketIndex);
      return `${s.label}: ${t ? `COUNTED ${Math.round((t - s.at) / 1000)}s after the scan` : `LOST (not counted within ${WAIT_FOR_COUNT_MS / 1000}s)`}`;
    });
    const lost = scans.filter((s) => !countedAt.has(s.ticketIndex)).length;
    const db = await ticketsInDb(out, eventId);
    const analytics = await api(out, 'GET', `/events/${eventId}/analytics`, org.token);
    log(`RESULT position=${POSITION} scans=${scans.length} counted=${scans.length - lost} lost=${lost}`);
    for (const r of rows) log(`  ${r}`);
    log(`  database says ${db.checkedIn}/3 tickets CHECKED_IN, analytics counter says ${analytics.body.checkedIn}, DLQ depth ${await dlqDepth(out)}`);

    expect(db.checkedIn).toBe(3); // the scans themselves always work

    if (POSITION === 'TRIM_HORIZON') {
      // The fix: nothing may be lost, and the counter must equal the real tickets.
      expect(lost, rows.join(' | ')).toBe(0);
      expect(analytics.body.checkedIn).toBe(3);
    }
    // LATEST is only a control: whatever it does is reported above, never asserted.
  }, 1_200_000);
});
