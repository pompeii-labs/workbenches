// A "utility library" the landing page imports wholesale for one function
// (formatPrice). No downloads: generated once and cached, like the hero
// image, so the bytes served are stable.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const CACHE_PATH = `${import.meta.dir}/../.generated/vendor.js`;

function build(): string {
    const filler: string[] = [];
    for (let i = 0; i < 400; i++) {
        filler.push(
            `function util${i}(a, b) { return (a || 0) * ${i + 1} + (b || 0) / ${i + 1 + 0.5}; }`
        );
    }
    const lib = `
// bigutils.js - grab-bag helper library (vendored)
window.bigutils = {};
${filler.join('\n')}
window.bigutils.formatPrice = function (cents) {
    return '$' + (cents / 100).toFixed(2);
};
${filler.map((_, i) => `window.bigutils.util${i} = util${i};`).join('\n')}

// Runs synchronously while the head is still parsing (render-blocking).
(function busyWork() {
    var until = Date.now() + 350;
    var x = 0;
    while (Date.now() < until) { x += Math.sqrt(x + 1); }
})();
`;
    return lib;
}

export function vendorJsPath(): string {
    if (!existsSync(CACHE_PATH)) {
        mkdirSync(dirname(CACHE_PATH), { recursive: true });
        writeFileSync(CACHE_PATH, build());
    }
    return CACHE_PATH;
}

export function vendorJsBytes(): Buffer {
    vendorJsPath();
    return readFileSync(CACHE_PATH);
}
