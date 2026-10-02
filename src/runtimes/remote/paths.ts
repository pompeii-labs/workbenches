import { posix, relative, resolve, sep } from 'node:path';

import { ActiveModelCatalog, ModelRouter } from '../../models/index.js';
import type { ResolvedWorkbench } from '../../types.js';
import type { RuntimePrepareRequest } from '../contracts.js';
import type { TransferRules } from '../staging/rules.js';
import type { AssetSource } from '../staging/source.js';
import type { AssetBinding } from '../staging/transfer.js';

/** Where each staged asset lands in a sandbox, and how host paths map to it. */
export class PathPlan {
    readonly bindings: AssetBinding[];

    constructor(
        private readonly request: RuntimePrepareRequest,
        private readonly rules: TransferRules
    ) {
        const workspace = resolve(request.workspaceDirectory);
        const packageDirectory = resolve(request.workbench.packageDirectory);
        const unique = new Map<string, AssetBinding>();
        for (const asset of request.assets) {
            const hostPath = resolve(asset.path);
            const existing = unique.get(hostPath);
            const binding: AssetBinding = asset.git
                ? {
                      hostPath,
                      runtimePath: '/workspace/.git',
                      access: asset.access,
                      excludedHostPaths: [],
                      kind: 'git',
                  }
                : asset.workspace
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
            if (request.credentials.runtime !== rules.provider.toLowerCase()) {
                throw new Error(
                    `${rules.provider} received credential storage for the ${request.credentials.runtime} runtime`
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
                        this.rules.contains(binding.hostPath, candidate.hostPath)
                )
                .map((candidate) => candidate.hostPath)
                .toSorted(),
        }));
    }

    /** Checks every staged path exists in `source`. */
    async verify(source: AssetSource): Promise<void> {
        for (const binding of this.bindings) {
            const entry = await source.stat(binding.hostPath);
            if (!entry) {
                throw new Error(`Runtime asset does not exist: ${binding.hostPath}`);
            }
            if (entry.kind !== 'directory' && entry.kind !== 'file') {
                throw new Error(`Unsupported runtime asset: ${binding.hostPath}`);
            }
            if (entry.kind === 'file' && binding.access === 'read-write') {
                throw new Error(
                    `${this.rules.provider} read-write runtime assets must be directories: ${binding.hostPath}`
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
            .filter((binding) => this.rules.contains(binding.hostPath, requested))
            .toSorted((left, right) => right.hostPath.length - left.hostPath.length)[0];
        if (!match) {
            throw new Error(
                `Path is not staged in ${this.rules.provider} runtime: ${hostPath}`
            );
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
            ...(this.request.repository
                ? {
                      WORKBENCH_REPOSITORY: this.request.repository.name,
                      WORKBENCH_REPOSITORY_REVISION: this.request.repository.revision,
                  }
                : {}),
            ...(credentials && this.request.workbench.manifest.runner === 'opencode'
                ? { XDG_DATA_HOME: credentials.runtimePath }
                : {}),
            ...(credentials && this.request.workbench.manifest.runner === 'pi'
                ? { WORKBENCH_CREDENTIALS_DIR: credentials.runtimePath }
                : {}),
            ...(this.request.outcome ? { WORKBENCH_OUTPUT_DIR: '/outbox' } : {}),
            ...Object.fromEntries(
                this.environmentNames(this.request.workbench).map((name) => [
                    name,
                    this.request.environment[name],
                ])
            ),
            ...(this.request.repository?.delivery === 'pr'
                ? Object.fromEntries(
                      [
                          'GH_TOKEN',
                          'GIT_TERMINAL_PROMPT',
                          'GIT_CONFIG_COUNT',
                          'GIT_CONFIG_KEY_0',
                          'GIT_CONFIG_VALUE_0',
                          'GIT_CONFIG_KEY_1',
                          'GIT_CONFIG_VALUE_1',
                          'GIT_CONFIG_KEY_2',
                          'GIT_CONFIG_VALUE_2',
                          'GIT_CONFIG_KEY_3',
                          'GIT_CONFIG_VALUE_3',
                      ].map((name) => [name, this.request.environment[name]])
                  )
                : {}),
        };
    }

    /**
     * The variables forwarded into the sandbox. The provider's own `<NAME>_API_KEY`
     * and `<NAME>_API_URL` provisioning settings stay on the host.
     */
    private environmentNames(workbench: ResolvedWorkbench): string[] {
        const prefix = this.rules.provider.toUpperCase();
        const hostOnly = new Set([`${prefix}_API_KEY`, `${prefix}_API_URL`]);
        return [
            ...new Set([
                ...Object.keys(workbench.manifest.env),
                ...new ModelRouter(
                    ActiveModelCatalog.current()
                ).providerEnvironmentNames(workbench),
            ]),
        ].filter((name) => !hostOnly.has(name));
    }

    private repositoryPathFor(workbench: ResolvedWorkbench): string {
        const repository = resolve(workbench.repositoryDirectory);
        if (
            this.bindings.some((binding) =>
                this.rules.contains(binding.hostPath, repository)
            )
        ) {
            return this.pathFor(repository);
        }
        return this.pathFor(workbench.packageDirectory);
    }
}
