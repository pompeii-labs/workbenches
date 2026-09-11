import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Workbench } from '../src/workbench/index.js';

const root = process.cwd();
const creatorDirectory = join(root, '.workbenches', 'creator');
const referencesDirectory = join(
    creatorDirectory,
    'skills',
    'workbench-authoring',
    'references'
);

async function digest(path: string): Promise<string> {
    return createHash('sha256')
        .update(await readFile(path))
        .digest('hex');
}

describe('creator Workbench', () => {
    test('is a valid self-contained draft-0 package', async () => {
        const workbench = await Workbench.load(creatorDirectory);

        expect(workbench.manifest).toEqual({
            spec: 0,
            version: '0.1.4',
            name: 'workbench-creator',
            description:
                'Design, author, review, and test repository-owned Workbenches.',
            runner: 'opencode',
            model: { id: 'openai/gpt-5.6-terra' },
            instructions: './instructions.md',
            skills: ['./skills/workbench-authoring'],
            tools: ['wb'],
            mcps: [],
            env: {},
            runtime: 'local',
        });
        expect(workbench.skills.map((skill) => skill.name)).toEqual([
            'workbench-authoring',
        ]);
    });

    test('keeps the published reference snapshot unchanged', async () => {
        expect(await digest(join(referencesDirectory, 'spec.md'))).toBe(
            'ba7ecf4052174e9fd4eb0801417dbc61b3394a4925140dee0551a3199b3a627b'
        );
        expect(await digest(join(referencesDirectory, 'workbench.schema.json'))).toBe(
            '8f44c19b7cc4594fe80d5371064df05a7c46cce505e705eba8d7573762aed072'
        );
    });
});
