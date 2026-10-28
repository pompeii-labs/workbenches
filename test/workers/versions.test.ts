import { describe, expect, test } from 'bun:test';

import { WorkerRejection } from '../../src/workers/contracts.js';
import { WorkerRunnerVersions } from '../../src/workers/versions.js';

const claude = {
    displayName: 'Claude Code',
    executable: 'claude',
    minimumVersion: '2.1.292',
};

function versions(output: string | undefined) {
    const asked: string[][] = [];
    const checker = new WorkerRunnerVersions(async (command) => {
        asked.push(command);
        return output;
    });
    return { checker, asked };
}

describe('worker runner versions', () => {
    test('refuses a runner CLI older than the runner works with, naming both versions', async () => {
        const { checker, asked } = versions('2.1.221 (Claude Code)');
        const refused = await checker.check(claude).catch((error: unknown) => error);
        expect(refused).toBeInstanceOf(WorkerRejection);
        expect(refused instanceof Error ? refused.message : '').toBe(
            'Claude Code 2.1.221 on this worker is older than 2.1.292, the oldest release Workbench works with. Update it on the worker.'
        );
        expect(asked).toEqual([['claude', '--version']]);
    });

    test('accepts the minimum and anything newer', async () => {
        await versions('2.1.292 (Claude Code)').checker.check(claude);
        await versions('2.1.310 (Claude Code)').checker.check(claude);
        await versions('2.10.0 (Claude Code)').checker.check(claude);
    });

    test('leaves a missing CLI or an unreadable version to preflight', async () => {
        await versions(undefined).checker.check(claude);
        await versions('Claude Code').checker.check(claude);
    });

    test('asks nothing of a runner with no minimum', async () => {
        const { checker, asked } = versions('0.0.1');
        await checker.check({ displayName: 'OpenCode', executable: 'opencode' });
        expect(asked).toEqual([]);
    });
});
