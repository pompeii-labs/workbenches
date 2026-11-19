import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Records the git boundary and maps the direct address to a real local git server. */
export class CheckoutGit {
    readonly bin: string;
    readonly record: string;

    constructor(directory: string) {
        this.bin = join(directory, 'bin');
        this.record = join(directory, 'git.jsonl');
    }

    async install(direct: string, target: string, failure?: string): Promise<void> {
        const executable = Bun.which('git');
        if (!executable) throw new Error('git is required');
        await mkdir(this.bin);
        const script = join(this.bin, 'git');
        await writeFile(
            script,
            `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
const config = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('GIT_CONFIG_')));
appendFileSync(${JSON.stringify(this.record)}, JSON.stringify({ args, config }) + '\\n');
if (${JSON.stringify(failure ?? '')} && args.includes('fetch')) {
    process.stderr.write(${JSON.stringify(failure ?? '')});
    process.exit(1);
}
const child = Bun.spawn([${JSON.stringify(executable)}, ...args.map(arg => arg === ${JSON.stringify(direct)} ? ${JSON.stringify(target)} : arg)], {
    env: process.env, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit',
});
process.exit(await child.exited);
`
        );
        await chmod(script, 0o755);
    }

    environment(environment: Record<string, string | undefined>) {
        return {
            ...environment,
            PATH: `${this.bin}:${environment.PATH ?? ''}`,
        };
    }

    async calls() {
        const lines = (await readFile(this.record, 'utf8')).trim().split('\n');
        return lines.map((line) => {
            const value: unknown = JSON.parse(line);
            if (
                !value ||
                typeof value !== 'object' ||
                !('args' in value) ||
                !Array.isArray(value.args) ||
                !value.args.every(
                    (arg: unknown): arg is string => typeof arg === 'string'
                ) ||
                !('config' in value) ||
                !value.config ||
                typeof value.config !== 'object'
            )
                throw new Error('Invalid git record');
            return { args: value.args, config: value.config };
        });
    }
}
