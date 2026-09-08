import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TuiCommandRegistry } from '../src/tui/commands/registry.js';
import { PromptAttachmentReader } from '../src/tui/prompt/attachments.js';
import {
    PromptHistory,
    parsePromptHistory,
    promptHistoryLimit,
} from '../src/tui/prompt/history.js';

const homes: string[] = [];

afterEach(async () => {
    await Promise.all(
        homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))
    );
});

describe('TUI prompt history', () => {
    test('compacts concurrently without sharing an atomic-write path', async () => {
        const home = await mkdtemp(join(tmpdir(), 'workbench-history-'));
        homes.push(home);
        const path = join(home, 'prompt-history.jsonl');
        await writeFile(
            path,
            `${JSON.stringify({ text: 'first' })}\n${JSON.stringify({ text: 'second' })}\n`
        );

        await Promise.all([
            new PromptHistory(home).load(),
            new PromptHistory(home).load(),
        ]);

        expect(parsePromptHistory(await readFile(path, 'utf8'))).toEqual([
            { text: 'first' },
            { text: 'second' },
        ]);
    });

    test('recovers valid entries and limits retained history', () => {
        const source = [
            'not json',
            ...Array.from({ length: promptHistoryLimit + 2 }, (_, index) =>
                JSON.stringify({ text: `message ${index}` })
            ),
        ].join('\n');

        const parsed = parsePromptHistory(source);
        expect(parsed).toHaveLength(promptHistoryLimit);
        expect(parsed[0]?.text).toBe('message 2');
        expect(parsed.at(-1)?.text).toBe(`message ${promptHistoryLimit + 1}`);
    });

    test('persists unique prompts and navigates without replacing a draft', async () => {
        const home = await mkdtemp(join(tmpdir(), 'workbench-history-'));
        homes.push(home);
        const history = new PromptHistory(home);
        await history.load();
        await history.append('first');
        await history.append('second');
        await history.append('second');

        expect(history.move(-1, '')).toBe('second');
        expect(history.move(-1, 'second')).toBe('first');
        expect(history.move(1, 'first')).toBe('second');
        expect(history.move(-1, 'unfinished draft')).toBeUndefined();
        expect(
            (await readFile(join(home, 'prompt-history.jsonl'), 'utf8'))
                .trim()
                .split('\n')
        ).toHaveLength(2);
    });
});

describe('TUI prompt attachments', () => {
    test('loads supported images without exposing a file path to the runner', async () => {
        const home = await mkdtemp(join(tmpdir(), 'workbench-attachments-'));
        homes.push(home);
        await writeFile(join(home, 'reference image.png'), Uint8Array.from([1, 2, 3]));

        const attachment = await new PromptAttachmentReader(home).readPasted(
            'reference\\ image.png'
        );
        expect(attachment).toMatchObject({
            name: 'reference image.png',
            mimeType: 'image/png',
            data: 'AQID',
        });
        expect(attachment?.path).toBe(join(home, 'reference image.png'));
    });

    test('leaves ordinary pasted text and unsupported files in the composer', async () => {
        const home = await mkdtemp(join(tmpdir(), 'workbench-attachments-'));
        homes.push(home);
        const reader = new PromptAttachmentReader(home);
        expect(await reader.readPasted('ordinary pasted text')).toBeUndefined();
        expect(await reader.readPasted('credentials.json')).toBeUndefined();
    });
});

describe('TUI command registry', () => {
    const commands = new TuiCommandRegistry([
        {
            name: 'theme',
            title: 'Choose theme',
            description: 'Change colors',
            category: 'Display',
            run() {},
        },
        {
            name: 'quit',
            aliases: ['exit'],
            title: 'Quit',
            description: 'Close the session',
            category: 'Session',
            run() {},
        },
    ]);

    test('finds commands and parses aliases without leaking slash input', () => {
        expect(commands.find('th').map((command) => command.name)).toEqual(['theme']);
        expect(commands.parse('/theme rosepine')).toMatchObject({
            command: { name: 'theme' },
            argument: 'rosepine',
        });
        expect(commands.parse('/exit')).toMatchObject({
            command: { name: 'quit' },
            argument: '',
        });
        expect(commands.parse('normal prompt')).toBeUndefined();
        expect(commands.parse('/unknown')).toBeUndefined();
    });
});
