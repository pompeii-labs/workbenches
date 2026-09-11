import pc from 'picocolors';

export type CliTone = 'success' | 'info' | 'warning' | 'error' | 'muted';

export interface CliRecord {
    machine: Array<string | undefined>;
    title: string;
    details?: Array<string | undefined>;
    tone?: CliTone;
    stream?: 'stdout' | 'stderr';
}

export interface CliPresenterOptions {
    interactive?: boolean;
    color?: boolean;
    stdout?: (value: string) => void;
    stderr?: (value: string) => void;
}

export class CliPresenter {
    readonly #interactive: boolean;
    readonly #colors: ReturnType<typeof pc.createColors>;
    readonly #stdout: (value: string) => void;
    readonly #stderr: (value: string) => void;

    constructor(options: CliPresenterOptions = {}) {
        this.#interactive = options.interactive ?? Boolean(process.stdout.isTTY);
        const color =
            options.color ??
            (this.#interactive &&
                process.env.NO_COLOR === undefined &&
                process.env.TERM !== 'dumb');
        this.#colors = pc.createColors(color);
        this.#stdout = options.stdout ?? ((value) => process.stdout.write(value));
        this.#stderr = options.stderr ?? ((value) => process.stderr.write(value));
    }

    get interactive(): boolean {
        return this.#interactive;
    }

    record(record: CliRecord): void {
        const write = record.stream === 'stderr' ? this.#stderr : this.#stdout;
        if (!this.#interactive) {
            write(
                `${record.machine.filter((value) => value !== undefined).join('\t')}\n`
            );
            return;
        }
        const tone = record.tone ?? 'success';
        const details = (record.details ?? []).filter((value): value is string =>
            Boolean(value)
        );
        const marker = this.#marker(tone);
        const title = this.#color(tone, this.#colors.bold(record.title));
        const suffix = details.length
            ? this.#colors.dim(` · ${details.join(' · ')}`)
            : '';
        write(`${marker} ${title}${suffix}\n`);
    }

    message(
        message: string,
        tone: CliTone = 'muted',
        stream: 'stdout' | 'stderr' = 'stdout'
    ): void {
        const write = stream === 'stderr' ? this.#stderr : this.#stdout;
        if (!this.#interactive) {
            write(`${message}\n`);
            return;
        }
        write(`${this.#marker(tone)} ${this.#color(tone, message)}\n`);
    }

    progress(message: string): void {
        if (!this.#interactive) return;
        this.#stderr(`${this.#colors.cyan('…')} ${message}\n`);
    }

    empty(message: string): void {
        if (!this.#interactive) return;
        this.message(message);
    }

    detail(label: string, value: string): void {
        if (!this.#interactive) {
            this.#stdout(`${label}\t${value}\n`);
            return;
        }
        this.#stdout(
            `  ${this.#colors.dim(label.padEnd(12))}${this.#colors.reset(value)}\n`
        );
    }

    block(lines: string[], tone: CliTone = 'muted'): void {
        if (!this.#interactive || lines.length === 0) return;
        this.#stdout(`${lines.map((line) => this.#color(tone, line)).join('\n')}\n`);
    }

    formattedBlock(styledLines: string[], plainLines = styledLines): void {
        if (!this.#interactive || styledLines.length === 0) return;
        const lines = this.#colors.isColorSupported ? styledLines : plainLines;
        this.#stdout(`${lines.join('\n')}\n`);
    }

    #marker(tone: CliTone): string {
        if (tone === 'success') return this.#colors.green('✓');
        if (tone === 'info') return this.#colors.cyan('●');
        if (tone === 'warning') return this.#colors.yellow('△');
        if (tone === 'error') return this.#colors.red('✗');
        return this.#colors.dim('○');
    }

    #color(tone: CliTone, value: string): string {
        if (tone === 'success') return this.#colors.green(value);
        if (tone === 'info') return this.#colors.cyan(value);
        if (tone === 'warning') return this.#colors.yellow(value);
        if (tone === 'error') return this.#colors.red(value);
        return this.#colors.dim(value);
    }
}
