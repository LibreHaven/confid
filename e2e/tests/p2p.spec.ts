import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';

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

/** Creates a room on pageA, joins it from pageB, and verifies fingerprints. */
async function connectPair(pageA: Page, pageB: Page) {
  await pageA.goto('/');
  await pageA.getByRole('button', { name: '创建安全会话' }).click();
  await waitForTestId(pageA, 'room-code');
  const roomCode = (await pageA.getByTestId('room-code').textContent())!.trim();
  expect(roomCode).toMatch(/^[0-9a-z]{6}$/);

  await pageB.goto(`/#/join/${roomCode}`);
  await waitForTestId(pageA, 'verify-match');
  await waitForTestId(pageB, 'verify-match');
  await pageA.getByTestId('verify-match').click();
  await pageB.getByTestId('verify-match').click();
  await waitForTestId(pageA, 'message-input');
  await waitForTestId(pageB, 'message-input');
}

test('two peers exchange encrypted messages', async ({ browser }) => {
  // Two isolated contexts = two independent devices.
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  await connectPair(pageA, pageB);

  // --- Encrypted messages round-trip --------------------------------
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

test('file transfer: bytes round-trip with download link', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  await connectPair(pageA, pageB);

  // --- Send a binary file with a Chinese name -----------------------
  // > 3 chunks (64KB each) + UTF-8 text + binary edges: proves multi-chunk
  // reassembly and byte-for-byte fidelity over the real DataChannel.
  const filler = Buffer.alloc(200 * 1024, 0x5a); // deterministic padding
  const payload = Buffer.concat([
    Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0xfe]), // binary head
    Buffer.from('保密合同条款 3.2：双方确认 🤝', 'utf8'),
    filler,
    Buffer.from([0x00, 0x01, 0x02, 0x7f, 0x80, 0xff]), // binary tail
  ]);
  await pageA.getByTestId('file-input').setInputFiles({
    name: '保密合同.pdf',
    mimeType: 'application/pdf',
    buffer: payload,
  });

  // Receiver sees the file card and a download link once complete.
  const fileMsg = pageB.getByTestId('file-message');
  await expect(fileMsg).toHaveCount(1);
  await expect(fileMsg).toContainText('保密合同.pdf');
  await expect(fileMsg).toContainText(/KB/); // formatted size
  await waitForTestId(pageB, 'file-download');

  // Sender's own card reaches complete too.
  await expect(pageA.getByTestId('file-message')).toContainText('已完成');

  // Download via the real browser download path (a[download] on the blob
  // URL) and verify the content byte-for-byte.
  const downloadPromise = pageB.waitForEvent('download');
  await pageB.getByTestId('file-download').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('保密合同.pdf');
  const received = readFileSync(await download.path()!);
  expect(received).toEqual(payload);

  // Chat still works after the transfer.
  await pageB.getByTestId('message-input').fill(REPLY_MESSAGE);
  await pageB.getByTestId('send-button').click();
  await expect(
    pageA.getByTestId('message').filter({ hasText: REPLY_MESSAGE }),
  ).toHaveCount(1);

  await ctxA.close();
  await ctxB.close();
});
