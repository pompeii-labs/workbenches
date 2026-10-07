import { describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
const source = join(root, '.workbenches', 'creator', 'skills', 'wb-authoring');
const copy = join(root, 'skills', 'wb-authoring');

async function files(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { recursive: true, withFileTypes: true });
    return entries
        .filter((entry) => !entry.isDirectory())
        .map((entry) => join(entry.parentPath, entry.name).slice(directory.length + 1))
        .sort();
}

describe('wb-authoring skill', () => {
    test('ships the same files as the creator skill', async () => {
        expect(await files(copy)).toEqual(await files(source));
    });

    test('ships byte-identical file contents', async () => {
        for (const file of await files(source)) {
            const [expected, actual] = await Promise.all([
                readFile(join(source, file)),
                readFile(join(copy, file)),
            ]);
            expect(actual.equals(expected), file).toBe(true);
        }
    });

    test('documents the Claude Code runner contract', async () => {
        const [
            cli,
            connections,
            troubleshooting,
            models,
            runtimes,
            permissions,
            reference,
            execution,
        ] = await Promise.all([
            readFile(join(root, 'skills', 'wb-cli', 'SKILL.md'), 'utf8'),
            readFile(
                join(root, 'skills', 'wb-cli', 'references', 'connections.md'),
                'utf8'
            ),
            readFile(
                join(root, 'skills', 'wb-cli', 'references', 'troubleshooting.md'),
                'utf8'
            ),
            readFile(join(copy, 'references', 'models.md'), 'utf8'),
            readFile(join(copy, 'references', 'runtimes.md'), 'utf8'),
            readFile(join(copy, 'references', 'permissions.md'), 'utf8'),
            readFile(join(root, 'docs', 'REFERENCE.md'), 'utf8'),
            readFile(join(root, 'docs', 'EXECUTION.md'), 'utf8'),
        ]);

        expect(cli).toContain('npm install -g @anthropic-ai/claude-code');
        expect(cli).toContain('Every runner uses the same model catalog');
        expect(connections).toContain("the runner's documented login command");
        expect(connections).toContain(
            'Claude Code credentials are never copied to E2B or Daytona'
        );
        expect(troubleshooting).not.toContain('bubblewrap');
        expect(models).toContain('For every runner');
        expect(models).toContain('shared runner capability table');
        expect(runtimes).toContain('@anthropic-ai/claude-code@');
        expect(runtimes).toContain('CLAUDE_CODE_VERSION');
        expect(permissions).toContain('"max_turns": 12');
        expect(permissions).not.toContain('CLAUDE.md');
        expect(reference).toContain('`claude auth status --json`');
        expect(reference).toContain('Native credential persistence');
        expect(execution).toContain(
            'Environment-only runners require the selected provider variable'
        );
    });
});
