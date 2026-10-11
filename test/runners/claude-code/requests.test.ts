import { describe, expect, test } from 'bun:test';

import { ClaudeCodeInputRequests } from '../../../src/runners/claude-code/requests.js';
import type { RunnerPermissionRequest } from '../../../src/runners/session.js';

/** The permission request the host receives for one `can_use_tool` control request. */
async function asked(
    request: Record<string, unknown>
): Promise<RunnerPermissionRequest> {
    const seen: RunnerPermissionRequest[] = [];
    const requests = new ClaudeCodeInputRequests(
        {
            requestPermission: async (permission) => {
                seen.push(permission);
                return 'reject';
            },
            requestQuestion: async () => ({ outcome: 'rejected' }),
        },
        async () => {},
        true
    );
    await requests.handle('request', { subtype: 'can_use_tool', ...request });
    const [permission] = seen;
    if (!permission) throw new Error('no permission was requested');
    return permission;
}

async function message(request: Record<string, unknown>): Promise<string> {
    return (await asked(request)).message;
}

describe('Claude Code permission messages', () => {
    test('show the full Bash command, the blocked path, and the reason', async () => {
        expect(
            await message({
                tool_name: 'Bash',
                input: { command: 'rm -rf build && make', description: 'Rebuild' },
                blocked_path: '/workspace/build',
                decision_reason:
                    'Claude requested permissions to edit /workspace/build.',
            })
        ).toBe(
            'Allow Bash for rm -rf build && make? Blocked path: /workspace/build. Reason: Claude requested permissions to edit /workspace/build.'
        );
    });

    test('read like OpenCode when Claude Code gives no reason', async () => {
        expect(await message({ tool_name: 'Bash', input: { command: 'ls' } })).toBe(
            'Allow Bash for ls?'
        );
        expect(
            await message({
                tool_name: 'external_directory',
                input: { path: '/outside/file.txt' },
                blocked_path: '/outside/*',
            })
        ).toBe('Allow external directory for /outside/*?');
        expect(await message({ tool_name: 'Glob', input: {} })).toBe('Allow Glob?');
    });

    test('show the file of a Write but never its content', async () => {
        const text = await message({
            tool_name: 'Write',
            input: {
                file_path: '/workspace/notes.md',
                content: 'API_KEY=sk-secret-write\nsecond',
            },
        });
        expect(text).toBe('Allow Write for /workspace/notes.md?');
        expect(text).not.toContain('Content');
        expect(text).not.toContain('sk-secret-write');
    });

    test('show the file of an Edit with a blocked path elsewhere, but never the text', async () => {
        const text = await message({
            tool_name: 'Edit',
            input: {
                file_path: '/workspace/.env.example',
                old_string: 'A=old-secret',
                new_string: 'A=new-secret',
            },
            blocked_path: '/workspace',
            decision_reason: 'This file is sensitive',
        });
        expect(text).toBe(
            'Allow Edit for /workspace/.env.example? Blocked path: /workspace. Reason: This file is sensitive.'
        );
        expect(text).not.toContain('secret');
    });

    test('never show MCP tool arguments', async () => {
        const text = await message({
            tool_name: 'mcp__github__create_issue',
            input: { title: 'Bug', token: 'ghp_secret', body: 'Line one\nLine two' },
        });
        expect(text).toBe('Allow mcp__github__create_issue?');
        expect(text).not.toContain('Arguments');
        expect(text).not.toContain('ghp_secret');
    });

    test('keep every part on one line and bounded', async () => {
        const terminal = String.fromCharCode(0x1b);
        const override = String.fromCharCode(0x202e);
        const separator = String.fromCharCode(0x2028);
        const command = `echo ${terminal}[31mred${override}txt${separator}done\n${'x'.repeat(2_000)}`;
        const permission = await asked({
            tool_name: 'Bash',
            input: { command },
            decision_reason: `${'why '.repeat(300)}\nnext`,
        });
        const text = permission.message;
        expect(text).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
        expect(text.startsWith('Allow Bash for echo  [31mred txt ↵ done ↵ xxx')).toBe(
            true
        );
        const [head, reason] = text.split(' Reason: ');
        expect(Array.from(head ?? '').length).toBe('Allow Bash for ?'.length + 500);
        expect(head?.endsWith('x…?')).toBe(true);
        expect(Array.from(reason ?? '').length).toBe(500);
        expect(reason?.endsWith('…')).toBe(true);
        // The persisted resource is bounded the same way as the message.
        const [resource] = permission.resources;
        expect(resource).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
        expect(Array.from(resource ?? '').length).toBe(500);
        expect(head).toBe(`Allow Bash for ${resource}?`);
    });

    test('persist only the MCP tool name as its resource', async () => {
        const permission = await asked({
            tool_name: 'mcp__github__create_issue',
            input: {
                path: '/workspace/secret-path',
                url: 'https://example.invalid/?token=ghp_secret',
                command: 'curl ghp_secret',
                file_path: '/workspace/.env',
            },
        });
        expect(permission.resources).toEqual(['mcp__github__create_issue']);
        expect(JSON.stringify(permission)).not.toContain('secret');
        expect(JSON.stringify(permission)).not.toContain('.env');
    });

    test('bound a long file path resource to one line', async () => {
        const file = `/workspace/${'d/'.repeat(400)}a\nb.txt`;
        const permission = await asked({
            tool_name: 'Read',
            input: { file_path: file },
        });
        const [resource] = permission.resources;
        expect(resource).not.toContain('\n');
        expect(Array.from(resource ?? '').length).toBe(500);
    });
});
