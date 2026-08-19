import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { WORKBENCH_EVENT_TYPES } from '../src/execution.js';

interface EventSchema {
    $id: string;
    properties: {
        protocol: { const: number };
        type: { enum: string[] };
    };
}

describe('Workbench event schema', () => {
    test('stays in sync with the TypeScript event catalog', async () => {
        const source = await readFile(
            join(
                import.meta.dir,
                '..',
                'schemas',
                'events',
                'v0',
                'workbench-event.schema.json'
            ),
            'utf8'
        );
        const schema = JSON.parse(source) as EventSchema;

        expect(schema.$id).toBe(
            'https://workbenches.dev/schemas/events/v0/workbench-event.schema.json'
        );
        expect(schema.properties.protocol.const).toBe(0);
        expect(schema.properties.type.enum).toEqual([...WORKBENCH_EVENT_TYPES]);
    });
});
