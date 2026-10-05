import { expect, type Page } from '@playwright/test';

export const PASSWORD = 'E2ePass12345';
export const stamp = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
export const newEmail = (label: string) => `e2e-${label}-${stamp()}@example.com`;

export async function register(page: Page, email: string, kind: 'Buy tickets' | 'Run events') {
  await page.goto('/register');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel(/^password/i).fill(PASSWORD);
  await page.getByLabel(new RegExp(kind, 'i')).check();
  await page.getByRole('button', { name: /create account/i }).click();
  // organizers land on the dashboard, attendees on the event list
  await expect(page).toHaveURL(kind === 'Run events' ? /\/organizer$/ : /\/$/, { timeout: 60_000 });
}

export function futureLocalInput(days = 5): string {
  const d = new Date(Date.now() + days * 86_400_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T18:00`;
}

export async function createEvent(page: Page, name: string, capacity = 5) {
  await page.goto('/organizer/events/new');
  await page.getByLabel('Event name').fill(name);
  await page.getByLabel('Description').fill('Created by the automated browser test.');
  await page.getByLabel('Place').fill('Test Hall');
  await page.getByLabel('Date and time').fill(futureLocalInput());
  await page.getByLabel('Ticket price').fill('5');
  await page.getByLabel('Capacity').fill(String(capacity));
  await page.getByRole('button', { name: /create event/i }).click();
  await expect(page).toHaveURL(/\/organizer$/, { timeout: 60_000 });
}

export async function noSideScroll(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}
