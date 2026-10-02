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
    test('is a valid self-contained spec 1 package', async () => {
        const workbench = await Workbench.load(creatorDirectory);

        expect(workbench.manifest).toEqual({
            spec: 1,
            version: '0.1.9',
            name: 'workbench-creator',
            description:
                'Design, author, review, and test repository-owned Workbenches.',
            runner: 'opencode',
            model: { id: 'openai/gpt-5.6-sol' },
            instructions: './instructions.md',
            skills: ['./skills/workbench-authoring'],
            tools: ['wb'],
            mcps: [],
            env: {},
            requirements: { gpu: false },
            runtimes: { local: {} },
        });
        expect(workbench.skills.map((skill) => skill.name)).toEqual([
            'workbench-authoring',
        ]);
    });

    test('keeps the candidate reference snapshot pinned to its version', async () => {
        expect(await digest(join(referencesDirectory, 'spec.md'))).toBe(
            '387dd432f65fe8b1d2fb4733a99be8e45cbcbf226939e297244cc15f48514105'
        );
        expect(await digest(join(referencesDirectory, 'workbench.schema.json'))).toBe(
            'e11f0e669cbf77220e472c79fe0fd5e153601d86b44c89bd2abc52bbc067c44f'
        );
    });
});
