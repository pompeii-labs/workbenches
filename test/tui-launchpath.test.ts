import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    directorySuggestions,
    launchDirectory,
    validateLaunchDirectory,
} from '../src/tui/launchpath.js';

const directories: string[] = [];
afterEach(async () => {
    await Promise.all(
        directories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

describe('TUI launch directory completion', () => {
    test('completes directories but not files, including relative parents', async () => {
        const cwd = await mkdtemp(join(tmpdir(), 'workbench-launch-'));
        directories.push(cwd);
        await mkdir(join(cwd, 'project'));
        await mkdir(join(cwd, 'private'));
        await writeFile(join(cwd, 'profile.txt'), 'file');
        expect(await directorySuggestions(cwd, './pr')).toEqual([
            './private/',
            './project/',
        ]);
        expect(await directorySuggestions(cwd, '.')).toEqual(['./']);
        expect(await directorySuggestions(cwd, '..')).toEqual(['../']);
        expect(await validateLaunchDirectory(cwd, './project/')).toBe(
            join(cwd, 'project')
        );
    });

    test('expands home paths and rejects missing or non-directory targets', async () => {
        const cwd = await mkdtemp(join(tmpdir(), 'workbench-launch-'));
        directories.push(cwd);
        await writeFile(join(cwd, 'file.txt'), 'file');
        expect(launchDirectory(cwd, '~/project')).toBe(join(homedir(), 'project'));
        expect(await directorySuggestions(cwd, '~')).toEqual(['~/']);
        await expect(validateLaunchDirectory(cwd, './missing')).rejects.toThrow(
            'Directory does not exist'
        );
        await expect(validateLaunchDirectory(cwd, './file.txt')).rejects.toThrow(
            'Directory does not exist'
        );
    });
});
