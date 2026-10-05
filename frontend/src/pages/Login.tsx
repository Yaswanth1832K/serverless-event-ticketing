import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import type { SessionUser } from '../auth/cognito';
import { Notice, PageHeader } from '../components/States';
import { plainMessage } from '../lib/errors';

export function homeFor(user: SessionUser | null): string {
  if (user?.groups.includes('Organizer')) return '/organizer';
  if (user?.groups.includes('Staff')) return '/scan';
  return '/';
}

export function useRedirectWhenSignedIn() {
  const { status, user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => {
    if (status === 'signedIn') {
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from && from.startsWith('/') ? from : homeFor(user), { replace: true });
    }
  }, [status, user, navigate, location.state]);
}

export function Login() {
  const { signIn, notice, clearNotice } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useRedirectWhenSignedIn();

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    clearNotice();
    if (!email.trim() || !password) {
      setError('Please enter your email and password.');
      return;
    }
    setBusy(true);
    try {
      await signIn(email, password);
    } catch (err) {
      setError(plainMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="narrow">
      <PageHeader title="Sign in" />
      {notice && <Notice kind="info">{notice}</Notice>}
      <form className="panel form" onSubmit={onSubmit} noValidate>
        <label>
          Email
          <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          Password
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && <Notice kind="error">{error}</Notice>}
        <button type="submit" className="btn btn-block" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="muted">
          New here? <Link to="/register">Create an account</Link>
        </p>
      </form>
    </div>
  );
}
