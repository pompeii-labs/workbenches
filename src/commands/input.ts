import { readFile } from 'node:fs/promises';

/** Exactly one explicit source; never read an inherited pipe by accident. */
export class CliInput {
    async read(options: {
        text?: string | undefined;
        file?: string | undefined;
        stdin?: boolean | undefined;
    }): Promise<string> {
        const sources = [
            options.text !== undefined,
            options.file !== undefined,
            options.stdin === true,
        ].filter(Boolean).length;
        if (sources !== 1)
            throw new Error('Pass exactly one text, file, or --stdin input');
        const value = options.stdin
            ? await Bun.stdin.text()
            : options.file
              ? await readFile(options.file, 'utf8')
              : (options.text ?? '');
        if (!value.trim()) throw new Error('Input must not be empty');
        return value.trim();
    }
}
