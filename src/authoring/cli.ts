import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { basename, delimiter, join } from 'node:path';

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
        const path = join(directory, 'wb');
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(path, this.wrapper(), { mode: 0o700 });
        await chmod(path, 0o700);
        return {
            ...inherited,
            PATH: [directory, inherited.PATH].filter(Boolean).join(delimiter),
        };
    }

    private wrapper(): string {
        const command = this.#command;
        return `#!${process.execPath}\nconst command = ${JSON.stringify(command)};\nconst result = Bun.spawnSync({\n    cmd: [...command, ...process.argv.slice(2)],\n    cwd: process.cwd(),\n    env: process.env,\n    stdin: 'inherit',\n    stdout: 'inherit',\n    stderr: 'inherit',\n});\nprocess.exit(result.exitCode);\n`;
    }

    private currentCommand(): string[] {
        return basename(process.execPath).startsWith('bun')
            ? [process.execPath, Bun.main]
            : [process.execPath];
    }
}
