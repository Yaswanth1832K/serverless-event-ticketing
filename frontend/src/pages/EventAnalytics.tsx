import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { CheckInColumns, Hero, StatTile } from '../components/Charts';
import { ErrorState, Loading, PageHeader } from '../components/States';
import { formatDateTime, percent } from '../lib/format';
import { usePolling } from '../lib/hooks';
import { LiveStatus, POLL_MS } from './Dashboard';

export function EventAnalytics() {
  const { id = '' } = useParams();
  const stats = usePolling(() => api.eventAnalytics(id), POLL_MS, [id]);

  if (stats.loading && !stats.data) return <Loading label="Loading the numbers…" />;
  if (!stats.data) {
    return (
      <>
        <ErrorState error={stats.error} onRetry={stats.refresh} title="We couldn't load these numbers" />
        <p><Link to="/organizer">← Back to the dashboard</Link></p>
      </>
    );
  }
  const s = stats.data;

  return (
    <>
      <p><Link to="/organizer">← Dashboard</Link></p>
      <PageHeader title={s.name}>
        <Link className="btn btn-quiet" to={`/organizer/events/${s.eventId}/edit`}>Edit event</Link>
      </PageHeader>
      <p className="muted">{formatDateTime(s.startsAt)}</p>
      <LiveStatus lastUpdated={stats.lastUpdated} error={stats.error} onRefresh={stats.refresh} />

      <section className="panel summary" aria-label="Summary">
        <Hero value={percent(s.attendancePct)} label="of the people who booked have checked in" />
        <div className="tiles">
          <StatTile label="Capacity" value={s.capacity} />
          <StatTile label="Tickets sold" value={s.sold} />
          <StatTile label="Tickets left" value={s.remaining} />
          <StatTile label="Checked in" value={s.checkedIn} />
        </div>
      </section>

      <section className="panel">
        <h2>Check-ins over time</h2>
        <CheckInColumns title="Check-ins per minute" points={s.checkInsOverTime} />
      </section>

      <p>
        <Link className="btn" to="/scan">Open the check-in scanner</Link>
      </p>
    </>
  );
}
