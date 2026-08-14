// Dogfood QA: systematic exploratory testing of the Confid web app.
// Two-peer flows use two isolated contexts; every step logs PASS/ISSUE.
// Evidence screenshots go to ../dogfood-output/screenshots/.
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const OUT = '../../dogfood-output';
const SHOTS = `${OUT}/screenshots`;
mkdirSync(SHOTS, { recursive: true });

const results = [];
let shotSeq = 0;

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'ISSUE'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function shot(page, tag) {
  shotSeq += 1;
  const path = `${SHOTS}/${String(shotSeq).padStart(2, '0')}-${tag}.png`;
  await page.screenshot({ path, fullPage: true }).catch(() => {});
  return path;
}

// Collect console errors / pageerrors per page.
function watch(page, tag) {
  const errs = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errs.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  return errs;
}

const browser = await chromium.launch({ channel: 'msedge' });
const ctxA = await browser.newContext();
const ctxB = await browser.newContext();
const ctxC = await browser.newContext();
const pageA = await ctxA.newPage();
const pageB = await ctxB.newPage();
const pageC = await ctxC.newPage();
const errsA = watch(pageA, 'A');
const errsB = watch(pageB, 'B');
const errsC = watch(pageC, 'C');

const BASE = 'http://localhost:5173';
const body = async (p) => (await p.locator('body').innerText().catch(() => '')).slice(0, 150).replace(/\n/g, ' | ');

// --- 1. Home page loads cleanly -----------------------------------------
await pageA.goto(BASE);
await pageA.getByRole('button', { name: '创建安全会话' }).click();
await pageA.waitForSelector('[data-testid="room-code"]', { timeout: 10000 });
const code = (await pageA.getByTestId('room-code').textContent()).trim();
record('create room shows 6-char code', /^[0-9a-z]{6}$/.test(code), code);
record('invite link shown', (await body(pageA)).includes('#/join/'));
await shot(pageA, 'waiting-view');
record('no JS errors on create flow', errsA.length === 0, errsA.join('; '));

// --- 2. Invalid room code ------------------------------------------------
await pageC.goto(BASE);
await pageC.getByPlaceholder('输入 6 位会话码').fill('zzzzzz');
await pageC.getByRole('button', { name: '加入会话' }).click();
await pageC.waitForTimeout(1500);
const cState = await body(pageC);
record('invalid room code shows failure state', cState.includes('会话失败'), cState.slice(30, 90));
record('invalid code: no JS errors', errsC.length === 0, errsC.join('; '));
await shot(pageC, 'invalid-code');

// --- 3. Empty input disabled ---------------------------------------------
await pageC.goto(BASE);
const joinBtn = pageC.getByRole('button', { name: '加入会话' });
record('join disabled with empty input', await joinBtn.isDisabled());

// --- 4. Join with valid code (two peers) ---------------------------------
await pageB.goto(`${BASE}/#/join/${code}`);
await pageA.waitForSelector('[data-testid="verify-match"]', { timeout: 30000 });
await pageB.waitForSelector('[data-testid="verify-match"]', { timeout: 30000 });
record('both peers reach fingerprint verification', true);
await shot(pageA, 'verify-view');
await shot(pageB, 'verify-view');

// --- 5. Fingerprint mismatch path (B rejects) ----------------------------
await pageB.getByTestId('verify-mismatch').click();
await pageB.waitForTimeout(500);
const bAfterReject = await body(pageB);
record('mismatch rejection shows failure', bAfterReject.includes('会话失败'), bAfterReject.slice(30, 90));
await shot(pageB, 'reject-fingerprint');
// A side should also end (peer closed/error)
await pageA.waitForTimeout(2000);
const aAfterReject = await body(pageA);
record('creator sees session end after peer rejects', aAfterReject.includes('会话已结束') || aAfterReject.includes('会话失败'), aAfterReject.slice(30, 90));
await shot(pageA, 'peer-rejected');

// --- 6. Retry from failed state ------------------------------------------
await pageB.getByRole('button', { name: '重试' }).click();
await pageB.waitForTimeout(500);
record('retry returns to home', (await body(pageB)).includes('创建安全会话'));

// --- 7. Full happy path again + chat -------------------------------------
await pageB.goto(BASE);
await pageB.getByRole('button', { name: '创建安全会话' }).click();
await pageB.waitForSelector('[data-testid="room-code"]', { timeout: 10000 });
const code2 = (await pageB.getByTestId('room-code').textContent()).trim();
await pageA.goto(`${BASE}/#/join/${code2}`);
await pageA.waitForSelector('[data-testid="verify-match"]', { timeout: 30000 });
await pageB.waitForSelector('[data-testid="verify-match"]', { timeout: 30000 });
await pageA.getByTestId('verify-match').click();
await pageB.getByTestId('verify-match').click();
await pageA.waitForSelector('[data-testid="message-input"]', { timeout: 15000 });
await pageB.waitForSelector('[data-testid="message-input"]', { timeout: 15000 });
record('happy path reaches chat', true);
await shot(pageA, 'chat-view');

// --- 8. XSS attempt + emoji + long message --------------------------------
const xss = '<img src=x onerror="window.__pwned=1">';
await pageB.getByTestId('message-input').fill(xss);
await pageB.getByTestId('send-button').click();
await pageA.waitForTimeout(800);
const pwned = await pageA.evaluate(() => window.__pwned === 1);
record('XSS payload rendered inert (no script execution)', !pwned, pwned ? 'SCRIPT EXECUTED!' : '');
const renderedXss = await pageA.getByTestId('message').filter({ hasText: 'onerror' }).count();
record('XSS payload visible as text', renderedXss > 0);

const emoji = '✅ 保密条款 3.2：已确认 🤝';
await pageB.getByTestId('message-input').fill(emoji);
await pageB.getByTestId('send-button').click();
await pageA.waitForTimeout(500);
record('emoji message round-trips', (await pageA.getByTestId('message').filter({ hasText: '保密条款' }).count()) >= 1);

const longMsg = '长消息测试'.repeat(200);
await pageB.getByTestId('message-input').fill(longMsg);
await pageB.getByTestId('send-button').click();
await pageA.waitForTimeout(800);
record('long message (1200 chars) round-trips', (await pageA.getByTestId('message').filter({ hasText: '长消息测试' }).count()) >= 1);
await shot(pageA, 'chat-messages');

// --- 9. Peer leaves --------------------------------------------------------
await pageB.close();
await pageA.waitForTimeout(2500);
const aAfterLeave = await body(pageA);
record('peer close ends session visibly', aAfterLeave.includes('会话已结束'), aAfterLeave.slice(30, 90));
await shot(pageA, 'peer-left');

// --- 10. Refresh resets (no residual state) --------------------------------
await pageA.goto(BASE);
await pageA.waitForTimeout(800);
const aAfterRefresh = await body(pageA);
record('refresh returns to home with no residual state', aAfterRefresh.includes('创建安全会话'));

// --- Summary ----------------------------------------------------------------
const issues = results.filter((r) => !r.ok);
console.log('\n==== QA SUMMARY ====');
console.log(`total: ${results.length}, issues: ${issues.length}`);
for (const i of issues) console.log(`- ${i.name}: ${i.detail}`);

await browser.close();
