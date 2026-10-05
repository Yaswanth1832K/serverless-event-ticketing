import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import type { CheckInResult } from '../api/types';
import { EmptyState, ErrorState, Loading, Notice, PageHeader } from '../components/States';
import { formatDateTime, formatTime } from '../lib/format';
import { scanOutcomeFor, type ScanOutcome } from '../lib/errors';
import { useAsync } from '../lib/hooks';

interface HistoryItem extends ScanOutcome {
  id: number;
  at: Date;
}

const REMEMBER_KEY = 'scanner.eventId';
const COOLDOWN_MS = 3000; // the camera sees the same code many times a second

export function Scanner() {
  const { hasRole } = useAuth();
  // Organizers pick from their own events. Door staff are not tied to an event, so they pick from the public list.
  const events = useAsync(async () => (hasRole('Organizer') ? api.myEvents() : api.listEvents()), []);

  const [eventId, setEventId] = useState(() => sessionStorage.getItem(REMEMBER_KEY) ?? '');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ScanOutcome | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);

  const [cameraState, setCameraState] = useState<'off' | 'starting' | 'on'>('off');
  const [cameraError, setCameraError] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const scanner = useRef<{ stop: () => void; destroy: () => void } | null>(null);
  const last = useRef<{ text: string; at: number }>({ text: '', at: 0 });
  const busyRef = useRef(false);
  const historyId = useRef(0);
  const eventRef = useRef(eventId);
  eventRef.current = eventId;

  // forget the choice if that event is no longer in the list
  useEffect(() => {
    if (events.data && eventId && !events.data.some((e) => e.eventId === eventId)) setEventId('');
  }, [events.data, eventId]);

  const submit = useCallback(async (token: string) => {
    const chosen = eventRef.current;
    if (busyRef.current || !chosen || !token.trim()) return;
    busyRef.current = true;
    setBusy(true);
    let outcome: ScanOutcome;
    try {
      const ok: CheckInResult = await api.checkIn(token.trim(), chosen);
      outcome = {
        kind: 'good',
        title: 'Checked in',
        detail: `${ok.eventName ?? 'Ticket'} is valid. Let them in. Checked in at ${formatTime(ok.checkedInAt)}.`,
      };
      navigator.vibrate?.(80);
    } catch (err) {
      outcome = scanOutcomeFor(err, formatTime);
      navigator.vibrate?.([60, 40, 60]);
    }
    setResult(outcome);
    historyId.current += 1;
    setHistory((h) => [{ ...outcome, id: historyId.current, at: new Date() }, ...h].slice(0, 6));
    busyRef.current = false;
    setBusy(false);
  }, []);

  async function stopCamera() {
    scanner.current?.stop();
    scanner.current?.destroy();
    scanner.current = null;
    setCameraState('off');
  }

  async function startCamera() {
    setCameraError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError("This browser can't use the camera here (it needs a secure https page). Use the code box below instead.");
      return;
    }
    setCameraState('starting');
    try {
      // loaded only when needed, so the camera library is not part of every page load
      const { default: QrScanner } = await import('qr-scanner');
      if (!(await QrScanner.hasCamera())) {
        setCameraError('No camera was found on this device. Use the code box below instead.');
        setCameraState('off');
        return;
      }
      const s = new QrScanner(
        video.current!,
        (found) => {
          const now = Date.now();
          if (found.data === last.current.text && now - last.current.at < COOLDOWN_MS) return;
          last.current = { text: found.data, at: now };
          void submit(found.data);
        },
        { preferredCamera: 'environment', returnDetailedScanResult: true, highlightScanRegion: true, maxScansPerSecond: 5 },
      );
      scanner.current = s;
      await s.start();
      setCameraState('on');
    } catch (err) {
      const name = (err as { name?: string } | string)?.toString();
      setCameraError(
        /NotAllowed|Permission/i.test(String(name))
          ? 'The camera is blocked. Allow camera access for this site in your browser settings, then try again. You can use the code box below meanwhile.'
          : "We couldn't start the camera. Use the code box below instead.",
      );
      scanner.current?.destroy();
      scanner.current = null;
      setCameraState('off');
    }
  }

  useEffect(() => () => {
    scanner.current?.stop();
    scanner.current?.destroy();
  }, []);

  function chooseEvent(id: string) {
    setEventId(id);
    setResult(null);
    if (id) sessionStorage.setItem(REMEMBER_KEY, id);
    else sessionStorage.removeItem(REMEMBER_KEY);
  }

  function onManual(e: FormEvent) {
    e.preventDefault();
    void submit(code).then(() => setCode(''));
  }

  if (events.status === 'loading' && !events.data) return <Loading label="Loading events…" />;
  if (!events.data) return <ErrorState error={events.error} onRetry={events.reload} title="We couldn't load the events" />;
  if (events.data.length === 0) {
    return (
      <>
        <PageHeader title="Check-in" />
        <EmptyState
          title="There are no events to check people into"
          action={hasRole('Organizer') ? <Link className="btn" to="/organizer/events/new">Create an event</Link> : undefined}
        >
          {hasRole('Organizer') ? 'Create an event first.' : 'No upcoming events are listed right now.'}
        </EmptyState>
      </>
    );
  }

  const ready = Boolean(eventId);

  return (
    <>
      <PageHeader title="Check-in" />
      <section className="panel">
        <label className="form-field">
          Which event are you checking people into?
          <select value={eventId} onChange={(e) => chooseEvent(e.target.value)}>
            <option value="">Choose an event…</option>
            {events.data.map((e) => (
              <option key={e.eventId} value={e.eventId}>{e.name} · {formatDateTime(e.startsAt)}</option>
            ))}
          </select>
        </label>
        {!ready && <p className="muted">Choose the event first. A ticket for a different event will be turned away.</p>}
      </section>

      {/* the verdict sits right under the event picker so it is on screen while the camera is open */}
      <div aria-live="assertive" className="result-region">
        {busy && !result && <Loading label="Checking the ticket…" />}
        {result && (
          <div className={`result result-${result.kind}`} role="status">
            <p className="result-title"><span aria-hidden="true">{result.kind === 'good' ? '✓' : '✕'}</span> {result.title}</p>
            <p>{result.detail}</p>
          </div>
        )}
      </div>


      <section className="panel" aria-labelledby="cam-h">
        <h2 id="cam-h">Scan with the camera</h2>
        <div className={`video-box${cameraState === 'on' ? ' on' : ''}`}>
          <video ref={video} playsInline muted aria-label="Camera view for scanning QR codes" />
        </div>
        {cameraError && <Notice kind="error">{cameraError}</Notice>}
        {cameraState === 'off' ? (
          <button type="button" className="btn" disabled={!ready} onClick={() => void startCamera()}>Start camera</button>
        ) : (
          <button type="button" className="btn btn-quiet" disabled={cameraState === 'starting'} onClick={() => void stopCamera()}>
            {cameraState === 'starting' ? 'Starting the camera…' : 'Stop camera'}
          </button>
        )}
        {!ready && <p className="muted small">Choose an event to turn the camera on.</p>}
      </section>

      <section className="panel" aria-labelledby="man-h">
        <h2 id="man-h">Or type in the ticket code</h2>
        <form className="form" onSubmit={onManual}>
          <label>
            Ticket code
            <textarea rows={3} value={code} onChange={(e) => setCode(e.target.value)} placeholder="Paste the code from the attendee's ticket page" spellCheck={false} autoCapitalize="off" autoCorrect="off" />
          </label>
          <button type="submit" className="btn" disabled={!ready || busy || !code.trim()}>
            {busy ? 'Checking…' : 'Check in'}
          </button>
        </form>
      </section>

      {history.length > 0 && (
        <section className="panel">
          <h2>Recent scans</h2>
          <ul className="history">
            {history.map((h) => (
              <li key={h.id}>
                <span className={h.kind === 'good' ? 'ok' : 'no'}><span aria-hidden="true">{h.kind === 'good' ? '✓' : '✕'}</span> {h.title}</span>
                <span className="muted small">{formatTime(h.at.toISOString())}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
