import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    CallToolRequestSchema,
    type CallToolResult,
    ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import packageMetadata from '../../package.json' with { type: 'json' };
import type { ProjectStore } from '../projects/store.js';
import type { McpRunLauncher } from './run.js';
import type { McpSupervision } from './supervision.js';
import { MCP_INSTRUCTIONS, mcpTools } from './tools.js';
import type { McpWorkbenchOperations } from './workbenches.js';

/** The `wb mcp` tool server over stdio. */
export class WorkbenchMcpServer {
    readonly #server = new Server(
        { name: 'wb', version: packageMetadata.version },
        { capabilities: { tools: {} }, instructions: MCP_INSTRUCTIONS }
    );

    constructor(
        private readonly workbenches: McpWorkbenchOperations,
        private readonly launcher: Pick<McpRunLauncher, 'start'>,
        private readonly supervision: McpSupervision,
        private readonly projects: Pick<ProjectStore, 'create'>
    ) {
        this.#server.setRequestHandler(ListToolsRequestSchema, () => ({
            tools: mcpTools,
        }));
        this.#server.setRequestHandler(CallToolRequestSchema, async (request) => {
            try {
                return await this.call(
                    request.params.name,
                    request.params.arguments ?? {}
                );
            } catch (error) {
                return toolError(
                    error instanceof Error ? error.message : 'Workbench tool failed'
                );
            }
        });
    }

    /** Serves stdin and stdout until the client closes them. */
    async serve(): Promise<void> {
        const closed = new Promise<void>((resolve) => {
            this.#server.onclose = resolve;
            process.stdin.once('end', resolve);
            process.stdin.once('close', resolve);
        });
        await this.#server.connect(new StdioServerTransport());
        await closed;
    }

    private async call(
        name: string,
        args: Record<string, unknown>
    ): Promise<CallToolResult> {
        const workbenches = this.workbenches;
        const supervision = this.supervision;
        if (name === 'search') {
            return toolResult({
                results: await workbenches.search(
                    optionalText(args, 'query'),
                    optionalInteger(args, 'limit') ?? 20
                ),
            });
        }
        if (name === 'view') {
            return toolResult(await workbenches.view(requiredText(args, 'workbench')));
        }
        if (name === 'run') {
            return toolResult({
                ...(await this.launcher.start({
                    workbench: workbenchInput(args.workbench),
                    task: requiredText(args, 'task'),
                    ...optionalProperty(args, 'project'),
                    ...optionalProperty(args, 'dir'),
                    ...optionalProperty(args, 'runtime'),
                    ...optionalProperty(args, 'org'),
                    ...optionalProperty(args, 'session_id'),
                    ...optionalProperty(args, 'repository'),
                    ...optionalProperty(args, 'ref'),
                    ...optionalProperty(args, 'idempotency_key'),
                    ...(args.where === undefined
                        ? {}
                        : { where: runLocation(args.where) }),
                })),
            });
        }
        if (name === 'wait') {
            const sessionId = optionalText(args, 'session_id');
            const runId = optionalText(args, 'run_id');
            if ((sessionId === undefined) === (runId === undefined)) {
                throw new Error('wait requires exactly one of session_id or run_id');
            }
            return toolResult(
                await supervision.wait({
                    ...(sessionId ? { sessionId } : {}),
                    ...(runId ? { runId } : {}),
                    ...(args.after !== undefined
                        ? { after: requiredInteger(args, 'after') }
                        : {}),
                    ...(args.timeout_seconds !== undefined
                        ? {
                              timeoutSeconds: requiredNumber(args, 'timeout_seconds'),
                          }
                        : {}),
                })
            );
        }
        if (name === 'send') {
            const mode = optionalText(args, 'mode') ?? 'send';
            if (!['send', 'steer', 'queue'].includes(mode))
                throw new Error('mode must be send, steer, or queue');
            return toolResult(
                await supervision.send(
                    requiredText(args, 'session_id'),
                    requiredText(args, 'text'),
                    mode === 'steer' ? 'steer' : mode === 'queue' ? 'queue' : 'send'
                )
            );
        }
        if (name === 'answer') {
            return toolResult(
                await supervision.answer(
                    requiredText(args, 'session_id'),
                    requiredText(args, 'request_id'),
                    answerResponse(args.response)
                )
            );
        }
        if (name === 'cancel') {
            return toolResult(
                await supervision.cancel(requiredText(args, 'session_id'))
            );
        }
        if (name === 'runs') {
            return toolResult({
                runs: await supervision.runs({
                    ...optionalValue(args, 'project'),
                    ...optionalValue(args, 'status'),
                    limit: optionalInteger(args, 'limit') ?? 20,
                }),
            });
        }
        if (name === 'sessions') {
            return toolResult({
                sessions: await supervision.sessions({
                    ...optionalValue(args, 'project'),
                    limit: optionalInteger(args, 'limit') ?? 20,
                }),
            });
        }
        if (name === 'push') {
            return toolResult(
                await workbenches.push(
                    requiredText(args, 'path'),
                    optionalText(args, 'org')
                )
            );
        }
        if (name === 'create_project') {
            const project = await this.projects.create(requiredText(args, 'name'));
            return toolResult({
                project: {
                    name: project.name,
                    slug: project.slug,
                    created_at: project.created_at,
                },
            });
        }
        throw new Error(`Unknown tool: ${name}`);
    }
}

function requiredText(args: Record<string, unknown>, name: string): string {
    const value = optionalText(args, name);
    if (value === undefined) throw new Error(`${name} must be a string`);
    return value;
}

function optionalText(args: Record<string, unknown>, name: string): string | undefined {
    const value = args[name];
    if (value === undefined) return undefined;
    if (typeof value !== 'string') throw new Error(`${name} must be a string`);
    return value;
}

function requiredNumber(args: Record<string, unknown>, name: string): number {
    const value = args[name];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
        throw new Error(`${name} must be a non-negative number`);
    return value;
}

function requiredInteger(args: Record<string, unknown>, name: string): number {
    const value = requiredNumber(args, name);
    if (!Number.isSafeInteger(value)) throw new Error(`${name} must be an integer`);
    return value;
}

function optionalInteger(
    args: Record<string, unknown>,
    name: string
): number | undefined {
    return args[name] === undefined ? undefined : requiredInteger(args, name);
}

function answerResponse(value: unknown): string | string[][] {
    if (typeof value === 'string') return value;
    if (
        Array.isArray(value) &&
        value.every(
            (answers) =>
                Array.isArray(answers) &&
                answers.every((answer) => typeof answer === 'string')
        )
    )
        return value;
    throw new Error('response must be a string or an array of string arrays');
}

function optionalProperty(
    args: Record<string, unknown>,
    name:
        | 'project'
        | 'dir'
        | 'runtime'
        | 'org'
        | 'session_id'
        | 'repository'
        | 'ref'
        | 'idempotency_key'
): Record<string, string> {
    const value = optionalText(args, name);
    return value === undefined ? {} : { [name]: value };
}

function workbenchInput(value: unknown): string | { version_id: string } {
    if (typeof value === 'string') return value;
    if (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        'version_id' in value &&
        typeof value.version_id === 'string' &&
        Object.keys(value).length === 1
    )
        return { version_id: value.version_id };
    throw new Error('workbench must be a string or a version_id object');
}

function runLocation(value: unknown): 'local' | 'cloud' {
    if (value === 'local' || value === 'cloud') return value;
    throw new Error('where must be local or cloud');
}

function optionalValue(
    args: Record<string, unknown>,
    name: 'project' | 'status'
): Record<string, string> {
    const value = optionalText(args, name);
    return value === undefined ? {} : { [name]: value };
}

function toolResult(value: Record<string, unknown>): CallToolResult {
    return {
        content: [{ type: 'text', text: JSON.stringify(value) }],
        structuredContent: value,
    };
}

function toolError(message: string): CallToolResult {
    return { isError: true, content: [{ type: 'text', text: message }] };
}
