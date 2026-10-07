import { describe, expect, test } from 'bun:test';

import { ClaudeCodeInputRequests } from '../src/runners/claude-code/requests.js';
import type { RunnerPermissionRequest } from '../src/runners/session.js';
import { claudeProtocolFixture } from './runners/claude-code/fixture.js';

describe('Claude Code input requests', () => {
    test('keeps allow-always exact and in memory without applying native suggestions', async () => {
        const requests: RunnerPermissionRequest[] = [];
        const writes: Record<string, unknown>[] = [];
        const handler = new ClaudeCodeInputRequests(
            {
                requestPermission: async (request) => {
                    requests.push(request);
                    return 'allow_always';
                },
                requestQuestion: async () => ({ outcome: 'rejected' }),
            },
            async (value) => {
                writes.push(value);
            }
        );
        const first = claudeProtocolFixture('permission-request.json');
        const second = structuredClone(first);
        second.request_id = 'permission_contract_2';

        expect(handler.handle(first)).toBeTrue();
        await eventually(() => expect(writes).toHaveLength(1));
        expect(handler.handle(second)).toBeTrue();
        await eventually(() => expect(writes).toHaveLength(2));

        expect(requests).toHaveLength(1);
        expect(writes).toEqual([
            claudeProtocolFixture('permission-always-response.json'),
            claudeProtocolFixture('permission-cached-response.json'),
        ]);
        expect(JSON.stringify(writes)).not.toContain('updatedPermissions');
        await handler.close(false);
    });

    test('suppresses allow-always for native safety and interaction flags', async () => {
        for (const flag of [
            'suppress_always_allow_rule',
            'requires_user_interaction',
        ] as const) {
            const observed: RunnerPermissionRequest[] = [];
            const request = claudeProtocolFixture('permission-request.json');
            const native = record(request.request);
            if (!native) {
                throw new Error('invalid permission fixture');
            }
            native[flag] = true;
            request.request = native;
            const handler = new ClaudeCodeInputRequests(
                {
                    requestPermission: async (value) => {
                        observed.push(value);
                        return 'allow_once';
                    },
                    requestQuestion: async () => ({ outcome: 'rejected' }),
                },
                async () => {}
            );

            handler.handle(request);
            await eventually(() => expect(observed).toHaveLength(1));
            expect(observed[0]?.allowAlways).toBeFalse();
            await handler.close(false);
        }
    });

    test('shows bounded tool input, decision reason, and blocked path', async () => {
        const observed: RunnerPermissionRequest[] = [];
        const request = claudeProtocolFixture('permission-edit-request.json');
        const native = record(request.request);
        if (!native) {
            throw new Error('invalid permission fixture');
        }
        const input = record(native.input);
        if (!input) {
            throw new Error('invalid permission input fixture');
        }
        input.new_string = `replacement ${'x'.repeat(2_000)}`;
        input.environment = { API_TOKEN: 'MUST_NOT_RENDER_CREDENTIAL' };
        native.input = input;
        request.request = native;
        const handler = new ClaudeCodeInputRequests(
            {
                requestPermission: async (value) => {
                    observed.push(value);
                    return 'reject';
                },
                requestQuestion: async () => ({ outcome: 'rejected' }),
            },
            async () => {}
        );

        handler.handle(request);
        await eventually(() => expect(observed).toHaveLength(1));

        const message = observed[0]?.message ?? '';
        expect(message).toContain('Path: /outside/example.ts');
        expect(message).toContain('Old text: const oldValue = true;');
        expect(message).toContain('New text: replacement');
        expect(message).toContain(
            'Decision reason: The path is outside the working directory'
        );
        expect(message).toContain('Blocked path: /outside/example.ts');
        expect(message.length).toBeLessThanOrEqual(1_024);
        expect(message).not.toContain('MUST_NOT_RENDER_CREDENTIAL');
        await handler.close(false);
    });

    test('answers requests without requiring an active model turn', async () => {
        const writes: Record<string, unknown>[] = [];
        const handler = new ClaudeCodeInputRequests(
            {
                requestPermission: async () => 'allow_once',
                requestQuestion: async () => ({ outcome: 'rejected' }),
            },
            async (value) => {
                writes.push(value);
            }
        );

        handler.handle(claudeProtocolFixture('permission-request.json'));
        await eventually(() => expect(writes).toHaveLength(1));
        expect(writes[0]).toEqual(
            claudeProtocolFixture('permission-allow-response.json')
        );
        await handler.close(false);
    });

    test('withdraws a cancelled native request without writing a response', async () => {
        const permission = deferred<'allow_once'>();
        const withdrawn: string[] = [];
        const writes: Record<string, unknown>[] = [];
        const handler = new ClaudeCodeInputRequests(
            {
                requestPermission: () => permission.promise,
                requestQuestion: async () => ({ outcome: 'rejected' }),
                withdrawPermission: (id) => withdrawn.push(id),
            },
            async (value) => {
                writes.push(value);
            }
        );

        handler.handle(claudeProtocolFixture('permission-request.json'));
        expect(handler.cancel('permission_contract_1')).toBeTrue();
        permission.resolve('allow_once');
        await Bun.sleep(0);

        expect(withdrawn).toEqual(['permission_contract_1']);
        expect(writes).toEqual([]);
        await handler.close(false);
    });

    test('denies immediately when native requests cannot be answered', async () => {
        let hostCalls = 0;
        const writes: Record<string, unknown>[] = [];
        const handler = new ClaudeCodeInputRequests(
            {
                requestPermission: async () => {
                    hostCalls += 1;
                    return 'allow_once';
                },
                requestQuestion: async () => ({ outcome: 'rejected' }),
            },
            async (value) => {
                writes.push(value);
            },
            async () => {},
            false
        );

        handler.handle(claudeProtocolFixture('permission-request.json'));
        await eventually(() => expect(writes).toHaveLength(1));
        expect(hostCalls).toBe(0);
        expect(record(record(writes[0]?.response)?.response)?.behavior).toBe('deny');
        await handler.close(false);
    });

    test('settles every pending denial when one native write rejects', async () => {
        const first = deferred<'reject'>();
        const second = deferred<'reject'>();
        let requestCount = 0;
        let writeCount = 0;
        const handler = new ClaudeCodeInputRequests(
            {
                requestPermission: () => {
                    requestCount += 1;
                    return requestCount === 1 ? first.promise : second.promise;
                },
                requestQuestion: async () => ({ outcome: 'rejected' }),
            },
            async () => {
                writeCount += 1;
                if (writeCount === 1) throw new Error('stdin closed');
            }
        );
        const secondRequest = claudeProtocolFixture('permission-request.json');
        secondRequest.request_id = 'permission_contract_2';
        handler.handle(claudeProtocolFixture('permission-request.json'));
        handler.handle(secondRequest);

        await expect(handler.close(true)).resolves.toBeUndefined();
        expect(writeCount).toBe(2);
        first.resolve('reject');
        second.resolve('reject');
    });
});

function record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value))
        : undefined;
}

function deferred<T>() {
    let resolve = (_value: T) => {};
    const promise = new Promise<T>((accepted) => {
        resolve = accepted;
    });
    return { promise, resolve };
}

async function eventually(assertion: () => void): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
            assertion();
            return;
        } catch {
            await Bun.sleep(0);
        }
    }
    assertion();
}
