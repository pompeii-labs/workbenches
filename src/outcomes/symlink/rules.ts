import { posix } from 'node:path';
import type { OutcomeChangeEntry } from '../contracts.js';

/** Resolve components before '..': a relative link can change the effective depth. */
export function validateOutcomeSymlinks(entries: OutcomeChangeEntry[]): void {
    for (const side of ['before', 'after'] as const) {
        const links = new Map<string, string>();
        for (const entry of entries) {
            const state = entry[side];
            if (state?.kind === 'symlink') links.set(entry.path, state.target);
        }
        for (const [path, target] of links) {
            const walker = components(path, target);
            let step = walker.next();
            while (!step.done) step = walker.next(links.get(step.value));
        }
    }
}

/**
 * Walks the path components a link target resolves through, yielding each one so
 * the caller can say whether it is itself a link. Throws for a link that
 * escapes the tree or loops.
 */
export function* components(
    path: string,
    target: string
): Generator<string, void, string | undefined> {
    const stack: string[] = [];
    const pending = [
        ...posix.dirname(path).split('/'),
        ...relativeTarget(target, path),
    ];
    let followed = 0;
    while (pending.length) {
        const segment = pending.shift();
        if (!segment || segment === '.') continue;
        if (segment === '..') {
            if (!stack.length)
                throw new Error(`Escaping symlink is not allowed in outcome: ${path}`);
            stack.pop();
            continue;
        }
        stack.push(segment);
        const link = yield stack.join('/');
        if (link !== undefined) {
            if (++followed > 40)
                throw new Error(`Cyclic symlink is not allowed in outcome: ${path}`);
            stack.pop();
            pending.unshift(...relativeTarget(link, path));
        }
    }
}

function relativeTarget(target: string, path: string): string[] {
    if (target.startsWith('/') || target.includes('\\') || /^[a-z]:/i.test(target))
        throw new Error(`Escaping symlink is not allowed in outcome: ${path}`);
    return target.split('/');
}
