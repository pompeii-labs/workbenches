#!/usr/bin/env node
// game-playcheck [project-directory] [build-directory]
// Serves the project's own web export on a plain static server, loads it in
// headless Chromium, and reports load errors, whether the canvas renders,
// and whether pressing the project's OWN InputMap-bound keys changes the
// frame. Generic: derives keys from project.godot, knows nothing about any
// specific game. Not the grader: no thresholds here match the benchmark's.
import { createServer } from 'node:http';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { createReadStream } from 'node:fs';
import { createRequire } from 'node:module';

function fail(message) {
    console.error('game-playcheck: cannot run here (' + message + '). Skip this tool; do not try to repair it.');
    process.exit(1);
}

const require = createRequire(import.meta.url);
const pwDir = process.env.PLAYWRIGHT_MODULE_DIR || '/opt/browser/node_modules';
let chromium;
try {
    ({ chromium } = require(require.resolve('playwright', { paths: [pwDir] })));
} catch {
    fail('playwright is not installed at ' + pwDir);
}

function findChromium() {
    if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
    for (const p of ['/usr/bin/chromium', '/usr/bin/chromium-browser']) {
        if (existsSync(p)) return p;
    }
    return undefined;
}
if (!findChromium()) fail('no Chromium binary found (checked /usr/bin/chromium, /usr/bin/chromium-browser, $CHROMIUM_PATH)');

const project = process.argv[2] ? resolvePath(process.argv[2]) : process.cwd();
const buildArg = process.argv[3];

function resolvePath(p) {
    return p.startsWith('/') ? p : join(process.cwd(), p);
}

function findBuild(root) {
    const skip = new Set(['.git', '.godot', '.import', 'node_modules']);
    const pcks = [];
    (function walk(dir) {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            if (skip.has(e.name)) continue;
            const p = join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith('.pck')) pcks.push(p);
        }
    })(root);
    let best = null;
    for (const pck of pcks) {
        const dir = dirname(pck);
        const stem = pck.slice(0, -4).split('/').pop();
        const wasm = join(dir, stem + '.wasm');
        const html = readdirSync(dir).find((f) => extname(f) === '.html');
        if (!existsSync(wasm) || !html) continue;
        const mtime = statSync(pck).mtimeMs;
        if (!best || mtime > best.mtime) best = { dir, html, mtime };
    }
    return best;
}

// Godot Key enum -> browser KeyboardEvent key name, common subset only.
const KEY_TABLE = {
    4194319: 'ArrowLeft',
    4194320: 'ArrowUp',
    4194321: 'ArrowRight',
    4194322: 'ArrowDown',
    32: ' ',
    4194309: 'Enter',
    4194313: 'Enter',
    4194305: 'Escape',
    4194306: 'Tab',
    4194325: 'Shift',
    4194326: 'Control',
    4194328: 'Alt',
};
for (let c = 65; c <= 90; c++) KEY_TABLE[c] = String.fromCharCode(c).toLowerCase();
for (let c = 48; c <= 57; c++) KEY_TABLE[c] = String.fromCharCode(c);

// Standard key set pressed regardless of what project.godot declares. Some
// games register actions at runtime (InputMap.action_add_event in
// _ready()), so project.godot's [input] section can be empty even though
// the game fully depends on keyboard input. Testing a fixed set catches
// that case instead of silently skipping input testing.
const STANDARD_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'a', 'd', 'w', 's', ' ', 'Enter'];

function extractInputKeys(projectDir) {
    const godotProject = join(projectDir, 'project.godot');
    if (!existsSync(godotProject)) return { keys: [], unrecognized: [], actionCount: 0, eventCount: 0 };
    const text = readFileSync(godotProject, 'utf8');
    const inputSection = text.match(/\[input\]([\s\S]*?)(\n\[|$)/);
    if (!inputSection) return { keys: [], unrecognized: [], actionCount: 0, eventCount: 0 };
    const body = inputSection[1];
    const actionCount = (body.match(/^\w+=\{/gm) || []).length;
    const keys = new Set();
    const unrecognized = new Set();
    const keyRe = /"(?:keycode|physical_keycode)":\s*(\d+)/g;
    let m;
    let eventCount = 0;
    while ((m = keyRe.exec(body))) {
        const code = Number(m[1]);
        if (code === 0) continue;
        eventCount++;
        if (KEY_TABLE[code]) keys.add(KEY_TABLE[code]);
        else unrecognized.add(code);
    }
    return { keys: [...keys], unrecognized: [...unrecognized], actionCount, eventCount };
}

function serveStatic(dir) {
    return new Promise((resolveServe) => {
        const server = createServer((req, res) => {
            let path = decodeURIComponent(req.url.split('?')[0]);
            if (path === '/') path = '/' + (dirEntry(dir) ?? 'index.html');
            const full = join(dir, path);
            if (!full.startsWith(dir) || !existsSync(full)) {
                res.writeHead(404);
                res.end();
                return;
            }
            createReadStream(full).pipe(res);
        });
        server.listen(0, '127.0.0.1', () => resolveServe(server));
    });
}
function dirEntry(dir) {
    return readdirSync(dir).find((f) => extname(f) === '.html');
}

// Sample the canvas down to a small grid so pixel-level comparisons stay
// cheap. Returns a flat RGBA array plus the grid size used.
const SAMPLE_SIZE = 96;
async function samplePixels(page) {
    return page.evaluate((size) => {
        const c = document.querySelector('canvas');
        const off = document.createElement('canvas');
        off.width = size;
        off.height = size;
        const ctx = off.getContext('2d');
        ctx.drawImage(c, 0, 0, size, size);
        return Array.from(ctx.getImageData(0, 0, size, size).data);
    }, SAMPLE_SIZE);
}

function pixelDiffSum(before, after) {
    let diff = 0;
    for (let i = 0; i < before.length; i++) diff += Math.abs(before[i] - after[i]);
    return diff;
}

// Signed shift along one axis between two samples: centroid of the pixels
// that brightened minus centroid of the pixels that darkened. A moving
// object brightens the pixels it enters and darkens the pixels it leaves,
// so this points in the direction of motion along that axis.
//
// Restricted to the bottom half of the frame: most small arcade games keep
// the player anchored low in frame (ground level, or a bottom lane) while
// obstacles typically
// spawn and travel through the upper frame. Newly spawned/despawned
// obstacles up top contribute bright/dark pixels with no matching
// counterpart (nothing there before an obstacle appears, nothing left
// after it's removed), which otherwise swamps the small player sprite's
// real signal with unrelated noise.
function centroidShift(before, after, size, axis) {
    let brightSum = 0, brightWeight = 0, darkSum = 0, darkWeight = 0;
    const yFrom = Math.floor(size * 0.5);
    for (let y = yFrom; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const idx = (y * size + x) * 4;
            const b0 = (before[idx] + before[idx + 1] + before[idx + 2]) / 3;
            const b1 = (after[idx] + after[idx + 1] + after[idx + 2]) / 3;
            const d = b1 - b0;
            const coord = axis === 'x' ? x : y;
            if (d > 10) {
                brightSum += coord * d;
                brightWeight += d;
            } else if (d < -10) {
                darkSum += coord * -d;
                darkWeight += -d;
            }
        }
    }
    if (!brightWeight || !darkWeight) return 0;
    return brightSum / brightWeight - darkSum / darkWeight;
}

async function press(page, keys, ms) {
    for (const k of keys) await page.keyboard.down(k);
    await page.waitForTimeout(ms);
    for (const k of keys) await page.keyboard.up(k);
}

// Alternate holding the "negative" and "positive" keys of an axis several
// times, measuring the signed pixel-centroid shift during each hold. A
// game that actually responds to that axis should shift one way while the
// negative keys are held and the other way while the positive keys are
// held; a game that ignores the keyboard shows no consistent pattern.
async function testAxis(page, negKeys, posKeys, axis, pairs) {
    let opposite = 0;
    let measured = 0;
    let shiftSum = 0;
    for (let i = 0; i < pairs; i++) {
        let negShift = 0, posShift = 0;
        // Retry once if a pair shows no shift at all: many games freeze on
        // a "game over" screen (hit an obstacle, ran out of lives) that
        // would otherwise be misread as "keys do nothing". Enter/Space are
        // the common restart keys, so nudge with those and try the pair
        // again before giving up on it.
        for (let attempt = 0; attempt < 2; attempt++) {
            const start = await samplePixels(page);
            await press(page, negKeys, 600);
            const mid = await samplePixels(page);
            await page.waitForTimeout(50);
            await press(page, posKeys, 600);
            const end = await samplePixels(page);
            await page.waitForTimeout(50);
            negShift = centroidShift(start, mid, SAMPLE_SIZE, axis);
            posShift = centroidShift(mid, end, SAMPLE_SIZE, axis);
            if (negShift !== 0 || posShift !== 0) break;
            if (attempt === 0) {
                await press(page, ['Enter'], 150);
                await press(page, [' '], 150);
                await page.waitForTimeout(300);
            }
        }
        // A pair with no detectable shift in either direction after the
        // retry usually means the object hit a bound (screen edge) rather
        // than "moved the wrong way" -- exclude it from the ratio instead
        // of counting it against responsiveness.
        if (negShift !== 0 || posShift !== 0) {
            measured++;
            if (negShift !== 0 && posShift !== 0 && Math.sign(negShift) !== Math.sign(posShift)) opposite++;
        }
        shiftSum += posShift - negShift;
    }
    return { opposite, measured, pairs, meanShift: shiftSum / pairs };
}

async function main() {
    const build = buildArg ? { dir: resolvePath(buildArg), html: dirEntry(resolvePath(buildArg)) } : findBuild(project);
    if (!build || !build.html) {
        console.log('playcheck: FAIL no web export found (run game-export first)');
        process.exit(1);
    }
    const server = await serveStatic(build.dir);
    const port = server.address().port;
    const url = `http://127.0.0.1:${port}/${build.html}`;

    let browser;
    try {
        browser = await chromium.launch({
            executablePath: findChromium(),
            args: [
                '--use-gl=angle',
                '--use-angle=swiftshader',
                '--enable-webgl',
                '--ignore-gpu-blocklist',
                '--enable-unsafe-swiftshader',
            ],
        });
    } catch (e) {
        server.close();
        fail('headless Chromium failed to launch (' + String(e).split('\n')[0] + ')');
    }
    const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
    const consoleErrors = [];
    const pageErrors = [];
    page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
    page.on('pageerror', (e) => pageErrors.push(String(e)));

    let loaded = true;
    try {
        await page.goto(url, { waitUntil: 'load', timeout: 20000 });
    } catch (e) {
        loaded = false;
    }
    const canvasUp = await page
        .waitForFunction(() => {
            const c = document.querySelector('canvas');
            return !!c && c.width > 0;
        }, { timeout: 15000 })
        .then(() => true)
        .catch(() => false);
    await page.waitForTimeout(1500);

    const shotPath = join(process.cwd(), 'playcheck-screenshot.png');
    if (canvasUp) await page.locator('canvas').first().screenshot({ path: shotPath }).catch(() => {});

    // Input is always tested with a standard key set, regardless of what
    // project.godot declares: a game can register its actions at runtime
    // (InputMap.action_add_event in _ready()) with an empty [input]
    // section, and that must never be read as "nothing to test".
    const { keys: declaredKeys, unrecognized, actionCount, eventCount } = extractInputKeys(project);
    const testedKeys = [...new Set([...STANDARD_KEYS, ...declaredKeys])];

    let lr = { opposite: 0, measured: 0, pairs: 0, meanShift: 0 };
    let ud = { opposite: 0, measured: 0, pairs: 0, meanShift: 0 };
    let idleDiff = 0;
    let keysDiff = 0;
    let enterSpaceChanged = false;
    if (canvasUp) {
        await page.mouse.click(480, 300);
        await page.waitForTimeout(200);

        const idleBefore = await samplePixels(page);
        await page.waitForTimeout(300);
        const idleAfter = await samplePixels(page);
        idleDiff = pixelDiffSum(idleBefore, idleAfter);

        const PAIRS = 10;
        lr = await testAxis(page, ['ArrowLeft', 'a'], ['ArrowRight', 'd'], 'x', PAIRS);
        ud = await testAxis(page, ['ArrowUp', 'w'], ['ArrowDown', 's'], 'y', PAIRS);

        const beforeEnter = await samplePixels(page);
        await press(page, ['Enter'], 200);
        await page.waitForTimeout(200);
        await press(page, [' '], 200);
        await page.waitForTimeout(200);
        const afterEnter = await samplePixels(page);
        enterSpaceChanged = pixelDiffSum(beforeEnter, afterEnter) > idleDiff * 1.5;

        const keysBefore = await samplePixels(page);
        for (const k of testedKeys) await press(page, [k], 120);
        await page.waitForTimeout(200);
        const keysAfter = await samplePixels(page);
        keysDiff = pixelDiffSum(keysBefore, keysAfter);
    }

    await browser.close();
    server.close();

    // The axis tests are the robust signal: a majority of pairs moving
    // opposite ways under opposite keys, WITH a non-trivial average shift,
    // is hard to get from background animation alone. Magnitude and
    // enter/space are printed for context but do not gate the verdict on
    // their own, because games with idle animation (falling obstacles,
    // particles) can clear those with no input at all. Pairs with no
    // detectable shift in either direction (object pinned at a bound, or
    // the run already ended) are excluded from the ratio rather than
    // counted as "wrong way". A minimum measured-pair count, a majority,
    // AND a minimum mean shift are all required together: a bare majority
    // with near-zero average shift is indistinguishable from noise (a
    // 50/50 coin flip has a majority about half the time no matter how
    // many samples you take).
    const MIN_MEAN_SHIFT_PX = 5;
    const lrOpposite = lr.measured >= 4 && lr.opposite * 2 > lr.measured && Math.abs(lr.meanShift) >= MIN_MEAN_SHIFT_PX;
    const udOpposite = ud.measured >= 4 && ud.opposite * 2 > ud.measured && Math.abs(ud.meanShift) >= MIN_MEAN_SHIFT_PX;
    const responds = canvasUp && (lrOpposite || udOpposite);

    console.log(`playcheck: build ${build.dir}/${build.html}`);
    console.log(`playcheck: page loaded: ${loaded ? 'yes' : 'no'}`);
    console.log(`playcheck: canvas rendered: ${canvasUp ? 'yes' : 'no'}`);
    console.log(`playcheck: console errors: ${consoleErrors.length}${consoleErrors[0] ? ' (e.g. ' + consoleErrors[0].slice(0, 120) + ')' : ''}`);
    console.log(`playcheck: page errors: ${pageErrors.length}${pageErrors[0] ? ' (e.g. ' + pageErrors[0].slice(0, 120) + ')' : ''}`);
    console.log(`playcheck: project.godot InputMap keys: ${declaredKeys.length ? declaredKeys.join(', ') : 'none'}`);
    if (unrecognized.length) {
        console.log(`playcheck: InputMap keycode(s) ${unrecognized.join(', ')} are not valid keys; no browser key can trigger them`);
    }
    if (actionCount > 0 && eventCount === 0) {
        console.log(`warning: project.godot declares ${actionCount} actions with no key events (registered at runtime?); tested a standard key set instead.`);
    }
    console.log(`playcheck: keys tested: ${testedKeys.join(', ')}`);
    if (canvasUp) {
        console.log(`playcheck: left/right: ${lr.opposite}/${lr.measured} moving pairs opposite (${lr.pairs} pairs tried), mean signed shift ${lr.meanShift.toFixed(1)}px`);
        console.log(`playcheck: up/down: ${ud.opposite}/${ud.measured} moving pairs opposite (${ud.pairs} pairs tried), mean signed shift ${ud.meanShift.toFixed(1)}px`);
        console.log(`playcheck: enter/space state change: ${enterSpaceChanged ? 'yes' : 'no'}`);
        console.log(`playcheck: frame change magnitude with keys vs idle: ${keysDiff} vs ${idleDiff}`);
    }
    console.log(`playcheck: screenshot: ${shotPath}`);

    if (!canvasUp) {
        console.log('input: NOT TESTED (canvas never rendered)');
    } else if (responds) {
        console.log(`input: RESPONDS (left/right ${lr.opposite}/${lr.measured} pairs opposite, up/down ${ud.opposite}/${ud.measured})`);
    } else {
        console.log('input: NO RESPONSE to arrows, WASD, space or enter; the browser build ignores the keyboard. Check that the actions your script reads are declared in project.godot (or registered in _ready()) with KEY_* constants, and that the game is not stuck on a start screen waiting for a key you do not handle.');
    }

    if (!loaded || !canvasUp || pageErrors.length || !responds) process.exit(1);
}
main().catch((e) => fail('unexpected error (' + String(e).split('\n')[0] + ')'));
