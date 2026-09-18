// Read-only real-host capability probe.
// Safety contract: explicit opt-in, no UI interaction, no saveMetadata call,
// and every non-GET request is aborted before it can reach ST or a plugin route.
import { createRequire } from 'node:module';

const target = String(process.env.QIANMU_ST_URL || '').trim();
if (!target) throw new Error('QIANMU_ST_URL is required; refusing to guess a host');
if (process.env.QIANMU_READONLY_CONFIRM !== '1') {
  throw new Error('Set QIANMU_READONLY_CONFIRM=1 to acknowledge the read-only host probe');
}

const parsedTarget = new URL(target);
if (!['http:', 'https:'].includes(parsedTarget.protocol)) throw new Error('QIANMU_ST_URL must use http or https');

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const connectUrl = String(process.env.QIANMU_ST_CDP_URL || '').trim();
const browserChannel = String(process.env.QIANMU_BROWSER_CHANNEL || '').trim();
const browserExecutable = String(process.env.QIANMU_BROWSER_EXECUTABLE || '').trim();
if (browserChannel && browserExecutable) {
  throw new Error('Use only one of QIANMU_BROWSER_CHANNEL or QIANMU_BROWSER_EXECUTABLE');
}
const attached = Boolean(connectUrl);
const browser = attached
  ? await chromium.connectOverCDP(connectUrl)
  : await chromium.launch({
    channel: browserChannel || undefined,
    executablePath: browserExecutable || undefined,
    headless: true,
  });

let context;
let page;
const blockedMethods = [];
const externalRequests = [];
const failedRequests = [];
const pageErrors = [];
try {
  if (attached) {
    context = browser.contexts()[0];
    if (!context) throw new Error('The connected browser has no usable context');
  } else {
    context = await browser.newContext();
  }
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  await context.route('**/*', async route => {
    const request = route.request();
    const method = request.method().toUpperCase();
    const url = new URL(request.url());
    if (url.origin !== parsedTarget.origin) externalRequests.push({ method, origin: url.origin });
    if (!['GET', 'HEAD'].includes(method)) {
      blockedMethods.push({ method, url: request.url() });
      await route.abort();
      return;
    }
    await route.continue();
  });
  page.on('requestfailed', request => failedRequests.push({ method: request.method(), url: request.url() }));
  page.on('pageerror', error => pageErrors.push(String(error?.message || error)));
  await page.goto(target, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof globalThis.SillyTavern?.getContext === 'function');
  const capability = await page.evaluate(() => {
    let context;
    try { context = globalThis.SillyTavern.getContext(); } catch (_) { context = null; }
    const metadata = context?.chatMetadata;
    return {
      contextAvailable: Boolean(context && typeof context === 'object'),
      saveMetadataAvailable: typeof context?.saveMetadata === 'function',
      saveSettingsAvailable: typeof context?.saveSettingsDebounced === 'function' || typeof context?.saveSettings === 'function',
      currentChatAvailable: Array.isArray(context?.chat),
      qianmuMetadataPresent: Boolean(metadata && typeof metadata === 'object' && metadata.story_director_liminale),
    };
  });
  console.log(JSON.stringify({
    targetOrigin: parsedTarget.origin,
    capability,
    blockedMethods,
    externalRequests: [...new Set(externalRequests.map(row => row.origin))],
    failedRequests: failedRequests.length,
    pageErrors,
    productionWrites: false,
    saveMetadataInvoked: false,
    attachedBrowser: attached,
  }));
} finally {
  await page?.close().catch(() => {});
  if (!attached) await browser.close().catch(() => {});
}
