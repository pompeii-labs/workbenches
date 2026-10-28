import { createHash } from 'node:crypto';
import { readdir, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { RepositoryCredentials } from '../repositories/credentials.js';
import type { RunnerRegistry } from '../runners/registry.js';
import {
    CONTAINER_FORWARD_VARIABLE,
    CREDENTIAL_ROOT_VARIABLE,
} from '../runtimes/hostvariables.js';
import type { WorkerHome } from './home.js';
import type { ImagePull, RunStart } from './protocol.js';

/**
 * What a run's environment is built from. A follow-up after a restart has no
 * pull credential and no repository access.
 */
export interface WorkerRunSpec {
    run_id: string;
    runtime: string;
    member_id: string | null;
    image_pull: ImagePull | null;
    /** The `gh` and branch variables the server sends for a repository run. */
    repository: Record<string, string>;
}

export function runSpec(start: RunStart): WorkerRunSpec {
    return {
        run_id: start.run_id,
        runtime: start.runtime,
        member_id: start.started_by.member_id,
        image_pull: start.image_pull,
        repository: start.workspace ? repositoryVariables(start.env) : {},
    };
}

/**
 * The variables of `run.start.env` that point `gh` at the site's proxy and
 * name the run's branch. The Workbench does not declare them, so they would
 * not otherwise reach the run. The names the worker isolates itself are not
 * taken from the server.
 */
function repositoryVariables(env: Record<string, string>): Record<string, string> {
    return Object.fromEntries(
        Object.entries(env).filter(
            ([name]) =>
                (name.startsWith('GH_') &&
                    name !== 'GH_TOKEN' &&
                    name !== 'GH_CONFIG_DIR') ||
                name === 'WORKBENCH_BRANCH'
        )
    );
}

/**
 * The host environment one worker run inherits, built for each launch: for a
 * repository run, the variables that point `gh` at the site's proxy; for a
 * local run, the member directory as its home; for a docker run, a Docker
 * client configuration of its own. The member's saved key or token is added
 * by the engine, only to a run that uses their connection.
 *
 * Every run runs as the machine's account, which every member who may run on
 * the worker is trusted with. What keeps members apart is whose sign-ins a
 * run uses, not a boundary: a local run's home is the starting member's
 * directory, or an empty one without a member, which then authenticates only
 * through `run.start.env`. A run works on GitHub only through the proxy with
 * its own credential, the same as in the cloud: `GH_TOKEN` is always empty,
 * which the engine reads as "no token" and never replaces with a GitHub CLI
 * login, and git and `gh` read no configuration of the account's. The
 * account's Docker settings and runner credential variables are dropped.
 */
export class WorkerRunEnvironment {
    constructor(
        private readonly home: Pick<
            WorkerHome,
            | 'memberDirectory'
            | 'anonymousDirectory'
            | 'dockerConfigDirectory'
            | 'ensure'
        > & { readonly root: string },
        private readonly runners: Pick<RunnerRegistry, 'find' | 'list'>,
        private readonly base: Record<string, string | undefined> = process.env,
        /** The Docker endpoint runs use, resolved from the account's context once. */
        private readonly dockerHost?: string
    ) {}

    async build(
        run: WorkerRunSpec,
        runner: string
    ): Promise<Record<string, string | undefined>> {
        const environment = this.#inherited();
        Object.assign(
            environment,
            run.repository,
            { GH_TOKEN: '' },
            await this.#temporary(run.run_id)
        );
        // The account's Docker context is in its own home, which no run has as
        // its home, so every run is pointed at the daemon it resolved.
        if (this.dockerHost) environment.DOCKER_HOST = this.dockerHost;
        // A docker container receives only declared names. A repository run
        // also gets these, never the paths that point at the host.
        if (Object.keys(run.repository).length > 0)
            environment[CONTAINER_FORWARD_VARIABLE] = JSON.stringify([
                ...Object.keys(run.repository),
                'GH_TOKEN',
                'GIT_TERMINAL_PROMPT',
            ]);
        const member = this.memberDirectory(run);
        // Either runtime finds the member's sign-ins where they made them.
        environment[CREDENTIAL_ROOT_VARIABLE] = await this.home.ensure(
            WorkerRunEnvironment.credentialRoot(member)
        );
        if (run.runtime === 'local') {
            Object.assign(environment, this.memberEnvironment(member, runner));
            return environment;
        }
        environment.DOCKER_CONFIG = await this.dockerConfig(run);
        return environment;
    }

    /**
     * What a member's runner sign-in runs with: what a local run of theirs
     * inherits, with the runner's login pointed into their sign-ins. `id`
     * names its temporary directory, which `release` removes.
     */
    async signIn(
        id: string,
        directory: string,
        runner: string
    ): Promise<Record<string, string | undefined>> {
        return {
            ...this.#inherited(),
            ...(await this.#temporary(id)),
            ...this.memberEnvironment(directory, runner),
            ...(this.runners
                .find(runner)
                ?.workerSignIn?.environment?.(
                    WorkerRunEnvironment.credentialRoot(directory)
                ) ?? {}),
        };
    }

    /** Where a member's runner sign-ins are: their data home. */
    static credentialRoot(directory: string): string {
        return join(directory, '.local', 'share');
    }

    /** The directory of the member who started the run, or the empty one without a member. */
    memberDirectory(run: Pick<WorkerRunSpec, 'member_id'>): string {
        return run.member_id
            ? this.home.memberDirectory(run.member_id)
            : this.home.anonymousDirectory;
    }

    /**
     * Makes a member directory a runner's home: `HOME`, the XDG config, data
     * and state locations, and the runner's own credential root the way
     * `wb connect` points it at a credential store. The member's sign-in runs
     * under the same environment, so a run finds exactly what they signed in to.
     */
    memberEnvironment(directory: string, runner: string): Record<string, string> {
        const data = WorkerRunEnvironment.credentialRoot(directory);
        return {
            HOME: directory,
            XDG_CONFIG_HOME: join(directory, '.config'),
            XDG_DATA_HOME: data,
            XDG_STATE_HOME: join(directory, '.local', 'state'),
            ...(this.runners.find(runner)?.credentials?.environment(data) ?? {}),
        };
    }

    /** This process's environment without credentials, Docker settings, or engine variables. */
    #inherited(): Record<string, string | undefined> {
        const credentials = new Set(
            this.runners.list().flatMap((runner) => runner.nativeCredentialVariables)
        );
        const environment: Record<string, string | undefined> = {};
        for (const [name, value] of Object.entries(this.base)) {
            if (
                !RepositoryCredentials.isProtected(name) &&
                !credentials.has(name) &&
                !name.startsWith('DOCKER_') &&
                !name.startsWith('WORKBENCH_')
            )
                environment[name] = value;
        }
        return environment;
    }

    /** Removes what a finished run held: its Docker client configuration and temporary directory. */
    async release(runId: string): Promise<void> {
        await rm(this.home.dockerConfigDirectory(runId), {
            recursive: true,
            force: true,
        });
        await rm(this.temporaryDirectory(runId), { recursive: true, force: true });
    }

    /** The run's own temporary directory, short enough for Unix socket paths beneath it. */
    temporaryDirectory(runId: string): string {
        return join(
            this.home.root,
            'tmp',
            createHash('sha256').update(runId).digest('hex').slice(0, 12)
        );
    }

    /**
     * Creates the run's temporary directory and returns the variables that
     * point a run at it, and that keep git and `gh` off the account's
     * configuration: no system git configuration, an empty global one and an
     * empty `gh` directory the run owns, and no prompts.
     */
    async #temporary(runId: string): Promise<Record<string, string>> {
        await this.home.ensure(join(this.home.root, 'tmp'));
        const directory = await this.home.ensure(this.temporaryDirectory(runId));
        const gitConfig = join(directory, 'gitconfig');
        await writeFile(gitConfig, '', { flag: 'a', mode: 0o600 });
        return {
            TMPDIR: directory,
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: gitConfig,
            GIT_TERMINAL_PROMPT: '0',
            GH_CONFIG_DIR: await this.home.ensure(join(directory, 'gh')),
        };
    }

    /** Removes what runs other than the `active` ones still hold, after a restart. */
    async releaseExcept(active: ReadonlySet<string>): Promise<void> {
        const docker = join(this.home.root, 'docker');
        const temporary = join(this.home.root, 'tmp');
        const kept = new Set(
            [...active].map((runId) => basename(this.temporaryDirectory(runId)))
        );
        const remove = async (root: string, keep: ReadonlySet<string>) => {
            const entries = await readdir(root).catch(() => []);
            await Promise.all(
                entries
                    .filter((entry) => !keep.has(entry))
                    .map((entry) =>
                        rm(join(root, entry), { recursive: true, force: true })
                    )
            );
        };
        await remove(docker, active);
        // The daemon's own temporary directory lives beside the runs'.
        await remove(temporary, new Set([...kept, 'daemon']));
    }

    /**
     * A Docker client configuration that holds only the run's own pull
     * credential, so neither a pull nor the pre-run check can use the
     * account's Docker login. The file is owner-only and removed when the
     * run ends. `DOCKER_AUTH_CONFIG` would keep it off disk, but older
     * Docker CLI releases do not read it.
     */
    private async dockerConfig(run: WorkerRunSpec): Promise<string> {
        await this.home.ensure(join(this.home.root, 'docker'));
        const directory = await this.home.ensure(
            this.home.dockerConfigDirectory(run.run_id)
        );
        await writeFile(
            join(directory, 'config.json'),
            `${JSON.stringify(run.image_pull ? dockerAuthConfig(run.image_pull) : {})}\n`,
            { mode: 0o600 }
        );
        return directory;
    }
}

/** The Docker client's registry credential for one registry, as `config.json` holds it. */
export function dockerAuthConfig(pull: {
    registry: string;
    username: string;
    password: string;
}): { auths: Record<string, { auth: string }> } {
    return {
        auths: {
            [pull.registry]: {
                auth: Buffer.from(`${pull.username}:${pull.password}`).toString(
                    'base64'
                ),
            },
        },
    };
}
