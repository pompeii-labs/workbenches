import { basename } from 'node:path';

import { SavedWorkbenchCatalog } from '../catalog/index.js';
import {
    ConnectionInspector,
    ConnectionStore,
    type RunnerAuthenticationStatus,
} from '../connections/index.js';
import {
    connectCommand,
    type ModelRoute,
    ModelRouter,
    modelLabel,
} from '../models/index.js';
import { RunnerRegistry } from '../runners/registry.js';
import type { PreparedRunner } from '../runners/runner.js';
import { type PreparedRuntime, RuntimeRegistry } from '../runtimes/index.js';
import {
    GitHubWorkbenchSource,
    type RemoteWorkbenchSummary,
} from '../sources/index.js';
import { workbenchHome } from '../storage.js';
import type { ResolvedWorkbench } from '../types.js';
import { WorkbenchPreflight } from './preflight.js';
import { WorkbenchSource } from './source.js';
import { Workbench } from './workbench.js';

export type WorkbenchOrigin =
    | {
          kind: 'saved';
          alias: string;
          source: string;
          selector: string;
          revision?: string;
          digest: string;
          added_at: string;
          package: string;
      }
    | {
          kind: 'local';
          source: string;
          selector: string;
          revision?: string;
      }
    | {
          kind: 'github';
          source: string;
          selector: string;
          revision: string;
      };

export interface WorkbenchView {
    origin: WorkbenchOrigin;
    spec: number;
    name: string;
    version: string;
    description?: string;
    runner: string;
    model: string;
    model_routes: Array<{
        provider: string;
        model: string;
        authenticated?: boolean;
    }>;
    runner_auth: {
        status: 'ready' | 'required' | 'unchecked' | 'unavailable';
        connect_command: string;
        provider?: string;
    };
    runtime: string;
    image?: string;
    docker_engine?: { mode: 'host'; authorization: 'explicit' };
    instructions: string;
    skills: string[];
    tools: string[];
    workspaces: Array<{
        name: string;
        required: boolean;
        access: 'read-only' | 'read-write';
    }>;
    environment: Array<{ name: string; required: boolean; bound: boolean }>;
    mcps: Array<{
        name: string;
        transport: string;
        url: string;
        status: 'enabled' | 'disabled';
        missing_env: string[];
    }>;
}

interface WorkbenchInspectionOptions {
    workbench: ResolvedWorkbench;
    origin: WorkbenchOrigin;
    environment?: Record<string, string | undefined>;
    reference?: string;
    authentication?: RunnerAuthenticationStatus | 'unavailable';
}

export class WorkbenchInspection {
    private constructor(readonly data: WorkbenchView) {}

    static describe(options: WorkbenchInspectionOptions): WorkbenchInspection {
        const manifest = options.workbench.manifest;
        const environment = options.environment ?? process.env;
        return new WorkbenchInspection({
            origin: options.origin,
            spec: manifest.spec,
            name: manifest.name,
            version: manifest.version,
            ...(manifest.description ? { description: manifest.description } : {}),
            runner: manifest.runner,
            model: modelLabel(manifest.model),
            model_routes: WorkbenchInspection.modelRoutes(
                options.workbench,
                options.authentication
            ),
            runner_auth: WorkbenchInspection.runnerAuthentication(options),
            runtime: manifest.runtime,
            ...(manifest.image
                ? {
                      image:
                          typeof manifest.image === 'string'
                              ? manifest.image
                              : `${manifest.image.build} (build context ${manifest.image.context ?? '.'})`,
                  }
                : {}),
            ...(manifest.docker?.engine
                ? {
                      docker_engine: {
                          mode: manifest.docker.engine.mode,
                          authorization: 'explicit' as const,
                      },
                  }
                : {}),
            instructions: manifest.instructions,
            skills: options.workbench.skills.map((skill) => skill.name),
            tools: manifest.tools,
            workspaces: Object.entries(manifest.workspaces ?? {}).map(
                ([name, requirement]) => ({ name, ...requirement })
            ),
            environment: Object.entries(manifest.env).map(([name, requirement]) => ({
                name,
                required: requirement.required,
                bound: Boolean(environment[name]),
            })),
            mcps: manifest.mcps.map((mcp) => {
                const references = new Set(
                    Object.values(mcp.headers).flatMap((value) =>
                        WorkbenchPreflight.environmentReferences(value)
                    )
                );
                const missing = [...references].filter((name) => !environment[name]);
                return {
                    name: mcp.name,
                    transport: mcp.transport,
                    url: mcp.url,
                    status: missing.length ? 'disabled' : 'enabled',
                    missing_env: missing,
                };
            }),
        });
    }

    toJSON(): WorkbenchView {
        return this.data;
    }

    render(): string {
        const view = this.data;
        const lines = [`${view.name}@${view.version}`];
        if (view.description) lines.push(view.description);
        lines.push('');
        this.field(lines, 'Origin', view.origin.kind);
        if (view.origin.kind === 'saved') this.field(lines, 'Alias', view.origin.alias);
        this.field(lines, 'Source', view.origin.source);
        this.field(lines, 'Selector', view.origin.selector);
        if (view.origin.revision) this.field(lines, 'Revision', view.origin.revision);
        if (view.origin.kind === 'saved') {
            this.field(lines, 'Digest', view.origin.digest);
            this.field(lines, 'Added', view.origin.added_at);
            this.field(lines, 'Package', view.origin.package);
        }
        this.field(lines, 'Spec', String(view.spec));
        this.field(lines, 'Version', view.version);
        this.field(lines, 'Runner', view.runner);
        this.field(lines, 'Model', view.model);
        this.field(lines, 'Routes', this.renderRoutes());
        this.field(
            lines,
            'Runner auth',
            `${view.runner_auth.status}${view.runner_auth.provider ? ` via ${view.runner_auth.provider}` : ''} · ${view.runner_auth.connect_command}`
        );
        this.field(lines, 'Runtime', view.runtime);
        this.field(lines, 'Image', view.image ?? 'none');
        this.field(
            lines,
            'Docker engine',
            view.docker_engine
                ? `${view.docker_engine.mode} · explicit authorization required`
                : 'none'
        );
        this.field(lines, 'Instructions', view.instructions);
        this.field(lines, 'Skills', view.skills.join(', ') || 'none');
        this.field(lines, 'Tools', view.tools.join(', ') || 'none');
        this.renderCollections(lines);
        return `${lines.join('\n')}\n`;
    }

    private renderRoutes(): string {
        const routes = this.data.model_routes;
        if (routes.length === 0) return 'none';
        const ready = routes.filter((route) => route.authenticated === true);
        const visible = (ready.length > 0 ? ready : routes).slice(0, 3);
        const shown = new Set(visible);
        const remaining = routes.filter((route) => !shown.has(route)).length;
        return [
            ...visible.map(
                (route) =>
                    `${route.provider}/${route.model}${route.authenticated === undefined ? '' : route.authenticated ? ' (ready)' : ' (not connected)'}`
            ),
            ...(remaining > 0 ? [`${remaining} more allowed`] : []),
        ].join(', ');
    }

    private renderCollections(lines: string[]): void {
        lines.push('', 'Workspaces');
        if (this.data.workspaces.length === 0) lines.push('  none');
        for (const workspace of this.data.workspaces) {
            lines.push(
                `  ${workspace.name} · ${workspace.required ? 'required' : 'optional'} · ${workspace.access}`
            );
        }
        lines.push('', 'Environment');
        if (this.data.environment.length === 0) lines.push('  none');
        for (const variable of this.data.environment) {
            lines.push(
                `  ${variable.name} · ${variable.required ? 'required' : 'optional'} · ${variable.bound ? 'bound' : 'unbound'}`
            );
        }
        lines.push('', 'MCPs');
        if (this.data.mcps.length === 0) lines.push('  none');
        for (const mcp of this.data.mcps) {
            const reason = mcp.missing_env.length
                ? ` (missing ${mcp.missing_env.join(', ')})`
                : '';
            lines.push(
                `  ${mcp.name} · ${mcp.transport} · ${mcp.url} · ${mcp.status}${reason}`
            );
        }
    }

    private field(lines: string[], label: string, value: string): void {
        lines.push(`${label.padEnd(12)} ${value}`);
    }

    private static modelRoutes(
        workbench: ResolvedWorkbench,
        authentication: RunnerAuthenticationStatus | 'unavailable' | undefined
    ): WorkbenchView['model_routes'] {
        if (authentication && authentication !== 'unavailable') {
            return authentication.routes.map((route) => ({
                provider: route.provider,
                model: route.model,
                authenticated: route.authenticated,
            }));
        }
        return WorkbenchInspection.declaredRoutes(workbench).map((route) => ({
            provider: route.provider,
            model: route.model,
        }));
    }

    private static declaredRoutes(workbench: ResolvedWorkbench): ModelRoute[] {
        try {
            return new ModelRouter().routes(workbench);
        } catch {
            const declared = workbench.manifest.model;
            return (declared.routes ?? []).map((route) => ({
                provider: route.provider,
                model: route.model ?? declared.id,
                value: `${route.provider}/${route.model ?? declared.id}`,
            }));
        }
    }

    private static runnerAuthentication(
        options: WorkbenchInspectionOptions
    ): WorkbenchView['runner_auth'] {
        const command = connectCommand(
            options.reference ?? options.workbench.manifest.name
        );
        if (options.authentication === 'unavailable') {
            return { status: 'unavailable', connect_command: command };
        }
        if (!options.authentication) {
            return { status: 'unchecked', connect_command: command };
        }
        if (!options.authentication.ready) {
            return {
                status: 'required',
                connect_command: options.authentication.connectCommand,
            };
        }
        return {
            status: 'ready',
            connect_command: options.authentication.connectCommand,
            ...(options.authentication.configuration
                ? { provider: options.authentication.configuration.provider }
                : {}),
        };
    }
}

export class WorkbenchInspector {
    constructor(private readonly home = workbenchHome()) {}

    async inspect(value: string): Promise<WorkbenchInspection> {
        const saved =
            !value.includes('/') && !value.includes('#')
                ? await new SavedWorkbenchCatalog(this.home).find(value)
                : undefined;
        if (saved) {
            const workbench = await Workbench.load(saved.packagePath);
            return this.describeResolved(workbench, value, {
                kind: 'saved',
                alias: saved.alias,
                source: saved.source,
                selector: saved.selector,
                ...(saved.revision ? { revision: saved.revision } : {}),
                digest: saved.digest,
                added_at: saved.addedAt,
                package: saved.packagePath,
            });
        }

        const source = new WorkbenchSource();
        const reference = source.parse(value);
        const local = await source.local(reference.source);
        if (local) {
            const workbench = await source.select(local.directory, reference.selector);
            return this.describeResolved(workbench, value, {
                kind: 'local',
                source: local.source,
                selector: basename(workbench.packageDirectory),
                ...(local.revision ? { revision: local.revision } : {}),
            });
        }

        const github = new GitHubWorkbenchSource();
        const selected = this.selectRemote(
            await github.list(reference.source),
            reference.selector
        );
        return WorkbenchInspection.describe({
            workbench: github.resolve(selected),
            reference: value,
            origin: {
                kind: 'github',
                source: selected.source,
                selector: selected.selector,
                revision: selected.revision,
            },
        });
    }

    private async describeResolved(
        workbench: Workbench,
        reference: string,
        origin: WorkbenchOrigin
    ): Promise<WorkbenchInspection> {
        if (workbench.manifest.runtime !== 'local') {
            return WorkbenchInspection.describe({ workbench, reference, origin });
        }
        let runner: PreparedRunner | undefined;
        let runtime: PreparedRuntime | undefined;
        try {
            runner = await RunnerRegistry.standard().prepare(workbench, process.env);
            runtime = await RuntimeRegistry.standard()
                .resolve('local')
                .prepare({
                    workbench,
                    workspaceDirectory: workbench.repositoryDirectory,
                    environment: process.env,
                    assets: [
                        { path: workbench.repositoryDirectory, access: 'read-write' },
                        { path: workbench.packageDirectory, access: 'read-only' },
                        ...runner.assets,
                    ],
                    purpose: 'connect',
                    authorizations: { hostDocker: false },
                });
            const authentication = await new ConnectionInspector({
                workbench,
                runtime,
                runner,
                reference,
                store: new ConnectionStore(this.home),
            }).inspect();
            return WorkbenchInspection.describe({
                workbench,
                reference,
                origin,
                authentication,
            });
        } catch {
            return WorkbenchInspection.describe({
                workbench,
                reference,
                origin,
                authentication: 'unavailable',
            });
        } finally {
            await Promise.allSettled([runtime?.cleanup(), runner?.cleanup()]);
        }
    }

    private selectRemote(
        available: RemoteWorkbenchSummary[],
        selector?: string
    ): RemoteWorkbenchSummary {
        if (available.length === 0) {
            throw new Error('No Workbenches found in repository');
        }
        if (selector) {
            const selected = available.find(
                (workbench) =>
                    workbench.selector === selector ||
                    workbench.manifest.name === selector
            );
            if (!selected) throw new Error(`Workbench not found: ${selector}`);
            return selected;
        }
        if (available.length > 1) {
            throw new Error(
                `Workbench selector required. Available: ${available.map((workbench) => workbench.selector).join(', ')}`
            );
        }
        return available[0] as RemoteWorkbenchSummary;
    }
}
