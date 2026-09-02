import { isAbsolute, relative } from 'node:path';

import pc from 'picocolors';

import type { WorkbenchEvent } from '../runs/index.js';
import { TerminalMarkdownStream } from './markdown.js';

type Colors = ReturnType<typeof pc.createColors>;

export type OutputMode = 'human' | 'json' | 'final';

export interface EventRenderer {
    render(event: WorkbenchEvent): void;
    finish(): void;
}

export interface EventRendererOptions {
    mode: OutputMode;
    stdout?: (value: string) => void;
    stderr?: (value: string) => void;
    color?: boolean;
    columns?: number;
}

export function createEventRenderer(options: EventRendererOptions): EventRenderer {
    const stdout = options.stdout ?? ((value: string) => process.stdout.write(value));
    const stderr = options.stderr ?? ((value: string) => process.stderr.write(value));
    if (options.mode === 'json') return new JsonEventRenderer(stdout);
    if (options.mode === 'final') {
        return new FinalEventRenderer(stdout, stderr);
    }
    return new HumanEventRenderer(stdout, stderr, {
        colors: pc.createColors(options.color ?? defaultColorEnabled()),
        columns: options.columns ?? process.stdout.columns ?? 80,
    });
}

class JsonEventRenderer implements EventRenderer {
    constructor(private readonly write: (value: string) => void) {}

    render(event: WorkbenchEvent): void {
        this.write(`${JSON.stringify(event)}\n`);
    }

    finish(): void {}
}

class FinalEventRenderer implements EventRenderer {
    private answer = '';
    private error = '';

    constructor(
        private readonly stdout: (value: string) => void,
        private readonly stderr: (value: string) => void
    ) {}

    render(event: WorkbenchEvent): void {
        if (event.type === 'output.text') this.answer += text(event.data, 'text');
        if (event.type === 'run.failed') this.error = text(event.data, 'message');
    }

    finish(): void {
        if (this.answer) this.stdout(`${this.answer.replace(/\s+$/, '')}\n`);
        if (this.error) this.stderr(`error: ${this.error}\n`);
    }
}

class HumanEventRenderer implements EventRenderer {
    private readonly colors: Colors;
    private readonly markdown: TerminalMarkdownStream;
    private readonly usage: Record<string, number> = {};
    private inAnswer = false;
    private workspace = '';

    constructor(
        private readonly stdout: (value: string) => void,
        private readonly stderr: (value: string) => void,
        options: { colors: Colors; columns: number }
    ) {
        this.colors = options.colors;
        this.markdown = new TerminalMarkdownStream(
            stdout,
            options.colors,
            options.columns
        );
    }

    render(event: WorkbenchEvent): void {
        const colors = this.colors;
        if (event.type === 'run.started') {
            this.workspace = text(event.data, 'workspace');
            const name = text(event.data, 'workbench') || 'Workbench';
            const model = text(event.data, 'model');
            const runtime = text(event.data, 'runtime');
            this.stdout(
                `${colors.cyan('●')} ${colors.bold(name)}\n  ${colors.dim([humanName(event.runner), model, runtime].filter(Boolean).join(' · '))}\n`
            );
            return;
        }
        if (event.type === 'run.ready') {
            const tools = stringArray(event.data, 'tools');
            const disabled = stringArray(event.data, 'disabled_mcps');
            this.stdout(
                `  ${colors.green('✓')} ${colors.green('Ready')}${tools.length ? colors.dim(` · ${tools.join(', ')}`) : ''}\n`
            );
            if (disabled.length) {
                this.stdout(
                    `  ${colors.yellow('○')} ${colors.yellow(`MCP unavailable · ${disabled.join(', ')}`)} ${colors.dim('(optional)')}\n`
                );
            }
            return;
        }
        if (event.type === 'output.text') {
            if (!this.inAnswer) {
                this.stdout('\n');
                this.inAnswer = true;
            }
            this.markdown.push(text(event.data, 'text'));
            return;
        }
        if (event.type === 'tool.started') {
            this.endAnswer();
            this.stdout(
                `  ${colors.cyan('→')} ${styledToolLabel(event.data, this.workspace, colors)}\n`
            );
            return;
        }
        if (event.type === 'tool.completed') {
            this.endAnswer();
            const failed = text(event.data, 'status') === 'failed';
            const marker = failed ? colors.red('✗') : colors.green('✓');
            const duration = durationLabel(number(event.data, 'duration_ms'));
            this.stdout(
                `  ${marker} ${styledToolLabel(event.data, this.workspace, colors)}${duration ? colors.dim(` · ${duration}`) : ''}\n`
            );
            const detail = text(event.data, 'message');
            if (failed && detail) this.stdout(`    ${colors.red(detail)}\n`);
            return;
        }
        if (event.type === 'file.changed') {
            this.endAnswer();
            this.stdout(
                `    ${colors.yellow('~')} ${colors.yellow(text(event.data, 'operation') || 'changed')} ${colors.dim(displayTarget(text(event.data, 'path'), this.workspace))}\n`
            );
            return;
        }
        if (event.type === 'usage.updated') {
            for (const [key, value] of Object.entries(record(event.data) ?? {})) {
                if (typeof value === 'number') {
                    this.usage[key] = (this.usage[key] ?? 0) + value;
                }
            }
            return;
        }
        if (event.type === 'turn.completed') {
            this.endAnswer();
            return;
        }
        if (event.type === 'input.requested') {
            this.endAnswer();
            this.stdout(
                `  ${colors.yellow('?')} ${colors.yellow('Input required')} ${colors.dim(`· ${text(event.data, 'message') || 'Input requested'}`)}\n`
            );
            return;
        }
        if (event.type === 'question.requested') {
            this.endAnswer();
            this.stdout(
                `  ${colors.yellow('?')} ${colors.yellow('Question')} ${colors.dim(`· ${questionText(event.data) || 'Answer required'}`)}\n`
            );
            return;
        }
        if (event.type === 'question.answered') {
            this.endAnswer();
            this.stdout(`  ${colors.green('✓')} ${colors.dim('Answer received')}\n`);
            return;
        }
        if (event.type === 'question.rejected') {
            this.endAnswer();
            this.stdout(
                `  ${colors.yellow('○')} ${colors.dim('Question dismissed')}\n`
            );
            return;
        }
        if (event.type === 'run.completed') {
            this.endAnswer();
            const duration = durationLabel(number(event.data, 'duration_ms'));
            this.stdout(
                `\n${colors.green('✓')} ${colors.bold(colors.green('Completed'))}${summaryLabel(duration, this.usage, colors)}\n`
            );
            return;
        }
        if (event.type === 'run.failed') {
            this.endAnswer();
            this.stderr(
                `\n${colors.red('✗')} ${colors.bold(colors.red('Failed'))} ${colors.dim(`· ${text(event.data, 'message') || 'Workbench run failed'}`)}\n`
            );
            return;
        }
        if (event.type === 'run.cancelled') {
            this.endAnswer();
            const reason = text(event.data, 'reason');
            this.stderr(
                `\n${colors.yellow('■')} ${colors.bold(colors.yellow('Cancelled'))}${reason ? colors.dim(` · ${reason}`) : ''}\n`
            );
        }
    }

    finish(): void {
        this.endAnswer();
    }

    private endAnswer(): void {
        if (!this.inAnswer) return;
        this.markdown.flush();
        this.stdout('\n');
        this.markdown.reset();
        this.inAnswer = false;
    }
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

function questionText(value: unknown): string {
    const questions = record(value)?.questions;
    if (!Array.isArray(questions)) return '';
    return text(questions[0], 'question');
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
