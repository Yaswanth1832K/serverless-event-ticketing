import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { SeriesPoint } from '../api/types';
import { formatTime, plural } from '../lib/format';

// ---------------------------------------------------------------------------------------------
// Charts. One series, one colour (--series-1). Thin bars (never wider than 24px) with a 4px rounded
// end that sit on a single baseline. A hover/focus readout under the chart, and a table view for
// anyone who prefers numbers or uses a screen reader.
// ---------------------------------------------------------------------------------------------

export function Hero({ value, label }: { value: string; label: string }) {
  return (
    <div className="hero">
      <p className="hero-value">{value}</p>
      <p className="hero-label">{label}</p>
    </div>
  );
}

export function StatTile({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="tile">
      <p className="tile-label">{label}</p>
      <p className="tile-value">{typeof value === 'number' ? value.toLocaleString() : value}</p>
    </div>
  );
}

// ---- event-wise sales: one horizontal bar per event ----------------------------------------

export interface SalesRow {
  id: string;
  name: string;
  sold: number;
  capacity: number;
  checkedIn: number;
  href?: string;
}

export function SalesBars({ rows }: { rows: SalesRow[] }) {
  return (
    <div>
      <ul className="bars" aria-label="Tickets sold per event">
        {rows.map((r) => {
          const pct = r.capacity > 0 ? Math.min(100, (r.sold / r.capacity) * 100) : 0;
          return (
            <li key={r.id} className="bar-row">
              <div className="bar-head">
                <span className="bar-name">{r.href ? <Link to={r.href}>{r.name}</Link> : r.name}</span>
                <span className="bar-value">
                  {r.sold} of {r.capacity} sold
                </span>
              </div>
              <div
                className="bar-track"
                role="img"
                aria-label={`${r.name}: ${r.sold} of ${r.capacity} tickets sold, ${r.checkedIn} checked in`}
              >
                <div className="bar-fill" style={{ width: `${pct}%` }} />
              </div>
              <p className="muted small">{plural(r.checkedIn, 'person', 'people')} checked in</p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---- check-ins over time: one column per minute ---------------------------------------------

const W = 640;
const H = 190;
const PAD = { left: 34, right: 8, top: 10, bottom: 26 };
const MAX_MINUTES = 60;

// minute strings look like 2026-10-05T07:29 and are UTC
const minuteToDate = (m: string) => new Date(`${m}:00Z`);

export function niceMax(n: number): number {
  if (n <= 5) return Math.max(n, 1);
  const pow = 10 ** Math.floor(Math.log10(n));
  for (const step of [1, 2, 5, 10]) if (n <= step * pow) return step * pow;
  return n;
}

// Fills in the minutes with no check-ins so gaps show as gaps, and keeps the most recent hour.
export function buildMinutes(points: SeriesPoint[]): SeriesPoint[] {
  if (points.length === 0) return [];
  const byMinute = new Map(points.map((p) => [p.minute, p.count]));
  const times = points.map((p) => minuteToDate(p.minute).getTime());
  const last = Math.max(...times);
  const first = Math.max(Math.min(...times), last - (MAX_MINUTES - 1) * 60_000);
  const out: SeriesPoint[] = [];
  for (let t = first; t <= last; t += 60_000) {
    const minute = new Date(t).toISOString().slice(0, 16);
    out.push({ minute, count: byMinute.get(minute) ?? 0 });
  }
  return out;
}

function columnPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h); // rounded at the top, square on the baseline
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}

export function CheckInColumns({ points, title }: { points: SeriesPoint[]; title: string }) {
  const minutes = useMemo(() => buildMinutes(points), [points]);
  const [active, setActive] = useState<number | null>(null);
  const total = points.reduce((n, p) => n + p.count, 0);
  const peak = minutes.reduce<SeriesPoint | null>((best, p) => (!best || p.count > best.count ? p : best), null);

  if (minutes.length === 0) {
    return (
      <div className="chart">
        <h3>{title}</h3>
        <p className="muted">No one has checked in yet. This chart fills in as people are scanned at the door.</p>
      </div>
    );
  }

  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const max = niceMax(Math.max(...minutes.map((m) => m.count)));
  const slot = innerW / minutes.length;
  const barW = Math.min(24, Math.max(2, slot - 2)); // 2px gap between neighbours
  const baseY = PAD.top + innerH;
  const ticks = [0, Math.round(max / 2), max].filter((v, i, a) => a.indexOf(v) === i);
  const labelAt = (i: number) => formatTime(minuteToDate(minutes[i]!.minute).toISOString());
  const xLabels = [...new Set([0, Math.floor((minutes.length - 1) / 2), minutes.length - 1])];

  const readout =
    active !== null
      ? `${labelAt(active)}: ${plural(minutes[active]!.count, 'check-in')}`
      : `${plural(total, 'check-in')} in total${peak && peak.count > 0 ? `, busiest minute ${labelAt(minutes.indexOf(peak))} with ${peak.count}` : ''}`;

  return (
    <div className="chart">
      <h3>{title}</h3>
      {/* biome-ignore lint/a11y/useSemanticElements: an SVG cannot be a fieldset, role="group" is the correct label for it */}
      <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg" role="group" aria-label={`${title}. ${readout}. A table is available below.`}>
        {ticks.map((t) => {
          const y = baseY - (t / max) * innerH;
          return (
            <g key={t}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y} y2={y} className={t === 0 ? 'axis' : 'grid'} />
              <text x={PAD.left - 6} y={y + 4} textAnchor="end" className="tick">{t}</text>
            </g>
          );
        })}
        {minutes.map((m, i) => {
          const h = (m.count / max) * innerH;
          const x = PAD.left + i * slot + (slot - barW) / 2;
          return (
            <g key={m.minute}>
              {m.count > 0 && <path d={columnPath(x, baseY - h, barW, h)} className={`col${active === i ? ' col-active' : ''}`} />}
              {/* wider invisible target so thin bars are easy to hover or tab to */}
              {/* biome-ignore lint/a11y/noStaticElementInteractions: a labelled, focusable hit area; the same numbers are in the table view below */}
              <rect
                x={PAD.left + i * slot}
                y={PAD.top}
                width={slot}
                height={innerH}
                fill="transparent"
                tabIndex={0}
                aria-label={`${labelAt(i)}: ${plural(m.count, 'check-in')}`}
                onMouseEnter={() => setActive(i)}
                onMouseLeave={() => setActive(null)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
              />
            </g>
          );
        })}
        {xLabels.map((i) => (
          <text
            key={i}
            x={PAD.left + i * slot + slot / 2}
            y={H - 6}
            textAnchor={i === 0 ? 'start' : i === minutes.length - 1 ? 'end' : 'middle'}
            className="tick"
          >
            {labelAt(i)}
          </text>
        ))}
      </svg>
      <p className="readout" aria-live="polite">{readout}</p>
      <details>
        <summary>Show as a table</summary>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th scope="col">Time</th><th scope="col">Check-ins</th></tr>
            </thead>
            <tbody>
              {minutes.filter((m) => m.count > 0).map((m) => (
                <tr key={m.minute}>
                  <td>{formatTime(minuteToDate(m.minute).toISOString())}</td>
                  <td>{m.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

