// Compares two PNG screenshots (same fixed viewport) perceptually and
// prints the fraction of downsampled-and-blurred pixels that differ beyond
// a per-channel tolerance.
//
// Raw per-pixel diffing punishes things that don't matter for "does this
// still look like the same page": hero images that are re-encoded, resized,
// or regenerated without per-pixel noise grain, and ordinary recompression
// artifacts. Those move individual pixels a lot while leaving the overall
// picture (layout, composition, colors) unchanged.
//
// To make the comparison perceptual instead of literal:
//   1. Downscale both screenshots by box-averaging BLOCK x BLOCK pixel
//      blocks down to roughly 1/8 linear size. This averages out grain,
//      dithering, and compression noise inside a small area while leaving
//      large-scale structure (missing hero, restyled colors, broken layout)
//      intact.
//   2. Apply a small 3x3 box blur on top of the downscaled image, so edges
//      introduced by the downscale itself (or by minor sub-pixel shifts in
//      where content lands) don't get treated as differences.
//   3. Diff the two blurred, downscaled images per-pixel with the same
//      per-channel tolerance as before.
//
// Usage: bun run compare-screens.ts <a.png> <b.png>
// Prints a single number: the fraction (0..1) of differing pixels.
import { PNG } from 'pngjs';
import { readFileSync } from 'node:fs';

const [, , pathA, pathB] = process.argv;
if (!pathA || !pathB) {
    console.error('usage: compare-screens.ts <a.png> <b.png>');
    process.exit(2);
}

const CHANNEL_TOLERANCE = 40; // per-channel (0-255) difference before a pixel counts as "different"
const DOWNSCALE_BLOCK = 8; // box-average this many source pixels per side into one output pixel

type RGB = { data: Uint8Array | Buffer; width: number; height: number };

// Box-average `src` down by `block` on each side (RGB only, alpha ignored).
function downscale(src: RGB, block: number): RGB {
    const outW = Math.max(1, Math.floor(src.width / block));
    const outH = Math.max(1, Math.floor(src.height / block));
    const out = new Float64Array(outW * outH * 3);
    const counts = new Uint32Array(outW * outH);

    for (let y = 0; y < outH * block && y < src.height; y++) {
        const oy = Math.min(outH - 1, Math.floor(y / block));
        for (let x = 0; x < outW * block && x < src.width; x++) {
            const ox = Math.min(outW - 1, Math.floor(x / block));
            const si = (y * src.width + x) * 4;
            const oi = (oy * outW + ox) * 3;
            out[oi] += src.data[si]!;
            out[oi + 1] += src.data[si + 1]!;
            out[oi + 2] += src.data[si + 2]!;
            counts[oy * outW + ox]++;
        }
    }

    const data = new Uint8ClampedArray(outW * outH * 3);
    for (let i = 0; i < outW * outH; i++) {
        const c = counts[i] || 1;
        data[i * 3] = out[i * 3]! / c;
        data[i * 3 + 1] = out[i * 3 + 1]! / c;
        data[i * 3 + 2] = out[i * 3 + 2]! / c;
    }
    return { data, width: outW, height: outH };
}

// Small 3x3 box blur (RGB, edge-clamped).
function blur3x3(src: RGB): RGB {
    const { width, height, data } = src;
    const out = new Uint8ClampedArray(width * height * 3);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let r = 0, g = 0, b = 0, n = 0;
            for (let dy = -1; dy <= 1; dy++) {
                const yy = Math.min(height - 1, Math.max(0, y + dy));
                for (let dx = -1; dx <= 1; dx++) {
                    const xx = Math.min(width - 1, Math.max(0, x + dx));
                    const i = (yy * width + xx) * 3;
                    r += data[i]!;
                    g += data[i + 1]!;
                    b += data[i + 2]!;
                    n++;
                }
            }
            const oi = (y * width + x) * 3;
            out[oi] = r / n;
            out[oi + 1] = g / n;
            out[oi + 2] = b / n;
        }
    }
    return { data: out, width, height };
}

const rawA = PNG.sync.read(readFileSync(pathA));
const rawB = PNG.sync.read(readFileSync(pathB));

if (rawA.width !== rawB.width || rawA.height !== rawB.height) {
    console.error(`size mismatch: ${rawA.width}x${rawA.height} vs ${rawB.width}x${rawB.height}`);
    console.log('1'); // maximally different
    process.exit(0);
}

const a = blur3x3(downscale(rawA, DOWNSCALE_BLOCK));
const b = blur3x3(downscale(rawB, DOWNSCALE_BLOCK));

let diffPixels = 0;
const total = a.width * a.height;
for (let i = 0; i < total; i++) {
    const o = i * 3;
    const dr = Math.abs(a.data[o]! - b.data[o]!);
    const dg = Math.abs(a.data[o + 1]! - b.data[o + 1]!);
    const db = Math.abs(a.data[o + 2]! - b.data[o + 2]!);
    if (dr > CHANNEL_TOLERANCE || dg > CHANNEL_TOLERANCE || db > CHANNEL_TOLERANCE) {
        diffPixels++;
    }
}

console.log((diffPixels / total).toFixed(4));
