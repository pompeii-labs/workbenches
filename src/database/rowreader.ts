export type Row = Record<string, unknown>;

/** Typed access to a result row. A column of the wrong type is corruption. */
export class RowReader {
    constructor(
        private readonly row: Row,
        private readonly label: string
    ) {}

    text(column: string): string {
        const value = this.row[column];
        if (typeof value !== 'string') throw this.invalid(column);
        return value;
    }

    optionalText(column: string): string | undefined {
        const value = this.row[column];
        if (value === null || value === undefined) return undefined;
        if (typeof value !== 'string') throw this.invalid(column);
        return value;
    }

    integer(column: string): number {
        const value = this.row[column];
        if (typeof value !== 'number' || !Number.isSafeInteger(value))
            throw this.invalid(column);
        return value;
    }

    optionalInteger(column: string): number | undefined {
        const value = this.row[column];
        if (value === null || value === undefined) return undefined;
        return this.integer(column);
    }

    optionalFlag(column: string): boolean | undefined {
        const value = this.optionalInteger(column);
        return value === undefined ? undefined : value !== 0;
    }

    /** Parses a JSON column and checks it with `guard`. */
    json<T>(column: string, guard: (value: unknown) => value is T): T {
        const value = this.optionalJson(column, guard);
        if (value === undefined) throw this.invalid(column);
        return value;
    }

    optionalJson<T>(
        column: string,
        guard: (value: unknown) => value is T
    ): T | undefined {
        const source = this.optionalText(column);
        if (source === undefined) return undefined;
        let value: unknown;
        try {
            value = JSON.parse(source);
        } catch {
            throw this.invalid(column);
        }
        if (!guard(value)) throw this.invalid(column);
        return value;
    }

    /** Whether a parsed JSON value is a plain object. */
    static isRecord(value: unknown): value is Record<string, unknown> {
        return typeof value === 'object' && value !== null && !Array.isArray(value);
    }

    private invalid(column: string): Error {
        return new Error(`Invalid ${this.label}: column ${column}`);
    }
}
