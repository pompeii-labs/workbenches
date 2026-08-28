import { join } from 'node:path';

import { modelLabel } from '../../models/index.js';
import type { ResolvedWorkbench, RunnerInvocation } from '../../types.js';

export function buildPiInvocation(
    workbench: ResolvedWorkbench,
    task: string,
    baseEnv: Record<string, string | undefined> = process.env,
    workspaceDirectory = workbench.repositoryDirectory,
    model = modelLabel(workbench.manifest.model),
    configDirectory?: string
): RunnerInvocation {
    validatePiWorkbench(workbench);
    const normalizedTask = task.trim();
    if (!normalizedTask) throw new Error('task must not be empty');

    const route = splitModelRoute(model);
    const command = [
        'pi',
        '--mode',
        'json',
        '--print',
        '--no-session',
        '--no-context-files',
        '--provider',
        route.provider,
        '--model',
        route.model,
        ...piSkillArguments(workbench, configDirectory),
        normalizedTask,
    ];
    const env = buildPiEnvironment(baseEnv, workspaceDirectory, configDirectory);
    return {
        command: piCredentialCommand(command, env, configDirectory),
        cwd: workspaceDirectory,
        env,
    };
}

export function buildPiRpcInvocation(
    workbench: ResolvedWorkbench,
    baseEnv: Record<string, string | undefined> = process.env,
    workspaceDirectory = workbench.repositoryDirectory,
    model = modelLabel(workbench.manifest.model),
    configDirectory?: string
): RunnerInvocation {
    validatePiWorkbench(workbench);
    const route = splitModelRoute(model);
    const command = [
        'pi',
        '--mode',
        'rpc',
        '--no-session',
        '--no-context-files',
        '--provider',
        route.provider,
        '--model',
        route.model,
        ...piSkillArguments(workbench, configDirectory),
    ];
    const env = buildPiEnvironment(baseEnv, workspaceDirectory, configDirectory);
    return {
        command: piCredentialCommand(command, env, configDirectory),
        cwd: workspaceDirectory,
        env,
    };
}

function piSkillArguments(
    workbench: ResolvedWorkbench,
    configDirectory: string | undefined
): string[] {
    if (workbench.skills.length > 0 && !configDirectory) {
        throw new Error('Pi skills require a staged config directory');
    }
    return workbench.skills.flatMap((skill) => [
        '--skill',
        join(configDirectory as string, 'skills', skill.name),
    ]);
}

export function publicPiInvocation(invocation: RunnerInvocation) {
    return {
        command: invocation.command,
        cwd: invocation.cwd,
        pi_config_directory: invocation.env.PI_CODING_AGENT_DIR ?? null,
    };
}

function buildPiEnvironment(
    baseEnv: Record<string, string | undefined>,
    workspaceDirectory: string,
    configDirectory: string | undefined
): Record<string, string | undefined> {
    return {
        ...baseEnv,
        PWD: workspaceDirectory,
        ...(configDirectory ? { PI_CODING_AGENT_DIR: configDirectory } : {}),
    };
}

export function piCredentialCommand(
    command: string[],
    environment: Record<string, string | undefined>,
    configDirectory?: string
): string[] {
    const credentials = environment.WORKBENCH_CREDENTIALS_DIR?.trim();
    if (!credentials) return command;
    if (!configDirectory) {
        throw new Error('Pi Docker credentials require staged runner configuration');
    }
    environment.WORKBENCH_PI_CONFIG_DIR = configDirectory;
    environment.PI_CODING_AGENT_DIR = '/tmp/workbench-pi';
    return [
        '/bin/sh',
        '-c',
        [
            'config="$PI_CODING_AGENT_DIR"',
            'source="$WORKBENCH_PI_CONFIG_DIR"',
            'credentials="$WORKBENCH_CREDENTIALS_DIR"',
            'mkdir -p "$config" "$credentials"',
            'cp -R "$source"/. "$config"/ 2>/dev/null || true',
            'if [ ! -f "$credentials/auth.json" ]; then printf "{}\\n" > "$credentials/auth.json"; fi',
            'chmod 600 "$credentials/auth.json"',
            'rm -f "$config/auth.json"',
            'ln -s "$credentials/auth.json" "$config/auth.json"',
            '"$@"',
            'code=$?',
            'exit "$code"',
        ].join('\n'),
        'workbench-pi',
        ...command,
    ];
}

function splitModelRoute(value: string): { provider: string; model: string } {
    const separator = value.indexOf('/');
    if (separator <= 0 || separator === value.length - 1) {
        throw new Error(`Pi model route must use provider/model: ${value}`);
    }
    return {
        provider: value.slice(0, separator),
        model: value.slice(separator + 1),
    };
}

function validatePiWorkbench(workbench: ResolvedWorkbench): void {
    if (workbench.manifest.runner !== 'pi') {
        throw new Error(`Unsupported runner: ${workbench.manifest.runner}`);
    }
    if (workbench.manifest.mcps.length > 0) {
        throw new Error(
            'Pi does not provide a native MCP transport. This Workbench requires an explicit Pi extension before it can run.'
        );
    }
}
