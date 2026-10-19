import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export const MCP_INSTRUCTIONS =
    'Find one with `search`, inspect it with `view`, then start it with `run`. Work the loop: `run`, then `wait`, then `send` or `answer`, then `wait` again. `wait` returns early with a cursor, either when something needs you or when its time is up. A run that is still going is normal. Call `wait` again with the returned `next` until the status is completed, failed, or cancelled. When a run asks a question or a permission, reply with `answer` and the request id. Use `cancel` to stop one.';

export const mcpTools: Tool[] = [
    {
        name: 'search',
        description: 'Find saved and available registry Workbenches.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string' },
                limit: { type: 'integer', minimum: 1, maximum: 100 },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'view',
        description: 'Inspect a Workbench before running it.',
        inputSchema: {
            type: 'object',
            properties: { workbench: { type: 'string' } },
            required: ['workbench'],
            additionalProperties: false,
        },
    },
    {
        name: 'run',
        description: 'Start a detached run.',
        inputSchema: {
            type: 'object',
            properties: {
                workbench: { type: 'string' },
                task: { type: 'string' },
                project: { type: 'string' },
                dir: { type: 'string' },
                runtime: {
                    type: 'string',
                    enum: ['local', 'docker', 'e2b', 'daytona'],
                },
            },
            required: ['workbench', 'task'],
            additionalProperties: false,
        },
    },
    {
        name: 'wait',
        description: 'Wait for progress, input, or completion.',
        inputSchema: {
            type: 'object',
            properties: {
                session_id: { type: 'string' },
                run_id: { type: 'string' },
                after: { type: 'integer', minimum: 0 },
                timeout_seconds: { type: 'number', minimum: 0 },
            },
            oneOf: [{ required: ['session_id'] }, { required: ['run_id'] }],
            additionalProperties: false,
        },
    },
    {
        name: 'send',
        description: 'Send, steer, or queue work in a session.',
        inputSchema: {
            type: 'object',
            properties: {
                session_id: { type: 'string' },
                text: { type: 'string' },
                mode: { type: 'string', enum: ['send', 'steer', 'queue'] },
            },
            required: ['session_id', 'text'],
            additionalProperties: false,
        },
    },
    {
        name: 'answer',
        description: 'Answer a pending permission or question.',
        inputSchema: {
            type: 'object',
            properties: {
                session_id: { type: 'string' },
                request_id: { type: 'string' },
                response: {
                    oneOf: [
                        { type: 'string' },
                        {
                            type: 'array',
                            items: { type: 'array', items: { type: 'string' } },
                        },
                    ],
                },
            },
            required: ['session_id', 'request_id', 'response'],
            additionalProperties: false,
        },
    },
    {
        name: 'cancel',
        description: 'Stop the active run in a session.',
        inputSchema: {
            type: 'object',
            properties: { session_id: { type: 'string' } },
            required: ['session_id'],
            additionalProperties: false,
        },
    },
    {
        name: 'runs',
        description: 'List recent runs.',
        inputSchema: {
            type: 'object',
            properties: {
                project: { type: 'string' },
                status: {
                    type: 'string',
                    enum: [
                        'dispatched',
                        'queued',
                        'provisioning',
                        'starting',
                        'running',
                        'needs_input',
                        'completing',
                        'completed',
                        'failed',
                        'cancelled',
                    ],
                },
                limit: { type: 'integer', minimum: 1, maximum: 100 },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'sessions',
        description: 'List sessions and their latest runs.',
        inputSchema: {
            type: 'object',
            properties: {
                project: { type: 'string' },
                limit: { type: 'integer', minimum: 1, maximum: 100 },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'push',
        description: 'Push a local Workbench package to the registry.',
        inputSchema: {
            type: 'object',
            properties: { path: { type: 'string' }, org: { type: 'string' } },
            required: ['path'],
            additionalProperties: false,
        },
    },
    {
        name: 'create_project',
        description: 'Create a tracked project.',
        inputSchema: {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
            additionalProperties: false,
        },
    },
];
