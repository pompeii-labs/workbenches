import { describe, expect, test } from 'bun:test';

import {
    type ConnectStart,
    parseServerMessage,
    type ServerMessage,
} from '../../src/workers/protocol.js';

const start = {
    type: 'run.start',
    run_id: 'run_1',
    session_id: 'ses_1',
    started_by: { member_id: 'mem_1' },
    runtime: 'docker',
    workbench: { version_id: 'wv_1', download_url: 'https://example.test/package' },
    image_pull: {
        registry: 'images.example.test',
        username: 'workbench',
        password: 'MUST_NOT_RENDER_CREDENTIAL',
        expires_at: '2030-01-01T00:00:00Z',
    },
    task: 'Build a pirate game',
    max_minutes: 30,
    workspace: {
        repository: 'acme/game',
        ref: 'main',
        branch: 'wb/run_1',
        credential: 'placeholder-credential',
        url: 'https://api.example.test/acme/game.git',
    },
    env: { OPENROUTER_API_KEY: 'placeholder-key' },
    connection: 'openrouter',
    run_token: 'placeholder-run-token',
};

describe('worker protocol', () => {
    test('parses every server message', () => {
        expect(
            parseServerMessage(
                JSON.stringify({
                    type: 'welcome',
                    worker: { id: 'wrk_1', slug: 'mini' },
                    organization: 'acme',
                    stored: [{ run_id: 'run_1', sequence: 4 }],
                })
            )
        ).toEqual({
            type: 'welcome',
            worker: { id: 'wrk_1', slug: 'mini' },
            organization: 'acme',
            stored: [{ run_id: 'run_1', sequence: 4 }],
        });
        expect(parseServerMessage(JSON.stringify(start))).toEqual({
            ...start,
            type: 'run.start',
        });
        expect(
            parseServerMessage(
                JSON.stringify({
                    type: 'command',
                    command_id: 'cmd_1',
                    run_id: 'run_1',
                    kind: 'steer',
                    payload: { text: 'Use TypeScript' },
                })
            )
        ).toEqual({
            type: 'command',
            command_id: 'cmd_1',
            run_id: 'run_1',
            kind: 'steer',
            payload: { text: 'Use TypeScript' },
        });
        expect(
            parseServerMessage(
                JSON.stringify({ type: 'stored', run_id: 'run_1', sequence: 9 })
            )
        ).toEqual({ type: 'stored', run_id: 'run_1', sequence: 9 });
    });

    test('parses a run.start without a member, image pull, workspace, or connection', () => {
        const parsed = parseServerMessage(
            JSON.stringify({
                ...start,
                started_by: { member_id: null },
                image_pull: null,
                workspace: null,
                connection: null,
            })
        );
        expect(parsed).toMatchObject({
            started_by: { member_id: null },
            image_pull: null,
            workspace: null,
            connection: null,
        });
    });

    test('refuses a run.start missing a field the server always sends', () => {
        for (const field of ['started_by', 'env', 'max_minutes'])
            expect(() =>
                parseServerMessage(JSON.stringify({ ...start, [field]: undefined }))
            ).toThrow(`run.start.${field}`);
    });

    test('parses a public repository without a credential or a branch', () => {
        const parsed = parseServerMessage(
            JSON.stringify({
                ...start,
                workspace: {
                    repository: 'acme/game',
                    url: 'https://github.com/acme/game.git',
                    ref: 'abc123',
                    branch: null,
                    credential: null,
                },
            })
        );
        expect(parsed).toMatchObject({
            workspace: {
                repository: 'acme/game',
                url: 'https://github.com/acme/game.git',
                ref: 'abc123',
                branch: null,
                credential: null,
            },
        });
    });

    test('refuses a workspace address with a credential or without a ref', () => {
        const workspace = start.workspace;
        expect(() =>
            parseServerMessage(
                JSON.stringify({
                    ...start,
                    workspace: {
                        ...workspace,
                        url: 'https://workbenches:MUST_NOT_RENDER@github.com/acme/game.git',
                    },
                })
            )
        ).toThrow('run.start.workspace.url');
        expect(() =>
            parseServerMessage(
                JSON.stringify({
                    ...start,
                    workspace: { ...workspace, ref: undefined },
                })
            )
        ).toThrow('run.start.workspace.ref');
    });

    test('parses the sign-in relay messages', () => {
        const connect: ConnectStart = {
            type: 'connect.start',
            connect_id: 'con_1',
            member_id: 'mem_1',
            member_name: 'matty',
            runner: 'opencode',
            provider: 'openai',
            method: 'chatgpt',
        };
        expect(parseServerMessage(JSON.stringify(connect))).toEqual(connect);
        expect(() =>
            parseServerMessage(JSON.stringify({ ...connect, provider: null }))
        ).toThrow('connect.start.provider');
        expect(() =>
            parseServerMessage(JSON.stringify({ ...connect, method: 7 }))
        ).toThrow('connect.start.method');
        const relayed: ServerMessage[] = [
            { type: 'connect.attach', connect_id: 'con_1', cols: 120, rows: 40 },
            { type: 'connect.input', connect_id: 'con_1', data: 'DQ==' },
            { type: 'connect.resize', connect_id: 'con_1', cols: 80, rows: 24 },
            { type: 'connect.secret', connect_id: 'con_1', text: 'sk-key' },
            { type: 'connect.cancel', connect_id: 'con_1' },
        ];
        for (const message of relayed)
            expect(parseServerMessage(JSON.stringify(message))).toEqual(message);
        expect(() =>
            parseServerMessage(JSON.stringify({ ...connect, member_id: undefined }))
        ).toThrow('connect.start.member_id');
        expect(() =>
            parseServerMessage(
                JSON.stringify({ type: 'connect.input', connect_id: 'c' })
            )
        ).toThrow('connect.input.data');
        expect(() =>
            parseServerMessage(
                JSON.stringify({
                    type: 'connect.attach',
                    connect_id: 'c',
                    cols: 0,
                    rows: 24,
                })
            )
        ).toThrow('connect.attach.cols');
        expect(() =>
            parseServerMessage(
                JSON.stringify({ type: 'connect.secret', connect_id: 'c', text: '' })
            )
        ).toThrow('connect.secret.text');
    });

    test('ignores unknown types and refuses malformed known ones', () => {
        expect(
            parseServerMessage(JSON.stringify({ type: 'future.message' }))
        ).toBeUndefined();
        expect(() => parseServerMessage('not json')).toThrow('not JSON');
        expect(() =>
            parseServerMessage(JSON.stringify({ ...start, run_token: undefined }))
        ).toThrow('run.start.run_token');
        expect(() =>
            parseServerMessage(JSON.stringify({ ...start, env: { 'BAD NAME': 'x' } }))
        ).toThrow('run.start.env');
        expect(() =>
            parseServerMessage(
                JSON.stringify({
                    type: 'command',
                    command_id: 'cmd_1',
                    run_id: 'run_1',
                    kind: 'delete',
                })
            )
        ).toThrow('command.kind');
    });
});
