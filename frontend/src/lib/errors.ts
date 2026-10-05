// Every error the user can see is turned into plain words here, in one place.

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export class NetworkError extends Error {
  constructor() {
    super('network');
  }
}

export const SESSION_ENDED = 'Your session has ended. Please sign in again.';

export function plainMessage(err: unknown): string {
  if (err instanceof NetworkError) return "Can't reach the server. Check your internet connection and try again.";

  if (err instanceof ApiError) {
    switch (err.code) {
      case 'UNAUTHENTICATED':
        return SESSION_ENDED;
      case 'FORBIDDEN':
        return "You don't have permission to do that with this account.";
      case 'NOT_FOUND':
        return "We couldn't find what you were looking for. It may have been removed.";
      case 'TICKET_NOT_FOUND':
        return "We couldn't find that ticket.";
      case 'SOLD_OUT': {
        const left = typeof err.extra.remaining === 'number' ? err.extra.remaining : 0;
        return left > 0
          ? `Only ${left} ticket${left === 1 ? ' is' : 's are'} left. Please choose a smaller number.`
          : 'Sorry, this event is sold out.';
      }
      case 'EVENT_STARTED':
        return 'Booking is closed because this event has already started.';
      case 'EVENT_ENDED':
        return 'This event has ended, so the ticket QR code is no longer available.';
      case 'EVENT_HAS_TICKETS':
        return "This event already has tickets sold, so it can't be deleted.";
      case 'BUSY':
        return 'Lots of people are booking right now. Please try again in a moment.';
      case 'VALIDATION_ERROR':
      case 'CONFLICT':
        return err.message; // the server already writes these in plain words
      default:
        if (err.status >= 500) return 'Something went wrong on our side. Please try again in a moment.';
        return err.message || 'Something went wrong. Please try again.';
    }
  }

  // Amazon Cognito errors carry a `code` or `name`
  const name = (err as { code?: string; name?: string } | null)?.code ?? (err as { name?: string } | null)?.name;
  switch (name) {
    case 'NotAuthorizedException':
    case 'UserNotFoundException':
      return "That email and password don't match. Please check them and try again.";
    case 'UsernameExistsException':
      return 'An account with this email already exists. Try signing in instead.';
    case 'InvalidPasswordException':
      return 'That password is too weak. Use at least 8 characters with a capital letter, a small letter and a number.';
    case 'InvalidParameterException':
      return 'Please check the details you entered and try again.';
    case 'UserLambdaValidationException':
      return "That account type isn't allowed for self sign-up.";
    case 'LimitExceededException':
    case 'TooManyRequestsException':
    case 'TooManyFailedAttemptsException':
      return 'Too many attempts. Please wait a minute and try again.';
    case 'NetworkError':
      return "Can't reach the sign-in service. Check your internet connection and try again.";
    default:
      return 'Something went wrong. Please try again.';
  }
}

// What the scanner shows for each check-in outcome. "good" is admitted, "bad" is turned away.
export interface ScanOutcome {
  kind: 'good' | 'bad';
  title: string;
  detail: string;
}

export function scanOutcomeFor(err: unknown, formatTime: (iso: string) => string): ScanOutcome {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'ALREADY_USED': {
        const at = typeof err.extra.checkedInAt === 'string' ? formatTime(err.extra.checkedInAt) : '';
        return {
          kind: 'bad',
          title: 'Already used',
          detail: at ? `This ticket was already checked in at ${at}. Do not let them in again.` : 'This ticket was already checked in. Do not let them in again.',
        };
      }
      case 'INVALID_TOKEN':
        return { kind: 'bad', title: 'Not a valid ticket', detail: "This QR code isn't a ticket from this system, or it has been changed." };
      case 'TOKEN_EXPIRED':
        return { kind: 'bad', title: 'Ticket expired', detail: 'This QR code is too old to use. The attendee can open My Tickets to get a current one.' };
      case 'WRONG_EVENT':
        return { kind: 'bad', title: 'Wrong event', detail: 'This ticket is for a different event than the one you are checking in.' };
      case 'TICKET_NOT_FOUND':
        return { kind: 'bad', title: 'Ticket not found', detail: "This ticket doesn't exist in our records." };
      case 'FORBIDDEN':
        return { kind: 'bad', title: 'Not allowed', detail: 'Your account is not allowed to check people in for this event.' };
      default:
        break;
    }
  }
  return { kind: 'bad', title: 'Could not check in', detail: plainMessage(err) };
}
