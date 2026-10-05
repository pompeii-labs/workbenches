import { AuthenticationRequiredError } from '../connections/error.js';
import type { ResolvedWorkbench, WorkbenchWorkspaceBinding } from '../types.js';
import { selectedRuntime } from '../workbench/runtimes.js';
import type { WorkbenchSmokeResult } from './smoke.js';

export type SmokeStatus = 'ready' | 'needs-auth' | 'failed';

/** The machine-readable outcome of smoking one Workbench (`wb smoke --json`). */
export interface SmokeReportData {
    status: SmokeStatus;
    workbench: string;
    version: string;
    runtime: string;
    runner?: { name: string; path: string };
    tools: Array<{ name: string; path: string }>;
    authentication?: {
        ready: boolean;
        model: string;
        /** The selected provider when ready. */
        provider?: string;
        /** The selected native route, `provider/model`, when ready. */
        route?: string;
        authenticated_providers: string[];
        /** The command to run when authentication is required. */
        connect_command?: string;
    };
    requirements?: { checked: string[]; applied: string[]; unchecked: string[] };
    workspaces: WorkbenchWorkspaceBinding[];
    docker_engine?: 'host';
    warnings: string[];
    error?: { code: string; message: string };
}

/** One Workbench's smoke outcome, with the process exit code it implies. */
export class SmokeReport {
    private constructor(readonly data: SmokeReportData) {}

    /** Reports a smoke that completed, whether or not a model route is connected. */
    static completed(
        workbench: ResolvedWorkbench,
        result: WorkbenchSmokeResult
    ): SmokeReport {
        const authentication = result.authentication;
        const requirements = result.requirements;
        const unchecked = requirements?.unchecked ?? [];
        return new SmokeReport({
            status: authentication.ready ? 'ready' : 'needs-auth',
            ...SmokeReport.identity(workbench),
            runner: result.runner,
            tools: result.tools,
            authentication: {
                ready: authentication.ready,
                model: authentication.model,
                ...(authentication.ready
                    ? {
                          provider:
                              authentication.configuration?.provider ?? 'environment',
                          ...(authentication.configuration
                              ? { route: authentication.configuration.model }
                              : {}),
                      }
                    : { connect_command: authentication.connectCommand }),
                authenticated_providers: authentication.authenticatedProviders,
            },
            requirements: {
                checked: requirements?.checked ?? [],
                applied: requirements?.applied ?? [],
                unchecked,
            },
            workspaces: result.workspaces,
            ...(result.dockerEngine ? { docker_engine: result.dockerEngine } : {}),
            warnings: [
                ...unchecked.map((entry) => `requirement not checked: ${entry}`),
                ...result.disabledMcps.map((name) => `optional MCP disabled: ${name}`),
            ],
        });
    }

    /** Reports a smoke that threw: `needs-auth` for missing credentials, else `failed`. */
    static failed(workbench: ResolvedWorkbench, error: unknown): SmokeReport {
        const authentication = error instanceof AuthenticationRequiredError;
        return new SmokeReport({
            status: authentication ? 'needs-auth' : 'failed',
            ...SmokeReport.identity(workbench),
            tools: [],
            workspaces: [],
            warnings: [],
            error: {
                code: authentication ? error.code : 'smoke_failed',
                message: error instanceof Error ? error.message : String(error),
            },
        });
    }

    /** 0 when ready, 3 when authentication is needed, 1 on failure. */
    get exitCode(): number {
        return this.data.status === 'ready'
            ? 0
            : this.data.status === 'needs-auth'
              ? AuthenticationRequiredError.exitCode
              : 1;
    }

    toJSON(): SmokeReportData {
        return this.data;
    }

    private static identity(
        workbench: ResolvedWorkbench
    ): Pick<SmokeReportData, 'workbench' | 'version' | 'runtime'> {
        return {
            workbench: workbench.manifest.name,
            version: workbench.manifest.version,
            runtime: selectedRuntime(workbench).name,
        };
    }
}
