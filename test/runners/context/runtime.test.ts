import { afterEach, describe, expect, test } from 'bun:test';

import { runtimeContext } from '../../../src/runners/context/runtime.js';
import { fixture, removeFixtures } from './fixture.js';

afterEach(removeFixtures);

describe('runtime context', () => {
    test('describes only selected workspace facts and never serializes credentials', async () => {
        const { workbench } = await fixture();
        workbench.manifest.workspaces = {
            notes: { required: true, access: 'read-only' },
            'source-code': { required: false, access: 'read-write' },
            unbound: { required: false, access: 'read-write' },
        };
        const context = runtimeContext(workbench, '/workspace', {
            WORKBENCH_OUTPUT_DIR: '/outbox',
            WORKBENCH_WORKSPACE_NOTES: '/notes',
            WORKBENCH_WORKSPACE_SOURCE_CODE: '/sources',
            WORKBENCH_WORKSPACE_UNDECLARED: '/not-selected',
            OPENAI_API_KEY: 'must-not-enter-context',
            WORKBENCH_CREDENTIALS_DIR: '/private-credentials',
        });
        expect(context).toContain(
            'name="primary" access="read-write" path="/workspace"'
        );
        expect(context).toContain('name="notes" access="read-only" path="/notes"');
        expect(context).toContain(
            'name="source-code" access="read-write" path="/sources"'
        );
        expect(context).toContain('environment="WORKBENCH_OUTPUT_DIR" path="/outbox"');
        expect(context).toContain('<declaration path="/outbox/outcome.json" />');
        expect(context).toContain(
            'prior session deliverables are restored here as independent working copies'
        );
        expect(context).toContain('find "$WORKBENCH_OUTPUT_DIR" -type f');
        expect(context).toContain(
            'Do not reuse absolute paths from earlier tool calls'
        );
        expect(context).toContain(
            'not evidence that the outbox is unavailable or read-only'
        );
        for (const value of [
            'must-not-enter-context',
            'OPENAI_API_KEY',
            'private-credentials',
            'not-selected',
            'unbound',
        ]) {
            expect(context).not.toContain(value);
        }
    });

    test('escapes runtime values instead of allowing XML structure', async () => {
        const { workbench } = await fixture();
        const runtime = runtimeContext(workbench, '/a"\n<injected>', {
            WORKBENCH_OUTPUT_DIR: '/b&c',
        });
        expect(runtime).toContain('path="/a&quot;&#10;&lt;injected&gt;"');
        expect(runtime).toContain('path="/b&amp;c"');
    });

    test('states actual application semantics for every supported runtime and an unavailable outbox', async () => {
        const { workbench } = await fixture();
        for (const runtime of ['local', 'docker', 'e2b'] as const) {
            workbench.manifest.runtime = runtime;
            const context = runtimeContext(workbench, '/workspace', {});
            expect(context).toContain(`<runtime>${runtime}</runtime>`);
            expect(context).toContain('<outbox available="false" />');
            expect(context).not.toContain('<declaration');
            expect(context).toContain(
                runtime === 'e2b'
                    ? 'pending until the caller explicitly applies'
                    : 'change the host immediately'
            );
        }
    });
});
