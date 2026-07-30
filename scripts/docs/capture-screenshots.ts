/**
 * Recaptures the dashboard screenshots committed under `docs/assets/`.
 *
 *   make up && npm run docs:screenshots
 *
 * Screenshots in a README go stale silently: nothing fails when the UI moves on
 * and the image does not. Scripting the capture means a maintainer can refresh
 * both images in one command against a real, seeded instance.
 *
 * The browser is driven over the Chrome DevTools Protocol using Node's built-in
 * WebSocket, so this adds no dependency to package.json and pulls no headless
 * browser into the repository or the container image. Chrome is expected to be
 * installed on the host already; `test/container-hardening.spec.ts` keeps it
 * that way.
 *
 * Prerequisites: a FeedPulse API reachable at DOCS_SCREENSHOT_BASE_URL, and a
 * Chrome or Chromium binary on PATH (or CHROME_PATH). This script starts
 * neither — use `make up` (full Docker stack) or `make dev` for the API.
 *
 * Configuration (all optional):
 *   DOCS_SCREENSHOT_BASE_URL   API origin. Default http://127.0.0.1:$PORT, or
 *                              port 3000.
 *   DOCS_SCREENSHOT_API_KEY    Key the dashboard session uses. Defaults to
 *                              DEMO_API_KEY, then BOOTSTRAP_API_KEY.
 *   DOCS_SCREENSHOT_WIDTH      Viewport width in CSS pixels. Default 1400.
 *   DOCS_SCREENSHOTS_SKIP_SEED Set to `true` to capture the instance as-is
 *                              instead of running `npm run demo:seed` first.
 *   CHROME_PATH                Explicit Chrome/Chromium binary to drive.
 */
import 'dotenv/config';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** Where the committed images live, relative to the repository root. */
const OUTPUT_DIR = resolve(__dirname, '..', '..', 'docs', 'assets');

/** The demo seeder, run before capturing. Same script `npm run demo:seed` executes. */
const SEED_SCRIPT = resolve(__dirname, '..', 'demo', 'seed-demo.ts');

/** Viewport height in CSS pixels. Full-page capture extends past it as needed. */
const VIEWPORT_HEIGHT = 900;

/** 2x so the images stay readable when a README scales them down. */
const DEVICE_SCALE_FACTOR = 2;

/** sessionStorage key the dashboard reads its API key from (public/dashboard/app.js). */
const DASHBOARD_KEY_STORAGE = 'rss-dashboard-api-key';

/** Replaces any credential the dashboard echoes back into an input before capture. */
const MASKED_KEY_PLACEHOLDER = 'fp_xxxxxxxx_••••••••••••••••';

/** Milliseconds to let rendering settle after the last API call resolves. */
const RENDER_SETTLE_MS = 900;

const CHROME_CANDIDATES = ['google-chrome-stable', 'google-chrome', 'chromium-browser', 'chromium', 'chrome'] as const;

interface Shot {
  /** Element id of the tab button to activate (public/dashboard/index.html). */
  readonly tabButtonId: string;
  /** Case-insensitive label match, used as a fallback when the id has been renamed. */
  readonly tabLabelPattern: string;
  readonly fileName: string;
}

const SHOTS: readonly Shot[] = [
  { tabButtonId: 'tab-btn-overview', tabLabelPattern: 'overview', fileName: 'dashboard-overview.png' },
  { tabButtonId: 'tab-btn-rules-alerts', tabLabelPattern: 'rules', fileName: 'dashboard-alerts.png' },
];

function isTruthyFlag(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());
}

function resolveBaseUrl(): string {
  const configured = process.env.DOCS_SCREENSHOT_BASE_URL?.trim();
  if (configured) {
    return configured.replace(/\/+$/, '');
  }

  return `http://127.0.0.1:${process.env.PORT?.trim() || '3000'}`;
}

function resolveViewportWidth(): number {
  const raw = Number(process.env.DOCS_SCREENSHOT_WIDTH ?? '');
  return Number.isInteger(raw) && raw >= 640 ? raw : 1400;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

// --- Chrome discovery -------------------------------------------------------

/**
 * `command -v` rather than `which`, which is not installed in every minimal
 * image. The command is built as one string on purpose: passing an argument
 * array alongside `shell: true` raises Node's DEP0190 warning on every run, and
 * the only values interpolated here come from the hard-coded list below.
 */
function lookUpOnPath(binary: string): string | null {
  const result = spawnSync(`command -v ${binary}`, { shell: true, encoding: 'utf8' });
  const found = result.stdout.trim().split('\n')[0]?.trim();
  return found ? found : null;
}

/**
 * Deliberately no auto-download step. Silently fetching a ~150 MB browser from a
 * documentation script is a surprising amount of network for `npm run
 * docs:screenshots`, and a repository-wide guard
 * (`test/container-hardening.spec.ts`) keeps headless-browser tooling out of the
 * tree so it can never reach the container image.
 */
function resolveChromeExecutable(): string {
  const configured = (process.env.CHROME_PATH ?? '').trim();
  if (configured) {
    if (!existsSync(configured)) {
      throw new Error(`CHROME_PATH points at a missing file: ${configured}`);
    }
    return configured;
  }

  for (const candidate of CHROME_CANDIDATES) {
    const found = lookUpOnPath(candidate);
    if (found) {
      return found;
    }
  }

  throw new Error(
    `No Chrome or Chromium binary found on PATH (looked for: ${CHROME_CANDIDATES.join(', ')}). ` +
      'Install one, or point CHROME_PATH at an existing binary.',
  );
}

// --- Minimal DevTools Protocol client --------------------------------------

interface CdpFrame {
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: { readonly message?: string };
}

function readProperty(source: unknown, key: string): unknown {
  if (typeof source !== 'object' || source === null) {
    return undefined;
  }

  return (source as Record<string, unknown>)[key];
}

class CdpClient {
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>();

  private nextId = 1;

  private constructor(private readonly socket: WebSocket) {
    this.socket.addEventListener('message', (event: MessageEvent) => {
      if (typeof event.data !== 'string') {
        return;
      }

      let frame: CdpFrame;
      try {
        frame = JSON.parse(event.data) as CdpFrame;
      } catch {
        return;
      }

      if (typeof frame.id !== 'number') {
        return;
      }

      const waiter = this.pending.get(frame.id);
      if (!waiter) {
        return;
      }

      this.pending.delete(frame.id);
      if (frame.error) {
        waiter.reject(new Error(frame.error.message ?? 'DevTools protocol error'));
      } else {
        waiter.resolve(frame.result);
      }
    });

    this.socket.addEventListener('close', () => {
      for (const waiter of this.pending.values()) {
        waiter.reject(new Error('DevTools connection closed'));
      }
      this.pending.clear();
    });
  }

  static connect(url: string): Promise<CdpClient> {
    return new Promise((resolveConnection, rejectConnection) => {
      const socket = new WebSocket(url);
      const client = new CdpClient(socket);

      socket.addEventListener('open', () => resolveConnection(client), { once: true });
      socket.addEventListener('error', () => rejectConnection(new Error(`Cannot connect to DevTools at ${url}`)), {
        once: true,
      });
    });
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    const id = this.nextId++;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) {
      payload.sessionId = sessionId;
    }

    return new Promise((resolveCall, rejectCall) => {
      this.pending.set(id, { resolve: resolveCall, reject: rejectCall });
      this.socket.send(JSON.stringify(payload));
    });
  }

  close(): void {
    this.socket.close();
  }
}

/** One attached page, with the handful of protocol calls this script needs. */
class Page {
  constructor(
    private readonly client: CdpClient,
    private readonly sessionId: string,
  ) {}

  static async open(client: CdpClient): Promise<Page> {
    const target = await client.send('Target.createTarget', { url: 'about:blank' });
    const targetId = readProperty(target, 'targetId');
    if (typeof targetId !== 'string') {
      throw new Error('Chrome did not return a target id');
    }

    const attached = await client.send('Target.attachToTarget', { targetId, flatten: true });
    const sessionId = readProperty(attached, 'sessionId');
    if (typeof sessionId !== 'string') {
      throw new Error('Chrome did not return a DevTools session id');
    }

    const page = new Page(client, sessionId);
    await client.send('Page.enable', {}, sessionId);
    await client.send('Runtime.enable', {}, sessionId);
    return page;
  }

  setViewport(width: number, height: number): Promise<unknown> {
    return this.client.send(
      'Emulation.setDeviceMetricsOverride',
      { width, height, deviceScaleFactor: DEVICE_SCALE_FACTOR, mobile: false },
      this.sessionId,
    );
  }

  addInitScript(source: string): Promise<unknown> {
    return this.client.send('Page.addScriptToEvaluateOnNewDocument', { source }, this.sessionId);
  }

  async navigate(url: string): Promise<void> {
    await this.client.send('Page.navigate', { url }, this.sessionId);
    await this.waitFor('document.readyState === "complete"', `page load of ${url}`);
  }

  async reload(): Promise<void> {
    await this.client.send('Page.reload', {}, this.sessionId);
    await this.waitFor('document.readyState === "complete"', 'page reload');
  }

  async evaluate<T>(expression: string): Promise<T> {
    const response = await this.client.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      this.sessionId,
    );

    const exception = readProperty(response, 'exceptionDetails');
    if (exception) {
      const text = readProperty(exception, 'text');
      throw new Error(`Page evaluation failed: ${typeof text === 'string' ? text : JSON.stringify(exception)}`);
    }

    return readProperty(readProperty(response, 'result'), 'value') as T;
  }

  async waitFor(expression: string, label: string, timeoutMs = 30000): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (await this.evaluate<boolean>(`Boolean(${expression})`)) {
        return;
      }
      await delay(150);
    }

    throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
  }

  async screenshot(): Promise<Buffer> {
    const response = await this.client.send(
      'Page.captureScreenshot',
      { format: 'png', captureBeyondViewport: true },
      this.sessionId,
    );

    const data = readProperty(response, 'data');
    if (typeof data !== 'string') {
      throw new Error('Chrome returned no screenshot data');
    }

    return Buffer.from(data, 'base64');
  }
}

// --- Browser lifecycle ------------------------------------------------------

interface Browser {
  readonly client: CdpClient;
  readonly stop: () => void;
}

function readDevToolsEndpoint(userDataDir: string, timeoutMs: number): Promise<string> {
  const portFile = join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;

  return (async () => {
    while (Date.now() < deadline) {
      if (existsSync(portFile)) {
        const [port, path] = readFileSync(portFile, 'utf8').split('\n');
        if (port && path) {
          return `ws://127.0.0.1:${port.trim()}${path.trim()}`;
        }
      }
      await delay(100);
    }

    throw new Error('Chrome did not report a DevTools port; it may have failed to start.');
  })();
}

async function launchBrowser(width: number): Promise<Browser> {
  const executable = resolveChromeExecutable();
  const userDataDir = mkdtempSync(join(tmpdir(), 'feedpulse-chrome-'));

  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    `--window-size=${width},${VIEWPORT_HEIGHT}`,
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-port=0',
  ];

  // Chrome's sandbox cannot initialise as uid 0, which is the normal case inside
  // a CI container image.
  if (process.getuid?.() === 0) {
    args.push('--no-sandbox');
  }

  const child: ChildProcess = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stopped = false;

  const stop = (): void => {
    if (stopped) {
      return;
    }
    stopped = true;
    child.kill('SIGTERM');
    rmSync(userDataDir, { recursive: true, force: true });
  };

  try {
    const endpoint = await readDevToolsEndpoint(userDataDir, 30000);
    const client = await CdpClient.connect(endpoint);
    return { client, stop };
  } catch (error: unknown) {
    stop();
    throw error;
  }
}

// --- Page instrumentation ---------------------------------------------------

/**
 * Counts in-flight `fetch` calls so the script can wait for the dashboard's data
 * to arrive without coupling to any particular element in the markup. Installed
 * before the document runs, so it also covers the calls made on first paint.
 */
const FETCH_TRACKER_SOURCE = `
  (() => {
    const original = window.fetch;
    window.__fpPending = 0;
    window.__fpTotal = 0;
    window.fetch = function (...args) {
      window.__fpPending += 1;
      window.__fpTotal += 1;
      return original.apply(this, args).finally(() => {
        window.__fpPending -= 1;
      });
    };
  })();
`;

/** Blanks anything on screen that looks like a credential before the shutter fires. */
const MASK_CREDENTIALS_SOURCE = `
  (() => {
    const placeholder = ${JSON.stringify(MASKED_KEY_PLACEHOLDER)};
    let masked = 0;
    for (const input of document.querySelectorAll('input, textarea')) {
      const identity = ((input.id || '') + ' ' + (input.name || '')).toLowerCase();
      const looksLikeKey = /key|token|secret/.test(identity) || /^fp_/.test(input.value || '');
      if (looksLikeKey && input.value) {
        input.value = placeholder;
        masked += 1;
      }
      if (input.type === 'password') {
        input.value = placeholder;
      }
    }
    return masked;
  })();
`;

function buildActivateTabSource(shot: Shot): string {
  return `
    (() => {
      const byId = ${JSON.stringify(shot.tabButtonId)}
        ? document.getElementById(${JSON.stringify(shot.tabButtonId)})
        : null;
      const pattern = new RegExp(${JSON.stringify(shot.tabLabelPattern)}, 'i');
      const byLabel = Array.from(document.querySelectorAll('button, a, [role="tab"]')).find((node) =>
        pattern.test((node.textContent || '').trim()),
      );
      const target = byId || byLabel;
      if (!target) {
        return false;
      }
      target.click();
      return true;
    })();
  `;
}

// --- Orchestration ----------------------------------------------------------

async function assertApiReachable(baseUrl: string): Promise<void> {
  let status: number;

  try {
    status = (await fetch(`${baseUrl}/health`)).status;
  } catch (error: unknown) {
    throw new Error(
      `Cannot reach the FeedPulse API at ${baseUrl} (${error instanceof Error ? error.message : 'unknown error'}).\n` +
        'Start it with `make up` or `make dev`, then re-run this script.',
    );
  }

  if (status !== 200) {
    throw new Error(`GET ${baseUrl}/health returned HTTP ${status}; the API is not ready.`);
  }
}

/**
 * Runs the seeder directly rather than through `npm run demo:seed`, so the two
 * scripts stay coupled by file path instead of by an npm script name that can be
 * renamed out from under this one.
 */
function runDemoSeed(baseUrl: string, apiKey: string): void {
  console.log('Seeding demo data...');
  const seedEnv: NodeJS.ProcessEnv = { ...process.env, DEMO_API_BASE_URL: baseUrl };

  // The seeder resolves its own credential from DEMO_API_KEY/BOOTSTRAP_API_KEY.
  // Forward the one this script resolved so a DOCS_SCREENSHOT_API_KEY-only setup
  // does not seed as an anonymous caller and get 401.
  if (apiKey) {
    seedEnv.DEMO_API_KEY = apiKey;
  }

  const result = spawnSync('npx', ['tsx', SEED_SCRIPT], { stdio: 'inherit', env: seedEnv });

  if (result.status !== 0) {
    throw new Error('The demo seed failed; fix `npm run demo:seed` before recapturing screenshots.');
  }
}

async function captureShots(page: Page, baseUrl: string, apiKey: string): Promise<string[]> {
  await page.addInitScript(FETCH_TRACKER_SOURCE);
  await page.navigate(`${baseUrl}/dashboard/`);

  // sessionStorage is origin-scoped, so the key can only be written once the
  // dashboard origin is loaded. Reload to let the app boot with it.
  if (apiKey) {
    await page.evaluate<null>(
      `window.sessionStorage.setItem(${JSON.stringify(DASHBOARD_KEY_STORAGE)}, ${JSON.stringify(apiKey)}), null`,
    );
    await page.reload();
  }

  await mkdir(OUTPUT_DIR, { recursive: true });
  const written: string[] = [];

  for (const shot of SHOTS) {
    // Fails loudly rather than silently capturing whichever tab happened to be
    // open: a screenshot of the wrong panel is worse than no screenshot.
    if (!(await page.evaluate<boolean>(buildActivateTabSource(shot)))) {
      throw new Error(`Could not find the "${shot.tabButtonId}" tab in the dashboard; update SHOTS in this script.`);
    }

    await page.waitFor('window.__fpTotal > 0 && window.__fpPending === 0', 'dashboard API calls to settle');
    await delay(RENDER_SETTLE_MS);
    await page.evaluate<number>(MASK_CREDENTIALS_SOURCE);

    const image = await page.screenshot();
    const target = join(OUTPUT_DIR, shot.fileName);
    await writeFile(target, image);
    written.push(target);
    console.log(`  wrote ${target} (${Math.round(image.byteLength / 1024)} KiB)`);
  }

  return written;
}

async function run(): Promise<void> {
  const baseUrl = resolveBaseUrl();
  const width = resolveViewportWidth();
  const apiKey = (
    process.env.DOCS_SCREENSHOT_API_KEY ??
    process.env.DEMO_API_KEY ??
    process.env.BOOTSTRAP_API_KEY ??
    ''
  ).trim();

  console.log(`Capturing dashboard screenshots from ${baseUrl} at ${width}px`);
  await assertApiReachable(baseUrl);

  if (!isTruthyFlag(process.env.DOCS_SCREENSHOTS_SKIP_SEED)) {
    runDemoSeed(baseUrl, apiKey);
  }

  const browser = await launchBrowser(width);

  try {
    const page = await Page.open(browser.client);
    await page.setViewport(width, VIEWPORT_HEIGHT);
    const written = await captureShots(page, baseUrl, apiKey);
    console.log(`\nDone. ${written.length} screenshot(s) updated.`);
  } finally {
    browser.client.close();
    browser.stop();
  }
}

void run().catch((error: unknown) => {
  console.error(`\nScreenshot capture failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
