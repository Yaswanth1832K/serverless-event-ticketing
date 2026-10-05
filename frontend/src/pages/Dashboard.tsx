import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { CheckInColumns, Hero, SalesBars, StatTile } from '../components/Charts';
import { EmptyState, ErrorState, Loading, Notice, PageHeader } from '../components/States';
import { formatDateTime, percent } from '../lib/format';
import { usePolling } from '../lib/hooks';

export const POLL_MS = 5000;

export function LiveStatus({ lastUpdated, error, onRefresh }: { lastUpdated: Date | null; error: unknown; onRefresh: () => void }) {
  return (
    <div className="live">
      <span className="muted small" aria-live="off">
        {lastUpdated ? `Updated ${lastUpdated.toLocaleTimeString()} · refreshes every ${POLL_MS / 1000} seconds` : 'Loading…'}
      </span>
      <button type="button" className="btn btn-quiet btn-small" onClick={onRefresh}>Refresh now</button>
      {error !== undefined && lastUpdated && (
        <Notice kind="info">Couldn't refresh just now, so these are the numbers from {lastUpdated.toLocaleTimeString()}. We'll keep trying.</Notice>
      )}
    </div>
  );
}

export function Dashboard() {
  const dash = usePolling(() => api.dashboard(), POLL_MS);

  return (
    <>
      <PageHeader title="Dashboard">
        <Link className="btn" to="/organizer/events/new">New event</Link>
      </PageHeader>

      {dash.loading && !dash.data && <Loading label="Loading your numbers…" />}
      {!dash.data && !dash.loading && <ErrorState error={dash.error} onRetry={dash.refresh} title="We couldn't load your dashboard" />}

      {dash.data && (
        <>
          <LiveStatus lastUpdated={dash.lastUpdated} error={dash.error} onRefresh={dash.refresh} />

          {dash.data.totals.totalEvents === 0 ? (
            <EmptyState title="You haven't created an event yet" action={<Link className="btn" to="/organizer/events/new">Create your first event</Link>}>
              Once you have an event and people book it, your sales and check-ins show up here.
            </EmptyState>
          ) : (
            <>
              <section className="panel summary" aria-label="Summary">
                <Hero value={percent(dash.data.totals.attendancePct)} label="of the people who booked have checked in" />
                <div className="tiles">
                  <StatTile label="Events" value={dash.data.totals.totalEvents} />
                  <StatTile label="Tickets sold" value={dash.data.totals.ticketsSold} />
                  <StatTile label="Tickets left" value={dash.data.totals.remaining} />
                  <StatTile label="Checked in" value={dash.data.totals.checkedIn} />
                </div>
              </section>

              <section className="panel">
                <h2>Check-ins over time</h2>
                <CheckInColumns title="Check-ins per minute" points={dash.data.checkInsOverTime} />
                {dash.data.seriesCoversEvents >= 20 && (
                  <p className="muted small">This chart combines your 20 most recent events with check-ins.</p>
                )}
              </section>

              <section className="panel">
                <h2>Sales by event</h2>
                <SalesBars
                  rows={dash.data.events.map((e) => ({
                    id: e.eventId, name: e.name, sold: e.sold, capacity: e.capacity, checkedIn: e.checkedIn,
                    href: `/organizer/events/${e.eventId}/analytics`,
                  }))}
                />
              </section>

              <section className="panel">
                <h2>Your events</h2>
                <ul className="event-rows">
                  {dash.data.events.map((e) => (
                    <li key={e.eventId}>
                      <div>
                        <strong>{e.name}</strong>
                        <span className="muted small"> · {formatDateTime(e.startsAt)}</span>
                      </div>
                      <div className="row-actions">
                        <Link className="btn btn-small btn-quiet" to={`/events/${e.eventId}`}>View</Link>
                        <Link className="btn btn-small btn-quiet" to={`/organizer/events/${e.eventId}/analytics`}>Analytics</Link>
                        <Link className="btn btn-small btn-quiet" to={`/organizer/events/${e.eventId}/edit`}>Edit</Link>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            </>
          )}
        </>
      )}
    </>
  );
}
