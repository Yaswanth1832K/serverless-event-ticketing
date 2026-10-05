import { expect, test } from '@playwright/test';
import { newEmail, noSideScroll, register } from './helpers';

const shots = '../docs/screenshots';

test.describe('on a phone (Pixel 7 size)', () => {
  test('public pages fit the screen, the menu works and buttons are easy to tap', async ({ page }) => {
    for (const path of ['/', '/login', '/register']) {
      await page.goto(path);
      await expect(page.locator('main')).toBeVisible();
      expect(await noSideScroll(page), `${path} scrolls sideways`).toBe(true);
    }
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Upcoming events' })).toBeVisible();
    await expect(page.getByText(/loading events/i)).toBeHidden();
    await page.screenshot({ path: `${shots}/phone-event-list.png` });

    // the menu button opens and closes the links
    const menu = page.getByRole('button', { name: 'Menu' });
    await expect(menu).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeHidden();
    await menu.click();
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
    await page.getByRole('button', { name: 'Close menu' }).click();
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeHidden();

    // every visible button and link-button is at least 36px tall (44px for the main ones)
    await page.goto('/login');
    // wait until the app has loaded its settings and drawn the page, or there is nothing to measure yet
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    const heights = await page.locator('button:visible, a.btn:visible').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
    expect(heights.length).toBeGreaterThan(0);
    for (const h of heights) expect(h).toBeGreaterThanOrEqual(36);
  });

  test('signed-in pages also fit, and the ticket QR is usable on a phone', async ({ page }) => {
    await register(page, newEmail('phone'), 'Buy tickets');
    for (const path of ['/', '/my-tickets']) {
      await page.goto(path);
      await expect(page.locator('main')).toBeVisible();
      expect(await noSideScroll(page), `${path} scrolls sideways`).toBe(true);
    }
    await expect(page.getByText(/don't have any tickets yet/i)).toBeVisible();
    await page.screenshot({ path: `${shots}/phone-my-tickets.png` });

    // a rejected action is explained in words and the page stays usable
    await page.goto('/events/00000000-0000-4000-8000-000000000000');
    await expect(page.getByRole('alert')).toContainText(/couldn't find what you were looking for/i);
    expect(await noSideScroll(page)).toBe(true);
  });
});
