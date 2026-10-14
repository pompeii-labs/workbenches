import { describe, expect, test } from 'bun:test';

import { RunnerRegistry } from '../../src/runners/registry.js';
import { DockerClient } from '../../src/runtimes/docker/client.js';
import { DockerCredentialVolume } from '../../src/runtimes/docker/credentials.js';
import { PathPlan } from '../../src/runtimes/remote/paths.js';
import { TransferRules } from '../../src/runtimes/staging/rules.js';
import type { ResolvedWorkbench } from '../../src/types.js';

/** The variable that points each runner at its mounted credential store, if it has one. */
const credentialVariables: Record<string, string | undefined> = {
    opencode: 'XDG_DATA_HOME',
    pi: 'WORKBENCH_CREDENTIALS_DIR',
    'claude-code': undefined,
};
const variables = Object.values(credentialVariables).filter(
    (variable): variable is string => Boolean(variable)
);

describe('runner credential environment', () => {
    const runners = RunnerRegistry.standard().list();

    test('names the credential variable of every registered runner', () => {
        expect(runners.map((runner) => runner.name)).toEqual(
            Object.keys(credentialVariables)
        );
    });

    for (const runner of runners) {
        const variable = credentialVariables[runner.name];

        test(`points ${runner.name} at its Docker credential volume`, () => {
            const volume = new DockerCredentialVolume(
                new DockerClient('/usr/bin/docker', { user: () => undefined }, []),
                'ghcr.io/example/lux:0.1.0',
                runner.name,
                runner.runtimeContract(),
                undefined
            );
            expect(volume.environment()).toEqual(
                variable
                    ? {
                          [variable]: '/workbench-credentials',
                          ...(runner.name === 'opencode'
                              ? {
                                    OPENCODE_DB:
                                        '/workbench-credentials/opencode/opencode.db',
                                }
                              : {}),
                      }
                    : {}
            );
        });

        test(`points ${runner.name} at its remote credential store only when one is bound`, () => {
            const workbench = fixture(runner.name);
            const request = {
                workbench,
                workspaceDirectory: '/repo',
                environment: {},
                runner: runner.runtimeContract(),
                assets: [],
            };
            const bind = () =>
                new PathPlan(
                    {
                        ...request,
                        credentials: {
                            runtime: 'e2b',
                            runner: runner.name,
                            directory: `/home/workbench/runtime-credentials/e2b/${runner.name}`,
                        },
                    },
                    new TransferRules('E2B')
                ).environment();
            if (variable) {
                const bound = bind();
                expect(bound[variable]).toBe('/workbench-credentials');
                for (const other of variables.filter((name) => name !== variable)) {
                    expect(bound).not.toHaveProperty(other);
                }
            } else {
                expect(bind).toThrow('keeps no credential file');
            }
            const unbound = new PathPlan(
                request,
                new TransferRules('E2B')
            ).environment();
            for (const name of variables) {
                expect(unbound).not.toHaveProperty(name);
            }
        });
    }
});

function fixture(runner: string): ResolvedWorkbench {
    return {
        manifestPath: '/repo/.workbenches/core/workbench.yml',
        packageDirectory: '/repo/.workbenches/core',
        repositoryDirectory: '/repo',
        instructionsPath: '/repo/.workbenches/core/instructions.md',
        skills: [],
        manifest: {
            spec: 0,
            version: '0.1.0',
            name: 'fixture',
            runner,
            model: { id: 'openai/gpt-5.6-terra' },
            instructions: './instructions.md',
            skills: [],
            tools: [],
            mcps: [],
            env: {},
            runtime: 'e2b',
            image: 'ghcr.io/example/lux:0.1.0',
        },
    };
}
