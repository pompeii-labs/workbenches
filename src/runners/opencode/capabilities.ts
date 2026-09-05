import type { RunnerAdapterDeclaration } from '../session.js';

export const OPENCODE_SESSION_DECLARATION: RunnerAdapterDeclaration = {
    native: {
        command: 'opencode',
        verified: [
            { version: '1.18.22', surfaces: ['server'] },
            { version: '1.18.26', surfaces: ['server'] },
        ],
    },
    capabilities: {
        streaming_text: { status: 'supported' },
        tool_events: { status: 'supported' },
        file_events: { status: 'supported' },
        usage: { status: 'supported' },
        permissions: { status: 'supported' },
        questions: { status: 'supported' },
        multi_turn: { status: 'supported' },
        steering: { status: 'supported' },
        image_input: { status: 'supported' },
        image_generation: {
            status: 'unsupported',
            detail: 'Workbench does not yet provide a normalized image-generation tool or image output event for OpenCode.',
        },
        session_resume: { status: 'supported' },
        cancellation: { status: 'supported' },
        failures: { status: 'supported' },
        unknown_events: { status: 'supported' },
    },
};
