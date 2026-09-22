// Procedurally generates the landing page's hero image: a plain PNG encoder
// (no image library) writing noisy pixel data. Sized and compressed for the
// web (a few hundred KB, not multi-megabyte): smaller pixel dimensions,
// noise sampled per 4-pixel block instead of per pixel so it stays
// deflate-friendly, and a high deflate level. No downloads, no external
// assets. Generated once and cached on disk so the bytes are stable across
// requests (and across a submission's own re-runs).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(buf: Buffer): number {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
        c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
    const typeBuf = Buffer.from(type, 'ascii');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const crcInput = Buffer.concat([typeBuf, data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(crcInput), 0);
    return Buffer.concat([len, typeBuf, data, crc]);
}

// Small xorshift PRNG so the image is byte-identical across generations.
function makeRng(seed: number) {
    let state = seed >>> 0 || 1;
    return () => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        state >>>= 0;
        return state;
    };
}

export const HERO_WIDTH = 640;
export const HERO_HEIGHT = 427;

export function generatePng(width: number, height: number, seed = 1): Buffer {
    const rng = makeRng(seed);
    const bytesPerPixel = 3;
    const stride = width * bytesPerPixel;
    const raw = Buffer.alloc((stride + 1) * height);
    const BLOCK = 4;
    for (let y = 0; y < height; y++) {
        const rowStart = y * (stride + 1);
        raw[rowStart] = 0; // no filter
        let r = 0;
        for (let x = 0; x < width; x++) {
            if (x % BLOCK === 0) r = rng();
            const offset = rowStart + 1 + x * bytesPerPixel;
            // Noisy but with a warm gradient bias so it looks like a photo,
            // sampled per block so deflate can actually shrink it.
            raw[offset] = (180 + (r & 0x1f) - (y / height) * 60) & 0xff;
            raw[offset + 1] = (120 + ((r >> 8) & 0x1f)) & 0xff;
            raw[offset + 2] = (90 + ((r >> 16) & 0x1f) + (x / width) * 40) & 0xff;
        }
    }

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // color type: RGB
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;

    const idat = deflateSync(raw, { level: 9 });

    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    return Buffer.concat([
        signature,
        chunk('IHDR', ihdr),
        chunk('IDAT', idat),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

const CACHE_PATH = `${import.meta.dir}/../.generated/hero.png`;

export function heroImagePath(): string {
    if (!existsSync(CACHE_PATH)) {
        mkdirSync(dirname(CACHE_PATH), { recursive: true });
        writeFileSync(CACHE_PATH, generatePng(HERO_WIDTH, HERO_HEIGHT, 42));
    }
    return CACHE_PATH;
}

export function heroImageBytes(): Buffer {
    heroImagePath();
    return readFileSync(CACHE_PATH);
}
