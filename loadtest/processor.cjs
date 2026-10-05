// Hooks for the Artillery scenarios. Identities and event ids come from a context file that
// scripts/run-loadtest.mjs writes just before the run and deletes right after (it holds short-lived
// tokens, so it is git-ignored and never committed).
const fs = require('node:fs');

const ctx = JSON.parse(fs.readFileSync(process.env.LOADTEST_CTX, 'utf8'));
let next = 0;

const randomEvent = () => ctx.eventIds[Math.floor(Math.random() * ctx.eventIds.length)];

module.exports = {
  // spreads attendees round-robin, and spreads bookings over several events so no single event is a hot spot
  pickAttendee(context, _events, done) {
    context.vars.token = ctx.attendeeTokens[next++ % ctx.attendeeTokens.length];
    context.vars.eventId = randomEvent();
    done();
  },
  pickOrganizer(context, _events, done) {
    context.vars.token = ctx.organizerToken;
    context.vars.eventId = randomEvent();
    done();
  },
  pickEvent(context, _events, done) {
    context.vars.eventId = randomEvent();
    done();
  },
};
