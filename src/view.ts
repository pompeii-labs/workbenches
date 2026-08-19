import { environmentReferences } from './preflight.js';
import type { ResolvedWorkbench } from './types.js';

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
    runtime: string;
    image?: string;
    instructions: string;
    skills: string[];
    tools: string[];
    environment: Array<{ name: string; required: boolean; bound: boolean }>;
    mcps: Array<{
        name: string;
        transport: string;
        url: string;
        status: 'enabled' | 'disabled';
        missing_env: string[];
    }>;
}

export function describeWorkbench(options: {
    workbench: ResolvedWorkbench;
    origin: WorkbenchOrigin;
    environment?: Record<string, string | undefined>;
}): WorkbenchView {
    const manifest = options.workbench.manifest;
    const environment = options.environment ?? process.env;
    return {
        origin: options.origin,
        spec: manifest.spec,
        name: manifest.name,
        version: manifest.version,
        ...(manifest.description ? { description: manifest.description } : {}),
        runner: manifest.runner,
        model: manifest.model,
        runtime: manifest.runtime,
        ...(manifest.image
            ? {
                  image:
                      typeof manifest.image === 'string'
                          ? manifest.image
                          : `${manifest.image.build} (build context ${manifest.image.context ?? '.'})`,
              }
            : {}),
        instructions: manifest.instructions,
        skills: options.workbench.skills.map((skill) => skill.name),
        tools: manifest.tools,
        environment: Object.entries(manifest.env).map(([name, requirement]) => ({
            name,
            required: requirement.required,
            bound: Boolean(environment[name]),
        })),
        mcps: manifest.mcps.map((mcp) => {
            const references = new Set(
                Object.values(mcp.headers).flatMap(environmentReferences)
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
    };
}

export function renderWorkbenchView(view: WorkbenchView): string {
    const lines = [`${view.name}@${view.version}`];
    if (view.description) lines.push(view.description);
    lines.push('');
    field(lines, 'Origin', view.origin.kind);
    if (view.origin.kind === 'saved') field(lines, 'Alias', view.origin.alias);
    field(lines, 'Source', view.origin.source);
    field(lines, 'Selector', view.origin.selector);
    if (view.origin.revision) field(lines, 'Revision', view.origin.revision);
    if (view.origin.kind === 'saved') {
        field(lines, 'Digest', view.origin.digest);
        field(lines, 'Added', view.origin.added_at);
        field(lines, 'Package', view.origin.package);
    }
    field(lines, 'Spec', String(view.spec));
    field(lines, 'Version', view.version);
    field(lines, 'Runner', view.runner);
    field(lines, 'Model', view.model);
    field(lines, 'Runtime', view.runtime);
    field(lines, 'Image', view.image ?? 'none');
    field(lines, 'Instructions', view.instructions);
    field(lines, 'Skills', view.skills.join(', ') || 'none');
    field(lines, 'Tools', view.tools.join(', ') || 'none');
    lines.push('', 'Environment');
    if (view.environment.length === 0) lines.push('  none');
    for (const variable of view.environment) {
        lines.push(
            `  ${variable.name} · ${variable.required ? 'required' : 'optional'} · ${variable.bound ? 'bound' : 'unbound'}`
        );
    }
    lines.push('', 'MCPs');
    if (view.mcps.length === 0) lines.push('  none');
    for (const mcp of view.mcps) {
        const reason = mcp.missing_env.length
            ? ` (missing ${mcp.missing_env.join(', ')})`
            : '';
        lines.push(
            `  ${mcp.name} · ${mcp.transport} · ${mcp.url} · ${mcp.status}${reason}`
        );
    }
    return `${lines.join('\n')}\n`;
}

function field(lines: string[], label: string, value: string): void {
    lines.push(`${label.padEnd(12)} ${value}`);
}
