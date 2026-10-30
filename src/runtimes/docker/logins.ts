import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { RegistryLogin } from '../daytona/contracts.js';

/** The key Docker saves a Docker Hub login under. */
const dockerHubKey = 'https://index.docker.io/v1/';
const helperPattern = /^[A-Za-z0-9._-]+$/;
const helperTimeoutMs = 30_000;

/**
 * The registry logins the Docker client keeps, as `docker login` and
 * `wb image login` save them: from the registry's credential helper, the
 * default credential store, or the config file itself. Only the image's
 * registry is ever asked for.
 */
export class DockerLogins {
    constructor(
        private readonly environment: Record<string, string | undefined> = process.env
    ) {}

    async find(host: string): Promise<RegistryLogin | undefined> {
        const config = await this.config();
        if (!config) return undefined;
        const key = host === 'registry-1.docker.io' ? dockerHubKey : host;
        const helper = record(config.credHelpers)?.[key] ?? config.credsStore;
        if (typeof helper === 'string' && helperPattern.test(helper)) {
            const login = await this.fromHelper(helper, key);
            if (login) return login;
        }
        const auths = record(config.auths);
        return saved(record(auths?.[key] ?? auths?.[`https://${key}`]));
    }

    private async config(): Promise<Record<string, unknown> | undefined> {
        const directory =
            this.environment.DOCKER_CONFIG?.trim() ||
            join(this.environment.HOME?.trim() || homedir(), '.docker');
        const text = await readFile(join(directory, 'config.json'), 'utf8').catch(
            () => undefined
        );
        if (text === undefined) return undefined;
        try {
            return record(JSON.parse(text));
        } catch {
            return undefined;
        }
    }

    /** `docker-credential-<helper> get`, or none when it is missing or has no login. */
    private async fromHelper(
        helper: string,
        key: string
    ): Promise<RegistryLogin | undefined> {
        try {
            const child = Bun.spawn([`docker-credential-${helper}`, 'get'], {
                env: this.environment,
                stdin: new Blob([key]),
                stdout: 'pipe',
                stderr: 'ignore',
                timeout: helperTimeoutMs,
            });
            const [code, output] = await Promise.all([
                child.exited,
                new Response(child.stdout).text(),
            ]);
            if (code !== 0) return undefined;
            const reply = record(JSON.parse(output));
            const username = reply?.Username;
            const secret = reply?.Secret;
            return typeof username === 'string' && typeof secret === 'string' && secret
                ? { username, secret }
                : undefined;
        } catch {
            return undefined;
        }
    }
}

/** A login saved in the config file as base64 `username:secret`. */
function saved(entry: Record<string, unknown> | undefined): RegistryLogin | undefined {
    if (typeof entry?.auth !== 'string') return undefined;
    const decoded = atob(entry.auth);
    const colon = decoded.indexOf(':');
    if (colon <= 0 || colon === decoded.length - 1) return undefined;
    return { username: decoded.slice(0, colon), secret: decoded.slice(colon + 1) };
}

function record(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}
