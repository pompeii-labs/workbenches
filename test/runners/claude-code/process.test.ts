import { describe, expect, test } from 'bun:test';

import {
    type ClaudeCodeChild,
    ClaudeCodeProcess,
} from '../../../src/runners/claude-code/process.js';

function shell(script: string, stopTimeoutMs = 2_000): ClaudeCodeProcess {
    return new ClaudeCodeProcess(
        {
            command: [process.execPath, '-e', script],
            cwd: process.cwd(),
            env: { ...process.env },
        },
        (command, options) => Bun.spawn(command, options) as unknown as ClaudeCodeChild,
        stopTimeoutMs
    );
}

describe('Claude Code process', () => {
    test('reads output lines in order, writes input lines, and reports the exit', async () => {
        const process = shell(
            'process.stdout.write("one\\ntw"); await Bun.sleep(50); process.stdout.write("o\\n"); for await (const chunk of Bun.stdin.stream()) { console.log("got " + new TextDecoder().decode(chunk).trim()); break; } console.error("Error: broken key");'
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
            'process.on("SIGTERM",()=>{}); console.log("ready"); setInterval(()=>{},50);',
            100
        );
        let ready!: () => void;
        const started = new Promise<void>((resolve) => (ready = resolve));
        const ended = process.start(async () => ready());
        await started;
        const stopping = Date.now();
        await process.stop();
        expect(Date.now() - stopping).toBeLessThan(2_000);
        const exit = await ended;
        if (globalThis.process.platform === 'win32')
            expect('code' in exit && exit.code !== 0).toBe(true);
        else expect(exit).toEqual({ code: 137 });
    });

    test('stops even when a tool subprocess keeps the output pipe open', async () => {
        const process = shell(
            'const child = Bun.spawn([process.execPath,"-e","setTimeout(()=>{},5000)"], {stdout:"inherit",stderr:"inherit"}); console.log(child.pid); setTimeout(()=>{},30000);',
            100
        );
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
