import { describe, expect, test } from 'bun:test';

import { CliPresenter } from '../src/commands/presenter.js';

describe('CLI presenter', () => {
    test('emits terminal hyperlinks without changing the original file URI', () => {
        const previous = process.env.TERM;
        process.env.TERM = 'xterm-256color';
        try {
            const output = new CliPresenter({ interactive: true, color: false });
            const uri = 'file:///private/tmp/results/Original%20image.png';
            expect(output.link('Original image.png', uri)).toBe(
                `\x1b]8;;${uri}\x1b\\Original image.png\x1b]8;;\x1b\\`
            );
            expect(output.link('Report\x07', 'https://example.com/\x07')).toBe(
                '\x1b]8;;https://example.com/\x1b\\Report \x1b]8;;\x1b\\'
            );
        } finally {
            if (previous === undefined) delete process.env.TERM;
            else process.env.TERM = previous;
        }
    });

    test('keeps file targets readable without terminal hyperlink support', () => {
        const uri = 'file:///private/tmp/results/Original%20image.png';
        expect(
            new CliPresenter({ interactive: false }).link('Original image.png', uri)
        ).toBe(`Original image.png · ${uri}`);
    });

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
