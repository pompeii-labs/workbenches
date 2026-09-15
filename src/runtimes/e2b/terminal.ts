export function terminalDimensions(): { columns: number; rows: number } {
    const output = globalThis.process.stdout;
    return {
        columns: Math.max(1, output.columns ?? 80),
        rows: Math.max(1, output.rows ?? 24),
    };
}
