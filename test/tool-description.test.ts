import { describe, expect, test } from 'bun:test';

import { describeTool } from '../src/runners/tool.js';

describe('runner tool descriptions', () => {
    test('describes known tools with safe, useful context', () => {
        expect(
            describeTool(
                'grep',
                { pattern: 'migration', path: '/repo/src' },
                { matches: 3 }
            )
        ).toEqual({
            title: 'Grep "migration"',
            target: '/repo/src',
            description: '3 matches',
        });
        expect(
            describeTool(
                'read',
                { filePath: '/repo/src/index.ts', offset: 10, limit: 20 },
                undefined
            )
        ).toEqual({
            title: 'Read',
            target: '/repo/src/index.ts',
            description: 'lines 10-29',
        });
        expect(
            describeTool(
                'task',
                { description: 'Review authentication', subagent_type: 'explore' },
                undefined
            )
        ).toEqual({
            title: 'Review authentication',
            description: 'Explore agent',
        });
    });

    test('does not expose shell commands or unknown object fields', () => {
        const description = describeTool(
            'bash',
            {
                command: 'curl -H Authorization:SECRET',
                token: 'SECRET_TOKEN',
            },
            { output: 'SECRET_OUTPUT' }
        );

        expect(description).toEqual({ title: 'Shell command' });
        expect(JSON.stringify(description)).not.toContain('SECRET');
    });

    test('strips terminal control characters and bounds display text', () => {
        const description = describeTool(
            'web_search',
            { query: `\u001b[31m${'a'.repeat(300)}` },
            undefined
        );

        expect(description.title).not.toContain('\u001b');
        expect(description.title.length).toBeLessThanOrEqual(252);
    });
});
