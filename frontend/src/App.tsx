import { Component, type ReactNode } from 'react';
import { Link, Route, Routes } from 'react-router-dom';
import { RequireAuth, RequireRole } from './components/Guards';
import { Layout } from './components/Layout';
import { EmptyState } from './components/States';
import { Book } from './pages/Book';
import { Dashboard } from './pages/Dashboard';
import { EventAnalytics } from './pages/EventAnalytics';
import { EventDetail } from './pages/EventDetail';
import { EventForm } from './pages/EventForm';
import { EventList } from './pages/EventList';
import { Login } from './pages/Login';
import { MyTickets } from './pages/MyTickets';
import { Register } from './pages/Register';
import { Scanner } from './pages/Scanner';
import { TicketQr } from './pages/TicketQr';

function NotFound() {
  return (
    <EmptyState title="We can't find that page" action={<Link className="btn" to="/">Go to the events</Link>}>
      The link may be old or mistyped.
    </EmptyState>
  );
}

// Last line of defence: a bug in one page should show a calm message, not a blank screen.
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error('page crashed', error);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="container">
        <div className="panel panel-error" role="alert">
          <h1>Something went wrong</h1>
          <p>We hit a problem showing this page. Your tickets and bookings are safe.</p>
          <button type="button" className="btn" onClick={() => window.location.assign('/')}>Start again</button>
        </div>
      </div>
    );
  }
}

export function App() {
  return (
    <ErrorBoundary>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<EventList />} />
          <Route path="login" element={<Login />} />
          <Route path="register" element={<Register />} />
          <Route path="events/:id" element={<EventDetail />} />
          <Route path="events/:id/book" element={<RequireRole roles={['Attendee']}><Book /></RequireRole>} />
          <Route path="my-tickets" element={<RequireRole roles={['Attendee']}><MyTickets /></RequireRole>} />
          <Route path="tickets/:eventId/:ticketId" element={<RequireAuth><TicketQr /></RequireAuth>} />
          <Route path="organizer" element={<RequireRole roles={['Organizer']}><Dashboard /></RequireRole>} />
          <Route path="organizer/events/new" element={<RequireRole roles={['Organizer']}><EventForm mode="create" /></RequireRole>} />
          <Route path="organizer/events/:id/edit" element={<RequireRole roles={['Organizer']}><EventForm mode="edit" /></RequireRole>} />
          <Route path="organizer/events/:id/analytics" element={<RequireRole roles={['Organizer']}><EventAnalytics /></RequireRole>} />
          <Route path="scan" element={<RequireRole roles={['Organizer', 'Staff']}><Scanner /></RequireRole>} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </ErrorBoundary>
  );
}
