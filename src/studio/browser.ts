import type { HostCommands } from '../processes/commands.js';

/** Opens a local file in the user's default browser. */
export class BrowserOpener {
    constructor(
        private readonly platform: NodeJS.Platform,
        private readonly commands: Pick<HostCommands, 'launch'>
    ) {}

    /** False when no launcher started or it reported failure. */
    open(path: string): Promise<boolean> {
        return this.commands.launch([
            this.platform === 'darwin' ? 'open' : 'xdg-open',
            path,
        ]);
    }
}
