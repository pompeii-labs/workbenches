import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { PreviewScript } from './script.js';

/** Installs the `wbx` helper on this host, private to the user who runs it. */
export class PreviewHelper {
    static readonly command = PreviewScript.command;

    constructor(private readonly controlFile: string) {}

    /** Installs the helper into `directory` and returns its path. */
    async install(directory: string): Promise<string> {
        const path = join(directory, PreviewHelper.command);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(path, this.script(), { mode: 0o700 });
        await chmod(path, 0o700);
        return path;
    }

    script(): string {
        return new PreviewScript(this.controlFile).text();
    }
}
