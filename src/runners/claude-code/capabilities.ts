import type { RunnerAdapterDeclaration } from '../session.js';

/** The Claude Code release whose stream-json protocol the session was verified against. */
export const CLAUDE_CODE_VERSION = '2.1.292';

export const CLAUDE_CODE_SESSION_DECLARATION: RunnerAdapterDeclaration = {
    native: {
        command: 'claude',
        verified: [{ version: CLAUDE_CODE_VERSION, surfaces: ['stream-json'] }],
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
            detail: 'Workbench does not yet provide a normalized image-generation tool or image output event for Claude Code.',
        },
        session_resume: { status: 'supported' },
        cancellation: { status: 'supported' },
        failures: { status: 'supported' },
        unknown_events: { status: 'supported' },
    },
};
