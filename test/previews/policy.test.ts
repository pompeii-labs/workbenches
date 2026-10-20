import { describe, expect, test } from 'bun:test';

import { PreviewPolicy } from '../../src/previews/policy.js';

const none = new Map<string, number>();

function decide(line: unknown, current = none, reserved: number[] = []) {
    return new PreviewPolicy(() => reserved).decide(
        typeof line === 'string' ? line : JSON.stringify(line),
        current
    );
}

describe('preview policy', () => {
    test('accepts a slug name and an unprivileged port', () => {
        expect(decide({ name: 'demo', port: 5173 })).toEqual({
            accepted: true,
            preview: { name: 'demo', port: 5173 },
        });
        expect(decide({ name: '0-a', port: 1024 })).toMatchObject({ accepted: true });
        expect(decide({ name: 'a'.repeat(40), port: 65_535 })).toMatchObject({
            accepted: true,
        });
    });

    test('rejects names outside the slug pattern without repeating them', () => {
        for (const name of [
            '',
            '-demo',
            'Demo',
            'demo_app',
            'demo app',
            'a'.repeat(41),
            'démo',
            7,
            null,
        ]) {
            const decision = decide({ name, port: 5173 });
            expect(decision.accepted).toBeFalse();
            if (!decision.accepted && typeof name === 'string' && name)
                expect(decision.reason).not.toContain(name);
        }
        expect(decide({ port: 5173 }).accepted).toBeFalse();
    });

    test('rejects ports that are not unprivileged integers', () => {
        for (const port of [0, 80, 1023, 65_536, 5173.5, '5173', -1, null]) {
            expect(decide({ name: 'demo', port })).toEqual({
                accepted: false,
                reason: 'the port of demo must be an integer from 1024 to 65535',
            });
        }
    });

    test('rejects a port the engine reserves, read at decision time', () => {
        const reserved: number[] = [];
        const policy = new PreviewPolicy(() => reserved);
        const line = JSON.stringify({ name: 'demo', port: 4096 });
        expect(policy.decide(line, none).accepted).toBeTrue();
        reserved.push(4096);
        expect(policy.decide(line, none)).toEqual({
            accepted: false,
            reason: 'port 4096 of demo is reserved by the engine',
        });
    });

    test('caps a run at eight previews but lets a shown name be replaced', () => {
        const current = new Map(
            Array.from({ length: 8 }, (_, index) => [`app-${index}`, 2000 + index])
        );
        expect(decide({ name: 'app-8', port: 3000 }, current)).toEqual({
            accepted: false,
            reason: 'app-8 exceeds the limit of 8 previews per run',
        });
        expect(decide({ name: 'app-3', port: 3000 }, current)).toMatchObject({
            accepted: true,
        });
    });

    test('rejects lines that are not a JSON object or are too long', () => {
        for (const line of ['not json', '[]', 'null', '"demo"', '{"name":']) {
            expect(decide(line)).toEqual({
                accepted: false,
                reason: 'the announcement is not a JSON object',
            });
        }
        expect(decide({ name: 'demo', port: 5173, padding: 'x'.repeat(600) })).toEqual({
            accepted: false,
            reason: 'the announcement is too long',
        });
    });
});
