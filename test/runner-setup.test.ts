import { describe, expect, test } from 'bun:test';

import { runnerSetupError } from '../src/runners/setup.js';
import type { ResolvedWorkbench } from '../src/types.js';

describe('runner setup guidance', () => {
    test('gives an actionable local Pi installation command', () => {
        expect(
            runnerSetupError(
                new Error('Runner CLI is unavailable: pi'),
                workbench('local')
            ).message
        ).toBe(
            'Pi is required for this Workbench but is not installed. Install it with: npm install -g @earendil-works/pi-coding-agent'
        );
    });

    test('does not suggest a host install for a missing image runner', () => {
        expect(
            runnerSetupError(
                new Error('Runner CLI is unavailable in Docker image: pi'),
                workbench('docker')
            ).message
        ).toContain('not installed in its runtime image');
    });
});

function workbench(runtime: 'local' | 'docker'): ResolvedWorkbench {
    return {
        manifestPath: '/repo/.workbenches/core/workbench.yml',
        packageDirectory: '/repo/.workbenches/core',
        repositoryDirectory: '/repo',
        instructionsPath: '/repo/.workbenches/core/instructions.md',
        skills: [],
        manifest: {
            spec: 0,
            version: '0.1.0',
            name: 'fixture',
            runner: 'pi',
            model: { id: 'openai/gpt-5.6-terra' },
            instructions: './instructions.md',
            skills: [],
            tools: [],
            mcps: [],
            env: {},
            runtime,
            ...(runtime === 'docker' ? { image: 'example.com/workbench:fixture' } : {}),
        },
    };
}
