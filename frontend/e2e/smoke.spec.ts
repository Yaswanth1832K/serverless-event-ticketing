import { expect, test } from '@playwright/test';
import { createEvent, newEmail, register, stamp } from './helpers';

const shots = '../docs/screenshots';

test.describe('site basics (no sign-in needed)', () => {
  test('is served over HTTPS with security headers, and the settings file is public and secret-free', async ({ request, baseURL }) => {
    const home = await request.get('/');
    expect(home.status()).toBe(200);
    const h = home.headers();
    expect(h['content-security-policy']).toContain("default-src 'self'");
    expect(h['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(h['strict-transport-security']).toContain('max-age=31536000');
    expect(h['x-frame-options']).toBe('DENY');
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['permissions-policy']).toContain('camera=(self)');

    const cfg = await request.get('/config.json');
    expect(cfg.status()).toBe(200);
    const config = await cfg.json();
    expect(Object.keys(config).sort()).toEqual(['apiUrl', 'currency', 'region', 'userPoolClientId', 'userPoolId']);
    expect(JSON.stringify(config)).not.toMatch(/secret|password|AKIA/i);

    // plain http is sent to https
    const insecure = await request.get(baseURL!.replace('https://', 'http://'), { maxRedirects: 0 });
    expect([301, 302, 307, 308]).toContain(insecure.status());
    expect(insecure.headers()['location']).toMatch(/^https:/);
  });

  test('a deep link works, and a protected page sends visitors to sign in', async ({ page }) => {
    await page.goto('/my-tickets');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await page.goto('/this-page-does-not-exist');
    await expect(page.getByText(/can't find that page/i)).toBeVisible();
  });
});

test('the full journey: organizer creates, attendee books, QR is scanned, numbers update', async ({ browser }) => {
  const name = `E2E-${stamp()}`;

  // ---- organizer: sign up and create an event
  const orgCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const org = await orgCtx.newPage();
  await register(org, newEmail('org'), 'Run events');
  await expect(org.getByText(/haven't created an event yet/i)).toBeVisible();
  await createEvent(org, name, 5);
  await expect(org.getByText(name).first()).toBeVisible({ timeout: 30_000 });

  // ---- attendee: sign up, find the event, book 2 tickets
  const attCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const att = await attCtx.newPage();
  await register(att, newEmail('att'), 'Buy tickets');
  await expect(async () => {
    await att.goto('/');
    await expect(att.getByRole('link', { name })).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 60_000 });
  await att.screenshot({ path: `${shots}/event-list.png` });
  await att.getByRole('link', { name }).click();
  await att.getByRole('link', { name: /book tickets/i }).click();
  await att.getByLabel(/how many tickets/i).selectOption('2');
  await att.getByRole('button', { name: /book 2 tickets/i }).click();
  await expect(att.getByText(/you're booked/i)).toBeVisible();

  // ---- attendee: tickets and QR (the list is eventually consistent, so Refresh until both appear)
  await att.getByRole('link', { name: /go to my tickets/i }).click();
  await expect(async () => {
    await att.getByRole('button', { name: /refresh/i }).click();
    await expect(att.getByText('2 tickets')).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 60_000 });
  await att.getByRole('link', { name: /show qr code/i }).first().click();
  const qr = att.getByRole('img', { name: /qr code for your ticket/i });
  await expect(qr).toBeVisible();
  // the QR really is drawn: the canvas contains dark squares
  const dark = await qr.evaluate((c: HTMLCanvasElement) => {
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 60 && d[i + 3] > 200) n++;
    return n;
  });
  expect(dark).toBeGreaterThan(500);
  await att.screenshot({ path: `${shots}/ticket-qr.png` });
  await att.getByText(/won't scan/i).click();
  const token = await att.getByLabel('Ticket code').inputValue();
  expect(token).toMatch(/^v1\.[\w-]+\.[\w-]+$/);
  expect(token).not.toContain('@'); // no personal data in the QR

  // ---- organizer: scan the code (manual entry), then scan it again
  await org.goto('/scan');
  const value = await org.locator('select option', { hasText: name }).getAttribute('value');
  await org.getByLabel(/which event/i).selectOption(value!);
  await org.getByPlaceholder(/paste the code/i).fill(token);
  await org.getByRole('button', { name: /^check in$/i }).click();
  await expect(org.getByRole('status').filter({ hasText: 'Checked in' })).toBeVisible();
  await org.screenshot({ path: `${shots}/scanner-admitted.png` });
  await org.getByPlaceholder(/paste the code/i).fill(token);
  await org.getByRole('button', { name: /^check in$/i }).click();
  await expect(org.getByRole('status').filter({ hasText: 'Already used' })).toBeVisible();
  await org.screenshot({ path: `${shots}/scanner-already-used.png` });
  await org.getByPlaceholder(/paste the code/i).fill('v1.not.real');
  await org.getByRole('button', { name: /^check in$/i }).click();
  await expect(org.getByRole('status').filter({ hasText: 'Not a valid ticket' })).toBeVisible();

  // ---- the attendee's screen flips to "used" by itself, and the dashboard shows 1 of 2 (50%)
  await expect(att.getByText(/this ticket has been used/i)).toBeVisible({ timeout: 40_000 });
  await org.goto('/organizer');
  await expect(org.getByText('50%')).toBeVisible({ timeout: 60_000 });
  await expect(org.getByText('2 of 5 sold')).toBeVisible();
  await org.screenshot({ path: `${shots}/dashboard.png`, fullPage: true });

  // ---- an attendee must not reach the organizer pages
  await att.goto('/organizer');
  await expect(att.getByText(/this page isn't for your account/i)).toBeVisible();
  await att.goto('/scan');
  await expect(att.getByText(/this page isn't for your account/i)).toBeVisible();

  await orgCtx.close();
  await attCtx.close();
});
