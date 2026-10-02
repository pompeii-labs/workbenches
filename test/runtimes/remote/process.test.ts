import { describe, expect, test } from 'bun:test';

import type { RuntimeCommandResult } from '../../../src/runtimes/contracts.js';
import {
    type RemoteCommand,
    type RemoteOutput,
    RemoteProcess,
} from '../../../src/runtimes/remote/process.js';

class FakeCommand implements RemoteCommand {
    readonly input: Array<string | Uint8Array> = [];
    closed = false;
    killed = false;
    private finish: (result: RuntimeCommandResult) => void = () => {};
    private readonly finished = new Promise<RuntimeCommandResult>((resolve) => {
        this.finish = resolve;
    });

    wait() {
        return this.finished;
    }
    async sendStdin(data: string | Uint8Array) {
        this.input.push(data);
    }
    async closeStdin() {
        this.closed = true;
    }
    async kill() {
        this.killed = true;
        this.finish({ code: 143, stdout: '', stderr: '' });
    }
    exit(result: RuntimeCommandResult) {
        this.finish(result);
    }
}

async function text(stream: ReadableStream<Uint8Array>): Promise<string> {
    return new Response(stream).text();
}

describe('RemoteProcess', () => {
    test('delivers streamed output and the exit code', async () => {
        const command = new FakeCommand();
        let output: RemoteOutput | undefined;
        const process = new RemoteProcess(
            {
                start: async (sink) => {
                    output = sink;
                    return command;
                },
            },
            false
        );
        await Promise.resolve();
        output?.onStdout('out ');
        output?.onStdout('more');
        output?.onStderr('err');
        command.exit({ code: 3, stdout: 'ignored', stderr: 'ignored' });
        expect(await process.spawned.exited).toBe(3);
        expect(await text(process.spawned.stdout as ReadableStream<Uint8Array>)).toBe(
            'out more'
        );
        expect(await text(process.spawned.stderr as ReadableStream<Uint8Array>)).toBe(
            'err'
        );
        expect(process.spawned.stdin).toBeUndefined();
    });

    test('delivers the output a sandbox reports only at the end', async () => {
        const command = new FakeCommand();
        const process = new RemoteProcess({ start: async () => command }, false);
        command.exit({ code: 0, stdout: 'final', stderr: 'warning' });
        expect(await process.spawned.exited).toBe(0);
        expect(await text(process.spawned.stdout as ReadableStream<Uint8Array>)).toBe(
            'final'
        );
        expect(await text(process.spawned.stderr as ReadableStream<Uint8Array>)).toBe(
            'warning'
        );
    });

    test('passes input to the command and stops it on kill', async () => {
        const command = new FakeCommand();
        const process = new RemoteProcess({ start: async () => command }, true);
        await process.spawned.stdin?.write('hello');
        await process.spawned.stdin?.end?.();
        expect(command.input).toEqual(['hello']);
        expect(command.closed).toBeTrue();
        await process.kill();
        expect(command.killed).toBeTrue();
        expect(await process.spawned.exited).toBe(143);
    });

    test('leaves a command that never started alone when killed', async () => {
        const process = new RemoteProcess(
            { start: () => Promise.reject(new Error('no sandbox')) },
            false
        );
        await expect(process.spawned.exited).rejects.toThrow('no sandbox');
        await process.kill();
    });
});
