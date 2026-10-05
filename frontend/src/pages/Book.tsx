import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import type { BookingResult } from '../api/types';
import { ErrorState, Loading, Notice, PageHeader } from '../components/States';
import { config } from '../config';
import { formatDateTime, formatPrice, plural, ticketsLeftLabel } from '../lib/format';
import { plainMessage } from '../lib/errors';
import { useAsync } from '../lib/hooks';

const MAX_PER_BOOKING = 5;

export function Book() {
  const { id = '' } = useParams();
  const event = useAsync(() => api.getEvent(id), [id]);
  const [quantity, setQuantity] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<BookingResult | null>(null);

  if (event.status === 'loading' && !event.data) return <Loading label="Loading the event…" />;
  if (!event.data) return <ErrorState error={event.error} onRetry={event.reload} title="We couldn't load this event" />;

  const e = event.data;
  const max = Math.max(0, Math.min(MAX_PER_BOOKING, e.remaining));
  const qty = Math.min(quantity, Math.max(max, 1));

  async function confirm() {
    if (busy || done) return; // one click, one booking
    setBusy(true);
    setError(null);
    try {
      setDone(await api.book(id, qty));
    } catch (err) {
      setError(plainMessage(err));
      event.reload(); // the numbers may have changed while the person was deciding
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="narrow">
        <PageHeader title="You're booked!" />
        <div className="panel">
          <Notice kind="success">
            {plural(done.quantity, 'ticket')} for <strong>{e.name}</strong>. Total: {formatPrice(done.totalPriceCents, config().currency)}.
          </Notice>
          <p>Your QR codes are ready. Show them on your phone at the door.</p>
          <ul className="plain-list">
            {done.tickets.map((t, i) => (
              <li key={t.ticketId}>
                Ticket {i + 1}: <Link to={`/tickets/${t.eventId}/${t.ticketId}`}>Show QR code</Link>
              </li>
            ))}
          </ul>
          <p>
            <Link className="btn" to="/my-tickets">Go to My tickets</Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="narrow">
      <PageHeader title="Book tickets" />
      <div className="panel">
        <h2>{e.name}</h2>
        <p className="muted">{formatDateTime(e.startsAt)} · {e.venue}</p>
        <p>{formatPrice(e.priceCents, config().currency)} per ticket · {ticketsLeftLabel(e.remaining)}</p>

        {max === 0 ? (
          <>
            <Notice kind="info">Sorry, this event is sold out.</Notice>
            <p><Link to="/">Find another event</Link></p>
          </>
        ) : (
          <form
            className="form"
            onSubmit={(ev) => {
              ev.preventDefault();
              void confirm();
            }}
          >
            <label>
              How many tickets?
              <select value={qty} onChange={(ev) => setQuantity(Number(ev.target.value))} disabled={busy}>
                {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
              <span className="hint">You can book up to {MAX_PER_BOOKING} at a time.</span>
            </label>
            <p className="total">Total: <strong>{formatPrice(e.priceCents * qty, config().currency)}</strong></p>
            {error && <Notice kind="error">{error}</Notice>}
            <button type="submit" className="btn btn-block" disabled={busy}>
              {busy ? 'Booking…' : `Book ${plural(qty, 'ticket')}`}
            </button>
            <p className="muted small">No payment is taken in this demo. Your tickets are confirmed straight away.</p>
          </form>
        )}
        <p><Link to={`/events/${e.eventId}`}>← Back to the event</Link></p>
      </div>
    </div>
  );
}
