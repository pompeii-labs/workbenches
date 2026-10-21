import { describe, expect, test } from 'bun:test';

import { AnnouncementLog } from '../../src/previews/log.js';
import { PreviewPolicy } from '../../src/previews/policy.js';

function fixture(listening = new Set([5173, 8080])) {
    const warnings: string[] = [];
    const log = new AnnouncementLog(
        new PreviewPolicy(() => [4096]),
        { listening: async (port) => listening.has(port) },
        (message) => warnings.push(message)
    );
    return { log, warnings };
}

const bytes = (text: string) => new TextEncoder().encode(text);
const line = (name: string, port: number) => `${JSON.stringify({ name, port })}\n`;

describe('announcement log', () => {
    test('applies bytes by file offset, so a replay from the start repeats nothing', async () => {
        const { log } = fixture();
        const first = line('demo', 5173);
        const file = first + line('demo', 8080);
        expect(await log.offer(bytes(first), 0)).toEqual([
            { name: 'demo', port: 5173 },
        ]);
        expect(log.offset).toBe(first.length);
        // A source that replays the whole file only contributes what is new.
        expect(await log.offer(bytes(file), 0)).toEqual([{ name: 'demo', port: 8080 }]);
        expect(await log.offer(bytes(file), 0)).toEqual([]);
        expect(log.offset).toBe(file.length);
    });

    test('joins a line split across sources and overlapping chunks', async () => {
        const { log } = fixture();
        const file = line('demo', 5173);
        expect(await log.offer(bytes(file.slice(0, 7)), 0)).toEqual([]);
        expect(await log.offer(bytes(file.slice(3, 12)), 3)).toEqual([]);
        expect(await log.offer(bytes(file.slice(12)), 12)).toEqual([
            { name: 'demo', port: 5173 },
        ]);
    });

    test('leaves bytes it cannot place for a later read from the start', async () => {
        const { log } = fixture();
        const file = line('demo', 5173) + line('game', 8080);
        const second = line('demo', 5173).length;
        expect(await log.offer(bytes(file.slice(second)), second)).toEqual([]);
        expect(log.offset).toBe(0);
        expect(await log.offer(bytes(file), 0)).toEqual([
            { name: 'demo', port: 5173 },
            { name: 'game', port: 8080 },
        ]);
    });

    test('knows which ports the run shows and rejects reserved or closed ones', async () => {
        const { log, warnings } = fixture();
        expect(log.empty).toBeTrue();
        await log.offer(
            bytes(line('runner', 4096) + line('closed', 9000) + line('demo', 5173)),
            0
        );
        expect(log.empty).toBeFalse();
        expect(log.shows(5173)).toBeTrue();
        expect(log.shows(4096)).toBeFalse();
        expect(log.shows(9000)).toBeFalse();
        expect(warnings).toEqual([
            'Ignored a preview announcement: port 4096 of runner is reserved by the engine',
            'Ignored preview closed: nothing is listening on port 9000',
        ]);
    });
});
