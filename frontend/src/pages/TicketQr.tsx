import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { ErrorState, Loading, Notice } from '../components/States';
import { QrCanvas, StatusBadge, type QrHandle } from '../components/TicketBits';
import { formatDateTime } from '../lib/format';
import { usePolling } from '../lib/hooks';

export function TicketQr() {
  const { eventId = '', ticketId = '' } = useParams();
  // Asked again every few seconds so the screen flips to "Checked in" right after the door scan.
  const ticket = usePolling(() => api.ticketQr(eventId, ticketId), 8000, [eventId, ticketId]);
  const qr = useRef<QrHandle>(null);
  const [copied, setCopied] = useState<'idle' | 'yes' | 'no'>('idle');
  const [downloadError, setDownloadError] = useState(false);

  if (ticket.loading && !ticket.data) return <Loading label="Getting your ticket…" />;
  if (!ticket.data) return (
    <>
      <ErrorState error={ticket.error} onRetry={ticket.refresh} title="We couldn't open this ticket" />
      <p><Link to="/my-tickets">← Back to My tickets</Link></p>
    </>
  );

  const t = ticket.data;

  async function download() {
    setDownloadError(false);
    const blob = await qr.current?.toBlob();
    if (!blob) {
      setDownloadError(true);
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ticket-${t.eventName.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${t.ticketId.slice(0, 8)}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(t.token);
      setCopied('yes');
    } catch {
      setCopied('no');
    }
  }

  return (
    <div className="narrow ticket-page">
      <p><Link to="/my-tickets">← My tickets</Link></p>
      <div className="panel ticket">
        <h1>{t.eventName}</h1>
        <p className="muted">{formatDateTime(t.startsAt)} · {t.venue}</p>
        <p><StatusBadge status={t.status} /></p>
        {t.status === 'CHECKED_IN' && (
          <Notice kind="info">This ticket has been used. The person at the door has already checked it in.</Notice>
        )}
        <div className="qr-wrap">
          <QrCanvas ref={qr} value={t.token} />
        </div>
        <p className="muted small">Turn your screen brightness up and hold your phone steady at the door.</p>
        <div className="actions">
          <button type="button" className="btn" onClick={() => void download()}>Download QR code</button>
        </div>
        {downloadError && <Notice kind="error">We couldn't save the picture. Take a screenshot of this page instead.</Notice>}
        {ticket.error !== undefined && <Notice kind="info">Couldn't refresh just now. This still shows your last ticket.</Notice>}

        <details className="manual">
          <summary>QR code won't scan? Use the ticket code</summary>
          <p className="small">The person checking you in can paste this code into their check-in page. Share it only at the door.</p>
          <textarea readOnly rows={4} value={t.token} aria-label="Ticket code" onFocus={(e) => e.currentTarget.select()} />
          <button type="button" className="btn btn-small" onClick={() => void copy()}>Copy code</button>
          {copied === 'yes' && <span role="status" className="small"> Copied.</span>}
          {copied === 'no' && <span role="status" className="small"> Your browser blocked copying. Tap the box and copy it by hand.</span>}
        </details>
        <p className="muted small">The code contains only a ticket number and an expiry time. It has no personal details.</p>
      </div>
    </div>
  );
}
