export interface WorkerGitDependencies {
    platform?: string;
    findExecutable?: (name: string) => string | null;
    /** Runs a command and resolves its exit code. */
    run?: (command: string[]) => Promise<number>;
}

/** Why a worker without git refuses repository runs. */
export const GIT_REFUSAL =
    'This worker cannot take repository runs: git is not installed. Install git on the worker and restart it.';

/** Where macOS keeps the stub that asks to install the developer tools instead of running git. */
const MACOS_STUB = '/usr/bin/git';

/**
 * Checks that git is usable on this machine. On macOS the stub in
 * `/usr/bin` pops an install dialog on the screen when run, so it is run
 * only once the developer tools are installed.
 */
export class WorkerGit {
    readonly #platform: string;
    readonly #findExecutable: (name: string) => string | null;
    readonly #run: (command: string[]) => Promise<number>;

    constructor(dependencies: WorkerGitDependencies = {}) {
        this.#platform = dependencies.platform ?? process.platform;
        this.#findExecutable =
            dependencies.findExecutable ?? ((name) => Bun.which(name));
        this.#run = dependencies.run ?? run;
    }

    async usable(): Promise<boolean> {
        const git = this.#findExecutable('git');
        if (!git) return false;
        if (
            this.#platform === 'darwin' &&
            git === MACOS_STUB &&
            (await this.#run(['xcode-select', '-p'])) !== 0
        )
            return false;
        return (await this.#run([git, '--version'])) === 0;
    }
}

async function run(command: string[]): Promise<number> {
    try {
        const child = Bun.spawn(command, {
            stdin: 'ignore',
            stdout: 'ignore',
            stderr: 'ignore',
        });
        const timer = setTimeout(() => child.kill(), 10_000);
        try {
            return await child.exited;
        } finally {
            clearTimeout(timer);
        }
    } catch {
        return 1;
    }
}
