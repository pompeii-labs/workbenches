import { isAbsolute, relative } from 'node:path';

import pc from 'picocolors';

import type { WorkbenchEvent } from './execution.js';

type Colors = ReturnType<typeof pc.createColors>;

export type OutputMode = 'human' | 'json' | 'final';

export interface EventRenderer {
    render(event: WorkbenchEvent): void;
    finish(): void;
}

export function createEventRenderer(options: {
    mode: OutputMode;
    stdout?: (value: string) => void;
    stderr?: (value: string) => void;
    color?: boolean;
}): EventRenderer {
    const stdout = options.stdout ?? ((value) => process.stdout.write(value));
    const stderr = options.stderr ?? ((value) => process.stderr.write(value));
    if (options.mode === 'json') return jsonRenderer(stdout);
    if (options.mode === 'final') return finalRenderer(stdout, stderr);
    return humanRenderer(
        stdout,
        stderr,
        pc.createColors(options.color ?? defaultColorEnabled())
    );
}

function jsonRenderer(write: (value: string) => void): EventRenderer {
    return {
        render(event) {
            write(`${JSON.stringify(event)}\n`);
        },
        finish() {},
    };
}

function finalRenderer(
    stdout: (value: string) => void,
    stderr: (value: string) => void
): EventRenderer {
    let answer = '';
    let error = '';
    return {
        render(event) {
            if (event.type === 'output.text') answer += text(event.data, 'text');
            if (event.type === 'run.failed') error = text(event.data, 'message');
        },
        finish() {
            if (answer) stdout(`${answer.replace(/\s+$/, '')}\n`);
            if (error) stderr(`error: ${error}\n`);
        },
    };
}

function humanRenderer(
    stdout: (value: string) => void,
    stderr: (value: string) => void,
    colors: Colors
): EventRenderer {
    let inAnswer = false;
    let workspace = '';
    const usage: Record<string, number> = {};
    const endAnswer = () => {
        if (!inAnswer) return;
        stdout('\n');
        inAnswer = false;
    };
    return {
        render(event) {
            if (event.type === 'run.started') {
                workspace = text(event.data, 'workspace');
                const name = text(event.data, 'workbench') || 'Workbench';
                const model = text(event.data, 'model');
                const runtime = text(event.data, 'runtime');
                stdout(
                    `${colors.cyan('●')} ${colors.bold(name)}\n  ${colors.dim([humanName(event.runner), model, runtime].filter(Boolean).join(' · '))}\n`
                );
                return;
            }
            if (event.type === 'run.ready') {
                const tools = stringArray(event.data, 'tools');
                const disabled = stringArray(event.data, 'disabled_mcps');
                stdout(
                    `  ${colors.green('✓')} ${colors.green('Ready')}${tools.length ? colors.dim(` · ${tools.join(', ')}`) : ''}\n`
                );
                if (disabled.length) {
                    stdout(
                        `  ${colors.yellow('○')} ${colors.yellow(`MCP unavailable · ${disabled.join(', ')}`)} ${colors.dim('(optional)')}\n`
                    );
                }
                return;
            }
            if (event.type === 'output.text') {
                if (!inAnswer) {
                    stdout('\n');
                    inAnswer = true;
                }
                stdout(text(event.data, 'text'));
                return;
            }
            if (event.type === 'tool.started') {
                endAnswer();
                stdout(
                    `  ${colors.cyan('→')} ${styledToolLabel(event.data, workspace, colors)}\n`
                );
                return;
            }
            if (event.type === 'tool.completed') {
                endAnswer();
                const failed = text(event.data, 'status') === 'failed';
                const marker = failed ? colors.red('✗') : colors.green('✓');
                const duration = durationLabel(number(event.data, 'duration_ms'));
                stdout(
                    `  ${marker} ${styledToolLabel(event.data, workspace, colors)}${duration ? colors.dim(` · ${duration}`) : ''}\n`
                );
                return;
            }
            if (event.type === 'file.changed') {
                endAnswer();
                stdout(
                    `    ${colors.yellow('~')} ${colors.yellow(text(event.data, 'operation') || 'changed')} ${colors.dim(displayTarget(text(event.data, 'path'), workspace))}\n`
                );
                return;
            }
            if (event.type === 'usage.updated') {
                for (const [key, value] of Object.entries(record(event.data) ?? {})) {
                    if (typeof value === 'number')
                        usage[key] = (usage[key] ?? 0) + value;
                }
                return;
            }
            if (event.type === 'input.requested') {
                endAnswer();
                stdout(
                    `  ${colors.yellow('?')} ${colors.yellow('Input required')} ${colors.dim(`· ${text(event.data, 'message') || 'Input requested'}`)}\n`
                );
                return;
            }
            if (event.type === 'run.completed') {
                endAnswer();
                const duration = durationLabel(number(event.data, 'duration_ms'));
                stdout(
                    `\n${colors.green('✓')} ${colors.bold(colors.green('Completed'))}${summaryLabel(duration, usage, colors)}\n`
                );
                return;
            }
            if (event.type === 'run.failed') {
                endAnswer();
                stderr(
                    `\n${colors.red('✗')} ${colors.bold(colors.red('Failed'))} ${colors.dim(`· ${text(event.data, 'message') || 'Workbench run failed'}`)}\n`
                );
                return;
            }
            if (event.type === 'run.cancelled') {
                endAnswer();
                const reason = text(event.data, 'reason');
                stderr(
                    `\n${colors.yellow('■')} ${colors.bold(colors.yellow('Cancelled'))}${reason ? colors.dim(` · ${reason}`) : ''}\n`
                );
            }
        },
        finish() {
            endAnswer();
        },
    };
}

function record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function text(value: unknown, key: string): string {
    const candidate = record(value)?.[key];
    return typeof candidate === 'string' ? candidate : '';
}

function number(value: unknown, key: string): number | undefined {
    const candidate = record(value)?.[key];
    return typeof candidate === 'number' && Number.isFinite(candidate)
        ? candidate
        : undefined;
}

function stringArray(value: unknown, key: string): string[] {
    const candidate = record(value)?.[key];
    return Array.isArray(candidate)
        ? candidate.filter((entry): entry is string => typeof entry === 'string')
        : [];
}

function humanName(value: string): string {
    if (value.toLowerCase() === 'opencode') return 'OpenCode';
    return value;
}

function styledToolLabel(data: unknown, workspace: string, colors: Colors): string {
    const name = text(data, 'name') || 'tool';
    const title = text(data, 'title');
    const target = text(data, 'target');
    const normalized = name.replaceAll('_', ' ');
    const action =
        title || `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`;
    return target && target !== title
        ? `${colors.bold(action)} ${colors.dim(`· ${displayTarget(target, workspace)}`)}`
        : colors.bold(action);
}

function summaryLabel(
    duration: string | undefined,
    usage: Record<string, number>,
    colors: Colors
): string {
    const tokens = usage.total_tokens;
    const cost = usage.cost_usd;
    const details: string[] = duration ? [duration] : [];
    if (typeof tokens === 'number') details.push(`${tokens.toLocaleString()} tokens`);
    if (typeof cost === 'number') details.push(`$${cost.toFixed(4)}`);
    return details.length ? colors.dim(` · ${details.join(' · ')}`) : '';
}

function displayTarget(target: string, workspace: string): string {
    if (!target || !workspace || !isAbsolute(target)) return target;
    const fromWorkspace = relative(workspace, target);
    return fromWorkspace &&
        !fromWorkspace.startsWith('..') &&
        !isAbsolute(fromWorkspace)
        ? fromWorkspace
        : target;
}

function durationLabel(milliseconds: number | undefined): string | undefined {
    if (milliseconds === undefined || milliseconds < 0) return undefined;
    if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`;
    if (milliseconds < 60_000) {
        return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`;
    }
    const minutes = Math.floor(milliseconds / 60_000);
    const seconds = Math.round((milliseconds % 60_000) / 1000);
    return `${minutes}m ${seconds}s`;
}

function defaultColorEnabled(): boolean {
    if (process.env.NO_COLOR !== undefined) return false;
    if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
    return Boolean(process.stdout.isTTY);
}
