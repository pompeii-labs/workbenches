import { describe, expect, test } from 'bun:test';
import { RunnerRegistry } from '../src/runners/registry.js';
import { type PreparedRunner, Runner } from '../src/runners/runner.js';
import {
    normalizeRunnerInput,
    RUNNER_CAPABILITIES,
    type RunnerAdapterDeclaration,
    type RunnerSessionAdapter,
} from '../src/runners/session.js';
import type { ResolvedWorkbench } from '../src/types.js';
import { supportedRunnerDeclaration } from './runner-adapter-contract.js';

describe('interactive runner registry', () => {
    test('normalizes text and image input without imposing a payload size limit', () => {
        expect(
            normalizeRunnerInput({
                text: '  inspect  ',
                images: [
                    {
                        data: '  aW1hZ2U=  ',
                        mimeType: ' IMAGE/PNG ',
                        name: ' screen.png ',
                    },
                ],
            })
        ).toEqual({
            text: 'inspect',
            images: [
                {
                    data: 'aW1hZ2U=',
                    mimeType: 'image/png',
                    name: 'screen.png',
                },
            ],
        });
        expect(() => normalizeRunnerInput('   ')).toThrow('input must not be empty');
        expect(() =>
            normalizeRunnerInput({
                text: 'inspect',
                images: [{ data: 'value', mimeType: 'text/plain' }],
            })
        ).toThrow('image 1 must use an image MIME type');
    });

    test('resolves adapters by the manifest runner name', () => {
        const adapter = fakeAdapter('opencode');
        const registry = new RunnerRegistry([new FakeRunner('opencode', adapter)]);

        expect(registry.session('opencode')).toBe(adapter);
    });

    test('rejects missing, empty, and duplicate adapter names', () => {
        expect(() => new RunnerRegistry([]).session('codex')).toThrow(
            'Unsupported runner: codex'
        );
        expect(
            () => new RunnerRegistry([new FakeRunner(' ', fakeAdapter(' '))])
        ).toThrow('Runner name must not be empty');
        expect(
            () =>
                new RunnerRegistry([
                    new FakeRunner('opencode', fakeAdapter('opencode')),
                    new FakeRunner('opencode', fakeAdapter('opencode')),
                ])
        ).toThrow('Duplicate runner: opencode');
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
            new RunnerRegistry([
                new FakeRunner('fixture', fakeAdapter('fixture', declaration)),
            ]).session('fixture').declaration
        ).toBe(declaration);
    });

    test('rejects incomplete declarations and unexplained limitations', () => {
        const missing = supportedRunnerDeclaration();
        delete (missing.capabilities as Partial<typeof missing.capabilities>).usage;
        expect(
            () =>
                new RunnerRegistry([
                    new FakeRunner('missing', fakeAdapter('missing', missing)),
                ])
        ).toThrow('Runner adapter capability is not declared: missing.usage');

        const unexplained = supportedRunnerDeclaration();
        unexplained.capabilities.permissions = { status: 'degraded' };
        expect(
            () =>
                new RunnerRegistry([
                    new FakeRunner('degraded', fakeAdapter('degraded', unexplained)),
                ])
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

class FakeRunner extends Runner {
    readonly name: string;
    readonly session: RunnerSessionAdapter;

    constructor(name: string, session: RunnerSessionAdapter) {
        super();
        this.name = name;
        this.session = session;
    }

    async prepare(_workbench: ResolvedWorkbench): Promise<PreparedRunner> {
        throw new Error('not used');
    }
}
