import { describe, expect, test } from 'bun:test';

import { CliPresenter } from '../src/commands/presenter.js';

describe('CLI presenter', () => {
    test('preserves stable tabular output when stdout is piped', () => {
        let stdout = '';
        new CliPresenter({
            interactive: false,
            stdout: (value) => {
                stdout += value;
            },
        }).record({
            machine: ['saved', 'lux-ops', 'sha256:abc'],
            title: 'Saved lux-ops',
            details: ['sha256:abc'],
        });

        expect(stdout).toBe('saved\tlux-ops\tsha256:abc\n');
    });

    test('renders concise styled records in an interactive terminal', () => {
        let stdout = '';
        new CliPresenter({
            interactive: true,
            color: false,
            stdout: (value) => {
                stdout += value;
            },
        }).record({
            machine: ['saved', 'lux-ops', 'sha256:abc'],
            title: 'Saved lux-ops',
            details: ['sha256:abc'],
        });

        expect(stdout).toBe('✓ Saved lux-ops · sha256:abc\n');
    });

    test('keeps progress messages on the requested stream', () => {
        let stdout = '';
        let stderr = '';
        new CliPresenter({
            interactive: false,
            stdout: (value) => {
                stdout += value;
            },
            stderr: (value) => {
                stderr += value;
            },
        }).message('Preparing runtime image', 'info', 'stderr');

        expect(stdout).toBe('');
        expect(stderr).toBe('Preparing runtime image\n');
    });

    test('keeps interactive-only progress and empty states out of piped output', () => {
        let stdout = '';
        let stderr = '';
        const output = new CliPresenter({
            interactive: false,
            stdout: (value) => {
                stdout += value;
            },
            stderr: (value) => {
                stderr += value;
            },
        });

        output.progress('Checking for updates');
        output.empty('No saved Workbenches.');

        expect(stdout).toBe('');
        expect(stderr).toBe('');
    });

    test('renders progress and empty states for an interactive terminal', () => {
        let stdout = '';
        let stderr = '';
        const output = new CliPresenter({
            interactive: true,
            color: false,
            stdout: (value) => {
                stdout += value;
            },
            stderr: (value) => {
                stderr += value;
            },
        });

        output.progress('Checking for updates');
        output.empty('No saved Workbenches.');

        expect(stdout).toBe('○ No saved Workbenches.\n');
        expect(stderr).toBe('… Checking for updates\n');
    });
});
