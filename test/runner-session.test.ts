import { describe, expect, test } from 'bun:test';

import {
    type RunnerSessionAdapter,
    RunnerSessionRegistry,
} from '../src/runner-session.js';

describe('interactive runner registry', () => {
    test('resolves adapters by the manifest runner name', () => {
        const adapter = fakeAdapter('opencode');
        const registry = new RunnerSessionRegistry([adapter]);

        expect(registry.resolve('opencode')).toBe(adapter);
    });

    test('rejects missing, empty, and duplicate adapter names', () => {
        expect(() => new RunnerSessionRegistry([]).resolve('codex')).toThrow(
            'Interactive sessions are unavailable for runner: codex'
        );
        expect(() => new RunnerSessionRegistry([fakeAdapter(' ')])).toThrow(
            'Runner adapter name must not be empty'
        );
        expect(
            () =>
                new RunnerSessionRegistry([
                    fakeAdapter('opencode'),
                    fakeAdapter('opencode'),
                ])
        ).toThrow('Duplicate interactive runner adapter: opencode');
    });
});

function fakeAdapter(runner: string): RunnerSessionAdapter {
    return {
        runner,
        async start() {
            return {
                id: undefined,
                async prompt() {
                    return {};
                },
                async cancelTurn() {},
                async close() {},
            };
        },
    };
}
