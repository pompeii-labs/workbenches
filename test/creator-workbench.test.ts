import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
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

async function digest(path: string): Promise<string> {
    return createHash('sha256')
        .update(await readFile(path))
        .digest('hex');
}

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

    test('keeps the published reference snapshot unchanged', async () => {
        expect(await digest(join(referencesDirectory, 'spec.md'))).toBe(
            '1f810926eb9c2bc9cf368bd3a7e58518d62aa0f7925a225add43b3a92c5c1dac'
        );
        expect(await digest(join(referencesDirectory, 'workbench.schema.json'))).toBe(
            'cee85a3ffb2ed79e280023324c1c1a0441192be07360aaa165a05e2c16e923a1'
        );
    });
});
