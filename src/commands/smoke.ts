import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { defineCommand } from 'citty';

import { SavedWorkbenchCatalog } from '../catalog/index.js';
import { CatalogSnapshots } from '../catalog/snapshots.js';
import { subscriptionLabel } from '../connections/targets.js';
import { RuntimeSmoke } from '../runtimes/index.js';
import { SmokeReport } from '../runtimes/smokereport.js';
import { GitHubWorkbenchSource } from '../sources/index.js';
import { workbenchHome } from '../storage.js';
import type { ResolvedWorkbench } from '../types.js';
import {
    selectedRuntime,
    Workbench,
    WorkbenchEnvironment,
    WorkbenchResolver,
    WorkbenchSource,
    WorkbenchWorkspaces,
    withRuntime,
} from '../workbench/index.js';
import { CliPresenter } from './presenter.js';

export const smokeCommand = defineCommand({
    meta: {
        name: 'smoke',
        description: 'Verify a Workbench can start without spending model tokens.',
    },
    args: {
        source: {
            type: 'positional',
            description: 'Workbench reference or source',
            default: '.',
        },
        'env-file': {
            type: 'string',
            valueHint: 'path',
            description:
                'Load declared and provider environment bindings from a dotenv file',
        },
        env: {
            type: 'string',
            valueHint: 'NAME=value',
            description: 'Set a declared or provider environment binding (repeatable)',
        },
        workspace: {
            type: 'string',
            valueHint: 'NAME=path',
            description: 'Bind a declared named workspace (repeatable)',
        },
        'allow-host-docker': {
            type: 'boolean',
            description:
                'Authorize a declared host Docker engine binding for this smoke',
            default: false,
        },
        runtime: {
            type: 'string',
            valueHint: 'name',
            description:
                'Declared runtime to check (defaults to the first declared runtime)',
        },
        'allow-unchecked-gpu': {
            type: 'boolean',
            description: 'Accept a GPU requirement on a runtime that cannot check it',
            default: false,
        },
        json: {
            type: 'boolean',
            description: 'Emit one JSON report per Workbench (NDJSON for several)',
            default: false,
        },
    },
    async run({ args, rawArgs }) {
        const workbenchEnvironment = new WorkbenchEnvironment();
        const overrides = await workbenchEnvironment.load({
            ...(args['env-file'] ? { envFile: args['env-file'] } : {}),
            rawArgs,
        });
        const home = workbenchHome();
        const smoke = new SmokeRun({
            ...(args.runtime ? { runtime: args.runtime } : {}),
            allowHostDocker: args['allow-host-docker'],
            allowUncheckedGpu: args['allow-unchecked-gpu'],
            json: args.json,
            rawArgs,
            environment: workbenchEnvironment,
            overrides,
            home,
        });
        const saved = !args.source.includes('/')
            ? await new SavedWorkbenchCatalog(home).find(args.source)
            : undefined;
        if (saved) {
            const resolved = await new WorkbenchResolver().resolve(args.source, {
                home,
            });
            await smoke.check(args.source, resolved.workbench, {
                workspaceDirectory: resolved.workspaceDirectory,
            });
        } else {
            const source = new WorkbenchSource();
            const reference = source.parse(args.source);
            const local = await source.local(reference.source);
            if (local) {
                const selected = reference.selector
                    ? [await source.select(local.directory, reference.selector)]
                    : await source.discover(local.directory);
                if (selected.length === 0)
                    throw new Error('No matching Workbenches found');
                for (const candidate of selected) {
                    const inRepository =
                        !reference.selector &&
                        resolve(candidate.packageDirectory) !== local.directory;
                    await smoke.check(
                        inRepository
                            ? `${args.source}#${basename(candidate.packageDirectory)}`
                            : args.source,
                        candidate
                    );
                }
            } else {
                const github = new GitHubWorkbenchSource();
                const workbenches = await github.fetchAll(
                    reference.source,
                    reference.selector
                );
                if (workbenches.length === 0)
                    throw new Error('No matching Workbenches found');
                // Smoke reads skills and instructions from disk, so the remote
                // packages are materialized into a scratch directory first.
                const scratch = await mkdtemp(join(tmpdir(), 'wb-smoke-'));
                try {
                    const snapshots = new CatalogSnapshots(scratch);
                    for (const workbench of workbenches) {
                        const { packagePath } = await snapshots.materialize(
                            workbench.selector,
                            workbench.files
                        );
                        const candidate = await Workbench.load(packagePath);
                        await smoke.check(
                            `${reference.source}#${workbench.selector}`,
                            candidate
                        );
                    }
                } finally {
                    await rm(scratch, { recursive: true, force: true });
                }
            }
        }
        if (smoke.exitCode !== 0) process.exitCode = smoke.exitCode;
    },
});

interface SmokeSettings {
    runtime?: string;
    allowHostDocker: boolean;
    allowUncheckedGpu: boolean;
    json: boolean;
    rawArgs: string[];
    environment: WorkbenchEnvironment;
    overrides: Awaited<ReturnType<WorkbenchEnvironment['load']>>;
    home: string;
}

/**
 * Smokes each Workbench of one invocation and prints its result. Human output
 * stops at the first thrown error; JSON output reports each failure as its own
 * object and carries on.
 */
class SmokeRun {
    /** 0 when every Workbench is ready, 1 if any failed, else 3 for missing authentication. */
    exitCode = 0;
    private readonly workspaces = new WorkbenchWorkspaces();

    constructor(private readonly settings: SmokeSettings) {}

    /** `reference` is the pasteable selector used in connect commands. */
    async check(
        reference: string,
        candidate: ResolvedWorkbench,
        options: { workspaceDirectory?: string | undefined } = {}
    ) {
        const { workspaceDirectory } = options;
        const report = this.settings.json
            ? await this.report(reference, candidate, workspaceDirectory)
            : await this.print(reference, candidate, workspaceDirectory);
        if (report.exitCode === 1 || this.exitCode === 0) {
            this.exitCode = report.exitCode;
        }
    }

    private async report(
        reference: string,
        candidate: ResolvedWorkbench,
        workspaceDirectory?: string
    ): Promise<SmokeReport> {
        let report: SmokeReport;
        try {
            const workbench = await this.run(reference, candidate, workspaceDirectory);
            report = SmokeReport.completed(workbench.workbench, workbench.result);
        } catch (error) {
            report = SmokeReport.failed(candidate, error);
        }
        process.stdout.write(`${JSON.stringify(report)}\n`);
        return report;
    }

    private async print(
        reference: string,
        candidate: ResolvedWorkbench,
        workspaceDirectory?: string
    ): Promise<SmokeReport> {
        const output = new CliPresenter();
        output.progress(`Checking ${candidate.manifest.name}`);
        const { workbench, result } = await this.run(
            reference,
            candidate,
            workspaceDirectory
        );
        const report = SmokeReport.completed(workbench, result);
        const name = workbench.manifest.name;
        const disabled = result.disabledMcps.length
            ? `; optional MCPs disabled: ${result.disabledMcps.join(', ')}`
            : '';
        const workspaces = result.workspaces.length
            ? `; workspaces: ${result.workspaces.map((workspace) => `${workspace.name}=${workspace.path} (${workspace.access})`).join(', ')}`
            : '';
        const dockerEngine = result.dockerEngine
            ? `; docker-engine: ${result.dockerEngine}`
            : '';
        const subprocessEnvironmentScrubbing =
            result.subprocessEnvironmentScrubbing === undefined
                ? ''
                : `; subprocess-env-scrub=${result.subprocessEnvironmentScrubbing ? 'enabled' : 'disabled'}`;
        const requirements = [
            ...(result.requirements?.applied ?? []).map((entry) => `applied ${entry}`),
            ...(result.requirements?.unchecked ?? []).map(
                (entry) => `unchecked: ${entry}`
            ),
        ];
        const unchecked = requirements.length
            ? `; requirements: ${requirements.join(', ')}`
            : '';
        const authenticationInstruction =
            result.authentication.instruction ?? result.authentication.connectCommand;
        const authenticationProvider =
            result.authentication.configuration?.provider ?? 'environment';
        const credential = result.authentication.method
            ? {
                  label:
                      result.authentication.method === 'api'
                          ? 'API key'
                          : result.authentication.method === 'oauth'
                            ? subscriptionLabel(authenticationProvider)
                            : result.authentication.method,
                  warning: result.authentication.warning,
              }
            : undefined;
        const authentication = result.authentication.ready
            ? `; auth: ready (${authenticationProvider}${credential ? `, ${credential.label}` : ''})`
            : `; auth: required (${authenticationInstruction})`;
        const status = result.authentication.ready ? 'ready' : 'needs-auth';
        output.record({
            machine: [
                status,
                name,
                `runner=${result.runner.path}`,
                `tools=${result.tools.map((tool) => tool.path).join(',') || '-'}${authentication}${workspaces}${dockerEngine}${subprocessEnvironmentScrubbing}${unchecked}${disabled}`,
            ],
            title: result.authentication.ready
                ? `${name} is ready`
                : `${name} needs a connection`,
            details: [
                result.runner.path,
                result.tools.length > 0
                    ? `${result.tools.length} ${result.tools.length === 1 ? 'tool' : 'tools'}`
                    : 'no required tools',
                result.authentication.ready
                    ? `auth ${authenticationProvider}${credential ? `, ${credential.label}` : ''}`
                    : authenticationInstruction,
                ...(result.subprocessEnvironmentScrubbing === undefined
                    ? []
                    : [
                          `subprocess environment scrubbing ${result.subprocessEnvironmentScrubbing ? 'enabled' : 'disabled'}`,
                      ]),
                ...requirements,
            ],
            tone: result.authentication.ready ? 'success' : 'warning',
        });
        if (credential?.warning) output.message(credential.warning, 'warning');
        return report;
    }

    private async run(
        reference: string,
        candidate: ResolvedWorkbench,
        workspaceDirectory?: string
    ) {
        const { settings } = this;
        const workbench = withRuntime(candidate, settings.runtime);
        const workspaces = await this.workspaces.bind({
            workbench,
            rawArgs: settings.rawArgs,
        });
        if (settings.allowHostDocker && !selectedRuntime(workbench).docker?.engine) {
            throw new Error(
                '--allow-host-docker requires a Workbench that declares docker.engine'
            );
        }
        const result = await new RuntimeSmoke({
            workbench,
            ...(workspaceDirectory ? { workspaceDirectory } : {}),
            environment: settings.environment.bind(workbench, settings.overrides),
            workspaces,
            allowHostDocker: settings.allowHostDocker,
            allowUncheckedGpu: settings.allowUncheckedGpu,
            reference,
            home: settings.home,
        }).check();
        return { workbench, result };
    }
}
