import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

export function Layout() {
  const { status, user, signOut, hasRole } = useAuth();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();

  // close the phone menu whenever the page changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: the path is the trigger, it is not read inside the effect
  useEffect(() => setOpen(false), [location.pathname]);

  const links: { to: string; label: string; end?: boolean }[] = [{ to: '/', label: 'Events', end: true }];
  if (hasRole('Attendee')) links.push({ to: '/my-tickets', label: 'My tickets' });
  if (hasRole('Organizer')) {
    links.push({ to: '/organizer', label: 'Dashboard', end: true });
    links.push({ to: '/organizer/events/new', label: 'New event' });
  }
  if (hasRole('Organizer', 'Staff')) links.push({ to: '/scan', label: 'Check-in' });

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="site-header">
        <div className="container header-row">
          <Link to="/" className="brand">
            <span className="brand-mark" aria-hidden="true">🎟</span> Event Tickets
          </Link>
          <button
            type="button"
            className="btn btn-quiet menu-toggle"
            aria-expanded={open}
            aria-controls="site-nav"
            onClick={() => setOpen((o) => !o)}
          >
            {open ? 'Close menu' : 'Menu'}
          </button>
          <nav id="site-nav" className={`site-nav${open ? ' open' : ''}`} aria-label="Main">
            {links.map((l) => (
              <NavLink key={l.to} to={l.to} end={l.end} className={({ isActive }) => (isActive ? 'active' : undefined)}>
                {l.label}
              </NavLink>
            ))}
            {status === 'signedIn' ? (
              <span className="nav-user">
                <span className="nav-email" title={user?.email}>{user?.email}</span>
                <button
                  type="button"
                  className="btn btn-quiet"
                  onClick={() => {
                    signOut();
                    navigate('/');
                  }}
                >
                  Sign out
                </button>
              </span>
            ) : status === 'signedOut' ? (
              <span className="nav-user">
                <NavLink to="/login">Sign in</NavLink>
                <Link className="btn" to="/register">Create account</Link>
              </span>
            ) : null}
          </nav>
        </div>
      </header>
      <main id="main" className="container">
        <Outlet />
      </main>
      <footer className="site-footer container">
        <p>Tickets are shown in the app. Show the QR code on your phone at the door.</p>
      </footer>
    </>
  );
}
