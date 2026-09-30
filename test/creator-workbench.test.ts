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
            version: '0.1.8',
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
            '17b1ef2950f446d442ab40ede9e9e8c49757bdb324c9c964e41cc8e52c99d1dc'
        );
        expect(await digest(join(referencesDirectory, 'workbench.schema.json'))).toBe(
            '88c57cd9698c9e6255fab15ebe4500533d63cb7ea76511261424c65794d116c8'
        );
    });
});
