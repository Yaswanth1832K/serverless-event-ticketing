import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { Notice, PageHeader } from '../components/States';
import { plainMessage } from '../lib/errors';
import { useRedirectWhenSignedIn } from './Login';

// The password rules mirror the Cognito pool, so people hear about a problem before they submit.
export function passwordProblems(pw: string): string[] {
  const out: string[] = [];
  if (pw.length < 8) out.push('at least 8 characters');
  if (!/[a-z]/.test(pw)) out.push('a small letter');
  if (!/[A-Z]/.test(pw)) out.push('a capital letter');
  if (!/[0-9]/.test(pw)) out.push('a number');
  return out;
}

export function Register() {
  const { register } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // Only these two are offered. Door staff accounts are created by an administrator, never here.
  const [role, setRole] = useState<'Attendee' | 'Organizer'>('Attendee');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useRedirectWhenSignedIn();

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError('Please enter a valid email address, like name@example.com.');
      return;
    }
    const problems = passwordProblems(password);
    if (problems.length) {
      setError(`Your password needs ${problems.join(', ')}.`);
      return;
    }
    setBusy(true);
    try {
      await register(email, password, role);
    } catch (err) {
      setError(plainMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="narrow">
      <PageHeader title="Create an account" />
      <form className="panel form" onSubmit={onSubmit} noValidate>
        <label>
          Email
          <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          Password
          <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required aria-describedby="pw-hint" />
          <span id="pw-hint" className="hint">At least 8 characters, with a capital letter, a small letter and a number.</span>
        </label>
        <fieldset>
          <legend>What do you want to do?</legend>
          <label className="choice">
            <input type="radio" name="role" checked={role === 'Attendee'} onChange={() => setRole('Attendee')} />
            <span><strong>Buy tickets</strong><br /><span className="muted">Browse events and get QR tickets.</span></span>
          </label>
          <label className="choice">
            <input type="radio" name="role" checked={role === 'Organizer'} onChange={() => setRole('Organizer')} />
            <span><strong>Run events</strong><br /><span className="muted">Create events, see sales and check people in.</span></span>
          </label>
        </fieldset>
        {error && <Notice kind="error">{error}</Notice>}
        <button type="submit" className="btn btn-block" disabled={busy}>
          {busy ? 'Creating your account…' : 'Create account'}
        </button>
        <p className="muted">
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      </form>
    </div>
  );
}
