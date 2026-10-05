import { Link } from 'react-router-dom';
import type { EventSummary } from '../api/types';
import { config } from '../config';
import { formatDateTime, formatPrice, ticketsLeftLabel } from '../lib/format';

export function AvailabilityBadge({ remaining }: { remaining: number }) {
  const soldOut = remaining <= 0;
  const low = !soldOut && remaining <= 5;
  return (
    <span className={`badge ${soldOut ? 'badge-bad' : low ? 'badge-warn' : 'badge-good'}`}>
      <span aria-hidden="true">{soldOut ? '✕' : low ? '!' : '✓'}</span> {ticketsLeftLabel(remaining)}
    </span>
  );
}

export function EventImage({ url, name, className = 'card-image' }: { url: string | null; name: string; className?: string }) {
  return url ? (
    <img className={className} src={url} alt={`Cover of ${name}`} loading="lazy" />
  ) : (
    <div className={`${className} placeholder`} role="img" aria-label="No picture for this event">
      <span aria-hidden="true">🎟</span>
    </div>
  );
}

export function EventCard({ event }: { event: EventSummary }) {
  return (
    <article className="card">
      <EventImage url={event.imageUrl} name={event.name} />
      <div className="card-body">
        <h2 className="card-title">
          <Link to={`/events/${event.eventId}`}>{event.name}</Link>
        </h2>
        <p className="muted">{formatDateTime(event.startsAt)}</p>
        <p>{event.venue}</p>
        <p className="card-foot">
          <strong>{formatPrice(event.priceCents, config().currency)}</strong>
          <AvailabilityBadge remaining={event.remaining} />
        </p>
      </div>
    </article>
  );
}
