import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { buildMinutes, CheckInColumns, niceMax, SalesBars } from './Charts';
import { MemoryRouter } from 'react-router-dom';

describe('chart helpers', () => {
  it('rounds the axis maximum to a clean number', () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(3)).toBe(3);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(23)).toBe(50);
    expect(niceMax(130)).toBe(200);
  });

  it('fills empty minutes so gaps show as gaps', () => {
    const out = buildMinutes([
      { minute: '2026-10-05T07:29', count: 2 },
      { minute: '2026-10-05T07:32', count: 1 },
    ]);
    expect(out.map((m) => m.count)).toEqual([2, 0, 0, 1]);
  });

  it('keeps only the most recent hour', () => {
    const out = buildMinutes([
      { minute: '2026-10-05T01:00', count: 1 },
      { minute: '2026-10-05T09:00', count: 1 },
    ]);
    expect(out).toHaveLength(60);
    expect(out[out.length - 1]!.minute).toBe('2026-10-05T09:00');
  });
});

describe('<CheckInColumns>', () => {
  it('explains an empty chart instead of drawing nothing', () => {
    render(<CheckInColumns title="Check-ins per minute" points={[]} />);
    expect(screen.getByText(/no one has checked in yet/i)).toBeInTheDocument();
  });

  it('describes the data in words and offers a table', () => {
    render(<CheckInColumns title="Check-ins per minute" points={[{ minute: '2026-10-05T07:29', count: 3 }, { minute: '2026-10-05T07:30', count: 1 }]} />);
    expect(screen.getByText(/4 check-ins in total/i)).toBeInTheDocument();
    expect(screen.getByText(/show as a table/i)).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(3); // header + two minutes
  });
});

describe('<SalesBars>', () => {
  it('shows sold of capacity in words for each event', () => {
    render(
      <MemoryRouter>
        <SalesBars rows={[{ id: 'a', name: 'Fest', sold: 8, capacity: 10, checkedIn: 3, href: '/x' }]} />
      </MemoryRouter>,
    );
    expect(screen.getByText('8 of 10 sold')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /8 of 10 tickets sold, 3 checked in/i })).toBeInTheDocument();
    expect(screen.getByText(/3 people checked in/i)).toBeInTheDocument();
  });
});
