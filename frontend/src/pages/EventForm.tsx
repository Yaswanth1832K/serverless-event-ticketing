import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api, uploadToS3 } from '../api/client';
import type { EventInput, EventSummary } from '../api/types';
import { EventImage } from '../components/EventCard';
import { ErrorState, Loading, Notice, PageHeader } from '../components/States';
import { centsToDollars, dollarsToCents, isoToLocalInput, localInputToIso } from '../lib/format';
import { plainMessage } from '../lib/errors';
import { useAsync } from '../lib/hooks';

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

export function imageProblem(file: { type: string; size: number }): string | null {
  if (!IMAGE_TYPES.includes(file.type)) return 'Please choose a JPEG, PNG or WebP picture.';
  if (file.size > MAX_IMAGE_BYTES) return 'That picture is bigger than 2 MB. Please choose a smaller one.';
  if (file.size === 0) return 'That file is empty.';
  return null;
}

interface FormValues {
  name: string; description: string; venue: string; startsAt: string; price: string; capacity: string;
}

const EMPTY: FormValues = { name: '', description: '', venue: '', startsAt: '', price: '0.00', capacity: '50' };

function toValues(e: EventSummary): FormValues {
  return {
    name: e.name, description: e.description, venue: e.venue, startsAt: isoToLocalInput(e.startsAt),
    price: centsToDollars(e.priceCents), capacity: String(e.capacity),
  };
}

// Validates in plain words. Returns the API payload, or a list of problems.
export function validateForm(v: FormValues, mode: 'create' | 'edit'): { input?: EventInput; problems: string[] } {
  const problems: string[] = [];
  const name = v.name.trim();
  const venue = v.venue.trim();
  if (!name) problems.push('Please enter a name for the event.');
  else if (name.length > 100) problems.push('The name is too long (100 characters at most).');
  if (!venue) problems.push('Please enter where the event is happening.');
  else if (venue.length > 200) problems.push('The place is too long (200 characters at most).');
  if (v.description.length > 2000) problems.push('The description is too long (2000 characters at most).');
  const startsAt = localInputToIso(v.startsAt);
  if (!v.startsAt || !startsAt) problems.push('Please choose the date and time.');
  else if (mode === 'create' && Date.parse(startsAt) <= Date.now()) problems.push('The start time must be in the future.');
  const priceCents = dollarsToCents(v.price);
  if (priceCents === null || priceCents > 1_000_000) problems.push('Enter the ticket price as a number like 5 or 12.50 (use 0 for a free event).');
  const capacity = Number(v.capacity);
  if (!/^\d+$/.test(v.capacity.trim()) || capacity < 1 || capacity > 100_000) problems.push('Capacity must be a whole number from 1 to 100,000.');
  if (problems.length) return { problems };
  return { problems, input: { name, description: v.description.trim(), venue, startsAt: startsAt!, priceCents: priceCents!, capacity } };
}

export function EventForm({ mode }: { mode: 'create' | 'edit' }) {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const existing = useAsync(() => (mode === 'edit' ? api.getEvent(id) : Promise.resolve(undefined)), [mode, id]);

  const [values, setValues] = useState<FormValues>(EMPTY);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'idle' | 'saving' | 'uploading' | 'deleting'>('idle');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const loaded = useRef(false);

  useEffect(() => {
    if (existing.data && !loaded.current) {
      loaded.current = true;
      setValues(toValues(existing.data));
    }
  }, [existing.data]);

  useEffect(() => {
    if (!file) return setPreview(null);
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const set = (key: keyof FormValues) => (e: { target: { value: string } }) => setValues((v) => ({ ...v, [key]: e.target.value }));

  if (mode === 'edit' && existing.status === 'loading' && !existing.data) return <Loading label="Loading the event…" />;
  if (mode === 'edit' && !existing.data) return <ErrorState error={existing.error} onRetry={existing.reload} title="We couldn't load this event" />;

  async function onSubmit(ev: FormEvent) {
    ev.preventDefault();
    if (busy !== 'idle') return;
    setError(null);
    const { input, problems: found } = validateForm(values, mode);
    setProblems(found);
    if (!input) return;

    setBusy('saving');
    let eventId = id;
    try {
      if (mode === 'create') eventId = (await api.createEvent(input)).eventId;
      else await api.updateEvent(id, input);
    } catch (err) {
      setError(plainMessage(err));
      setBusy('idle');
      return;
    }

    if (file) {
      setBusy('uploading');
      try {
        const policy = await api.imageUploadPolicy(eventId, file.type, file.size);
        await uploadToS3(policy, file);
        await api.updateEvent(eventId, { imageKey: policy.imageKey });
      } catch (err) {
        // The event itself is saved. Send them to the edit page so they can retry just the picture.
        navigate(`/organizer/events/${eventId}/edit`, { replace: true, state: { notice: `The event was saved, but the picture could not be added. ${plainMessage(err)}` } });
        setBusy('idle');
        return;
      }
    }
    navigate('/organizer', { replace: true });
  }

  async function onDelete() {
    setBusy('deleting');
    setError(null);
    try {
      await api.deleteEvent(id);
      navigate('/organizer', { replace: true });
    } catch (err) {
      setError(plainMessage(err));
      setConfirmDelete(false);
      setBusy('idle');
    }
  }

  const working = busy !== 'idle';
  const noticeFromUpload = (location.state as { notice?: string } | null)?.notice;

  return (
    <div className="narrow">
      <PageHeader title={mode === 'create' ? 'New event' : 'Edit event'} />
      {noticeFromUpload && <Notice kind="info">{noticeFromUpload}</Notice>}
      <form className="panel form" onSubmit={onSubmit} noValidate>
        <label>
          Event name
          <input value={values.name} onChange={set('name')} maxLength={100} required />
        </label>
        <label>
          Description <span className="muted">(optional)</span>
          <textarea rows={4} value={values.description} onChange={set('description')} maxLength={2000} />
        </label>
        <label>
          Place
          <input value={values.venue} onChange={set('venue')} maxLength={200} required />
        </label>
        <label>
          Date and time
          <input type="datetime-local" value={values.startsAt} onChange={set('startsAt')} required />
        </label>
        <div className="two-col">
          <label>
            Ticket price
            <input inputMode="decimal" value={values.price} onChange={set('price')} aria-describedby="price-hint" />
            <span id="price-hint" className="hint">Use 0 for a free event.</span>
          </label>
          <label>
            Capacity
            <input inputMode="numeric" value={values.capacity} onChange={set('capacity')} aria-describedby="cap-hint" />
            <span id="cap-hint" className="hint">
              {mode === 'edit' && existing.data ? `Not lower than the ${existing.data.sold} already sold.` : 'How many tickets you can sell.'}
            </span>
          </label>
        </div>

        <div className="image-field">
          <p className="label-text">Picture <span className="muted">(optional)</span></p>
          {(preview || existing.data?.imageUrl) && (
            preview ? <img className="detail-image" src={preview} alt="Preview of the chosen cover" /> : <EventImage url={existing.data!.imageUrl} name={values.name} className="detail-image" />
          )}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            aria-label="Choose a picture"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              const problem = f ? imageProblem(f) : null;
              setFileError(problem);
              setFile(problem ? null : f);
            }}
          />
          <span className="hint">JPEG, PNG or WebP, up to 2 MB.</span>
          {fileError && <Notice kind="error">{fileError}</Notice>}
        </div>

        {problems.length > 0 && (
          <Notice kind="error">
            <strong>Please fix this first:</strong>
            <ul>{problems.map((p) => <li key={p}>{p}</li>)}</ul>
          </Notice>
        )}
        {error && <Notice kind="error">{error}</Notice>}

        <div className="actions">
          <button type="submit" className="btn" disabled={working}>
            {busy === 'saving' ? 'Saving…' : busy === 'uploading' ? 'Uploading the picture…' : mode === 'create' ? 'Create event' : 'Save changes'}
          </button>
          <Link className="btn btn-quiet" to="/organizer" aria-disabled={working}>Cancel</Link>
        </div>
      </form>

      {mode === 'edit' && (
        <div className="panel danger-zone">
          <h2>Delete this event</h2>
          {!confirmDelete ? (
            <>
              <p>Events that already have tickets sold can't be deleted.</p>
              <button type="button" className="btn btn-danger" onClick={() => setConfirmDelete(true)} disabled={working}>Delete event…</button>
            </>
          ) : (
            <>
              <p><strong>Delete “{existing.data?.name}” for good?</strong> This can't be undone.</p>
              <div className="actions">
                <button type="button" className="btn btn-danger" onClick={() => void onDelete()} disabled={working}>
                  {busy === 'deleting' ? 'Deleting…' : 'Yes, delete it'}
                </button>
                <button type="button" className="btn btn-quiet" onClick={() => setConfirmDelete(false)} disabled={working}>Keep it</button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
