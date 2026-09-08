import { lstat, readdir, readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { CredentialFilePolicy } from './credentials.js';

const credentialFieldPattern =
    /^(?:api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|authorization|cookie|password|private[-_]?key|secret|token)$/i;

export class RunnerConfiguration {
    readonly #credentials = new CredentialFilePolicy();

    async validate(path: string): Promise<void> {
        const metadata = await lstat(path).catch(() => null);
        if (!metadata) throw new Error(`runner_config does not exist: ${path}`);
        if (metadata.isSymbolicLink()) {
            throw new Error(`runner_config must not contain symbolic links: ${path}`);
        }
        if (metadata.isDirectory()) {
            for (const entry of await readdir(path, { withFileTypes: true })) {
                if (this.#credentials.matches(entry.name)) {
                    throw new Error(
                        `runner_config contains a credential file: ${entry.name}`
                    );
                }
                await this.validate(resolve(path, entry.name));
            }
            return;
        }
        if (!metadata.isFile()) {
            throw new Error('runner_config must be a file or directory');
        }
        if (this.#credentials.matches(basename(path))) {
            throw new Error(
                `runner_config contains a credential file: ${basename(path)}`
            );
        }
        if (!path.toLowerCase().endsWith('.json')) return;

        let parsed: unknown;
        try {
            parsed = JSON.parse(await readFile(path, 'utf8'));
        } catch {
            throw new Error(`runner_config JSON is invalid: ${path}`);
        }
        this.assertEnvironmentCredentials(parsed, path);
    }

    private assertEnvironmentCredentials(value: unknown, path: string): void {
        if (Array.isArray(value)) {
            for (const entry of value) {
                this.assertEnvironmentCredentials(entry, path);
            }
            return;
        }
        if (!value || typeof value !== 'object') return;
        for (const [key, entry] of Object.entries(value)) {
            if (
                credentialFieldPattern.test(key) &&
                typeof entry === 'string' &&
                !this.isEnvironmentReference(entry)
            ) {
                throw new Error(
                    `runner_config must reference credentials by environment name, not ${key}: ${path}`
                );
            }
            this.assertEnvironmentCredentials(entry, path);
        }
    }

    private isEnvironmentReference(value: string): boolean {
        return /^(?:[A-Za-z][A-Za-z0-9._~-]*\s+)?(?:[A-Z][A-Z0-9_]*|\$\{[A-Z][A-Z0-9_]*\}|\{env:[A-Z][A-Z0-9_]*\})$/.test(
            value
        );
    }
}
