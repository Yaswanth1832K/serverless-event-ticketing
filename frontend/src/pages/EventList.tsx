import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { EventCard } from '../components/EventCard';
import { EmptyState, ErrorState, Loading, PageHeader } from '../components/States';
import { useAsync } from '../lib/hooks';

export function EventList() {
  const { hasRole } = useAuth();
  const events = useAsync(() => api.listEvents(), []);
  const [query, setQuery] = useState('');

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = events.data ?? [];
    return q ? all.filter((e) => `${e.name} ${e.venue} ${e.description}`.toLowerCase().includes(q)) : all;
  }, [events.data, query]);

  return (
    <>
      <PageHeader title="Upcoming events" />
      {events.status === 'loading' && !events.data && <Loading label="Loading events…" />}
      {events.status === 'error' && !events.data && <ErrorState error={events.error} onRetry={events.reload} title="We couldn't load the events" />}
      {events.data && events.data.length === 0 && (
        <EmptyState
          title="No upcoming events yet"
          action={hasRole('Organizer') ? <Link className="btn" to="/organizer/events/new">Create the first event</Link> : undefined}
        >
          {hasRole('Organizer') ? 'You can create one now.' : 'Please check back soon.'}
        </EmptyState>
      )}
      {events.data && events.data.length > 0 && (
        <>
          <div className="toolbar">
            <label className="search">
              <span className="sr-only">Search events</span>
              <input type="search" placeholder="Search by name, place or description" value={query} onChange={(e) => setQuery(e.target.value)} />
            </label>
            <p className="muted" aria-live="polite">
              Showing {shown.length} of {events.data.length}
            </p>
          </div>
          {shown.length === 0 ? (
            <EmptyState
              title="No events match your search"
              action={<button type="button" className="btn" onClick={() => setQuery('')}>Clear search</button>}
            >
              Try different words, or clear the search to see everything.
            </EmptyState>
          ) : (
            <div className="grid">
              {shown.map((e) => (
                <EventCard key={e.eventId} event={e} />
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
