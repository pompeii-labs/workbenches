import type { ResolvedRunnerConfiguration } from '../models/index.js';
import type { WorkbenchEventDraft } from '../runs/index.js';
import type { ResolvedWorkbench } from '../types.js';

export const RUNNER_CAPABILITIES = [
    'streaming_text',
    'tool_events',
    'file_events',
    'usage',
    'permissions',
    'multi_turn',
    'steering',
    'image_input',
    'image_generation',
    'cancellation',
    'failures',
    'unknown_events',
] as const;

export type RunnerCapability = (typeof RUNNER_CAPABILITIES)[number];
export type RunnerCapabilityStatus = 'supported' | 'degraded' | 'unsupported';

export interface RunnerCapabilitySupport {
    status: RunnerCapabilityStatus;
    detail?: string;
}

export interface VerifiedRunnerSurface {
    version: string;
    surfaces: string[];
}

export interface RunnerAdapterDeclaration {
    native: {
        command: string;
        verified: VerifiedRunnerSurface[];
    };
    capabilities: Record<RunnerCapability, RunnerCapabilitySupport>;
}

export interface RunnerTurnResult {
    reason?: string;
}

export interface RunnerImageInput {
    data: string;
    mimeType: string;
    name?: string;
}

export interface RunnerPromptInput {
    text: string;
    images?: RunnerImageInput[];
}

export type RunnerInput = string | RunnerPromptInput;

export interface NormalizedRunnerInput {
    text: string;
    images: RunnerImageInput[];
}

export type RunnerPermissionDecision = 'allow_once' | 'allow_always' | 'reject';

export interface RunnerPermissionRequest {
    id: string;
    action: string;
    resources: string[];
    message: string;
    allowAlways: boolean;
}

export interface RunnerSession {
    readonly id: string | undefined;
    prompt(input: RunnerInput): Promise<RunnerTurnResult>;
    steer?(input: RunnerInput): Promise<void>;
    followUp?(input: RunnerInput): Promise<void>;
    cancelTurn(): Promise<void>;
    close(): Promise<void>;
}

export function normalizeRunnerInput(input: RunnerInput): NormalizedRunnerInput {
    const value = typeof input === 'string' ? { text: input } : input;
    const text = value.text.trim();
    if (!text) throw new Error('input must not be empty');
    const images = (value.images ?? []).map((image, index) => {
        const mimeType = image.mimeType.trim().toLowerCase();
        const data = image.data.trim();
        if (!mimeType.startsWith('image/')) {
            throw new Error(`image ${index + 1} must use an image MIME type`);
        }
        if (!data) throw new Error(`image ${index + 1} data must not be empty`);
        const name = image.name?.trim();
        return {
            data,
            mimeType,
            ...(name ? { name } : {}),
        };
    });
    return { text, images };
}

export interface RunnerSessionHost {
    emit(event: WorkbenchEventDraft): Promise<void>;
    requestPermission(
        request: RunnerPermissionRequest
    ): Promise<RunnerPermissionDecision>;
}

export interface RunnerSessionStartOptions {
    workbench: ResolvedWorkbench;
    workspaceDirectory: string;
    environment: Record<string, string | undefined>;
    configuration: ResolvedRunnerConfiguration;
    host: RunnerSessionHost;
}

export interface RunnerSessionAdapter {
    readonly runner: string;
    readonly declaration: RunnerAdapterDeclaration;
    start(options: RunnerSessionStartOptions): Promise<RunnerSession>;
}
