import { stripVTControlCharacters } from 'node:util';

export type TerminalStyle = (value: string) => string;

export interface TerminalSegment {
    text: string;
    styles: TerminalStyle[];
}

export function sanitizeTerminalText(value: string): string {
    return [...stripVTControlCharacters(value).replace(/\r\n?/gu, '\n')]
        .filter((character) => {
            const code = character.codePointAt(0) ?? 0;
            if (code < 32) return code === 9 || code === 10;
            if (code >= 127 && code <= 159) return false;
            if (code >= 0x202a && code <= 0x202e) return false;
            if (code >= 0x2066 && code <= 0x2069) return false;
            return code !== 0xfeff;
        })
        .join('');
}

export function terminalWidth(value: string): number {
    const plain = stripVTControlCharacters(value);
    const bun = (
        globalThis as typeof globalThis & {
            Bun?: { stringWidth?: (input: string) => number };
        }
    ).Bun;
    return bun?.stringWidth?.(plain) ?? [...plain].length;
}

export function normalizeTerminalColumns(value: number): number {
    return Number.isFinite(value) ? Math.max(20, Math.floor(value)) : 80;
}

export function wrapTerminalSegments(
    segments: TerminalSegment[],
    columns: number
): string[] {
    const width = Math.max(1, Math.floor(columns));
    const lines: string[] = [];
    let line = '';
    let lineWidth = 0;
    let pendingSpace = false;

    const breakLine = () => {
        lines.push(line.replace(/\s+$/u, ''));
        line = '';
        lineWidth = 0;
        pendingSpace = false;
    };

    for (const segment of segments) {
        const safe = sanitizeTerminalText(segment.text).replaceAll('\t', '    ');
        for (const part of safe.split(/(\s+)/u)) {
            if (!part) continue;
            if (/\s+/u.test(part)) {
                for (const character of part) {
                    if (character === '\n') breakLine();
                    else pendingSpace = lineWidth > 0;
                }
                continue;
            }
            for (const chunk of hardWrapTerminalText(part, width)) {
                const chunkWidth = terminalWidth(chunk);
                const spacer = pendingSpace && lineWidth > 0 ? 1 : 0;
                if (lineWidth > 0 && lineWidth + spacer + chunkWidth > width) {
                    breakLine();
                }
                if (pendingSpace && lineWidth > 0) {
                    line += ' ';
                    lineWidth += 1;
                }
                line += applyTerminalStyles(chunk, segment.styles);
                lineWidth += chunkWidth;
                pendingSpace = false;
                if (lineWidth >= width) breakLine();
            }
        }
    }
    if (line || lines.length === 0) lines.push(line.replace(/\s+$/u, ''));
    return lines;
}

export function wrapPlainTerminalText(value: string, columns: number): string[] {
    return wrapTerminalSegments(
        [{ text: sanitizeTerminalText(value), styles: [] }],
        columns
    );
}

export function hardWrapTerminalText(value: string, columns: number): string[] {
    if (!value) return [''];
    const chunks: string[] = [];
    let chunk = '';
    let width = 0;
    for (const character of graphemes(value)) {
        const nextWidth = terminalWidth(character);
        if (chunk && width + nextWidth > columns) {
            chunks.push(chunk);
            chunk = '';
            width = 0;
        }
        chunk += character;
        width += nextWidth;
    }
    if (chunk) chunks.push(chunk);
    return chunks;
}

export function identityTerminalStyle(value: string): string {
    return value;
}

function applyTerminalStyles(value: string, styles: TerminalStyle[]): string {
    return styles.reduce((result, style) => style(result), value);
}

function graphemes(value: string): string[] {
    const Segmenter = Intl.Segmenter;
    if (!Segmenter) return [...value];
    return [
        ...new Segmenter(undefined, { granularity: 'grapheme' }).segment(value),
    ].map((entry) => entry.segment);
}
