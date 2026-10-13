import { mkdir } from 'node:fs/promises';
import { basename, delimiter, join } from 'node:path';
import { chmod, writeFile } from '../platform/permissions.js';

export class AuthoringCli {
    readonly #command: string[];

    constructor(
        private readonly home: string,
        command?: string[]
    ) {
        this.#command = command ?? this.currentCommand();
    }

    async environment(
        operationId: string,
        inherited: Record<string, string | undefined> = process.env
    ): Promise<Record<string, string | undefined>> {
        const directory = join(this.home, 'authoring', operationId, 'bin');
        const path = join(directory, process.platform === 'win32' ? 'wb.cmd' : 'wb');
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(path, this.wrapper(), { mode: 0o700 });
        await chmod(path, 0o700);
        return {
            ...inherited,
            PATH: [directory, inherited.PATH].filter(Boolean).join(delimiter),
        };
    }

    private wrapper(): string {
        if (process.platform === 'win32') {
            const command = this.#command
                .map((part) => {
                    if (/[\r\n"]/.test(part))
                        throw new Error('Invalid Windows CLI command');
                    return `"${part.replaceAll('%', '%%')}"`;
                })
                .join(' ');
            return `@echo off\r\n${command} %*\r\n`;
        }
        const command = this.#command.map((part) => this.shellQuote(part)).join(' ');
        return `#!/bin/sh\nexec ${command} "$@"\n`;
    }

    private shellQuote(value: string): string {
        return `'${value.replaceAll("'", `'"'"'`)}'`;
    }

    private currentCommand(): string[] {
        return basename(process.execPath).startsWith('bun')
            ? [process.execPath, Bun.main]
            : [process.execPath];
    }
}
