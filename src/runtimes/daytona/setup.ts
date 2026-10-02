import type { ResolvedWorkbench } from '../../types.js';
import { RuntimeError } from '../error.js';
import { installRepositoryTools, probeRepositoryTools } from '../repository-tools.js';
import { quote } from '../staging/shell.js';
import type { DaytonaSandbox } from './contracts.js';

/** The runner and tool paths found inside the sandbox. */
export interface ImageInspection {
    runnerPath: string;
    tools: Array<{ name: string; path: string }>;
}

/** What a run needs from the sandbox's image, beyond the Workbench's own tools. */
export interface ImageNeeds {
    /** The run works on a repository checkout, which needs Git. */
    repository: boolean;
    /** The run delivers a pull request, which needs the GitHub CLI. */
    pullRequests: boolean;
}

const label = 'Daytona';

/** Prepares one Daytona sandbox, created from `image`, for a run. */
export class SandboxSetup {
    constructor(
        private readonly sandbox: Pick<DaytonaSandbox, 'run'>,
        private readonly image: string
    ) {}

    /** Installs `git` and `gh` when the image lacks them, as root or through sudo. */
    async provisionRepositoryTools(): Promise<void> {
        const probe = await this.sandbox.run(probeRepositoryTools);
        if (probe.code === 0) return;
        const missing = probe.stdout.trim() || 'git, gh';
        const install = await this.sandbox.run(installRepositoryTools, {
            user: 'root',
        });
        if (install.code === 0) return;
        const detail = install.stdout.trim() || install.stderr.trim();
        throw this.failure(
            detail.includes('root access is required')
                ? `The ${label} sandbox image is missing ${missing} and cannot install it without root: the image must ship git and gh or allow root`
                : `Failed to provision Git tools in the ${label} sandbox: ${detail}`
        );
    }

    /**
     * Checks that the image ships what a run needs: Git, GNU tar with `--null`,
     * the runner CLI, the declared tools, and `gh` for pull request delivery.
     * Each failure names the image.
     */
    async inspect(
        workbench: ResolvedWorkbench,
        needs: ImageNeeds
    ): Promise<ImageInspection> {
        const image = this.image;
        const names = [
            'git',
            'tar',
            workbench.manifest.runner,
            ...workbench.manifest.tools,
            ...(needs.pullRequests ? ['gh'] : []),
        ];
        const paths = await Promise.all(names.map((name) => this.find(name)));
        if (!paths[0]) {
            throw this.failure(
                needs.repository
                    ? `Engine-managed Git is unavailable in the ${label} sandbox from image ${image}`
                    : `Git is unavailable in ${label} image ${image}; ${label} workspace outcome collection requires git`
            );
        }
        if (!paths[1]) {
            throw this.failure(
                `Tar is unavailable in ${label} image ${image}; ${label} workspace outcome collection requires tar`
            );
        }
        const tarCapabilities = await this.sandbox.run('tar --help 2>&1');
        if (
            tarCapabilities.code !== 0 ||
            !`${tarCapabilities.stdout}\n${tarCapabilities.stderr}`.includes('--null')
        ) {
            throw this.failure(
                `GNU tar is unavailable in ${label} image ${image}; ${label} workspace outcome collection requires tar --null support`
            );
        }
        const runnerPath = paths[2];
        if (!runnerPath) {
            throw this.failure(
                `Runner CLI is unavailable in ${label} image ${image}: ${workbench.manifest.runner}`
            );
        }
        const tools = workbench.manifest.tools.map((name, index) => {
            const path = paths[index + 3];
            if (!path) {
                throw this.failure(
                    `Required CLI tool is unavailable in ${label} image ${image}: ${name}`
                );
            }
            return { name, path };
        });
        if (needs.pullRequests && !paths.at(-1)) {
            throw this.failure(
                `Engine-managed GitHub CLI (gh) is unavailable in the ${label} sandbox from image ${image}`
            );
        }
        return { runnerPath, tools };
    }

    private failure(message: string): RuntimeError {
        return new RuntimeError('daytona', 'preflight', message);
    }

    private async find(name: string): Promise<string | null> {
        const result = await this.sandbox.run(`command -v ${quote(name)} 2>/dev/null`);
        if (result.code !== 0) return null;
        return result.stdout.trim().split(/\r?\n/)[0] || null;
    }
}
