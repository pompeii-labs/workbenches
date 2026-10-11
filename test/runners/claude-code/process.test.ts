import { describe, expect, test } from 'bun:test';

import {
    type ClaudeCodeChild,
    ClaudeCodeProcess,
} from '../../../src/runners/claude-code/process.js';

function shell(script: string, stopTimeoutMs = 2_000): ClaudeCodeProcess {
    return new ClaudeCodeProcess(
        {
            command: ['/bin/sh', '-c', script],
            cwd: '/',
            env: { PATH: '/usr/bin:/bin' },
        },
        (command, options) => Bun.spawn(command, options) as unknown as ClaudeCodeChild,
        stopTimeoutMs
    );
}

describe('Claude Code process', () => {
    test('reads output lines in order, writes input lines, and reports the exit', async () => {
        const process = shell(
            'printf "one\\ntw"; sleep 0.05; printf "o\\n"; read line; echo "got $line"; echo "Error: broken key" >&2'
        );
        const lines: string[] = [];
        const ended = process.start(async (line) => void lines.push(line));
        await process.write('{"ping":1}');
        expect(await ended).toEqual({ code: 0 });
        expect(lines).toEqual(['one', 'two', 'got {"ping":1}']);
        expect(process.errorLine()).toBe('Error: broken key');
        await process.stop();
        await expect(process.write('late')).rejects.toThrow('not running');
    });

    test('kills a child that ignores SIGTERM after the bounded wait', async () => {
        const process = shell(
            'trap "" TERM; echo ready; while :; do sleep 0.05; done',
            100
        );
        let ready!: () => void;
        const started = new Promise<void>((resolve) => (ready = resolve));
        const ended = process.start(async () => ready());
        await started;
        const stopping = Date.now();
        await process.stop();
        expect(Date.now() - stopping).toBeLessThan(2_000);
        expect(await ended).toEqual({ code: 137 });
    });

    test('stops even when a tool subprocess keeps the output pipe open', async () => {
        const process = shell('sleep 5 & echo $!; exec sleep 30', 100);
        let pid!: (value: number) => void;
        const grandchild = new Promise<number>((resolve) => (pid = resolve));
        process.start(async (line) => pid(Number(line)));
        const orphan = await grandchild;
        try {
            const stopping = Date.now();
            await process.stop();
            expect(Date.now() - stopping).toBeLessThan(2_000);
        } finally {
            try {
                globalThis.process.kill(orphan, 'SIGKILL');
            } catch {
                // Already gone.
            }
        }
    });
});
