// Loads a URL in headless Chromium under mobile emulation, a slow-4G-like
// network throttle, and 4x CPU throttle, and reports LCP, CLS, and total
// transferred bytes for the first load. Optionally saves a screenshot.
//
// Usage: bun run measure.ts <url> <out-json> [screenshot-path] [--no-throttle]
// A navigation timeout is reported as a capped measurement ({timedOut: true},
// lcp = the timeout in ms) rather than as an error. NAV_TIMEOUT_MS overrides
// the 180000ms default.
import { chromium, devices } from 'playwright-core';
import { writeFileSync } from 'node:fs';

const url = process.argv[2];
const outJson = process.argv[3];
const screenshotPath = process.argv[4] && process.argv[4] !== '' ? process.argv[4] : undefined;
const noThrottle = process.argv.includes('--no-throttle');

if (!url || !outJson) {
    console.error('usage: measure.ts <url> <out-json> [screenshot-path] [--no-throttle]');
    process.exit(2);
}

// Contract: iPhone 12/13 viewport, mobile emulation, ~slow-4G network
// (400kbps down/up, 400ms RTT), 4x CPU throttle.
const VIEWPORT = { width: 390, height: 844 };
const NETWORK = {
    offline: false,
    latency: 400,
    downloadThroughput: (400 * 1024) / 8,
    uploadThroughput: (400 * 1024) / 8,
};
const CPU_RATE = 4;

// Navigation timeout. A capped baseline (see below) understates the
// baseline's real LCP, which only makes the speed gate stricter, so the
// default stays at 180s. Overridable for remote runs and calibration.
const NAV_TIMEOUT_MS = process.env.NAV_TIMEOUT_MS ? Number(process.env.NAV_TIMEOUT_MS) : 180000;

// Tries, in order: $CHROMIUM_PATH, the Linux apt binary the gate's own
// container image installs (see .workbenches/web-performance/Dockerfile),
// then the macOS Playwright cache (for local calibration). Throws with a
// list of everything tried if none of them exist.
function findChromium(): string {
    const { existsSync, readdirSync } = require('node:fs') as typeof import('node:fs');
    const tried: string[] = [];

    if (process.env.CHROMIUM_PATH) {
        tried.push(`$CHROMIUM_PATH (${process.env.CHROMIUM_PATH})`);
        if (existsSync(process.env.CHROMIUM_PATH)) return process.env.CHROMIUM_PATH;
    } else {
        tried.push('$CHROMIUM_PATH (not set)');
    }

    for (const p of ['/usr/bin/chromium', '/usr/bin/chromium-browser']) {
        tried.push(p);
        if (existsSync(p)) return p;
    }

    const base = `${process.env.HOME}/Library/Caches/ms-playwright`;
    if (existsSync(base)) {
        for (const dir of readdirSync(base)) {
            if (!dir.startsWith('chromium-')) continue;
            for (const arch of ['chrome-mac-arm64', 'chrome-mac', 'chrome-linux']) {
                const candidates = [
                    `${base}/${dir}/${arch}/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
                    `${base}/${dir}/${arch}/chrome`,
                ];
                for (const c of candidates) {
                    tried.push(c);
                    if (existsSync(c)) return c;
                }
            }
        }
    } else {
        tried.push(`${base} (not present)`);
    }

    throw new Error(`could not find a Chromium binary. Tried:\n  ${tried.join('\n  ')}`);
}

async function main() {
    const executablePath = findChromium();
    const browser = await chromium.launch({ executablePath, headless: true });
    const device = devices['iPhone 13'];
    const context = await browser.newContext({
        ...device,
        viewport: VIEWPORT,
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    if (!noThrottle) {
        await cdp.send('Network.emulateNetworkConditions', NETWORK);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_RATE });
    }

    let totalBytes = 0;
    const debug = !!process.env.MEASURE_DEBUG;
    const urlsByRequestId = new Map<string, string>();
    cdp.on('Network.requestWillBeSent', (e: any) => {
        urlsByRequestId.set(e.requestId, e.request?.url);
    });
    cdp.on('Network.loadingFailed', (e: any) => {
        if (debug) console.error('FAILED', urlsByRequestId.get(e.requestId), e.errorText, e.canceled);
    });
    cdp.on('Network.loadingFinished', (e: any) => {
        if (debug) console.error('FINISHED', urlsByRequestId.get(e.requestId), e.encodedDataLength);
    });
    // Counted from dataReceived (fires incrementally as bytes arrive) rather
    // than loadingFinished's cumulative total, so a request still in flight
    // when the navigation times out still contributes the bytes it has
    // received so far instead of contributing nothing.
    cdp.on('Network.dataReceived', (e: any) => {
        totalBytes += e.encodedDataLength || 0;
    });

    await page.addInitScript(() => {
        (window as any).__lcp = 0;
        (window as any).__cls = 0;
        try {
            new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) {
                    (window as any).__lcp = entry.startTime;
                }
            }).observe({ type: 'largest-contentful-paint', buffered: true });
            new PerformanceObserver((list) => {
                for (const entry of list.getEntries() as any[]) {
                    if (!entry.hadRecentInput) (window as any).__cls += entry.value;
                }
            }).observe({ type: 'layout-shift', buffered: true });
        } catch {
            // observers unsupported; leave metrics at 0
        }
        // Headless Chromium only produces frames on demand, and layout-shift
        // entries are only recorded between produced frames. A continuous
        // rAF loop keeps frames flowing for the whole load, so a shift is
        // recorded whenever it happens. Verified: without this loop an
        // obvious synthetic shift reports CLS 0, with it 0.68 every time.
        const tick = () => requestAnimationFrame(tick);
        tick();
    });

    // A goto timeout is not a failure of the measurement: an untouched
    // baseline page can genuinely take longer than the budget to finish
    // loading under throttling. Treat it as a capped measurement instead
    // of an error, so a slow baseline never blows up the gate run; the
    // capped LCP only understates the baseline, which makes the ratio
    // stricter, not looser.
    let timedOut = false;
    try {
        await page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
        // Let network settle (throttled loads finish, LCP/CLS entries land).
        await page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT_MS }).catch(() => {});
        await page.waitForTimeout(1000);
    } catch (err: any) {
        if (err?.name === 'TimeoutError') {
            timedOut = true;
        } else {
            throw err;
        }
    }

    let lcp: number;
    let cls: number;
    if (timedOut) {
        lcp = NAV_TIMEOUT_MS;
        cls = await page.evaluate(() => (window as any).__cls).catch(() => 0);
        if (typeof cls !== 'number' || Number.isNaN(cls)) cls = 0;
    } else {
        lcp = await page.evaluate(() => (window as any).__lcp);
        cls = await page.evaluate(() => (window as any).__cls);
    }

    if (screenshotPath) {
        await page.screenshot({ path: screenshotPath }).catch(() => {});
    }

    await browser.close();
    writeFileSync(outJson, JSON.stringify({ lcp, cls, bytes: totalBytes, timedOut }, null, 2));
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
