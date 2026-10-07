import { describe, expect, test } from 'bun:test';
import { RunnerRegistry } from '../src/runners/registry.js';
import type { WorkbenchSmokeResult } from '../src/runtimes/smoke.js';
import { SmokeReport } from '../src/runtimes/smokereport.js';
import { SubprocessEnvironmentScrubbing } from '../src/runtimes/subprocess-environment.js';
import { claudeCodeWorkbench } from './runners/claude-code/fixture.js';

describe('subprocess environment scrubbing', () => {
    test('enables Claude Code only on macOS or after a successful Linux probe', async () => {
        const scrubbing = new SubprocessEnvironmentScrubbing();
        const capability =
            RunnerRegistry.standard().authentication(
                'claude-code'
            ).subprocessEnvironmentScrubbing;
        const commands: string[][] = [];
        const execute = async (command: string[]) => {
            commands.push(command);
            return { code: 0 };
        };

        await expect(scrubbing.check(capability, 'macos', execute)).resolves.toBeTrue();
        await expect(scrubbing.check(capability, 'linux', execute)).resolves.toBeTrue();
        await expect(
            scrubbing.check(capability, 'windows', execute)
        ).resolves.toBeFalse();
        await expect(
            scrubbing.check(undefined, 'linux', execute)
        ).resolves.toBeUndefined();
        expect(commands).toEqual([['bwrap', '--ro-bind', '/', '/', 'true']]);

        await expect(
            scrubbing.check(capability, 'linux', async () => ({
                code: 1,
            }))
        ).resolves.toBeFalse();
        await expect(
            scrubbing.check(capability, 'linux', () =>
                Promise.reject(new Error('bwrap unavailable'))
            )
        ).resolves.toBeFalse();
    });

    test('includes the selected state in smoke JSON', () => {
        const workbench = claudeCodeWorkbench();
        const result: WorkbenchSmokeResult = {
            runner: { name: 'claude-code', path: '/usr/bin/claude' },
            tools: [],
            enabledMcps: [],
            disabledMcps: [],
            optionalEnvironment: [],
            workspaces: [],
            subprocessEnvironmentScrubbing: false,
            authentication: {
                model: workbench.manifest.model.id,
                ready: true,
                authenticatedProviders: ['anthropic'],
                connections: [],
                routes: [],
                connectCommand: 'wb connect fixture',
            },
        };

        expect(SmokeReport.completed(workbench, result).toJSON()).toMatchObject({
            subprocess_environment_scrubbing: false,
        });
    });
});
