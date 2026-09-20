import { stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { ModelRouter } from '../../models/index.js';
import type { ResolvedWorkbench } from '../../types.js';
import type { RuntimePrepareRequest } from '../contracts.js';
import type { DockerHostSocket } from './contracts.js';

interface DockerMount {
    hostPath: string;
    runtimePath: string;
    access: 'read-only' | 'read-write';
    translate?: boolean;
}

export class DockerMountPlan {
    private readonly mounts: DockerMount[];

    constructor(
        private readonly request: RuntimePrepareRequest,
        hostSocket?: DockerHostSocket
    ) {
        const workspace = resolve(request.workspaceDirectory);
        const packageDirectory = resolve(request.workbench.packageDirectory);
        const unique = new Map<string, DockerMount>();
        for (const asset of request.assets) {
            const hostPath = resolve(asset.path);
            let runtimePath: string;
            if (asset.git) {
                runtimePath = join(hostSocket ? workspace : '/workspace', '.git');
            } else if (asset.workspace) {
                runtimePath = hostSocket ? hostPath : `/workspaces/${asset.workspace}`;
            } else if (hostPath === workspace) {
                runtimePath = hostSocket ? hostPath : '/workspace';
            } else if (hostPath === packageDirectory) {
                runtimePath = '/workbench';
            } else {
                runtimePath = `/runtime-assets/${unique.size}`;
            }
            const existing = unique.get(hostPath);
            if (existing && existing.runtimePath !== runtimePath) {
                throw new Error(
                    `Runtime assets must resolve to distinct mount points: ${hostPath}`
                );
            }
            unique.set(hostPath, {
                hostPath,
                runtimePath,
                access: asset.access,
            });
        }
        if (request.outcome) {
            unique.set(resolve(request.outcome.directory), {
                hostPath: resolve(request.outcome.directory),
                runtimePath: '/outbox',
                access: 'read-write',
            });
        }
        if (hostSocket) {
            unique.set(resolve(hostSocket.path), {
                hostPath: resolve(hostSocket.path),
                runtimePath: '/var/run/docker.sock',
                access: 'read-write',
            });
        }
        this.mounts = [...unique.values()];
        const primary = this.mounts.find((mount) => mount.hostPath === workspace);
        if (
            primary &&
            packageDirectory !== workspace &&
            contains(workspace, packageDirectory)
        ) {
            this.mounts.push({
                hostPath: packageDirectory,
                runtimePath: join(
                    primary.runtimePath,
                    relative(workspace, packageDirectory)
                ),
                access: 'read-only',
                translate: false,
            });
        }
    }

    async verify(): Promise<void> {
        for (const mount of this.mounts) {
            const entry = await stat(mount.hostPath).catch(() => null);
            if (!entry) {
                throw new Error(`Runtime asset does not exist: ${mount.hostPath}`);
            }
            if (mount.hostPath.includes('\n') || mount.hostPath.includes('\r')) {
                throw new Error('Runtime asset paths must not contain newlines');
            }
            if (mount.hostPath.includes(':')) {
                throw new Error('Runtime asset paths must not contain colons');
            }
        }
    }

    pathFor(hostPath: string): string {
        const requested = resolve(hostPath);
        const match = this.mounts
            .filter(
                (mount) =>
                    mount.translate !== false && contains(mount.hostPath, requested)
            )
            .toSorted((left, right) => right.hostPath.length - left.hostPath.length)[0];
        if (!match) {
            throw new Error(`Path is not staged in Docker runtime: ${hostPath}`);
        }
        const suffix = relative(match.hostPath, requested);
        return suffix ? join(match.runtimePath, suffix) : match.runtimePath;
    }

    arguments(): string[] {
        return this.mounts.flatMap((mount) => [
            '--volume',
            `${mount.hostPath}:${mount.runtimePath}${mount.access === 'read-only' ? ':ro' : ''}`,
        ]);
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

    containerEnvironment(): Record<string, string | undefined> {
        return {
            HOME: '/tmp/workbench-home',
            ...(this.request.repository
                ? {
                      WORKBENCH_REPOSITORY: this.request.repository.name,
                      WORKBENCH_REPOSITORY_REVISION: this.request.repository.revision,
                  }
                : {}),
            ...Object.fromEntries(
                DockerMountPlan.environmentNames(this.request.workbench).map((name) => [
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

    static environmentNames(workbench: ResolvedWorkbench): string[] {
        return [
            ...new Set([
                ...Object.keys(workbench.manifest.env),
                ...new ModelRouter().providerEnvironmentNames(workbench),
            ]),
        ];
    }

    private repositoryPathFor(workbench: ResolvedWorkbench): string {
        const repository = resolve(workbench.repositoryDirectory);
        if (this.mounts.some((mount) => contains(mount.hostPath, repository))) {
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
