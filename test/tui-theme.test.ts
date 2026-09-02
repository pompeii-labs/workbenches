import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ThemeController } from '../src/tui/theme/index.js';

const homes: string[] = [];

afterEach(async () => {
    await Promise.all(
        homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))
    );
});

describe('TUI themes', () => {
    test('starts with the Workbench default and exposes the built-in themes', async () => {
        const themes = new ThemeController(await home());

        expect(themes.selected).toBe('flexoki');
        expect(themes.current.background).toBe('#100F0F');
        expect(themes.list().map((theme) => theme.name)).toEqual([
            'flexoki',
            'github',
            'catppuccin',
            'dracula',
            'tokyonight',
            'rosepine',
        ]);
    });

    test('persists a selected theme without changing a Workbench package', async () => {
        const directory = await home();
        const themes = new ThemeController(directory);
        await themes.select('github');

        expect(JSON.parse(await readFile(join(directory, 'tui.json'), 'utf8'))).toEqual(
            {
                theme: 'github',
            }
        );

        const restored = new ThemeController(directory);
        await restored.load();
        expect(restored.selected).toBe('github');
        expect(restored.current.background).toBe('#0d1117');
    });

    test('resolves light variants and rejects an unknown theme', async () => {
        const themes = new ThemeController(await home());
        themes.setMode('light');

        expect(themes.current.background).toBe('#FFFCF0');
        await expect(themes.select('missing')).rejects.toThrow(
            'Unknown theme: missing'
        );
    });
});

async function home(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-tui-theme-'));
    homes.push(directory);
    return directory;
}
