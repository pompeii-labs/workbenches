#!/usr/bin/env node
// Headless-Chromium probes shared by every godot-game-* gate. One process,
// one subcommand per gate. Never named after or aware of any specific game.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const modDir = process.env.PW_MODULE_DIR;
if (!modDir) fail('PW_MODULE_DIR not set (call ensure_browser first)');
const { chromium } = require(require.resolve('playwright', { paths: [modDir] }));

const ENGINE_FATAL = /godot|wasm|out of memory|uncaught|failed to fetch|instantiate/i;

// A genuinely frozen tab (e.g. the JS/wasm thread stuck in a busy loop)
// never returns a CDP evaluate() response either, so a naive `await
// page.evaluate(...)` would hang forever instead of reporting FAIL. Race
// every liveness read against a short timeout so a true hang is itself
// treated as evidence of death, not as an indefinitely pending check.
const UNRESPONSIVE = Symbol('unresponsive');
function withTimeout(promise, ms) {
    return Promise.race([
        promise.catch(() => UNRESPONSIVE),
        new Promise((resolve) => setTimeout(() => resolve(UNRESPONSIVE), ms)),
    ]);
}

function fail(msg) {
    console.error(`RESULT: FAIL ${msg}`);
    process.exit(1);
}
function pass(msg) {
    console.log(`RESULT: PASS ${msg}`);
    process.exit(0);
}

async function openPage(browser) {
    const context = await browser.newContext({ viewport: { width: 960, height: 600 } });
    const page = await context.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    page.on('console', (m) => {
        if (m.type() === 'error') consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    return { context, page, consoleErrors, pageErrors };
}

async function waitForCanvas(page, timeoutMs) {
    return page
        .waitForFunction(
            () => {
                const c = document.querySelector('canvas');
                return !!c && c.width > 0 && c.height > 0;
            },
            { timeout: timeoutMs }
        )
        .then(() => true)
        .catch(() => false);
}

// Small helper: average-pixel-value fingerprint of the canvas, cheap enough
// to call many times per second without materially slowing the page.
// 96 x 96: on a 960x600 canvas a cell is 10 x 6.25 source pixels. At 48 x 48
// (20 x 12.5 px cells) a real 26x34 px player drawn in muted colours on a
// dark level averaged down to a handful of cells barely over the dead zone
// and read 116 where 400 was needed; a steerable game failed on
// sensitivity alone.
const SIG_GRID = 96;
async function canvasSignature(page) {
    return page.evaluate((grid) => {
        const c = document.querySelector('canvas');
        if (!c || !c.width || !c.height) return null;
        const off = document.createElement('canvas');
        const w = (off.width = grid);
        const h = (off.height = grid);
        const ctx = off.getContext('2d');
        try {
            ctx.drawImage(c, 0, 0, w, h);
        } catch {
            return null;
        }
        const data = ctx.getImageData(0, 0, w, h).data;
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        return { sum, pixels: Array.from(data) };
    }, SIG_GRID);
}

// Sum of per-channel absolute differences between two consecutive frames.
// Far more sensitive to a small moving object than diffing the frames'
// total-brightness scalars, which a few pixels moving barely budges.
function frameDiff(a, b) {
    if (!a || !b || !a.pixels || !b.pixels) return 0;
    let total = 0;
    for (let i = 0; i < a.pixels.length; i++) total += Math.abs(a.pixels[i] - b.pixels[i]);
    return total;
}

// Many legitimate games kill the player within a few seconds of no input
// and freeze on a "game over -- press Enter/Space to restart" screen. If
// the probe's directional holds land after that freeze, every window reads
// as a static frame and the pair looks unresponsive even though the game
// is fine. Nudge past it: Enter, then Space, then re-click the canvas
// (Godot's web export only delivers keyboard events once the canvas has
// focus, and a restart can drop that focus) and give the engine a moment
// to redraw the revived scene.
// R is included because "press R to restart" is as common a convention as
// Enter or Space; a real submission that offered only R was measured as
// dead in every capture once its ship died during the idle probe.
async function revive(page) {
    for (const key of ['Enter', 'Space', 'r']) {
        await page.keyboard.down(key);
        await page.waitForTimeout(150);
        await page.keyboard.up(key);
    }
    await page.mouse.click(480, 300);
    await page.waitForTimeout(400);
}

async function pressSequence(page) {
    await page.mouse.click(480, 300);
    for (const key of ['Enter', 'Space']) {
        await page.keyboard.press(key);
        await page.waitForTimeout(200);
    }
    for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'w', 'a', 's', 'd']) {
        await page.keyboard.down(key);
        await page.waitForTimeout(250);
        await page.keyboard.up(key);
    }
}

async function main() {
    const [, , mode, url] = process.argv;
    if (!mode || !url) fail('usage: probe.mjs <load|render|input|survive> <url> [screenshotPath]');
    const browser = await chromium.launch({
        executablePath: process.env.CHROMIUM_PATH || undefined,
        args: [
            '--headless=new',
            '--use-gl=angle',
            '--use-angle=swiftshader',
            '--enable-webgl',
            '--ignore-gpu-blocklist',
            '--enable-unsafe-swiftshader',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-background-timer-throttling',
        ],
    });
    try {
        if (mode === 'load') await cmdLoad(browser, url);
        else if (mode === 'render') await cmdRender(browser, url, process.argv[4]);
        else if (mode === 'input') await cmdInput(browser, url);
        else if (mode === 'survive') await cmdSurvive(browser, url);
        else fail(`unknown mode ${mode}`);
    } finally {
        await browser.close().catch(() => {});
    }
}

async function cmdLoad(browser, url) {
    const { page, consoleErrors, pageErrors } = await openPage(browser);
    await page.goto(url, { waitUntil: 'load', timeout: 30000 }).catch((e) => {
        fail(`page did not load: ${e.message.split('\n')[0]}`);
    });
    const started = await waitForCanvas(page, 25000);
    await page.waitForTimeout(2000);
    if (!started) fail('canvas never appeared / engine did not start within 25s');
    const fatalConsole = consoleErrors.filter((m) => ENGINE_FATAL.test(m));
    if (pageErrors.length) fail(`uncaught page error: ${pageErrors[0].split('\n')[0]}`);
    if (fatalConsole.length) fail(`engine-fatal console error: ${fatalConsole[0].slice(0, 200)}`);
    pass(`loaded, canvas active, ${consoleErrors.length} non-fatal console message(s)`);
}

async function cmdRender(browser, url, screenshotPath) {
    const { page } = await openPage(browser);
    await page.goto(url, { waitUntil: 'load', timeout: 30000 }).catch((e) => fail(`load failed: ${e.message.split('\n')[0]}`));
    const started = await waitForCanvas(page, 25000);
    if (!started) fail('canvas never appeared');
    await page.waitForTimeout(3000);
    const canvas = page.locator('canvas').first();
    const buf = await canvas.screenshot();
    if (screenshotPath) writeFileSync(screenshotPath, buf);
    const stats = await page.evaluate(() => {
        const c = document.querySelector('canvas');
        const off = document.createElement('canvas');
        off.width = 48;
        off.height = 48;
        const ctx = off.getContext('2d');
        ctx.drawImage(c, 0, 0, 48, 48);
        const data = ctx.getImageData(0, 0, 48, 48).data;
        const first = [data[0], data[1], data[2]];
        let uniform = true;
        let minv = 255,
            maxv = 0;
        for (let i = 0; i < data.length; i += 4) {
            if (data[i] !== first[0] || data[i + 1] !== first[1] || data[i + 2] !== first[2]) uniform = false;
            const lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
            minv = Math.min(minv, lum);
            maxv = Math.max(maxv, lum);
        }
        return { uniform, range: maxv - minv };
    });
    if (stats.uniform || stats.range < 4)
        fail(`canvas is blank or a single flat color (luminance range ${stats.range})`);
    pass(`canvas has visual variation (luminance range ${stats.range})`);
}

// --- Pinned-position median frames -----------------------------------------
//
// The player is the only object on screen whose POSITION depends on the
// keyboard. Hold one direction long enough and a steerable player is driven
// to a screen edge (or as far as that direction takes it); hold the opposite
// direction and it ends up somewhere else entirely. Everything else that
// moves -- falling hazards, scrolling stars, particles -- keeps moving the
// same way regardless of the key, so it is noise, and it is the noise that
// sank every magnitude/sign/t-statistic version of this gate.
//
// Erase that noise instead of trying to out-argue it: capture the canvas
// several times WHILE THE KEY IS STILL HELD and take the per-cell, per-
// channel MEDIAN. A hazard occupies any given cell for only a fraction of
// the capture window, so that cell's median is the background. The held
// player does not move once it has reached its edge, so it is in the same
// cells in every capture and survives the median at full strength.
const CAPTURES = 8;
const CAPTURE_GAP_MS = 75;

// The hold has to run long enough that the player is ALREADY pinned against
// its edge when the capture window opens, not merely moving fast. A player
// still travelling during the ~0.6 s of captures is smeared across a dozen
// cells and the median erases it exactly as it erases the hazards: measured
// on the reference dodger (300 px/s across a 612 px range, so 2.04 s edge to
// edge), a 1500 ms hold scored 450-510 against a 100-390 noise floor, barely
// separable, while a 2500 ms hold scores in the thousands. 2500 ms was not
// enough either: a real platformer submission ran its player at 245 px/s
// across the full 960 px level (3.9 s edge to edge), so both holds captured
// a still-moving player, the median erased it both times and the two
// medians were identical. 4000 ms covers a full-width traversal at any
// speed from ~240 px/s up. The noise floor's two frames are taken the same
// HOLD_MS apart, so the floor sees the same span of ambient drift the two
// pinned frames do and is not flattered by a shorter gap.
const HOLD_MS = 4000;
const HOLD_FIRST_MS = 1000;
const HOLD_EARLY_MS = 2500;
const HOLD_POINTS_MS = [HOLD_FIRST_MS, HOLD_EARLY_MS, HOLD_MS];
const FLOOR_SAMPLES = 3;

// 3 trials per axis, for both the pinned test and the instantaneous one.
// The gate runs the probe twice inside its 600 s timeout.
const TRIALS = 3;

// Per floor sample and per axis trial, not per run.
const MAX_RETRIES = 2;

// Absolute floor on a decisive score, to guard the `score >= 3 * floor`
// test on a game whose background is perfectly static (floor ~ 0, so any
// flicker would clear 3x). Derivation, entirely from how canvasSignature
// and inputDiff are defined: the canvas is resampled to a SIG_GRID x
// SIG_GRID grid, so on a 960x600 canvas one cell is 10 x 6.25 source
// pixels. A ~16x16 px object covers 16/10 = 1.6 cells across and 16/6.25 =
// 2.56 cells down, i.e. 4.1 cells of area. Moving it somewhere else
// changes two regions of that size, the cells it left and the cells it
// now occupies, for 8.2 cell-areas. The diff sums |delta| over all four
// channels, but an opaque canvas has a constant alpha, so only the three
// color channels contribute: 8.2 * 3 * C, where C is the object-vs-
// background per-channel contrast. Taking a deliberately weak C = 64 (a
// quarter of the 0-255 range) gives 8.2 * 3 * 64 = 1574, rounded to 1600.
// This is the 48 x 48 derivation (393, rounded to 400) scaled by the four
// times as many cells; at that grid the reference dodger scored 894-922,
// the same dodger with its keys bound to nonsense keycodes 0-64, the
// reference platformer 846 steerable and 0 unbound.
const ABS_MIN = 1600;

// canvasSignature downsamples by AVERAGING each cell's source pixels, so a
// dense field of small fast movers (a scrolling starfield) does not vanish
// under the median: it becomes a low-amplitude flicker of a few units in
// nearly every cell, and summed over every cell and channel that flicker
// reads in the tens of thousands (measured 19742 idle on a real dodger with
// a starfield, against ~1000 for its ship). A per-channel dead zone erases
// that flicker and keeps the player, whose cells change by the full object-
// vs-background contrast. 20 is a third of the weak contrast ABS_MIN assumes.
const DIFF_DEADZONE = 20;

// Whether a hazard moved between two consecutive captures is decided by
// amplitude per cell, not by how much changed in total. Measured on a real
// dodger that keeps its starfield scrolling through its game-over screen:
// the dead screen's stars summed to 500-2300 per pair (many cells, each
// changed by 20-30), while the reference dodger's live meteors summed to
// 1800-5800 (few cells, each changed by 100+). No sum separates those; the
// per-cell amplitude does. A pair's motion is the number of channel values
// that changed by MOTION_DELTA or more. Measured at the 96 x 96 signature,
// 75 ms apart: that dodger's dead screen (starfield still scrolling) has 5
// to 28 per pair; the same game alive has 157 to 297; the reference dodger,
// whose few small meteors thin out as they speed up, has 87 to 156 early
// in a run and 55 to 69 fifty seconds in. No fixed bar sits safely between
// 28 and 55 for every game, so the bar is relative: a pair moved when its
// motion is at least MOTION_FRACTION of MOTION_REF, the median per-pair
// motion of the first capture taken right after a revive, when the game is
// certainly alive. Dead starfield: 28 / 237 = 0.12. Late reference dodger:
// 55 / 126 = 0.44. A capture with fewer than FROZEN_MOVING_PAIRS moving
// pairs out of CAPTURES - 1 is frozen. Live hazards move in every pair. The
// bar sits at 6 of 7 so that a death INSIDE the capture window (half the
// frames live, half a game-over panel, which leaves a half-intensity panel
// in the median) counts as frozen and is retried, while a blinking label on
// a dead screen (one or two moving pairs) never counts as alive.
const MOTION_DELTA = 80;
const MOTION_FRACTION = 0.25;
const FROZEN_MOVING_PAIRS = 6;
// The run's live reference: the highest median per-pair motion any IDLE
// capture has shown so far, i.e. the scene moving on its own with no key
// held. A running maximum over several idle samples, not a one-off
// reading, because a single idle capture can land before the hazards have
// spawned (measured: 15 per pair on a dodger that reads 199 a moment
// later, and 15 reads as "static scenery") or on a game that has already
// died (all zeros). Neither can raise the maximum; a live one does. Idle
// samples are taken at several points in the run. Below
// ANIMATES_MIN_MOTION the scene counts as static and nothing is ever
// discarded as a death, which is what keeps a static-scenery platformer
// (a jump transient moves one or two pairs, so its median stays near 0)
// out of the death rule.
let MOTION_REF = 0;
function noteMotion(pairCounts) {
    const m = median(pairCounts);
    if (m > MOTION_REF) MOTION_REF = m;
}
function motionCount(a, b) {
    let big = 0;
    for (let i = 0; i < a.length; i++) {
        if (Math.abs(a[i] - b[i]) >= MOTION_DELTA) big++;
    }
    return big;
}
// pairCounts holds one motion count per consecutive pair of a capture (7
// for a median frame, 1 for an instantaneous tap).
function isFrozen(frame) {
    if (MOTION_REF < ANIMATES_MIN_MOTION) return false;
    const bar = MOTION_FRACTION * MOTION_REF;
    const moving = frame.pairCounts.filter((c) => c >= bar).length;
    const required = frame.pairCounts.length >= CAPTURES - 1 ? FROZEN_MOVING_PAIRS : frame.pairCounts.length;
    return moving < required;
}
function inputDiff(a, b) {
    if (!a || !b || !a.pixels || !b.pixels) return 0;
    let total = 0;
    for (let i = 0; i < a.pixels.length; i++) {
        const d = Math.abs(a.pixels[i] - b.pixels[i]);
        if (d >= DIFF_DEADZONE) total += d;
    }
    return total;
}

function median(xs) {
    const a = xs.slice().sort((x, y) => x - y);
    const mid = a.length >> 1;
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

// An axis score is a value at least TWO valid trials reached: the second
// largest. With three valid trials that is the median; with two it is the
// smaller one. Never a mean: a real dodger with two valid trials on an axis
// it does not bind read [13632, 2074], and their mean cleared the bar on an
// axis the game ignores. One contaminated trial must never decide.
function trialScore(valid) {
    if (valid.length < 2) return null;
    const a = valid.slice().sort((x, y) => x - y);
    return a[a.length - 2];
}

// Per-cell, per-channel median of CAPTURES signatures taken CAPTURE_GAP_MS
// apart. Returns the same `{ pixels }` shape canvasSignature returns, so
// inputDiff takes it unchanged, plus `pairCounts`, the per-pair motion the
// death rule reads (see isFrozen). `idle` marks a capture taken with no key
// held: only those feed the live reference, because during a hold the
// player's own movement is motion too, and a platformer whose player kept
// walking off a ledge and respawning set the reference above the static
// bar and then had every still capture discarded as a death.
async function medianFrame(page, idle = false) {
    const frames = [];
    for (let i = 0; i < CAPTURES; i++) {
        if (i) await page.waitForTimeout(CAPTURE_GAP_MS);
        const sig = await canvasSignature(page);
        if (!sig || !sig.pixels) return null;
        frames.push(sig.pixels);
    }
    const n = frames[0].length;
    const pixels = new Array(n);
    const column = new Array(frames.length);
    const mid = frames.length >> 1;
    for (let i = 0; i < n; i++) {
        for (let f = 0; f < frames.length; f++) column[f] = frames[f][i];
        column.sort((a, b) => a - b);
        pixels[i] = frames.length % 2 ? column[mid] : (column[mid - 1] + column[mid]) / 2;
    }
    // Frozen means the hazards stopped, not that every byte held still. A
    // real dodger kept its starfield scrolling through its game-over screen
    // (measured: byte-identical captures never happened, so every death went
    // undetected and inflated its floor to 15000). Each consecutive pair's
    // motion count (per-cell amplitude, see motionCount) is kept on the
    // frame; isFrozen reads them against the run's live reference: hazards
    // move in every pair, a blinking "press space" label moves in one or
    // two.
    const pairCounts = [];
    for (let f = 1; f < frames.length; f++) pairCounts.push(motionCount(frames[f - 1], frames[f]));
    if (idle) noteMotion(pairCounts);
    const frame = { pixels, pairCounts };
    if (process.env.PROBE_DEBUG)
        console.error(`probe capture: motion=[${pairCounts.join(',')}] ref=${MOTION_REF} frozen=${isFrozen(frame)}`);
    return frame;
}

// --- Telling a pinned player apart from a dead one -------------------------
//
// `frozen` on its own is ambiguous, and both readings are real: a platformer
// with static scenery is frozen when its player is correctly pinned against
// an edge, while a dodger that has just died is frozen on a game-over screen
// with its hazards stopped mid-fall. What disambiguates them is a fact about
// the game measured BEFORE any key is touched: does anything on this screen
// move by itself? Two back-to-back idle median frames answer it. If the
// scene animates when left alone, a frozen capture means the game stopped,
// and that capture is worthless -- it is the game-over screen, not the
// player's position. If the scene does not animate, frozen is the normal
// state and means nothing either way.
//
// Getting this wrong is not a small error. On the benchmark machine, real dodgers that
// freeze the whole scene on game over produced floors of 40571 and scores
// of 29900, because a no-key floor sample was comparing a LIVE median frame
// (hazards averaged away) against a FROZEN game-over frame (hazards still
// there). Those are not measurements of anything.
//
// The measurement here is per-pair motion (motionCount) on the first
// capture, which doubles as the run's live reference for every later
// frozen decision. revive presses Space, which on a platformer is jump, so
// that first capture can catch a player mid-jump; a jump moves one or two
// of its seven pairs, and the median over the seven ignores that, so a
// static-scenery platformer stays classed as static. Reading a transient
// like that as "the scene animates" once made every later frozen capture
// look like a death and failed the reference platformer outright.
async function detectSceneAnimation(page) {
    // Let a jump or a restart animation finish first, so the question being
    // answered is "does this scene move on its own", not "is the engine
    // still settling after revive".
    await page.waitForTimeout(600);
    const a = await medianFrame(page, true);
    await page.waitForTimeout(300);
    const b = await medianFrame(page, true);
    if (!a || !b) return { animates: true, diff: 0, ref: 0 };
    // The live reference is the FIRST capture's median per-pair motion: it
    // is taken 600 ms after a revive, when the game is certainly alive, and
    // a dodger left unsteered routinely dies before the second capture
    // (reading its game-over screen as "static scenery" once switched death
    // detection off for a whole run: floor 11706, every trial
    // contaminated). The median over the 7 pairs is what a jump transient
    // after the settle cannot lift on a static platformer (one or two pairs
    // move, five do not), so that game stays classed as static; a scene
    // that only fades a banner or flickers a lantern stays static too, and
    // must, or every one of its captures would be discarded as a death
    // (measured on a real platformer: pinned floor unmeasurable). Live
    // hazards put the median at 55 and up (see MOTION_FRACTION); the bar
    // for "animates" is ANIMATES_MIN_MOTION. The two medians' diff is
    // logged for reading, not for the verdict.
    const diff = inputDiff(a, b);
    // Both captures have already fed the running reference (noteMotion).
    // The verdict here is provisional: the reference keeps rising as live
    // captures come in, and captureUsable reads it fresh every time.
    return { animates: MOTION_REF >= ANIMATES_MIN_MOTION, diff, ref: MOTION_REF };
}
// Below this median per-pair motion on the first live capture, the scene is
// treated as static and no capture is ever discarded as a death. The dead
// starfield screen measured at most 28 per pair; live hazards 55 and up.
const ANIMATES_MIN_MOTION = 40;

// One more idle reading for the live reference, taken in a fresh life with
// no key held: revive, let the hazards build up for IDLE_REF_SETTLE_MS,
// capture. The first idle captures come 600 ms after a revive, before some
// games have spawned a single hazard (measured: 15 per pair on a dodger
// that reads 199 a moment later), so the reference is re-sampled at a few
// points in the run. A capture on a game that has already died reads low
// and cannot lower the reference, so this is safe to do anywhere.
const IDLE_REF_SETTLE_MS = 2000;
async function sampleIdleReference(page) {
    await revive(page);
    await page.waitForTimeout(IDLE_REF_SETTLE_MS);
    await medianFrame(page, true);
}

// `sceneAnimates` is the provisional reading logged at the start; the live
// decision is isFrozen's, which reads the running reference and returns
// false for any scene still classed as static.
function captureUsable(frame, sceneAnimates) {
    void sceneAnimates;
    return !!frame && !isFrozen(frame);
}

// One measurement outcome, carrying enough to read a fail: the number, how
// many retries it took, and whether it ever became valid at all.
function fmtSample(s) {
    if (s.dropped) return `dropped(dead by the final reference)`;
    if (!s.valid) return `invalid(${s.retries} retries)`;
    return s.retries ? `${s.value.toFixed(0)}(retried ${s.retries}x)` : s.value.toFixed(0);
}

// The live reference only rises as idle samples accumulate (see
// MOTION_REF), so a capture judged alive early, while the reference was
// still too low to tell, can be a game-over screen after all. Measured on a real dodger: its first
// idle captures came before any hazard had spawned (reference 0), the
// first floor sample was taken with death detection off and read 44747,
// and that one sample poisoned the floor median. Re-judging every sample
// against the reference as it stands when the sample is USED can only drop
// samples, never admit any (a sample already marked invalid stays so), so
// it is applied before every median and score.
function revalidate(samples) {
    for (const s of samples) {
        if (!s.valid || !s.frames) continue;
        if (s.frames.some((f) => isFrozen(f))) {
            s.valid = false;
            s.dropped = true;
            s.value = 0;
        }
    }
    return samples;
}

// Press `key` and hold it so the player is driven as far as that direction
// takes it, taking a median frame WITHOUT releasing at two points: after
// HOLD_EARLY_MS and again after HOLD_MS. The player has to stay pinned for
// the whole capture window or the median erases it along with the hazards,
// and the two games this gate has to serve pull in opposite directions: a
// dense dodger's ship pinned against an edge is often dead by 4 s
// (measured: 2 of 3 trials invalid at a single 4 s capture on a real
// submission that had been fine at 2.5 s), while a slow platformer on a
// wide level is still walking at 2.5 s (measured: identical medians for
// Left and Right at 245 px/s across 960 px). So take both and let the
// caller keep the later capture that is still alive: the dodger yields its
// 2.5 s frame, the platformer its 4 s frame.
// A third, earliest point at HOLD_FIRST_MS exists for dodgers so dense that
// the ship dies inside two seconds of any hold (measured on a real
// submission: live motion 400 to 800 per pair, every 2.5 s capture already
// on its game-over screen). A ship at 500 px/s is pinned from the centre
// well inside a second; slower players simply get their later captures.
async function holdAndCapture(page, key) {
    await page.keyboard.down(key);
    const started = Date.now();
    const captures = [];
    for (const at of HOLD_POINTS_MS) {
        // Each capture itself takes ~0.8 s, so wait by the clock, not by
        // the nominal gap, or the later points drift.
        const wait = started + at - Date.now();
        if (wait > 0) await page.waitForTimeout(wait);
        captures.push(await medianFrame(page));
    }
    await page.keyboard.up(key);
    return captures;
}

// One hold in its own fresh life: revive, hold, capture. A dense dodger
// kills a ship pinned against an edge within a few seconds, so a trial
// that needs the player to survive two consecutive holds rarely completes
// there, measured on a real submission: 2 of 3 trials invalid, run after
// run. One hold per life halves the survival time needed, and a revive
// restarts the game so both holds of a trial start at the same difficulty.
// When the scene animates, a frozen capture means the game ended; the
// later capture is preferred (the player has had longest to get pinned),
// the early one is the fallback when the game died in between, and a hold
// with neither is retried in a new life, up to MAX_RETRIES times.
async function holdInFreshLife(page, key, sceneAnimates, deadlineAt) {
    let retries = 0;
    for (;;) {
        await revive(page);
        const captures = await holdAndCapture(page, key);
        // Latest live capture wins: the player has had longest to get pinned.
        for (let i = captures.length - 1; i >= 0; i--) {
            if (captureUsable(captures[i], sceneAnimates)) return { frame: captures[i], retries };
        }
        if (retries >= MAX_RETRIES || Date.now() > deadlineAt) return { frame: null, retries };
        retries++;
    }
}

// The noise floor, measured with the SAME key held in two separate lives
// rather than with no key at all. One sample: hold `key` in a fresh life,
// capture; hold `key` again in another fresh life, capture; diff the two.
//
// Holding the same key for both captures is what makes the floor comparable
// to an axis trial. A steerable player is pinned against the same edge in
// both captures and contributes nothing; an unsteerable one sits wherever it
// sits, equally in both. Ambient motion is sampled over the same span, by the
// same median, from the same game state (a fresh life, same key). What is
// left is exactly the part of a trial's diff that the keys did not cause,
// which a no-key floor could not isolate, because "no key" is a different
// game state from "key held" once the player's survival depends on being
// steered.
async function measureFloor(page, key, sceneAnimates, deadlineAt) {
    const samples = [];
    for (let i = 0; i < FLOOR_SAMPLES; i++) {
        const a = await holdInFreshLife(page, key, sceneAnimates, deadlineAt);
        const b = a.frame ? await holdInFreshLife(page, key, sceneAnimates, deadlineAt) : { frame: null, retries: 0 };
        const retries = a.retries + b.retries;
        if (a.frame && b.frame) samples.push({ value: inputDiff(a.frame, b.frame), retries, valid: true, frames: [a.frame, b.frame] });
        else samples.push({ value: 0, retries, valid: false });
    }
    return samples;
}

// One axis = TRIALS trials of (hold keyA to its edge in a fresh life, hold
// keyB to its edge in another, diff the two pinned frames). Which key goes
// first alternates across trials so a game that only responds from one
// starting position cannot fake a score by always being driven the same way
// first.
//
// A trial is valid only if BOTH holds produced usable captures. A trial with
// one live hold and one dead one is the false-positive path that has to stay
// closed: it diffs a live frame against a game-over screen and reads
// enormous whether or not the keys did anything. holdInFreshLife never
// returns a dead capture while the scene animates, so such a trial cannot
// be scored; it comes back invalid instead.
//
// Score = trialScore of the valid trials (a value two trials reached), and
// at least 2 must be valid; an axis the game kept dying through is
// inconclusive, never a pass and never a fail on its own.
//
// `trials` is an array to append to, so an axis can be screened with one
// trial first and completed later only if that trial looked promising:
// pass the same array back with `from` set to its length.
async function axisScore(page, keyA, keyB, sceneAnimates, deadlineAt, trials = [], count = TRIALS) {
    const from = trials.length;
    for (let t = from; t < from + count; t++) {
        const [first, second] = t % 2 === 0 ? [keyA, keyB] : [keyB, keyA];
        const a = await holdInFreshLife(page, first, sceneAnimates, deadlineAt);
        const b = a.frame ? await holdInFreshLife(page, second, sceneAnimates, deadlineAt) : { frame: null, retries: 0 };
        const retries = a.retries + b.retries;
        if (a.frame && b.frame) trials.push({ value: inputDiff(a.frame, b.frame), retries, valid: true, frames: [a.frame, b.frame] });
        else trials.push({ value: 0, retries, valid: false });
    }
    const valid = revalidate(trials).filter((s) => s.valid).map((s) => s.value);
    return { trials, score: trialScore(valid) };
}

// --- The instantaneous test: for players that never hold still -------------
//
// The pinned test assumes a held direction eventually parks the player
// somewhere it stays. Plenty of real games have no such state. A platformer
// whose starting platform is shorter than HOLD_MS of walking goes: walk, walk
// off the edge, fall, respawn at the start, walk off again. It is perfectly
// steerable, but it is never still in EITHER direction, so the median erases
// it both times and the pinned diff collapses. That is a real submission the
// benchmark failed twice: per-axis D of 63 to 235 against a floor of ~220, on a
// game whose screenshots show it steering fine.
//
// So: stop waiting for stillness. Tap a direction for TAP_MS, grab ONE raw
// frame while the key is still down, tap the opposite direction, grab one
// more, and diff those. No median, no pinning. The player is simply at two
// different places in two single frames, which on a static-scenery game is
// two clearly separated blobs and comfortably over ABS_MIN, while a game
// whose movement keys do nothing gives a diff of about zero.
//
// The price is that this test has no defence at all against ambient motion:
// one raw frame TAP_MS after another includes every meteor that moved in
// between. On a busy scene the instantaneous floor is therefore large, and
// the 3x rule means this test simply cannot return a pass there. That is
// deliberate, not a gap -- on those games the pinned test is the one that
// works, and it runs first. This is a fallback for the static-scene games
// the pinned test cannot read, not a second opinion on the busy ones.
const TAP_MS = 400;
const TAP_GAP_MS = 150;

// A single raw frame says nothing about whether the engine is still running,
// which the death rule needs. Take a second frame a moment later and call
// the capture frozen when nothing moved between them above the dead zone.
// Cheap: two extra evaluates and FROZEN_PROBE_MS per hold.
const FROZEN_PROBE_MS = 80;

// Hold `key` for TAP_MS, then capture while still holding. Returns the same
// `{ pixels, pairCounts }` shape medianFrame does, so inputDiff and
// captureUsable take it unchanged. A single pair is read against the live
// reference but never sets it: one pair during a jump (the revive presses
// Space) once read as "live hazards" on a static platformer and turned
// death detection on for a game that never dies.
async function tapAndCapture(page, key) {
    await page.keyboard.down(key);
    await page.waitForTimeout(TAP_MS);
    const s1 = await canvasSignature(page);
    await page.waitForTimeout(FROZEN_PROBE_MS);
    const s2 = await canvasSignature(page);
    await page.keyboard.up(key);
    if (!s1 || !s2) return null;
    return { pixels: s1.pixels, pairCounts: [motionCount(s1.pixels, s2.pixels)] };
}

// After a revive, the platformer case needs the jump it just triggered to
// land before a tap measures anything (a jump is ~0.6 to 0.9 s of motion).
const REVIVE_SETTLE_MS = 1200;

// Instantaneous floor: two raw frames TAP_MS apart with no key held. On a
// static scene this is 0; on a busy one it is whatever the hazards did in
// 400 ms, which is exactly the amount this test cannot see through.
async function measureInstantFloor(page, sceneAnimates, deadlineAt) {
    const samples = [];
    for (let i = 0; i < FLOOR_SAMPLES; i++) {
        let retries = 0;
        for (;;) {
            const a = await canvasSignature(page);
            await page.waitForTimeout(TAP_MS);
            const b = await canvasSignature(page);
            const value = a && b ? inputDiff(a, b) : 0;
            // The same death rule as every other capture: hazards stopped,
            // judged against the run's live reference.
            let frame = null;
            if (a && b) frame = { pixels: a.pixels, pairCounts: [motionCount(a.pixels, b.pixels)] };
            if (captureUsable(frame, sceneAnimates)) {
                samples.push({ value, retries, valid: true, frames: [frame] });
                break;
            }
            if (retries >= MAX_RETRIES || Date.now() > deadlineAt) {
                samples.push({ value: 0, retries, valid: false });
                break;
            }
            retries++;
            await revive(page);
            await page.waitForTimeout(REVIVE_SETTLE_MS);
        }
    }
    return samples;
}

// One axis of the instantaneous test. Same shape as axisScore: alternating
// order, retries on a dead capture, trialScore of the valid trials, at least
// 2 of TRIALS required.
async function instantAxisScore(page, keyA, keyB, sceneAnimates, deadlineAt) {
    const trials = [];
    for (let t = 0; t < TRIALS; t++) {
        const [first, second] = t % 2 === 0 ? [keyA, keyB] : [keyB, keyA];
        let retries = 0;
        for (;;) {
            await revive(page);
            await page.waitForTimeout(REVIVE_SETTLE_MS);
            const mFirst = await tapAndCapture(page, first);
            await page.waitForTimeout(TAP_GAP_MS);
            const mSecond = await tapAndCapture(page, second);
            if (captureUsable(mFirst, sceneAnimates) && captureUsable(mSecond, sceneAnimates)) {
                trials.push({ value: inputDiff(mFirst, mSecond), retries, valid: true, frames: [mFirst, mSecond] });
                break;
            }
            if (retries >= MAX_RETRIES || Date.now() > deadlineAt) {
                trials.push({ value: 0, retries, valid: false });
                break;
            }
            retries++;
        }
    }
    const valid = revalidate(trials).filter((s) => s.valid).map((s) => s.value);
    return { trials, score: trialScore(valid) };
}

// Does holding a direction put the game in a visibly different state from
// holding the opposite direction, by more than the game's own ambient
// motion accounts for?
//
// Two tests answer it, each with its own floor, and the same decision rule
// for both: an axis is decisive when its score is at least 3x that test's
// noise floor AND at least ABS_MIN. Within a test, axes are tried in order
// and it stops at the first decisive one: arrows first, then WASD, since a
// game that binds only WASD is still playable.
//
//   1. Pinned (above): HOLD_MS holds, median frames, immune to ambient motion
//      but blind to a player that never holds still.
//   2. Instantaneous (above): 400 ms taps, single raw frames, blind to
//      nothing about the player but wide open to ambient motion.
//
// They fail in opposite directions, which is the point of running both. The
// pinned test goes first because it is the one that works on busy games,
// where the instantaneous test's floor is too high to ever pass. The
// instantaneous test only runs when the pinned test decided nothing, and it
// is what reads the static-scene games with no pinned state.
//
// Known limits: a game that reacts only through audio or off-canvas UI
// passes neither, since both read only the canvas. Nor does a busy game
// whose player never holds still, which is the one square both tests leave
// empty: the pinned test cannot see the player and the instantaneous test
// cannot see past the hazards.
//
// Runtime budget for one invocation. Load and settle ~5 s; one median
// frame ~0.8 s (7 x 75 ms of gaps plus the per-capture evaluate, now at
// 96 x 96); the animation probe ~2.5 s; one hold in a fresh life = revive
// 0.85 s + HOLD_MS + a median ~= 5.7 s, so a pinned floor sample or trial
// (two holds) is ~11.5 s; the pinned floor is ~35 s and one pinned axis
// ~35 s. Four pinned axes plus the preamble is ~180 s. The instantaneous
// test is far cheaper: its floor is ~1.5 s and a trial is ~2.1 s, so all
// four of its axes cost ~26 s. A clean run that exhausts both tests is
// ~210 s; one decided on the first pinned axis is ~75 s.
//
// The two deadlines bound the retries, which are what can otherwise run
// away: a game that dies during every hold would pay MAX_RETRIES + 1
// attempts on every floor sample and every trial. Past a deadline no new
// axis of that phase is started and no further retry is attempted, so the
// tail is one already-running axis.
//
// The pinned phase gets the larger share because on a busy scene it is the
// ONLY test that can pass: the instantaneous test's floor is too high there
// by construction. A dodger that dies every few seconds needs its retries
// on every hold, and a WASD-only game needs the third axis reached; at a
// budget that stopped after the two arrow axes, a real WASD-only dodger
// never had its a/d axis started. INST_DEADLINE_MS caps the whole run; the
// instantaneous phase is skipped outright when less than
// INST_MIN_BUDGET_MS is left, since a floor plus one axis is the smallest
// useful thing it can do. Worst case ~290 s. The probe is deterministic
// enough that the gate runs it twice, not three times: 2 x 290 s sits
// inside the gate's 600 s timeout.
const PINNED_DEADLINE_MS = 240000;
const INST_DEADLINE_MS = 285000;
const INST_MIN_BUDGET_MS = 20000;

async function cmdInput(browser, url) {
    const started = Date.now();
    const pinnedDeadlineAt = started + PINNED_DEADLINE_MS;
    const instDeadlineAt = started + INST_DEADLINE_MS;
    const { page } = await openPage(browser);
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    await waitForCanvas(page, 25000);
    await page.waitForTimeout(1500);
    // Godot's web export only delivers keyboard events once the canvas has
    // focus, so click it before anything else, then get past a title or
    // game-over screen so the measurements act on a live player.
    await page.mouse.click(480, 300);
    await page.waitForTimeout(300);
    await revive(page);

    const anim = await detectSceneAnimation(page);
    console.error(
        `probe input: sceneAnimates=${anim.animates} ` +
            `(live motion reference=${anim.ref.toFixed(0)} per pair, animates at >= ${ANIMATES_MIN_MOTION}; idle median diff=${anim.diff.toFixed(0)}) -- ` +
            (anim.animates
                ? 'a frozen capture means the game ended and is discarded'
                : 'static scenery, frozen captures are normal and are kept')
    );

    const axes = [
        ['ArrowLeft', 'ArrowRight'],
        ['ArrowUp', 'ArrowDown'],
        ['a', 'd'],
        ['w', 's'],
    ];

    // One floor, held on the first axis's first key. Ambient motion does not
    // depend on which key is down, and a key the game ignores leaves the
    // player as still as a key that pins it, so this single measurement is
    // the right baseline for every axis. Re-measuring it per axis would cost
    // 22 s each and push the run past the gate's budget.
    const floorKey = axes[0][0];
    // One discarded hold before anything is measured, so the live reference
    // has seen a game with its hazards up (the idle captures can land before
    // the first hazard spawns) before the first real sample is judged.
    await holdInFreshLife(page, floorKey, anim.animates, pinnedDeadlineAt);
    await sampleIdleReference(page);
    const floorSamples = await measureFloor(page, floorKey, anim.animates, pinnedDeadlineAt);
    await sampleIdleReference(page);
    revalidate(floorSamples);
    const validFloor = floorSamples.filter((s) => s.valid).map((s) => s.value);
    const floorLine = floorSamples.map(fmtSample).join(', ');

    let decisive = null;
    // A pinned floor that could not be measured is not the end of the run:
    // a game that keeps ending during five-second holds is exactly the shape
    // the instantaneous test below exists for, and its 400 ms taps may well
    // finish before the game dies. Skip the pinned phase, do not fail yet.
    let pinnedFloor = null;
    if (validFloor.length < 2) {
        console.error(
            `probe input pinned floor (holding ${floorKey}): [${floorLine}] -- ` +
                `only ${validFloor.length} of ${FLOOR_SAMPLES} samples valid, skipping the pinned test`
        );
    } else {
        // Median, not max: one sample wrecked by an unlucky burst of ambient
        // motion should not raise the bar every axis then has to clear.
        pinnedFloor = median(validFloor);
        const need = Math.max(3 * pinnedFloor, ABS_MIN);
        console.error(
            `probe input pinned floor (holding ${floorKey}): [${floorLine}] floor=median=${pinnedFloor.toFixed(0)} ` +
                `(threshold: score >= 3*floor = ${(3 * pinnedFloor).toFixed(0)} AND score >= ABS_MIN = ${ABS_MIN}, so >= ${need.toFixed(0)})`
        );
        // Screen every axis with ONE trial first, then spend the remaining
        // trials only on axes whose first trial cleared the bar, best first.
        // Measured on a real WASD-only dodger that dies often: three full
        // trials on each of the two arrow axes it does not bind, with their
        // retries, spent the whole pinned budget and a/d, the axis it does
        // bind, was never started. One trial per axis costs a quarter of
        // that and finds the candidate; two more trials confirm it.
        const screened = [];
        for (let i = 0; i < axes.length; i++) {
            const [keyA, keyB] = axes[i];
            if (i > 0 && Date.now() > pinnedDeadlineAt) {
                console.error(`probe input pinned axis ${keyA}/${keyB}: screen skipped (time budget spent)`);
                continue;
            }
            const { trials } = await axisScore(page, keyA, keyB, anim.animates, pinnedDeadlineAt, [], 1);
            const first = trials[0];
            const promising = first.valid && first.value >= need;
            console.error(
                `probe input pinned axis ${keyA}/${keyB}: screen D=[${fmtSample(first)}] vs needed ${need.toFixed(0)} -> ` +
                    (promising ? 'candidate' : first.valid ? 'not promising' : 'invalid')
            );
            if (promising) screened.push({ keyA, keyB, trials });
        }
        screened.sort((x, y) => y.trials[0].value - x.trials[0].value);
        // Confirming a screened candidate is the most valuable measurement in
        // the run, so it gets the whole remaining budget (the instantaneous
        // deadline), not just the pinned share: on a dense dodger the floor's
        // and screen's retries alone once spent the pinned share, and a game
        // with two clear candidates (12328 and 12249 against 1600) failed
        // with "confirmation skipped".
        for (const cand of screened) {
            if (Date.now() > instDeadlineAt - INST_MIN_BUDGET_MS) {
                console.error(`probe input pinned axis ${cand.keyA}/${cand.keyB}: confirmation skipped (time budget spent)`);
                continue;
            }
            const { trials, score } = await axisScore(page, cand.keyA, cand.keyB, anim.animates, instDeadlineAt, cand.trials, TRIALS - 1);
            const ok = score !== null && score >= need;
            console.error(
                `probe input pinned axis ${cand.keyA}/${cand.keyB}: D=[${trials.map(fmtSample).join(', ')}] ` +
                    `score=${score === null ? `inconclusive (<2 of ${TRIALS} trials valid)` : score.toFixed(0)} ` +
                    `vs needed ${need.toFixed(0)} -> ${ok ? 'DECISIVE' : 'not decisive'}`
            );
            if (ok) {
                decisive = { test: 'pinned', keyA: cand.keyA, keyB: cand.keyB, score, floor: pinnedFloor, need };
                break;
            }
        }
    }

    // Second test, only if the first decided nothing and there is enough
    // left of the budget for a floor plus at least one axis.
    let instFloor = null;
    let instSkipped = false;
    if (!decisive && Date.now() > instDeadlineAt - INST_MIN_BUDGET_MS) {
        instSkipped = true;
        console.error('probe input instantaneous test: skipped (time budget spent on the pinned test)');
    }
    if (!decisive && !instSkipped) {
        // A real fresh start, not just a revive. A game with no restart key
        // keeps whatever state the pinned holds left behind, and on a level
        // with no horizontal bounds those holds walked the player clean off
        // screen (measured on a real submission: every tap then compared two
        // empty levels and read ~300 against 1600 needed). Reloading puts
        // the player back at its spawn, which is where the taps must start.
        await page.goto(url, { waitUntil: 'load', timeout: 30000 });
        await waitForCanvas(page, 25000);
        await page.waitForTimeout(1500);
        await page.mouse.click(480, 300);
        await page.waitForTimeout(300);
        await sampleIdleReference(page);
        await revive(page);
        await page.waitForTimeout(REVIVE_SETTLE_MS);
        const instSamples = revalidate(await measureInstantFloor(page, anim.animates, instDeadlineAt));
        const validInst = instSamples.filter((s) => s.valid).map((s) => s.value);
        const instLine = instSamples.map(fmtSample).join(', ');
        if (validInst.length < 2) {
            console.error(
                `probe input instantaneous floor: [${instLine}] -- ` +
                    `only ${validInst.length} of ${FLOOR_SAMPLES} samples valid`
            );
        } else {
            instFloor = median(validInst);
            const need = Math.max(3 * instFloor, ABS_MIN);
            console.error(
                `probe input instantaneous floor: [${instLine}] floor=median=${instFloor.toFixed(0)} ` +
                    `(threshold: score >= 3*floor = ${(3 * instFloor).toFixed(0)} AND score >= ABS_MIN = ${ABS_MIN}, so >= ${need.toFixed(0)})`
            );
            for (let i = 0; i < axes.length; i++) {
                const [keyA, keyB] = axes[i];
                if (i > 0 && Date.now() > instDeadlineAt) {
                    console.error(`probe input instantaneous axis ${keyA}/${keyB}: skipped (time budget spent)`);
                    continue;
                }
                const { trials, score } = await instantAxisScore(page, keyA, keyB, anim.animates, instDeadlineAt);
                const ok = score !== null && score >= need;
                console.error(
                    `probe input instantaneous axis ${keyA}/${keyB}: D=[${trials.map(fmtSample).join(', ')}] ` +
                        `score=${score === null ? `inconclusive (<2 of ${TRIALS} trials valid)` : score.toFixed(0)} ` +
                        `vs needed ${need.toFixed(0)} -> ${ok ? 'DECISIVE' : 'not decisive'}`
                );
                if (ok) {
                    decisive = { test: 'instantaneous', keyA, keyB, score, floor: instFloor, need };
                    break;
                }
            }
        }
    }

    console.error(`probe input: final live motion reference=${MOTION_REF.toFixed(0)} per pair (death detection ${MOTION_REF >= ANIMATES_MIN_MOTION ? 'on' : 'off'})`);
    if (!decisive) {
        if (pinnedFloor === null && instFloor === null)
            fail(
                `could not measure a noise floor: game keeps ending during measurement ` +
                    `(neither the pinned nor the instantaneous floor got 2 of ${FLOOR_SAMPLES} valid samples)`
            );
        fail(
            `no axis separated the two held directions from the noise floor ` +
                `(pinned floor=${pinnedFloor === null ? 'unmeasurable' : pinnedFloor.toFixed(0)}, ` +
                `instantaneous floor=${instFloor === null ? 'unmeasurable' : instFloor.toFixed(0)})`
        );
    }
    pass(
        `canvas responded to input (${decisive.test} test, axis ${decisive.keyA}/${decisive.keyB}: ` +
            `score=${decisive.score.toFixed(0)}, floor=${decisive.floor.toFixed(0)}, needed >= ${decisive.need.toFixed(0)})`
    );
}

async function cmdSurvive(browser, url) {
    const { page, consoleErrors, pageErrors } = await openPage(browser);
    // Liveness counters, injected before navigation so they exist from the
    // engine's very first frame. rAF is the primary signal; the setInterval
    // heartbeat is a fallback in case the engine throttles rAF when the
    // canvas isn't focused (headless browsing, no window focus events).
    await page.addInitScript(() => {
        window.__wbmFrameCount = 0;
        window.__wbmBeatCount = 0;
        const tick = () => {
            window.__wbmFrameCount++;
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        setInterval(() => {
            window.__wbmBeatCount++;
        }, 250);
    });
    await page.goto(url, { waitUntil: 'load', timeout: 30000 }).catch((e) => fail(`load failed: ${e.message.split('\n')[0]}`));
    const started = await waitForCanvas(page, 25000);
    if (!started) fail('canvas never appeared');
    await page.waitForTimeout(1000);
    const before = await canvasSignature(page);
    const DURATION = 60000;
    const start = Date.now();
    while (Date.now() - start < DURATION) {
        // A genuinely frozen renderer can also leave keyboard/mouse CDP
        // commands unanswered (the browser process waits on an input-ack
        // from a main thread that will never run again), so this needs the
        // same timeout race as the evaluate() calls below.
        const seq = await withTimeout(pressSequence(page), 8000);
        if (seq === UNRESPONSIVE) fail('page stopped responding to input during play (frozen)');
        if (pageErrors.length) fail(`page error during play: ${pageErrors[0].split('\n')[0]}`);
        const stillAlive = await withTimeout(
            page.evaluate(() => !!document.querySelector('canvas')),
            5000
        );
        if (stillAlive === UNRESPONSIVE) fail('page stopped responding during play (frozen)');
        if (!stillAlive) fail('canvas / page disappeared during play (crash)');
    }

    // Liveness means the engine is still running, not that the screen looks
    // different from the first frame -- a finished or reset game sitting on
    // a title screen that is pixel-identical to the start is a legitimate
    // state, not a freeze. Sample the counters twice, 3s apart, at the end
    // of the input session: the engine is alive if either counter advanced.
    // Every read races a short timeout: a truly frozen tab (JS/wasm thread
    // stuck) never answers a CDP evaluate() either, and that non-answer is
    // itself proof of death, not a reason to hang the check indefinitely.
    const sample1 = await withTimeout(
        page.evaluate(() => ({ frames: window.__wbmFrameCount || 0, beats: window.__wbmBeatCount || 0 })),
        5000
    );
    if (sample1 === UNRESPONSIVE) fail('page stopped responding while sampling liveness counters (frozen)');
    await page.waitForTimeout(3000);
    const sample2 = await withTimeout(
        page.evaluate(() => ({ frames: window.__wbmFrameCount || 0, beats: window.__wbmBeatCount || 0 })),
        5000
    );
    if (sample2 === UNRESPONSIVE) fail('page stopped responding while sampling liveness counters (frozen)');

    const after = await withTimeout(canvasSignature(page), 5000);
    if (pageErrors.length) fail(`page error during play: ${pageErrors[0].split('\n')[0]}`);
    const fatalConsole = consoleErrors.filter((m) => ENGINE_FATAL.test(m));
    if (fatalConsole.length) fail(`engine-fatal console error: ${fatalConsole[0].slice(0, 200)}`);

    const stillThere = await withTimeout(
        page.evaluate(() => !!document.querySelector('canvas')),
        5000
    );
    if (stillThere === UNRESPONSIVE) fail('page stopped responding after 60s of input (frozen)');
    if (!stillThere) fail('canvas / page disappeared during liveness sample (crash)');

    const frameDelta = sample2.frames - sample1.frames;
    const beatDelta = sample2.beats - sample1.beats;
    if (frameDelta <= 0 && beatDelta <= 0)
        fail(`engine stopped ticking: 0 rAF frames and 0 heartbeats in a 3s window after 60s of input (frozen)`);

    const diff = before && after && after !== UNRESPONSIVE ? frameDiff(before, after) : 0;
    pass(
        `survived 60s of mixed input, engine alive (+${frameDelta} frames / +${beatDelta} heartbeats in 3s), ` +
            `0 page errors, 0 engine-fatal console errors (frame diff vs start: ${diff.toFixed(0)}, informational only)`
    );
}

main().catch((e) => fail(`probe crashed: ${String(e).split('\n')[0]}`));
