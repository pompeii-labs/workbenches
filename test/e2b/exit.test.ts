import { describe, expect, test } from 'bun:test';

import { RunnerProcessExit } from '../../src/runners/exit.js';
import { e2bExitCode } from '../../src/runtimes/e2b/exit.js';

describe('e2bExitCode', () => {
    test('reports a signal kill as 128 plus the signal number', () => {
        expect(e2bExitCode(-1, 'signal: killed')).toBe(137);
        expect(e2bExitCode(-1, 'signal: terminated')).toBe(143);
        expect(e2bExitCode(-1, 'signal: segmentation fault (core dumped)')).toBe(139);
    });

    test('lets the runner explain an out of memory kill', () => {
        expect(
            new RunnerProcessExit('OpenCode server').message(
                e2bExitCode(-1, 'signal: killed')
            )
        ).toBe('OpenCode server was killed (exit 137), most likely out of memory.');
    });

    test('keeps every other exit code', () => {
        expect(e2bExitCode(0)).toBe(0);
        expect(e2bExitCode(2, 'exit status 2')).toBe(2);
        expect(e2bExitCode(-1)).toBe(-1);
        expect(e2bExitCode(-1, 'signal: something new')).toBe(-1);
    });
});
