import { describe, expect, test } from 'bun:test';

import {
    RUNNER_CAPABILITIES,
    type RunnerAdapterDeclaration,
    type RunnerSessionAdapter,
    RunnerSessionRegistry,
} from '../src/runner-session.js';
import { supportedRunnerDeclaration } from './runner-adapter-contract.js';

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

    test('accepts explicit degraded and unsupported capability outcomes', () => {
        const declaration = supportedRunnerDeclaration();
        declaration.capabilities.permissions = {
            status: 'degraded',
            detail: 'The native runner can only approve a whole turn.',
        };
        declaration.capabilities.file_events = {
            status: 'unsupported',
            detail: 'The native event stream has no file-change signal.',
        };

        expect(
            new RunnerSessionRegistry([fakeAdapter('fixture', declaration)]).resolve(
                'fixture'
            ).declaration
        ).toBe(declaration);
    });

    test('rejects incomplete declarations and unexplained limitations', () => {
        const missing = supportedRunnerDeclaration();
        delete (missing.capabilities as Partial<typeof missing.capabilities>).usage;
        expect(
            () => new RunnerSessionRegistry([fakeAdapter('missing', missing)])
        ).toThrow('Runner adapter capability is not declared: missing.usage');

        const unexplained = supportedRunnerDeclaration();
        unexplained.capabilities.permissions = { status: 'degraded' };
        expect(
            () => new RunnerSessionRegistry([fakeAdapter('degraded', unexplained)])
        ).toThrow(
            'Runner adapter degraded capability requires detail: degraded.permissions'
        );

        expect(Object.keys(supportedRunnerDeclaration().capabilities).sort()).toEqual(
            [...RUNNER_CAPABILITIES].sort()
        );
    });
});

function fakeAdapter(
    runner: string,
    declaration: RunnerAdapterDeclaration = supportedRunnerDeclaration()
): RunnerSessionAdapter {
    return {
        runner,
        declaration,
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
