import { test, expect, type Page } from '@playwright/test';

/**
 * Full peer-to-peer flow across two isolated browser contexts:
 * create → invite link → join → handshake → fingerprint verify → chat.
 *
 * The two contexts simulate two devices; WebRTC connects them over the
 * host loopback. Message content is end-to-end encrypted in transit.
 */

const SECRET_MESSAGE = '保密合同条款 3.2';
const REPLY_MESSAGE = '收到，确认无误';

/** Waits until the given page reaches a phase (by testid presence). */
async function waitForTestId(page: Page, testId: string, timeout = 45_000) {
  await page.waitForSelector(`[data-testid="${testId}"]`, { timeout });
}

test('two peers exchange encrypted messages', async ({ browser }) => {
  // Two isolated contexts = two independent devices.
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  // --- Phase 1: creator opens a room -------------------------------
  await pageA.goto('/');
  await pageA.getByRole('button', { name: '创建安全会话' }).click();
  await waitForTestId(pageA, 'room-code');
  const roomCode = (await pageA.getByTestId('room-code').textContent())!.trim();
  expect(roomCode).toMatch(/^[0-9a-z]{6}$/);

  // --- Phase 2: joiner arrives via the invite link ------------------
  await pageB.goto(`/#/join/${roomCode}`);

  // --- Phase 3: both sides reach fingerprint verification -----------
  await waitForTestId(pageA, 'verify-match');
  await waitForTestId(pageB, 'verify-match');

  await pageA.getByTestId('verify-match').click();
  await pageB.getByTestId('verify-match').click();

  // --- Phase 4: chat is live -----------------------------------------
  await waitForTestId(pageA, 'message-input');
  await waitForTestId(pageB, 'message-input');

  // --- Phase 5: encrypted messages round-trip ------------------------
  await pageA.getByTestId('message-input').fill(SECRET_MESSAGE);
  await pageA.getByTestId('send-button').click();
  await expect(pageA.getByTestId('message')).toHaveCount(1);
  await expect(
    pageB.getByTestId('message').filter({ hasText: SECRET_MESSAGE }),
  ).toHaveCount(1);

  await pageB.getByTestId('message-input').fill(REPLY_MESSAGE);
  await pageB.getByTestId('send-button').click();
  await expect(
    pageA.getByTestId('message').filter({ hasText: REPLY_MESSAGE }),
  ).toHaveCount(1);

  await ctxA.close();
  await ctxB.close();
});
