import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { fullFormats } from 'ajv-formats/dist/formats.js';
import { RunEvents } from '../../src/runs/events.js';
import { binding, result, temporary } from './fixture.js';

describe('repository execution event contract', () => {
    test('validates emitted preparation and delivery receipts and rejects incomplete payloads', async () => {
        const ajv = new Ajv2020({ allErrors: true });
        ajv.addFormat('date-time', fullFormats['date-time']);
        ajv.addFormat('uri', fullFormats.uri);
        const validate = ajv.compile(
            JSON.parse(
                await readFile(
                    join(
                        import.meta.dir,
                        '..',
                        '..',
                        'schemas',
                        'events',
                        'v0',
                        'workbench-event.schema.json'
                    ),
                    'utf8'
                )
            )
        );
        const home = await temporary();
        const outcome = await result(home);
        const receipt = {
            version: 1 as const,
            run_id: outcome.run_id,
            session_id: binding.session_id,
            outcome_id: outcome.id,
            repository: 'example/project',
            revision: binding.revision,
            base_branch: binding.base_branch,
            branch: `workbenches/${binding.session_id}`,
            created_at: new Date().toISOString(),
            state: 'unchanged' as const,
        };
        const events = new RunEvents({ runId: outcome.run_id, runner: 'opencode' });
        const inputs = [
            await events.emit('repository.preparing', {
                repository: 'example/project',
                revision: binding.revision,
            }),
            await events.emit('repository.ready', {
                repository: 'example/project',
                revision: binding.revision,
            }),
            await events.emit('delivery.started', {
                repository: 'example/project',
                outcome_id: outcome.id,
            }),
            await events.emit('delivery.completed', receipt),
            await events.emit('delivery.failed', {
                ...receipt,
                state: 'failed',
                message: 'GitHub request failed',
            }),
            await events.emit('repository.checks', {
                pull_request: {
                    number: 1,
                    url: 'https://github.com/example/project/pull/1',
                    head: 'f'.repeat(40),
                    branch: `workbenches/${binding.session_id}`,
                    state: 'open',
                    merged: false,
                    draft: true,
                },
                state: 'none',
                truncated: false,
                checks: [],
                statuses: [],
                workflows: [],
                jobs: [],
            }),
        ];
        for (const input of inputs) {
            expect(validate(input), JSON.stringify(validate.errors)).toBeTrue();
            expect(validate({ ...input, data: {} })).toBeFalse();
        }
        expect(
            validate({
                ...inputs[0],
                data: { repository: 'example/project', revision: 'not-a-commit' },
            })
        ).toBeFalse();
        expect(validate({ ...inputs[4], data: receipt })).toBeFalse();
        expect(
            validate({ ...inputs[3], data: { ...receipt, state: 'publishing' } })
        ).toBeFalse();
        expect(
            validate({ ...inputs[3], data: { ...receipt, state: 'published' } })
        ).toBeFalse();
        expect(
            validate({ ...inputs[5], data: { ...inputs[5]?.data, state: 'success' } })
        ).toBeFalse();
    });
});
