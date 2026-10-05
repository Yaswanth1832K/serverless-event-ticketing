import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { ApiError, NetworkError } from '../lib/errors';
import { future, makeAuth, makeEvent, renderAt, useTestConfig } from '../test/helpers';

const authMock = vi.hoisted(() => ({ current: null as any }));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => authMock.current, AuthProvider: ({ children }: any) => children }));

const apiMock = vi.hoisted(() => ({
  listEvents: vi.fn(), getEvent: vi.fn(), book: vi.fn(), myEvents: vi.fn(), dashboard: vi.fn(), checkIn: vi.fn(),
  myTickets: vi.fn(), ticketQr: vi.fn(), eventAnalytics: vi.fn(), createEvent: vi.fn(), updateEvent: vi.fn(),
  deleteEvent: vi.fn(), imageUploadPolicy: vi.fn(),
}));
vi.mock('../api/client', () => ({ api: apiMock, uploadToS3: vi.fn() }));
vi.mock('qrcode', () => ({ default: { toCanvas: vi.fn(async () => {}) } }));

import { EventList } from './EventList';
import { Book } from './Book';
import { EventDetail } from './EventDetail';
import { Register } from './Register';
import { Login } from './Login';
import { Scanner } from './Scanner';
import { Dashboard } from './Dashboard';
import { EventForm, imageProblem, validateForm } from './EventForm';
import { MyTickets } from './MyTickets';
import { TicketQr } from './TicketQr';
import { RequireRole } from '../components/Guards';

const EID = '11111111-1111-4111-8111-111111111111';
const pending = <T,>() => new Promise<T>(() => {});

beforeEach(() => {
  useTestConfig();
  for (const m of Object.values(apiMock)) m.mockReset();
  authMock.current = makeAuth(['Attendee']);
});

describe('event list', () => {
  it('shows a loading message, then the events', async () => {
    apiMock.listEvents.mockReturnValue(pending());
    const { unmount } = renderAt(<EventList />);
    expect(screen.getByRole('status')).toHaveTextContent(/loading events/i);
    unmount();

    apiMock.listEvents.mockResolvedValue([makeEvent(), makeEvent({ eventId: 'b', name: 'Sold Out Show', remaining: 0, sold: 10 })]);
    renderAt(<EventList />);
    expect(await screen.findByText('Tech Fest')).toBeInTheDocument();
    expect(screen.getByText('Sold out')).toBeInTheDocument();
    expect(screen.getByText('8 tickets left')).toBeInTheDocument();
  });

  it('explains an empty list, and offers organizers a way to fix it', async () => {
    apiMock.listEvents.mockResolvedValue([]);
    const { unmount } = renderAt(<EventList />);
    expect(await screen.findByText(/no upcoming events yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /create the first event/i })).not.toBeInTheDocument();
    unmount();

    authMock.current = makeAuth(['Organizer']);
    renderAt(<EventList />);
    expect(await screen.findByRole('link', { name: /create the first event/i })).toBeInTheDocument();
  });

  it('shows a plain error with a working Try again button', async () => {
    apiMock.listEvents.mockRejectedValueOnce(new NetworkError()).mockResolvedValueOnce([makeEvent()]);
    renderAt(<EventList />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/can't reach the server/i);
    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('Tech Fest')).toBeInTheDocument();
  });

  it('search filters the list and Clear search brings everything back', async () => {
    apiMock.listEvents.mockResolvedValue([makeEvent(), makeEvent({ eventId: 'b', name: 'Music Night', venue: 'Park' })]);
    renderAt(<EventList />);
    await screen.findByText('Tech Fest');
    const box = screen.getByRole('searchbox');
    await userEvent.type(box, 'music');
    expect(screen.queryByText('Tech Fest')).not.toBeInTheDocument();
    expect(screen.getByText('Music Night')).toBeInTheDocument();
    await userEvent.clear(box);
    await userEvent.type(box, 'zzzz');
    expect(screen.getByText(/no events match your search/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /clear search/i }));
    expect(screen.getByText('Tech Fest')).toBeInTheDocument();
  });
});

describe('event details', () => {
  const at = () => renderAt(<EventDetail />, { path: '/events/:id', route: `/events/${EID}` });

  it('offers a booking link to attendees and a sign-in link to visitors', async () => {
    apiMock.getEvent.mockResolvedValue(makeEvent());
    const { unmount } = at();
    expect(await screen.findByRole('link', { name: /book tickets/i })).toHaveAttribute('href', `/events/${EID}/book`);
    unmount();
    authMock.current = makeAuth(null);
    at();
    expect(await screen.findByRole('link', { name: /sign in to book/i })).toBeInTheDocument();
  });

  it('says why booking is unavailable instead of showing a dead button', async () => {
    apiMock.getEvent.mockResolvedValue(makeEvent({ remaining: 0 }));
    const a = at();
    expect(await screen.findByText(/sorry, this event is sold out/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /book tickets/i })).not.toBeInTheDocument();
    a.unmount();

    apiMock.getEvent.mockResolvedValue(makeEvent({ startsAt: '2020-01-01T00:00:00.000Z' }));
    const b = at();
    expect(await screen.findByText(/already started/i)).toBeInTheDocument();
    b.unmount();

    authMock.current = makeAuth(['Organizer']);
    apiMock.getEvent.mockResolvedValue(makeEvent());
    at();
    expect(await screen.findByText(/organizer and door-staff accounts can't buy tickets/i)).toBeInTheDocument();
  });

  it('shows a friendly message for an event that does not exist', async () => {
    apiMock.getEvent.mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'Event not found'));
    at();
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn't find what you were looking for/i);
    expect(screen.getByRole('link', { name: /back to all events/i })).toBeInTheDocument();
  });
});

describe('booking', () => {
  const at = () => renderAt(<Book />, { path: '/events/:id/book', route: `/events/${EID}/book` });

  it('books the chosen number of tickets and shows where to find the QR codes', async () => {
    apiMock.getEvent.mockResolvedValue(makeEvent());
    apiMock.book.mockResolvedValue({
      eventId: EID, quantity: 2, totalPriceCents: 1000,
      tickets: [{ ticketId: 't1', eventId: EID, status: 'BOOKED', createdAt: '' }, { ticketId: 't2', eventId: EID, status: 'BOOKED', createdAt: '' }],
    });
    at();
    await screen.findByText('Tech Fest');
    await userEvent.selectOptions(screen.getByLabelText(/how many tickets/i), '2');
    expect(screen.getByText('$10.00')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /book 2 tickets/i }));
    expect(apiMock.book).toHaveBeenCalledWith(EID, 2);
    expect(await screen.findByText(/you're booked/i)).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /show qr code/i })).toHaveLength(2);
    expect(screen.getByRole('link', { name: /go to my tickets/i })).toBeInTheDocument();
  });

  it('cannot book twice with a double click', async () => {
    apiMock.getEvent.mockResolvedValue(makeEvent());
    apiMock.book.mockReturnValue(pending());
    at();
    const button = await screen.findByRole('button', { name: /book 1 ticket/i });
    await userEvent.dblClick(button);
    expect(apiMock.book).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('button', { name: /booking…/i })).toBeDisabled();
  });

  it('says it plainly when the tickets ran out meanwhile, and refreshes the numbers', async () => {
    apiMock.getEvent.mockResolvedValueOnce(makeEvent()).mockResolvedValue(makeEvent({ remaining: 1 }));
    apiMock.book.mockRejectedValue(new ApiError(409, 'SOLD_OUT', 'Only 1 ticket(s) left', { remaining: 1 }));
    at();
    await userEvent.click(await screen.findByRole('button', { name: /book 1 ticket/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/only 1 ticket is left/i);
    await waitFor(() => expect(apiMock.getEvent).toHaveBeenCalledTimes(2));
  });

  it('shows sold out with no booking form', async () => {
    apiMock.getEvent.mockResolvedValue(makeEvent({ remaining: 0 }));
    at();
    expect(await screen.findByText(/sorry, this event is sold out/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /book/i })).not.toBeInTheDocument();
  });
});

describe('create account and sign in', () => {
  it('only offers Attendee and Organizer, never Staff', () => {
    authMock.current = makeAuth(null);
    renderAt(<Register />);
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(2);
    expect(screen.getByLabelText(/buy tickets/i)).toBeChecked();
    expect(screen.getByLabelText(/run events/i)).toBeInTheDocument();
    expect(screen.queryByText(/staff/i)).not.toBeInTheDocument();
  });

  it('tells people what is wrong with their email or password in words', async () => {
    authMock.current = makeAuth(null);
    renderAt(<Register />);
    await userEvent.type(screen.getByLabelText(/^email/i), 'nope');
    await userEvent.type(screen.getByLabelText(/^password/i), 'abc');
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));
    expect(screen.getByRole('alert')).toHaveTextContent(/valid email address/i);
    await userEvent.clear(screen.getByLabelText(/^email/i));
    await userEvent.type(screen.getByLabelText(/^email/i), 'me@example.com');
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));
    expect(screen.getByRole('alert')).toHaveTextContent(/at least 8 characters, a capital letter, a number/i);
    expect(authMock.current.register).not.toHaveBeenCalled();
  });

  it('registers with the chosen account type', async () => {
    authMock.current = makeAuth(null);
    renderAt(<Register />);
    await userEvent.type(screen.getByLabelText(/^email/i), 'me@example.com');
    await userEvent.type(screen.getByLabelText(/^password/i), 'GoodPass123');
    await userEvent.click(screen.getByLabelText(/run events/i));
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));
    expect(authMock.current.register).toHaveBeenCalledWith('me@example.com', 'GoodPass123', 'Organizer');
  });

  it('shows a plain message when the email is already used', async () => {
    authMock.current = makeAuth(null, { register: vi.fn().mockRejectedValue({ code: 'UsernameExistsException' }) });
    renderAt(<Register />);
    await userEvent.type(screen.getByLabelText(/^email/i), 'me@example.com');
    await userEvent.type(screen.getByLabelText(/^password/i), 'GoodPass123');
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/already exists/i);
    expect(screen.getByRole('button', { name: /create account/i })).toBeEnabled();
  });

  it('sign-in asks for both fields and explains a wrong password', async () => {
    authMock.current = makeAuth(null, { signIn: vi.fn().mockRejectedValue({ code: 'NotAuthorizedException' }), notice: 'Your session has ended. Please sign in again.' });
    renderAt(<Login />);
    expect(screen.getByText(/your session has ended/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^sign in$/i }));
    expect(screen.getByRole('alert')).toHaveTextContent(/enter your email and password/i);
    await userEvent.type(screen.getByLabelText(/^email/i), 'me@example.com');
    await userEvent.type(screen.getByLabelText(/^password/i), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: /^sign in$/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/email and password don't match/i);
  });
});

describe('page access', () => {
  const guarded = () =>
    renderAt(
      <Routes>
        <Route path="/login" element={<p>login page</p>} />
        <Route path="/organizer" element={<RequireRole roles={['Organizer']}><p>organizer page</p></RequireRole>} />
      </Routes>,
      { path: '*', route: '/organizer' },
    );

  it('sends visitors to sign in', () => {
    authMock.current = makeAuth(null);
    guarded();
    expect(screen.getByText('login page')).toBeInTheDocument();
  });
  it('explains to the wrong kind of account that the page is not for them', () => {
    guarded();
    expect(screen.getByText(/this page isn't for your account/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to events/i })).toBeInTheDocument();
    expect(screen.queryByText('organizer page')).not.toBeInTheDocument();
  });
  it('lets the right account in', () => {
    authMock.current = makeAuth(['Organizer']);
    guarded();
    expect(screen.getByText('organizer page')).toBeInTheDocument();
  });
});

describe('check-in scanner', () => {
  const at = () => renderAt(<Scanner />, { path: '/scan' });
  const scanSetup = async () => {
    authMock.current = makeAuth(['Organizer']);
    apiMock.myEvents.mockResolvedValue([makeEvent()]);
    at();
    await screen.findByLabelText(/which event/i);
  };
  const submitCode = async (code = 'v1.abc.def') => {
    await userEvent.selectOptions(screen.getByLabelText(/which event/i), EID);
    await userEvent.type(screen.getByPlaceholderText(/paste the code/i), code);
    await userEvent.click(screen.getByRole('button', { name: /^check in$/i }));
  };

  it('keeps the buttons off until an event is chosen', async () => {
    await scanSetup();
    expect(screen.getByRole('button', { name: /start camera/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^check in$/i })).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText(/which event/i), EID);
    expect(screen.getByRole('button', { name: /start camera/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /^check in$/i })).toBeDisabled(); // still no code typed
  });

  it('admits a valid ticket', async () => {
    await scanSetup();
    apiMock.checkIn.mockResolvedValue({ result: 'CHECKED_IN', ticketId: 't', eventId: EID, eventName: 'Tech Fest', checkedInAt: new Date().toISOString() });
    await submitCode();
    expect(apiMock.checkIn).toHaveBeenCalledWith('v1.abc.def', EID);
    const result = await screen.findByRole('status');
    expect(result).toHaveTextContent('Checked in');
    expect(result).toHaveTextContent(/let them in/i);
  });

  it.each([
    ['ALREADY_USED', 'Already used', { checkedInAt: new Date().toISOString() }],
    ['INVALID_TOKEN', 'Not a valid ticket', {}],
    ['TOKEN_EXPIRED', 'Ticket expired', {}],
    ['WRONG_EVENT', 'Wrong event', {}],
    ['TICKET_NOT_FOUND', 'Ticket not found', {}],
  ])('turns away a ticket with %s in plain words', async (code, title, extra) => {
    await scanSetup();
    apiMock.checkIn.mockRejectedValue(new ApiError(409, code, 'm', extra));
    await submitCode();
    expect(await screen.findByRole('status')).toHaveTextContent(title);
  });

  it('keeps a short history of recent scans', async () => {
    await scanSetup();
    apiMock.checkIn.mockRejectedValue(new ApiError(409, 'ALREADY_USED', 'm', {}));
    await submitCode();
    expect(await screen.findByRole('heading', { name: /recent scans/i })).toBeInTheDocument();
  });

  it('explains when the camera cannot be used and points to the code box', async () => {
    await scanSetup();
    await userEvent.selectOptions(screen.getByLabelText(/which event/i), EID);
    await userEvent.click(screen.getByRole('button', { name: /start camera/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/code box below/i);
    expect(screen.getByRole('button', { name: /start camera/i })).toBeEnabled();
  });

  it('door staff choose from the public list because they own no events', async () => {
    authMock.current = makeAuth(['Staff']);
    apiMock.listEvents.mockResolvedValue([makeEvent()]);
    at();
    await screen.findByLabelText(/which event/i);
    expect(apiMock.listEvents).toHaveBeenCalled();
    expect(apiMock.myEvents).not.toHaveBeenCalled();
  });

  it('says so when there are no events, and when loading fails', async () => {
    authMock.current = makeAuth(['Staff']);
    apiMock.listEvents.mockResolvedValue([]);
    const a = at();
    expect(await screen.findByText(/no events to check people into/i)).toBeInTheDocument();
    a.unmount();
    apiMock.listEvents.mockRejectedValue(new NetworkError());
    at();
    expect(await screen.findByRole('alert')).toHaveTextContent(/can't reach the server/i);
  });
});

describe('organizer dashboard', () => {
  const totals = { totalEvents: 2, ticketsSold: 10, remaining: 5, checkedIn: 5, attendancePct: 50 };
  const data = {
    totals, generatedAt: '', seriesCoversEvents: 1,
    events: [{ eventId: 'a', name: 'Fest', startsAt: future(), capacity: 10, sold: 10, remaining: 0, checkedIn: 5, attendancePct: 50 }],
    checkInsOverTime: [{ minute: '2026-10-05T07:29', count: 5 }],
  };
  beforeEach(() => {
    authMock.current = makeAuth(['Organizer']);
  });

  it('shows loading, then the numbers', async () => {
    apiMock.dashboard.mockResolvedValue(data);
    renderAt(<Dashboard />);
    expect(screen.getByRole('status')).toHaveTextContent(/loading your numbers/i);
    expect(await screen.findByText('50%')).toBeInTheDocument();
    expect(screen.getByText(/of the people who booked have checked in/i)).toBeInTheDocument();
    expect(screen.getByText('Tickets sold')).toBeInTheDocument();
    expect(screen.getByText('10 of 10 sold')).toBeInTheDocument();
  });

  it('explains an organizer with no events', async () => {
    apiMock.dashboard.mockResolvedValue({ ...data, totals: { ...totals, totalEvents: 0, ticketsSold: 0, remaining: 0, checkedIn: 0, attendancePct: 0 }, events: [], checkInsOverTime: [] });
    renderAt(<Dashboard />);
    expect(await screen.findByText(/haven't created an event yet/i)).toBeInTheDocument();
  });

  it('shows an error with retry when the first load fails', async () => {
    apiMock.dashboard.mockRejectedValueOnce(new ApiError(500, 'INTERNAL', 'x')).mockResolvedValue(data);
    renderAt(<Dashboard />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/went wrong on our side/i);
    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('50%')).toBeInTheDocument();
  });

  it('keeps the last numbers on screen when a refresh fails, and says so', async () => {
    apiMock.dashboard.mockResolvedValueOnce(data).mockRejectedValue(new NetworkError());
    renderAt(<Dashboard />);
    await screen.findByText('50%');
    await userEvent.click(screen.getByRole('button', { name: /refresh now/i }));
    expect(await screen.findByText(/couldn't refresh just now/i)).toBeInTheDocument();
    expect(screen.getByText('50%')).toBeInTheDocument();
  });
});

describe('create and edit event form', () => {
  const good = { name: 'Fest', description: '', venue: 'Hall', startsAt: '', price: '5', capacity: '20' };
  const laterLocal = () => {
    const d = new Date(Date.now() + 5 * 86_400_000);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T10:00`;
  };

  it('validates in plain words', () => {
    expect(validateForm({ ...good, startsAt: laterLocal() }, 'create').input).toMatchObject({ name: 'Fest', priceCents: 500, capacity: 20 });
    const bad = validateForm({ name: ' ', description: '', venue: '', startsAt: '', price: 'abc', capacity: '0' }, 'create').problems;
    expect(bad).toEqual(expect.arrayContaining([
      'Please enter a name for the event.',
      'Please enter where the event is happening.',
      'Please choose the date and time.',
      expect.stringMatching(/ticket price as a number/),
      expect.stringMatching(/whole number from 1/),
    ]));
    expect(validateForm({ ...good, startsAt: '2020-01-01T10:00' }, 'create').problems).toContain('The start time must be in the future.');
    expect(validateForm({ ...good, startsAt: '2020-01-01T10:00' }, 'edit').problems).toEqual([]); // old events can still be edited
  });

  it('checks picture type and size before uploading anything', () => {
    expect(imageProblem({ type: 'image/png', size: 1000 })).toBeNull();
    expect(imageProblem({ type: 'image/gif', size: 1000 })).toMatch(/JPEG, PNG or WebP/);
    expect(imageProblem({ type: 'image/png', size: 3 * 1024 * 1024 })).toMatch(/bigger than 2 MB/);
  });

  it('lists what to fix and does not call the server when the form is empty', async () => {
    authMock.current = makeAuth(['Organizer']);
    renderAt(<EventForm mode="create" />, { path: '/organizer/events/new' });
    await userEvent.clear(screen.getByLabelText(/capacity/i));
    await userEvent.click(screen.getByRole('button', { name: /create event/i }));
    expect(screen.getByText(/please fix this first/i)).toBeInTheDocument();
    expect(screen.getByText('Please enter a name for the event.')).toBeInTheDocument();
    expect(apiMock.createEvent).not.toHaveBeenCalled();
  });

  it('refuses a picture that is too big, straight away', async () => {
    authMock.current = makeAuth(['Organizer']);
    renderAt(<EventForm mode="create" />, { path: '/organizer/events/new' });
    const big = new File([new ArrayBuffer(3 * 1024 * 1024)], 'big.png', { type: 'image/png' });
    await userEvent.upload(screen.getByLabelText(/choose a picture/i), big);
    expect(await screen.findByRole('alert')).toHaveTextContent(/bigger than 2 MB/i);
  });

  it('delete asks first, and explains why an event with tickets cannot be deleted', async () => {
    authMock.current = makeAuth(['Organizer']);
    apiMock.getEvent.mockResolvedValue(makeEvent());
    apiMock.deleteEvent.mockRejectedValue(new ApiError(409, 'EVENT_HAS_TICKETS', 'x'));
    renderAt(<EventForm mode="edit" />, { path: '/organizer/events/:id/edit', route: `/organizer/events/${EID}/edit` });
    await userEvent.click(await screen.findByRole('button', { name: /delete event…/i }));
    expect(screen.getByText(/can't be undone/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /keep it/i }));
    expect(screen.queryByText(/can't be undone/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /delete event…/i }));
    await userEvent.click(screen.getByRole('button', { name: /yes, delete it/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/already has tickets sold/i);
  });

  it('an edit that the server refuses (not your event) shows a plain message', async () => {
    authMock.current = makeAuth(['Organizer']);
    apiMock.getEvent.mockResolvedValue(makeEvent());
    apiMock.updateEvent.mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'You do not own this event'));
    renderAt(<EventForm mode="edit" />, { path: '/organizer/events/:id/edit', route: `/organizer/events/${EID}/edit` });
    await screen.findByDisplayValue('Tech Fest');
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/don't have permission/i);
  });
});

describe('my tickets and the QR ticket', () => {
  const ticket = (over = {}) => ({
    ticketId: 't1', eventId: EID, status: 'BOOKED', eventName: 'Tech Fest', venue: 'Hall', startsAt: future(),
    priceCents: 0, createdAt: '', checkedInAt: null, ...over,
  });

  it('groups tickets by event and links each to its QR code', async () => {
    apiMock.myTickets.mockResolvedValue([ticket(), ticket({ ticketId: 't2', status: 'CHECKED_IN', checkedInAt: new Date().toISOString() })]);
    renderAt(<MyTickets />);
    expect(await screen.findByText('2 tickets')).toBeInTheDocument();
    expect(screen.getByText('Ready to use')).toBeInTheDocument();
    expect(screen.getByText('Checked in')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /show qr code/i })[0]).toHaveAttribute('href', `/tickets/${EID}/t1`);
  });

  it('has an empty state that mentions the short delay after booking, plus loading and error states', async () => {
    apiMock.myTickets.mockResolvedValue([]);
    const a = renderAt(<MyTickets />);
    expect(await screen.findByText(/don't have any tickets yet/i)).toBeInTheDocument();
    expect(screen.getByText(/press refresh/i)).toBeInTheDocument();
    a.unmount();
    apiMock.myTickets.mockReturnValue(pending());
    const b = renderAt(<MyTickets />);
    expect(screen.getByRole('status')).toHaveTextContent(/loading your tickets/i);
    b.unmount();
    apiMock.myTickets.mockRejectedValue(new NetworkError());
    renderAt(<MyTickets />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/can't reach the server/i);
  });

  const qrAt = () => renderAt(<TicketQr />, { path: '/tickets/:eventId/:ticketId', route: `/tickets/${EID}/t1` });
  const qr = (over = {}) => ({ ticketId: 't1', eventId: EID, status: 'BOOKED', eventName: 'Tech Fest', venue: 'Hall', startsAt: future(), token: 'v1.payload.signature', expiresAt: '', ...over });

  it('shows the ticket, a download button and the manual code', async () => {
    apiMock.ticketQr.mockResolvedValue(qr());
    qrAt();
    expect(await screen.findByRole('heading', { name: 'Tech Fest' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /qr code for your ticket/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /download qr code/i })).toBeEnabled();
    expect(screen.getByLabelText('Ticket code')).toHaveValue('v1.payload.signature');
  });

  it('copy button works, and says so when the browser blocks it', async () => {
    apiMock.ticketQr.mockResolvedValue(qr());
    const user = userEvent.setup();
    qrAt();
    await screen.findByRole('heading', { name: 'Tech Fest' });
    await user.click(screen.getByText(/won't scan/i));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await user.click(screen.getByRole('button', { name: /copy code/i }));
    expect(writeText).toHaveBeenCalledWith('v1.payload.signature');
    expect(await screen.findByText(/copied/i)).toBeInTheDocument();
    writeText.mockRejectedValue(new Error('blocked'));
    await user.click(screen.getByRole('button', { name: /copy code/i }));
    expect(await screen.findByText(/blocked copying/i)).toBeInTheDocument();
  });

  it('shows a used ticket clearly', async () => {
    apiMock.ticketQr.mockResolvedValue(qr({ status: 'CHECKED_IN' }));
    qrAt();
    expect(await screen.findByText(/this ticket has been used/i)).toBeInTheDocument();
  });

  it("explains a ticket that isn't yours or no longer available", async () => {
    apiMock.ticketQr.mockRejectedValue(new ApiError(404, 'TICKET_NOT_FOUND', 'Ticket not found'));
    qrAt();
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn't find that ticket/i);
    expect(screen.getByRole('link', { name: /back to my tickets/i })).toBeInTheDocument();
  });
});
