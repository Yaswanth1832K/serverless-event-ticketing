import type { ReactNode } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { AvailabilityBadge, EventImage } from '../components/EventCard';
import { ErrorState, Loading, Notice } from '../components/States';
import { config } from '../config';
import { formatDateTime, formatPrice } from '../lib/format';
import { useAsync } from '../lib/hooks';

export function EventDetail() {
  const { id = '' } = useParams();
  const { status, hasRole } = useAuth();
  const location = useLocation();
  const event = useAsync(() => api.getEvent(id), [id]);

  if (event.status === 'loading' && !event.data) return <Loading label="Loading the event…" />;
  if (!event.data) {
    return (
      <>
        <ErrorState error={event.error} onRetry={event.reload} title="We couldn't load this event" />
        <p><Link to="/">← Back to all events</Link></p>
      </>
    );
  }

  const e = event.data;
  const started = Date.parse(e.startsAt) <= Date.now();

  let booking: ReactNode;
  if (started) {
    booking = <Notice kind="info">This event has already started, so booking is closed.</Notice>;
  } else if (e.remaining <= 0) {
    booking = <Notice kind="info">Sorry, this event is sold out.</Notice>;
  } else if (status === 'signedOut') {
    booking = (
      <Link className="btn" to="/login" state={{ from: location.pathname }}>
        Sign in to book tickets
      </Link>
    );
  } else if (hasRole('Attendee')) {
    booking = <Link className="btn" to={`/events/${e.eventId}/book`}>Book tickets</Link>;
  } else if (status === 'signedIn') {
    booking = <Notice kind="info">Organizer and door-staff accounts can't buy tickets. Sign in with an attendee account to book.</Notice>;
  }

  return (
    <article className="detail">
      <p><Link to="/">← All events</Link></p>
      <EventImage url={e.imageUrl} name={e.name} className="detail-image" />
      <h1>{e.name}</h1>
      <dl className="facts">
        <div><dt>When</dt><dd>{formatDateTime(e.startsAt)}</dd></div>
        <div><dt>Where</dt><dd>{e.venue}</dd></div>
        <div><dt>Price</dt><dd>{formatPrice(e.priceCents, config().currency)} per ticket</dd></div>
        <div><dt>Availability</dt><dd><AvailabilityBadge remaining={e.remaining} /></dd></div>
      </dl>
      {e.description && <p className="description">{e.description}</p>}
      <div className="cta">{booking}</div>
    </article>
  );
}
