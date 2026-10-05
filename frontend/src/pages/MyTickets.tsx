import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { Ticket } from '../api/types';
import { EmptyState, ErrorState, Loading, PageHeader } from '../components/States';
import { StatusBadge } from '../components/TicketBits';
import { formatDateTime, formatTime, plural } from '../lib/format';
import { useAsync } from '../lib/hooks';

export function MyTickets() {
  const tickets = useAsync(() => api.myTickets(), []);

  const groups = useMemo(() => {
    const byEvent = new Map<string, Ticket[]>();
    for (const t of tickets.data ?? []) byEvent.set(t.eventId, [...(byEvent.get(t.eventId) ?? []), t]);
    return [...byEvent.values()].sort((a, b) => a[0]!.startsAt.localeCompare(b[0]!.startsAt));
  }, [tickets.data]);

  return (
    <>
      <PageHeader title="My tickets">
        <button type="button" className="btn btn-quiet" onClick={tickets.reload} disabled={tickets.status === 'loading'}>
          {tickets.status === 'loading' && tickets.data ? 'Refreshing…' : 'Refresh'}
        </button>
      </PageHeader>

      {tickets.status === 'loading' && !tickets.data && <Loading label="Loading your tickets…" />}
      {tickets.status === 'error' && !tickets.data && <ErrorState error={tickets.error} onRetry={tickets.reload} title="We couldn't load your tickets" />}

      {tickets.data && tickets.data.length === 0 && (
        <EmptyState title="You don't have any tickets yet" action={<Link className="btn" to="/">Browse events</Link>}>
          Just booked? New tickets can take a few seconds to appear. Press Refresh.
        </EmptyState>
      )}

      {groups.map((list) => {
        const first = list[0]!;
        return (
          <section key={first.eventId} className="panel ticket-group">
            <h2><Link to={`/events/${first.eventId}`}>{first.eventName}</Link></h2>
            <p className="muted">{formatDateTime(first.startsAt)} · {first.venue}</p>
            <p>{plural(list.length, 'ticket')}</p>
            <ul className="ticket-list">
              {list.map((t, i) => (
                <li key={t.ticketId}>
                  <span>Ticket {i + 1}</span>
                  <StatusBadge status={t.status} />
                  {t.checkedInAt && <span className="muted small">at {formatTime(t.checkedInAt)}</span>}
                  <Link className="btn btn-small" to={`/tickets/${t.eventId}/${t.ticketId}`}>
                    Show QR code
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </>
  );
}
