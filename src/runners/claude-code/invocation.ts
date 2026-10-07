import {
    ActiveModelCatalog,
    type ResolvedRunnerConfiguration,
} from '../../models/index.js';
import type { ResolvedWorkbench, RunnerInvocation } from '../../types.js';
import type { NormalizedRunnerInput, RunnerSessionContext } from '../session.js';
import { claudeCodeCredentials } from './authentication.js';
import type { StagedClaudeCodeConfig } from './config.js';
import { claudeCodeRouteEnvironment } from './providers.js';

export function buildClaudeCodeInvocation(
    workbench: ResolvedWorkbench,
    environment: Record<string, string | undefined>,
    workspaceDirectory: string,
    configuration: ResolvedRunnerConfiguration,
    staged: StagedClaudeCodeConfig,
    session?: RunnerSessionContext,
    resume = Boolean(session?.nativeSessionId),
    answerRequests = true,
    subprocessEnvironmentScrubbing = false
): RunnerInvocation {
    if (workbench.manifest.runner !== 'claude-code') {
        throw new Error(`Unsupported runner: ${workbench.manifest.runner}`);
    }
    const command = [
        'claude',
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--replay-user-messages',
        '--verbose',
        '--model',
        configuration.nativeModel,
        '--append-system-prompt-file',
        staged.context.instructions,
        '--strict-mcp-config',
        '--mcp-config',
        staged.mcpConfigFile,
        '--settings',
        staged.settingsFile,
        // Claude Code 2.1.292 traces confirm that user settings exclude project
        // instructions and hooks. Workbench stages repository CLAUDE.md itself.
        '--setting-sources',
        'user',
        // Claude Code 2.1.292 traces confirm stdio control requests and responses.
        ...(answerRequests
            ? ['--permission-prompt-tool', 'stdio']
            : ['--permission-prompts', 'none']),
        ...staged.runtimeDirectories.flatMap((path) => ['--add-dir', path]),
        ...(staged.maxTurns ? ['--max-turns', String(staged.maxTurns)] : []),
        ...(session?.nativeSessionId
            ? [resume ? '--resume' : '--session-id', session.nativeSessionId]
            : []),
    ];
    const invocation: RunnerInvocation = {
        command,
        cwd: workspaceDirectory,
        env: {
            ...claudeCodeEnvironment(
                claudeCodeRouteEnvironment(
                    configuration.provider,
                    environment,
                    Object.fromEntries(
                        Object.entries(ActiveModelCatalog.current().providers).map(
                            ([provider, metadata]) => [provider, metadata.env]
                        )
                    )
                )
            ),
            PWD: workspaceDirectory,
            CLAUDE_CONFIG_DIR: staged.directory,
            CLAUDE_SECURESTORAGE_CONFIG_DIR:
                environment.CLAUDE_SECURESTORAGE_CONFIG_DIR,
            CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: subprocessEnvironmentScrubbing
                ? '1'
                : '0',
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
        },
    };
    return staged.context.apply(invocation, workbench);
}

function claudeCodeEnvironment(
    environment: Record<string, string | undefined>
): Record<string, string | undefined> {
    const filtered = Object.fromEntries(
        Object.entries(environment).filter(
            ([name]) => !name.startsWith('CLAUDE') && !name.startsWith('ANTHROPIC_')
        )
    );
    const credentials = claudeCodeCredentials(environment);
    return {
        ...filtered,
        ...(environment.ANTHROPIC_BASE_URL
            ? { ANTHROPIC_BASE_URL: environment.ANTHROPIC_BASE_URL }
            : {}),
        ...(environment.ANTHROPIC_AUTH_TOKEN !== undefined
            ? { ANTHROPIC_AUTH_TOKEN: environment.ANTHROPIC_AUTH_TOKEN }
            : {}),
        ...(credentials.apiKey
            ? { ANTHROPIC_API_KEY: credentials.apiKey }
            : environment.ANTHROPIC_API_KEY === ''
              ? { ANTHROPIC_API_KEY: '' }
              : {}),
    };
}

export function claudeCodeInput(
    input: NormalizedRunnerInput,
    uuid: string = crypto.randomUUID()
): string {
    const text = input.text.trim();
    if (!text) throw new Error('task must not be empty');
    return `${JSON.stringify({
        type: 'user',
        uuid,
        message: {
            role: 'user',
            content: [
                { type: 'text', text },
                ...input.images.map((image) => ({
                    type: 'image',
                    source: {
                        type: 'base64',
                        media_type: image.mimeType,
                        data: image.data,
                    },
                })),
            ],
        },
    })}\n`;
}

export function publicClaudeCodeInvocation(invocation: RunnerInvocation) {
    return {
        command: invocation.command,
        cwd: invocation.cwd,
        claude_config_directory: invocation.env.CLAUDE_CONFIG_DIR ?? null,
    };
}
