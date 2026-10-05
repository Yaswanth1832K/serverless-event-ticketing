// Removes what the browser smoke test leaves behind: users whose email starts with "e2e-" and events
// named "E2E-...". Events with sold tickets cannot be deleted through the API, so this writes to
// DynamoDB directly with your AWS credentials (same trade-off as seed:demo:clean).
import { apiClient, deleteUser, listUsersWithPrefix, purgeEvent, stackOutputs } from './lib.mjs';

const out = stackOutputs();
const call = apiClient(out);

const list = await call('GET', '/events');
const events = (list.data?.events ?? []).filter((e) => e.name.startsWith('E2E-'));
for (const e of events) {
  const n = await purgeEvent(out, e.eventId);
  console.log(`removed event "${e.name}" (${n} records)`);
}
const users = await listUsersWithPrefix(out, 'e2e-');
for (const email of users) await deleteUser(out, email);
console.log(`removed ${users.length} test user(s) and ${events.length} test event(s)`);
