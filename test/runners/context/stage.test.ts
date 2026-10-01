import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { RunnerContextStaging } from '../../../src/runners/context/stage.js';
import { DiskRunnerFiles } from '../../../src/runners/files/disk.js';
import { fixture, removeFixtures } from './fixture.js';

afterEach(removeFixtures);

const staging = new RunnerContextStaging(new DiskRunnerFiles());

describe('runner context staging', () => {
    test('keeps the protocol and exact package instructions ahead of runtime facts', async () => {
        const { root, workbench } = await fixture();
        const native = '# Native package settings';
        const context = await staging.stage({
            directory: root,
            workbench,
            nativeInstructions: native,
        });
        const prefix = await readFile(context.prefix, 'utf8');
        expect(prefix).toStartWith('<workbench_context>');
        expect(prefix).toContain('<workbench_package name="probe" version="0.1.0" />');
        expect(prefix).toEndWith(
            `${native}\n\n# Authored behavior\n\nDo the requested work.\n`
        );
        expect(prefix).not.toContain('<workbench_runtime>');
        expect(prefix).not.toContain(root);
        expect(prefix).not.toContain('workbenches.dev');
        expect(prefix).not.toContain('publisher=');
        expect(prefix).not.toContain('author=');
        const example = prefix
            .split('\n')
            .find((line) => line.startsWith('{"version":1'));
        expect(JSON.parse(example ?? '')).toMatchObject({
            version: 1,
            artifacts: [{ path: 'reports/findings.html' }],
        });
    });

    test('routes requested files without requiring users to name the outbox', async () => {
        const { root, workbench } = await fixture();
        const context = await staging.stage({ directory: root, workbench });
        const prefix = await readFile(context.prefix, 'utf8');
        expect(prefix).toContain(
            'The user never needs to know, name, or opt into the outbox'
        );
        expect(prefix).toContain('write the finished file in the outbox');
        expect(prefix).toContain('Pasting its content in chat, naming a file');
        expect(prefix).toContain(
            'record that actual URL in outcome.json automatically'
        );
        expect(prefix).toContain('Never write it alongside the outbox');
        expect(prefix).toContain('copy its original bytes there');
        expect(prefix).toContain('without changing retained earlier artifacts');
        expect(prefix).toContain('belong in the appropriate workspace, not the outbox');
        expect(prefix).toContain('do not manufacture an attachment for every response');
        expect(prefix).toContain('prefer the quoted "$WORKBENCH_OUTPUT_DIR" variable');
        expect(prefix).toContain('never guess its spelling or reconstruct a run ID');
    });

    test('escapes package identity instead of allowing XML structure', async () => {
        const { root, workbench } = await fixture();
        workbench.manifest.name = 'probe" /><injected>&';
        workbench.manifest.version = "0.1.0'";
        const files = await staging.stage({ directory: root, workbench });
        const prefix = await readFile(files.prefix, 'utf8');
        expect(prefix).toContain('name="probe&quot; /&gt;&lt;injected&gt;&amp;"');
        expect(prefix).not.toContain('<injected>');
    });

    test('rejects a package-owned staging namespace or a symlink instruction target', async () => {
        const first = await fixture();
        await mkdir(join(first.root, '.workbench-context'));
        await expect(
            staging.stage({ directory: first.root, workbench: first.workbench })
        ).rejects.toThrow();
        const second = await fixture();
        const original = join(second.root, 'original.md');
        await writeFile(original, 'must not change');
        const target = join(second.root, 'APPEND_SYSTEM.md');
        await symlink(original, target);
        await expect(
            staging.stage({
                directory: second.root,
                workbench: second.workbench,
                instructions: target,
            })
        ).rejects.toThrow('regular file');
        expect(await readFile(original, 'utf8')).toBe('must not change');
    });
});
