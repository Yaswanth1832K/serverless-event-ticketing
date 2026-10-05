// Demo data: one event with some bookings and check-ins.
//
//   npm run seed:demo         create the demo accounts (if missing) and ONE fresh demo event
//   npm run seed:demo:clean   remove old demo events (admin clean-up, see below)
//   npm run demo:reset        clean, then seed: a fresh demo in about 20 seconds
//
// SEEDING USES THE REAL API ONLY. Accounts are created with Cognito sign-up, the event, picture,
// bookings and check-ins go through the same HTTP endpoints the website uses. The single exception
// is the Staff account: staff cannot sign themselves up, so an administrator (your AWS credentials)
// adds it to the Staff group with Cognito's admin call.
//
// The CLEAN step is different: events that have sold tickets cannot be deleted through the API, so it
// deletes the demo events' records straight from DynamoDB with your AWS credentials. It only touches
// events named "[DEMO] ..." that belong to the demo organizer.
import { deflateSync } from 'node:zlib';
import { apiClient, login, makeStaff, purgeEvent, signUpIfNeeded, sleep, stackOutputs } from './lib.mjs';

const PASSWORD = 'DemoPass123';
export const ACCOUNTS = {
  organizer: 'demo.organizer@example.com',
  attendees: ['demo.attendee1@example.com', 'demo.attendee2@example.com', 'demo.attendee3@example.com'],
  staff: 'demo.staff@example.com',
};
const EVENT_PREFIX = '[DEMO]';
const EVENT_NAME = `${EVENT_PREFIX} Campus Tech Fest`;

const out = stackOutputs();
const call = apiClient(out);
const args = new Set(process.argv.slice(2));

// ---------------------------------------------------------------------------------------------
async function organizerToken() {
  return login(out, ACCOUNTS.organizer, PASSWORD).catch(() => null);
}

async function demoEvents(token) {
  const r = await call('GET', '/my/events', token);
  if (r.status !== 200) throw new Error(`Could not list the organizer's events: ${r.status} ${r.text}`);
  return r.data.events.filter((e) => e.name.startsWith(EVENT_PREFIX));
}

async function clean() {
  const token = await organizerToken();
  if (!token) return console.log('No demo organizer account yet, so there is nothing to clean.');
  const events = await demoEvents(token);
  for (const e of events) {
    const n = await purgeEvent(out, e.eventId);
    console.log(`removed "${e.name}" (${e.eventId}) and its ${n} records`);
  }
  if (!events.length) console.log('No demo events found. Nothing to clean.');
}

// A plain gradient picture, made here so the demo needs no image file. (PNG: signature + IHDR + IDAT + IEND.)
function makePng(width = 640, height = 360) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const row = width * 3 + 1;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t = (x / width + y / height) / 2;
      const stripe = Math.floor((x + y) / 28) % 2 ? 14 : 0;
      const o = y * row + 1 + x * 3;
      raw[o] = Math.min(255, 28 + t * 40 + stripe);
      raw[o + 1] = Math.min(255, 96 + t * 90 + stripe);
      raw[o + 2] = Math.min(255, 190 + t * 50 + stripe);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

function must(r, what) {
  if (r.status >= 300) throw new Error(`${what} failed: HTTP ${r.status} ${r.text}`);
  return r.data;
}

async function eventually(fn, ok, tries = 20, ms = 1000) {
  let last;
  for (let i = 0; i < tries; i++) {
    last = await fn();
    if (ok(last)) return last;
    await sleep(ms);
  }
  return last;
}

async function seed() {
  console.log('Accounts…');
  const created = [];
  const roles = [[ACCOUNTS.organizer, 'Organizer'], ...ACCOUNTS.attendees.map((e) => [e, 'Attendee']), [ACCOUNTS.staff, 'Attendee']];
  for (const [email, role] of roles) if (await signUpIfNeeded(out, email, PASSWORD, role)) created.push(email);
  await makeStaff(out, ACCOUNTS.staff);
  console.log(created.length ? `  created: ${created.join(', ')}` : '  all demo accounts already exist');

  const org = await login(out, ACCOUNTS.organizer, PASSWORD);
  const att = await Promise.all(ACCOUNTS.attendees.map((e) => login(out, e, PASSWORD)));
  const staff = await login(out, ACCOUNTS.staff, PASSWORD); // after the group change, so the token says Staff

  if ((await demoEvents(org)).length && !args.has('--allow-duplicates')) {
    console.log('\nA demo event already exists. Run "npm run demo:reset" for a fresh one (or add --allow-duplicates).');
    return;
  }

  console.log('Event…');
  const startsAt = new Date(Date.now() + 36 * 3600_000).toISOString();
  const ev = must(await call('POST', '/events', org, {
    name: EVENT_NAME,
    description: 'A friendly demo event: talks, demos and snacks. Everything here is sample data.',
    venue: 'Main Auditorium', startsAt, priceCents: 500, capacity: 10,
  }), 'create event');
  const eventId = ev.eventId;

  console.log('Picture…');
  const png = makePng();
  const policy = must(await call('POST', `/events/${eventId}/image-url`, org, { contentType: 'image/png', sizeBytes: png.length }), 'picture permission');
  const form = new FormData();
  for (const [k, v] of Object.entries(policy.fields)) form.append(k, v);
  form.append('file', new Blob([png], { type: 'image/png' }), 'demo.png');
  const up = await fetch(policy.url, { method: 'POST', body: form });
  if (!up.ok) throw new Error(`picture upload failed: HTTP ${up.status}`);
  must(await call('PUT', `/events/${eventId}`, org, { imageKey: policy.imageKey }), 'attach picture');

  console.log('Bookings…');
  const quantities = [2, 3, 1];
  for (const [i, q] of quantities.entries()) must(await call('POST', `/events/${eventId}/book`, att[i], { quantity: q }), `booking for attendee ${i + 1}`);

  // each attendee's own tickets, then the QR code behind each one
  const mine = [];
  for (const [i, token] of att.entries()) {
    const list = await eventually(
      async () => (await call('GET', '/my/tickets', token)).data.tickets.filter((t) => t.eventId === eventId),
      (t) => t.length >= quantities[i],
    );
    const withQr = [];
    for (const t of list) withQr.push({ ...t, qr: must(await call('GET', `/events/${eventId}/tickets/${t.ticketId}/qr`, token), 'QR').token });
    mine.push(withQr);
  }

  console.log('Check-ins (door staff scanning real QR codes)…');
  const toScan = [mine[0][0], mine[0][1], mine[1][0]];
  for (const t of toScan) must(await call('POST', '/checkin', staff, { token: t.qr, eventId }), 'check-in');

  const stats = await eventually(
    async () => (await call('GET', `/events/${eventId}/analytics`, org)).data,
    (s) => s?.checkedIn >= toScan.length, 30, 1000,
  );

  const web = out.WebUrl ?? '(website not deployed yet: run npm run deploy:frontend)';
  console.log(`
Demo ready.
  Website:   ${web}
  Event:     ${EVENT_NAME}
  Sold:      ${stats.sold} of ${stats.capacity}   (${stats.remaining} left, so there is room to book live)
  Checked in: ${stats.checkedIn}${stats.checkedIn < toScan.length ? '  (the counter is still catching up, give it a few seconds)' : ''}
  Not yet scanned: ${mine[1].length - 1 + mine[2].length} tickets (attendee2 has 2, attendee3 has 1), ready for a live scan
  Password for every demo account: ${PASSWORD}
  See docs/demo-guide.md for the accounts and the demo script.`);
}

try {
  if (args.has('--clean')) await clean();
  else if (args.has('--reset')) { await clean(); await seed(); }
  else await seed();
} catch (e) {
  console.error(`\nFailed: ${e.message}`);
  process.exit(1);
}
