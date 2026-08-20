import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveWorkbench } from '../src/manifest.js';

const root = process.cwd();
const creatorDirectory = join(root, '.workbenches', 'creator');
const referencesDirectory = join(
    creatorDirectory,
    'skills',
    'workbench-authoring',
    'references'
);

describe('creator Workbench', () => {
    test('is a valid self-contained draft-0 package', async () => {
        const workbench = await resolveWorkbench(creatorDirectory);

        expect(workbench.manifest).toEqual({
            spec: 0,
            version: '0.1.0',
            name: 'workbench-creator',
            description:
                'Design, author, review, and test repository-owned Workbenches.',
            runner: 'opencode',
            model: 'openrouter/openai/gpt-5.6-terra',
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

    test('keeps packaged standard references identical to canonical sources', async () => {
        const [canonicalSpec, packagedSpec, canonicalSchema, packagedSchema] =
            await Promise.all([
                readFile(join(root, 'SPEC.md'), 'utf8'),
                readFile(join(referencesDirectory, 'spec.md'), 'utf8'),
                readFile(join(root, 'schemas', 'v0', 'workbench.schema.json'), 'utf8'),
                readFile(join(referencesDirectory, 'workbench.schema.json'), 'utf8'),
            ]);

        expect(packagedSpec).toBe(canonicalSpec);
        expect(packagedSchema).toBe(canonicalSchema);
    });
});
