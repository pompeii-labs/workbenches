#!/usr/bin/env node
// Finds the newest complete Godot web export anywhere in a repo: a .pck
// with a same-named .wasm and an .html in the same directory. Does not
// assume a fixed path or filename (Godot's default is index.*, but a
// renamed export preset produces a different basename).
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';

const root = process.argv[2] || process.cwd();
const SKIP = new Set(['.git', 'node_modules', '.import', '.godot']);

function walk(dir, out) {
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const e of entries) {
        if (SKIP.has(e.name)) continue;
        const path = join(dir, e.name);
        if (e.isDirectory()) walk(path, out);
        else if (e.isFile() && e.name.endsWith('.pck')) out.push(path);
    }
}

const pcks = [];
walk(root, pcks);

const candidates = [];
for (const pck of pcks) {
    const dir = dirname(pck);
    const stem = basename(pck, '.pck');
    const wasm = join(dir, stem + '.wasm');
    let wasmSize = 0;
    try {
        wasmSize = statSync(wasm).size;
    } catch {
        continue;
    }
    if (wasmSize === 0) continue;
    let pckSize = 0;
    try {
        pckSize = statSync(pck).size;
    } catch {
        continue;
    }
    if (pckSize === 0) continue;

    // Prefer an html in the same dir that references this build's basename;
    // fall back to any html in the same dir.
    let htmlFiles;
    try {
        htmlFiles = readdirSync(dir).filter((f) => extname(f) === '.html');
    } catch {
        continue;
    }
    let html = htmlFiles.find((f) => {
        try {
            return readFileSync(join(dir, f), 'utf8').includes(stem);
        } catch {
            return false;
        }
    });
    if (!html) html = htmlFiles[0];
    if (!html) continue;
    const htmlSize = statSync(join(dir, html)).size;
    if (htmlSize === 0) continue;

    candidates.push({
        dir,
        html,
        mtime: statSync(pck).mtimeMs,
    });
}

if (candidates.length === 0) {
    console.error('no complete web export found (need a .html + .wasm + .pck together)');
    process.exit(1);
}

candidates.sort((a, b) => b.mtime - a.mtime);
const best = candidates[0];
process.stdout.write(`${best.dir}\t${best.html}\n`);
