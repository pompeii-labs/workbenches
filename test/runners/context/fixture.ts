import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ResolvedWorkbench } from '../../../src/types.js';

const directories: string[] = [];

/** Removes every directory `fixture` created. Call it from `afterEach`. */
export async function removeFixtures(): Promise<void> {
    await Promise.all(
        directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
    );
}

/** A Workbench on disk with one instructions file, for staging tests. */
export async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'workbench-context-test-'));
    directories.push(root);
    const packageDirectory = join(root, 'package');
    await mkdir(packageDirectory);
    const instructionsPath = join(packageDirectory, 'instructions.md');
    await writeFile(
        instructionsPath,
        '# Authored behavior\n\nDo the requested work.\n'
    );
    const workbench: ResolvedWorkbench = {
        manifestPath: join(packageDirectory, 'workbench.yml'),
        packageDirectory,
        repositoryDirectory: root,
        instructionsPath,
        skills: [],
        manifest: {
            spec: 0,
            version: '0.1.0',
            name: 'probe',
            runner: 'pi',
            model: { id: 'openai/gpt-5.6-sol' },
            instructions: './instructions.md',
            skills: [],
            tools: [],
            mcps: [],
            env: {},
            runtime: 'local',
        },
    };
    return { root, workbench };
}
