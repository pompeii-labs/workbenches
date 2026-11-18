import { expect, test } from 'bun:test';
import { workbenchCommand } from '../src/cli.js';

test('exposes the supported CLI commands without retired aliases', () => {
    const commands = Object.keys(workbenchCommand.subCommands ?? {});
    expect(commands).toContain('save');
    expect(commands).toContain('unsave');
    for (const name of ['mcp', 'studio', 'project', 'create', 'add', 'remove']) {
        expect(commands).not.toContain(name);
    }
});
