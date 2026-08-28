import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Workbench } from '../src/workbench/index.js';

const root = process.cwd();
const creator = join(root, '.workbenches', 'creator');
const references = join(creator, 'skills', 'workbench-authoring', 'references');

describe('published Workbench creator', () => {
    test('resolves as a valid package', async () => {
        const workbench = await Workbench.load(creator);

        expect(workbench.manifest).toMatchObject({
            name: 'workbench-creator',
            runner: 'opencode',
            runtime: 'local',
        });
    });

    test('packages the current normative spec and schema', async () => {
        const [rootSpec, packagedSpec, rootSchema, packagedSchema] = await Promise.all([
            readFile(join(root, 'SPEC.md'), 'utf8'),
            readFile(join(references, 'spec.md'), 'utf8'),
            readFile(join(root, 'schemas', 'v0', 'workbench.schema.json'), 'utf8'),
            readFile(join(references, 'workbench.schema.json'), 'utf8'),
        ]);

        expect(packagedSpec).toBe(rootSpec);
        expect(packagedSchema).toBe(rootSchema);
    });
});
