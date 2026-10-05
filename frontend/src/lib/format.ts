// Display helpers. Money is stored as whole cents on the server, never as floats.

export function formatPrice(cents: number, currency = 'USD'): string {
  if (cents === 0) return 'Free';
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100);
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Date to be announced';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(d);
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(d);
}

export function ticketsLeftLabel(remaining: number): string {
  if (remaining <= 0) return 'Sold out';
  if (remaining === 1) return '1 ticket left';
  return `${remaining} tickets left`;
}

// "7 tickets" / "1 ticket"
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

// <input type="datetime-local"> works in local time without a zone. These convert to and from ISO.
export function isoToLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function localInputToIso(value: string): string | null {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// "12.50" -> 1250. Returns null for anything that is not a plain non-negative amount.
export function dollarsToCents(text: string): number | null {
  const t = text.trim();
  if (!/^\d{1,5}(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(parseFloat(t) * 100);
}

export function centsToDollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function percent(n: number): string {
  return `${Number.isInteger(n) ? n : n.toFixed(1)}%`;
}
