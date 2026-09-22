// Shared measurement logic for perf-audit and perf-check. Generic: no
// knowledge of any specific project, fixture, route, or grader budget.
'use strict';

const { Client } = require('pg');
const puppeteer = require('puppeteer-core');

const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/chromium';
const DB_URL = process.env.DATABASE_URL || 'postgres://app:app@localhost:5432/app';

async function timeRequests(url, samples = 5) {
    const times = [];
    let lastStatus = null;
    for (let i = 0; i < samples; i++) {
        const started = Date.now();
        try {
            const res = await fetch(url, { redirect: 'follow' });
            lastStatus = res.status;
            await res.arrayBuffer();
        } catch (err) {
            return { error: String(err && err.message ? err.message : err) };
        }
        times.push(Date.now() - started);
    }
    times.sort((a, b) => a - b);
    const mid = Math.floor(times.length / 2);
    return {
        status: lastStatus,
        samples: times,
        medianMs: times[mid],
        minMs: times[0],
        maxMs: times[times.length - 1],
    };
}

async function sqlDuringRequest(url) {
    let client;
    try {
        client = new Client({ connectionString: DB_URL, connectionTimeoutMillis: 1500 });
        await client.connect();
    } catch (err) {
        return { available: false, reason: `cannot reach database (${DB_URL}): ${err.message}` };
    }
    try {
        await client.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
    } catch (err) {
        await client.end();
        return {
            available: false,
            reason: 'pg_stat_statements not available (needs shared_preload_libraries=pg_stat_statements and a restart of the server, which this tool cannot do). Skip the SQL section; do not try to repair it.',
        };
    }
    try {
        await client.query('SELECT pg_stat_statements_reset()');
    } catch (err) {
        // reset can fail under restricted privileges; continue anyway, counts
        // will include prior traffic too, still directionally useful.
    }
    await fetch(url).then((r) => r.arrayBuffer()).catch(() => {});
    const { rows } = await client.query(
        `SELECT query, calls, total_exec_time
         FROM pg_stat_statements
         WHERE query NOT ILIKE '%pg_stat_statements%'
         ORDER BY total_exec_time DESC
         LIMIT 8`
    );
    await client.end();
    const totalCalls = rows.reduce((sum, r) => sum + Number(r.calls), 0);
    return {
        available: true,
        totalStatements: totalCalls,
        byQuery: rows.map((r) => ({
            query: r.query.replace(/\s+/g, ' ').trim().slice(0, 90),
            calls: Number(r.calls),
            totalMs: Math.round(Number(r.total_exec_time)),
        })),
    };
}

const NAV_TIMEOUT_MS = 90000;

function fmtMB(bytes) {
    const mb = bytes / 1024 / 1024;
    return mb < 1 ? mb.toFixed(2) : mb.toFixed(1);
}

function basename(u) {
    try {
        const parts = new URL(u).pathname.split('/');
        return parts[parts.length - 1] || u;
    } catch (e) {
        return u;
    }
}

async function pageAudit(url) {
    let browser;
    try {
        browser = await puppeteer.launch({
            executablePath: CHROME_PATH,
            headless: true,
            args: ['--no-sandbox', '--disable-dev-shm-usage'],
        });
    } catch (err) {
        return {
            available: false,
            reason: `could not launch chromium (${err.message}). This environment cannot run the page-load section. Skip it; do not try to repair it.`,
        };
    }
    try {
        const page = await browser.newPage();
        await page.emulate({
            viewport: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
            userAgent:
                'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        });
        const client = await page.createCDPSession();
        await client.send('Network.enable');
        await client.send('Emulation.setCPUThrottlingRate', { rate: 4 });
        await client.send('Network.emulateNetworkConditions', {
            offline: false,
            latency: 400,
            downloadThroughput: (400 * 1024) / 8,
            uploadThroughput: (400 * 1024) / 8,
        });

        // Track every request's lifecycle (not just finished ones) so an
        // unfinished load can be reported as unfinished instead of being
        // silently summarized as if it were complete.
        const requests = new Map();
        client.on('Network.requestWillBeSent', (e) => {
            requests.set(e.requestId, {
                url: e.request.url,
                resourceType: e.type || null,
                startedAt: Date.now(),
                mimeType: null,
                encodedBytes: 0,
                receivedBytes: 0,
                contentLength: null,
                finished: false,
                failed: false,
            });
        });
        client.on('Network.responseReceived', (e) => {
            const r = requests.get(e.requestId);
            if (!r) return;
            r.mimeType = e.response.mimeType;
            const headers = e.response.headers || {};
            const cl = headers['Content-Length'] || headers['content-length'];
            if (cl) r.contentLength = Number(cl);
        });
        client.on('Network.dataReceived', (e) => {
            const r = requests.get(e.requestId);
            if (r) r.receivedBytes += e.dataLength || 0;
        });
        client.on('Network.loadingFinished', (e) => {
            const r = requests.get(e.requestId);
            if (r) {
                r.finished = true;
                r.encodedBytes = e.encodedDataLength || 0;
            }
        });
        client.on('Network.loadingFailed', (e) => {
            const r = requests.get(e.requestId);
            if (r) r.failed = true;
        });

        let loadFired = false;
        let loadFiredAt = null;
        page.once('load', () => {
            loadFired = true;
            loadFiredAt = Date.now();
        });

        await page.evaluateOnNewDocument(() => {
            window.__perf = { lcp: 0, lcpElement: '', cls: 0 };
            try {
                new PerformanceObserver((list) => {
                    const entries = list.getEntries();
                    const last = entries[entries.length - 1];
                    if (last) {
                        window.__perf.lcp = last.startTime;
                        window.__perf.lcpElement =
                            (last.element && (last.element.tagName + (last.element.id ? '#' + last.element.id : ''))) || last.url || '';
                    }
                }).observe({ type: 'largest-contentful-paint', buffered: true });
                new PerformanceObserver((list) => {
                    for (const entry of list.getEntries()) {
                        if (!entry.hadRecentInput) window.__perf.cls += entry.value;
                    }
                }).observe({ type: 'layout-shift', buffered: true });
            } catch (e) {}
        });

        const navStart = Date.now();
        let navResponse = null;
        let navError = null;
        try {
            navResponse = await page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
        } catch (err) {
            navError = err;
        }
        const isTimeout = !!navError && /timeout/i.test(navError.message || '');
        if (navError && !isTimeout) {
            await browser.close();
            return { available: false, reason: `page did not load: ${navError.message}` };
        }
        if (!navError && !navResponse) {
            await browser.close();
            return { available: false, reason: 'page did not load: no response' };
        }
        // Give in-flight byte counters a brief moment to settle before we
        // snapshot them.
        await new Promise((r) => setTimeout(r, 500));
        const wallMs = Date.now() - navStart;

        const perf = await page.evaluate(() => window.__perf).catch(() => ({ lcp: 0, lcpElement: '', cls: 0 }));

        const renderBlocking = await page
            .evaluate(() => {
                const out = [];
                document.querySelectorAll('head script[src]').forEach((s) => {
                    if (!s.async && !s.defer) out.push(s.src);
                });
                document.querySelectorAll('head link[rel=stylesheet]').forEach((l) => out.push(l.href));
                return out;
            })
            .catch(() => []);

        const all = Array.from(requests.values());
        const inFlight = all.filter((r) => !r.finished && !r.failed);
        const finished = all.filter((r) => r.finished);
        const finishedBytes = finished.reduce((sum, r) => sum + r.encodedBytes, 0);
        const inFlightBytes = inFlight.reduce((sum, r) => sum + r.receivedBytes, 0);
        // Total is always finished + in-flight bytes so it never omits an
        // unfinished download, whether or not the load is complete.
        const totalBytes = finishedBytes + inFlightBytes;

        // Not every unfinished request means the load is meaningfully
        // incomplete: the browser's own trailing favicon fetch, or anything
        // that only started after `load` fired, or a tiny straggler that
        // will never matter, shouldn't produce a false "didn't finish"
        // headline. Those are still shown in largestResources as
        // [INCOMPLETE], just not promoted to the headline/cost #1.
        const BLOCKING_TYPES = new Set(['Document', 'Stylesheet', 'Script', 'Font', 'Image', 'Media']);
        const BLOCKING_BYTES = 50 * 1024;
        function isFavicon(u) {
            return basename(u).toLowerCase() === 'favicon.ico';
        }
        function isBlocking(r) {
            if (isFavicon(r.url)) return false;
            if (loadFiredAt !== null && r.startedAt > loadFiredAt) return false;
            if (!BLOCKING_TYPES.has(r.resourceType)) return false;
            const sizeKnown = r.receivedBytes > BLOCKING_BYTES || (r.contentLength && r.contentLength > BLOCKING_BYTES);
            return sizeKnown;
        }
        const blockingInFlight = inFlight.filter(isBlocking);

        const incomplete = isTimeout || !loadFired || blockingInFlight.length > 0;

        const pendingResources = inFlight
            .map((r) => ({ url: r.url, mimeType: r.mimeType, bytes: r.receivedBytes, contentLength: r.contentLength, pending: true }))
            .sort((a, b) => b.bytes - a.bytes);
        const finishedResources = finished
            .map((r) => ({ url: r.url, mimeType: r.mimeType, bytes: r.encodedBytes, contentLength: null, pending: false }))
            .sort((a, b) => b.bytes - a.bytes);

        let incompleteSummary = null;
        if (incomplete) {
            let cause;
            if (isTimeout) cause = `did not finish loading within ${Math.round(NAV_TIMEOUT_MS / 1000)}s`;
            else if (!loadFired) cause = 'did not finish loading (load event never fired)';
            else cause = 'did not finish loading (requests still in flight when measurement ended)';

            // Prefer naming a blocking straggler; fall back to any pending
            // resource only when the load itself never finished (timeout or
            // no load event) and nothing blocking was found.
            const detailList = blockingInFlight.length
                ? [...blockingInFlight].sort((a, b) => b.receivedBytes - a.receivedBytes)
                : pendingResources.length
                  ? inFlight.slice().sort((a, b) => b.receivedBytes - a.receivedBytes)
                  : [];

            let detail = '';
            if (detailList.length) {
                const top = detailList[0];
                const name = basename(top.url);
                const bytes = top.receivedBytes !== undefined ? top.receivedBytes : top.bytes;
                const contentLength = top.contentLength;
                const sizeDesc = contentLength
                    ? `${fmtMB(bytes)} of ${fmtMB(contentLength)} MB received so far`
                    : `${fmtMB(bytes)} MB of unknown total received so far`;
                const countDesc =
                    detailList.length === 1 ? '1 request still downloading' : `${detailList.length} requests still downloading`;
                const more = detailList.length > 1 ? `, and ${detailList.length - 1} more` : '';
                detail = `: ${countDesc} (${name}, ${sizeDesc}${more})`;
            }
            incompleteSummary = `page ${cause}${detail}. LCP below is NOT final.`;
        }

        await browser.close();
        return {
            available: true,
            incomplete,
            incompleteSummary,
            wallMs,
            lcpMs: Math.round(perf.lcp),
            lcpElement: perf.lcpElement,
            cls: Number(perf.cls.toFixed(4)),
            totalBytes,
            largestResources: [...pendingResources, ...finishedResources].slice(0, 5),
            renderBlocking,
        };
    } catch (err) {
        await browser.close().catch(() => {});
        return { available: false, reason: err.message };
    }
}

function looksLikeHtml(url) {
    return !/\.(png|jpe?g|gif|webp|svg|css|js|json|ico|woff2?)$/i.test(new URL(url).pathname);
}

async function measure(url) {
    const timing = await timeRequests(url, 5);
    const sql = await sqlDuringRequest(url);
    const page = looksLikeHtml(url) ? await pageAudit(url) : { available: false, reason: 'not an HTML page' };
    return { url, timing, sql, page };
}

module.exports = { measure };
