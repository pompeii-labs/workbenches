import { describe, expect, test } from 'bun:test';

import { RunnerProcessExit } from '../../src/runners/exit.js';

describe('RunnerProcessExit', () => {
    const exit = new RunnerProcessExit('Pi RPC');

    test('names a SIGKILL as most likely out of memory', () => {
        expect(exit.message(137)).toBe(
            'Pi RPC was killed (exit 137), most likely out of memory.'
        );
        expect(exit.message(-9)).toBe(
            'Pi RPC was killed (exit -9), most likely out of memory.'
        );
    });

    test('keeps the plain message for every other code', () => {
        expect(exit.message(1)).toBe('Pi RPC exited with code 1');
        expect(exit.message(143)).toBe('Pi RPC exited with code 143');
        expect(exit.message(0)).toBe('Pi RPC exited with code 0');
    });

    test('adds the process detail to either message', () => {
        expect(exit.message(1, 'boom')).toBe('Pi RPC exited with code 1: boom');
        expect(exit.message(137, 'boom')).toEndWith('Last output: boom');
    });
});
