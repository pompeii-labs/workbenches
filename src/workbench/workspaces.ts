import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import type { ResolvedWorkbench, WorkbenchWorkspaceBinding } from '../types.js';

export class WorkbenchWorkspaces {
    parse(rawArgs: string[]): Map<string, string> {
        const assignments = new Map<string, string>();
        for (let index = 0; index < rawArgs.length; index += 1) {
            const argument = rawArgs[index];
            if (argument === '--') break;
            let assignment: string | undefined;
            if (argument === '--workspace') {
                assignment = rawArgs[index + 1];
                index += 1;
            } else if (argument?.startsWith('--workspace=')) {
                assignment = argument.slice('--workspace='.length);
            } else {
                continue;
            }
            if (assignment === undefined) {
                throw new Error('--workspace requires NAME=PATH');
            }
            const separator = assignment.indexOf('=');
            const name = separator < 0 ? '' : assignment.slice(0, separator);
            const path = separator < 0 ? '' : assignment.slice(separator + 1);
            if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name === 'primary') {
                throw new Error(
                    '--workspace requires a lowercase NAME=PATH assignment'
                );
            }
            if (!path) {
                throw new Error(`Workspace path must not be empty: ${name}`);
            }
            if (assignments.has(name)) {
                throw new Error(`Duplicate workspace binding: ${name}`);
            }
            assignments.set(name, path);
        }
        return assignments;
    }

    async bind(options: {
        workbench: ResolvedWorkbench;
        rawArgs?: string[];
        cwd?: string;
    }): Promise<WorkbenchWorkspaceBinding[]> {
        const declared = options.workbench.manifest.workspaces ?? {};
        const assignments = this.parse(options.rawArgs ?? []);
        for (const name of assignments.keys()) {
            if (!declared[name]) {
                throw new Error(
                    `Workspace binding is not declared by ${options.workbench.manifest.name}: ${name}`
                );
            }
        }
        for (const [name, requirement] of Object.entries(declared)) {
            if (requirement.required && !assignments.has(name)) {
                throw new Error(`Missing required workspace binding: ${name}`);
            }
        }

        const bindings: WorkbenchWorkspaceBinding[] = [];
        const boundPaths = new Map<string, string>();
        for (const [name, source] of assignments) {
            const path = await this.directory(
                name,
                resolve(options.cwd ?? process.cwd(), source)
            );
            const existing = boundPaths.get(path);
            if (existing) {
                throw new Error(
                    `Workspace bindings must resolve to distinct directories: ${existing}, ${name}`
                );
            }
            const requirement = declared[name];
            if (!requirement) continue;
            await this.assertAccess(name, path, requirement.access);
            boundPaths.set(path, name);
            bindings.push({ name, path, access: requirement.access });
        }
        return bindings;
    }

    environment(
        bindings: WorkbenchWorkspaceBinding[],
        pathFor: (path: string) => string = (path) => path
    ): Record<string, string> {
        return Object.fromEntries(
            bindings.map((binding) => [
                `WORKBENCH_WORKSPACE_${binding.name
                    .toUpperCase()
                    .replaceAll('-', '_')}`,
                pathFor(binding.path),
            ])
        );
    }

    async validate(
        workbench: ResolvedWorkbench,
        bindings: WorkbenchWorkspaceBinding[]
    ): Promise<void> {
        const declared = workbench.manifest.workspaces ?? {};
        const names = new Set<string>();
        const paths = new Set<string>();
        for (const binding of bindings) {
            if (
                !binding ||
                typeof binding.name !== 'string' ||
                typeof binding.path !== 'string' ||
                !['read-only', 'read-write'].includes(binding.access)
            ) {
                throw new Error('Invalid workspace binding');
            }
            const requirement = declared[binding.name];
            if (!requirement) {
                throw new Error(
                    `Workspace binding is not declared by ${workbench.manifest.name}: ${binding.name}`
                );
            }
            if (binding.access !== requirement.access) {
                throw new Error(
                    `Workspace binding access does not match manifest: ${binding.name}`
                );
            }
            if (names.has(binding.name)) {
                throw new Error(`Duplicate workspace binding: ${binding.name}`);
            }
            names.add(binding.name);
            if (!isAbsolute(binding.path)) {
                throw new Error(
                    `Workspace binding path must be absolute: ${binding.name}`
                );
            }
            const canonical = await this.directory(binding.name, binding.path);
            if (canonical !== binding.path) {
                throw new Error(
                    `Workspace binding path must be canonical: ${binding.name}`
                );
            }
            if (paths.has(canonical)) {
                throw new Error(
                    'Workspace bindings must resolve to distinct directories'
                );
            }
            paths.add(canonical);
            await this.assertAccess(binding.name, canonical, requirement.access);
        }
        for (const [name, requirement] of Object.entries(declared)) {
            if (requirement.required && !names.has(name)) {
                throw new Error(`Missing required workspace binding: ${name}`);
            }
        }
    }

    private async directory(name: string, requested: string): Promise<string> {
        const canonical = await realpath(requested).catch(() => null);
        const details = canonical ? await stat(canonical).catch(() => null) : null;
        if (!canonical || !details?.isDirectory()) {
            throw new Error(`Workspace directory is unavailable: ${name}`);
        }
        return canonical;
    }

    private async assertAccess(
        name: string,
        path: string,
        mode: 'read-only' | 'read-write'
    ): Promise<void> {
        await access(
            path,
            constants.R_OK | (mode === 'read-write' ? constants.W_OK : 0)
        ).catch(() => {
            throw new Error(
                `Workspace directory is not ${mode === 'read-write' ? 'writable' : 'readable'}: ${name}`
            );
        });
    }
}
