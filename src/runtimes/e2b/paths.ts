import { stat } from 'node:fs/promises';
import { isAbsolute, posix, relative, resolve, sep } from 'node:path';

import { ModelRouter } from '../../models/index.js';
import type { ResolvedWorkbench } from '../../types.js';
import type { RuntimePrepareRequest } from '../contracts.js';

export interface E2BAssetBinding {
    hostPath: string;
    runtimePath: string;
    access: 'read-only' | 'read-write';
    excludedHostPaths: string[];
    workspace?: string;
    kind: 'workspace' | 'package' | 'asset' | 'credentials' | 'state' | 'outcome';
}

export class E2BPathPlan {
    readonly bindings: E2BAssetBinding[];

    constructor(private readonly request: RuntimePrepareRequest) {
        const workspace = resolve(request.workspaceDirectory);
        const packageDirectory = resolve(request.workbench.packageDirectory);
        const unique = new Map<string, E2BAssetBinding>();
        for (const asset of request.assets) {
            const hostPath = resolve(asset.path);
            const existing = unique.get(hostPath);
            const binding: E2BAssetBinding = asset.workspace
                ? {
                      hostPath,
                      runtimePath: `/workspaces/${asset.workspace}`,
                      access: asset.access,
                      excludedHostPaths: [],
                      workspace: asset.workspace,
                      kind: 'workspace',
                  }
                : asset.state
                  ? {
                        hostPath,
                        runtimePath: `/runtime-state/${unique.size}`,
                        access: asset.access,
                        excludedHostPaths: [],
                        kind: 'state',
                    }
                  : hostPath === workspace
                    ? {
                          hostPath,
                          runtimePath: '/workspace',
                          access: asset.access,
                          excludedHostPaths: [],
                          kind: 'workspace',
                      }
                    : hostPath === packageDirectory
                      ? {
                            hostPath,
                            runtimePath: '/workbench',
                            access: asset.access,
                            excludedHostPaths: [],
                            kind: 'package',
                        }
                      : {
                            hostPath,
                            runtimePath: `/runtime-assets/${unique.size}`,
                            access: asset.access,
                            excludedHostPaths: [],
                            kind: 'asset',
                        };
            if (existing && existing.runtimePath !== binding.runtimePath) {
                throw new Error(
                    `Runtime assets must resolve to distinct staged paths: ${hostPath}`
                );
            }
            unique.set(
                hostPath,
                existing?.access === 'read-write' || binding.access === 'read-write'
                    ? { ...binding, access: 'read-write' }
                    : binding
            );
        }
        if (request.credentials) {
            if (request.credentials.runtime !== 'e2b') {
                throw new Error(
                    `E2B received credential storage for the ${request.credentials.runtime} runtime`
                );
            }
            if (request.credentials.runner !== request.workbench.manifest.runner) {
                throw new Error(
                    `Runner credential storage does not match the Workbench runner: ${request.credentials.runner}`
                );
            }
            const hostPath = resolve(request.credentials.directory);
            if (unique.has(hostPath)) {
                throw new Error(
                    `Runner credential storage must be separate from runtime assets: ${hostPath}`
                );
            }
            unique.set(hostPath, {
                hostPath,
                runtimePath: '/workbench-credentials',
                access: 'read-write',
                excludedHostPaths: [],
                kind: 'credentials',
            });
        }
        if (request.outcome) {
            const hostPath = resolve(request.outcome.directory);
            if (unique.has(hostPath)) {
                throw new Error(
                    `Outcome storage must be separate from runtime assets: ${hostPath}`
                );
            }
            unique.set(hostPath, {
                hostPath,
                runtimePath: '/outbox',
                access: 'read-write',
                excludedHostPaths: [],
                kind: 'outcome',
            });
        }
        const bindings = [...unique.values()];
        this.bindings = bindings.map((binding) => ({
            ...binding,
            excludedHostPaths: bindings
                .filter(
                    (candidate) =>
                        candidate.hostPath !== binding.hostPath &&
                        contains(binding.hostPath, candidate.hostPath)
                )
                .map((candidate) => candidate.hostPath)
                .toSorted(),
        }));
    }

    async verify(): Promise<void> {
        for (const binding of this.bindings) {
            const entry = await stat(binding.hostPath).catch(() => null);
            if (!entry) {
                throw new Error(`Runtime asset does not exist: ${binding.hostPath}`);
            }
            if (!entry.isDirectory() && !entry.isFile()) {
                throw new Error(`Unsupported runtime asset: ${binding.hostPath}`);
            }
            if (entry.isFile() && binding.access === 'read-write') {
                throw new Error(
                    `E2B read-write runtime assets must be directories: ${binding.hostPath}`
                );
            }
            if (binding.hostPath.includes('\n') || binding.hostPath.includes('\r')) {
                throw new Error('Runtime asset paths must not contain newlines');
            }
        }
    }

    pathFor(hostPath: string): string {
        const requested = resolve(hostPath);
        const match = this.bindings
            .filter((binding) => contains(binding.hostPath, requested))
            .toSorted((left, right) => right.hostPath.length - left.hostPath.length)[0];
        if (!match) {
            throw new Error(`Path is not staged in E2B runtime: ${hostPath}`);
        }
        const suffix = relative(match.hostPath, requested);
        return suffix
            ? posix.join(match.runtimePath, ...suffix.split(sep))
            : match.runtimePath;
    }

    remap(workbench: ResolvedWorkbench): ResolvedWorkbench {
        return {
            ...workbench,
            manifestPath: this.pathFor(workbench.manifestPath),
            packageDirectory: this.pathFor(workbench.packageDirectory),
            repositoryDirectory: this.repositoryPathFor(workbench),
            instructionsPath: this.pathFor(workbench.instructionsPath),
            ...(workbench.runnerConfigPath
                ? { runnerConfigPath: this.pathFor(workbench.runnerConfigPath) }
                : {}),
            skills: workbench.skills.map((skill) => ({
                ...skill,
                directory: this.pathFor(skill.directory),
                manifestPath: this.pathFor(skill.manifestPath),
            })),
        };
    }

    environment(): Record<string, string | undefined> {
        const credentials = this.bindings.find(
            (binding) => binding.kind === 'credentials'
        );
        return {
            HOME: '/tmp/workbench-home',
            ...(credentials && this.request.workbench.manifest.runner === 'opencode'
                ? { XDG_DATA_HOME: credentials.runtimePath }
                : {}),
            ...(credentials && this.request.workbench.manifest.runner === 'pi'
                ? { WORKBENCH_CREDENTIALS_DIR: credentials.runtimePath }
                : {}),
            ...(this.request.outcome ? { WORKBENCH_OUTPUT_DIR: '/outbox' } : {}),
            ...Object.fromEntries(
                E2BPathPlan.environmentNames(this.request.workbench).map((name) => [
                    name,
                    this.request.environment[name],
                ])
            ),
        };
    }

    static environmentNames(workbench: ResolvedWorkbench): string[] {
        return [
            ...new Set([
                ...Object.keys(workbench.manifest.env),
                ...new ModelRouter().providerEnvironmentNames(workbench),
            ]),
        ].filter((name) => name !== 'E2B_API_KEY');
    }

    private repositoryPathFor(workbench: ResolvedWorkbench): string {
        const repository = resolve(workbench.repositoryDirectory);
        if (this.bindings.some((binding) => contains(binding.hostPath, repository))) {
            return this.pathFor(repository);
        }
        return this.pathFor(workbench.packageDirectory);
    }
}

function contains(parent: string, child: string): boolean {
    const suffix = relative(parent, child);
    return (
        suffix === '' ||
        (!suffix.startsWith(`..${sep}`) && suffix !== '..' && !isAbsolute(suffix))
    );
}
