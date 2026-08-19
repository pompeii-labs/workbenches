import { stripVTControlCharacters } from 'node:util';

import { Marked, type Token, type Tokens } from 'marked';

type Colors = {
    bold(value: string): string;
    cyan(value: string): string;
    dim(value: string): string;
    green(value: string): string;
    italic(value: string): string;
    strikethrough(value: string): string;
    underline(value: string): string;
};

type Style = (value: string) => string;

interface Segment {
    text: string;
    styles: Style[];
}

interface OpenFence {
    marker: '`' | '~';
    length: number;
}

const markdown = new Marked({
    async: false,
    breaks: false,
    gfm: true,
    pedantic: false,
});

const plainColors: Colors = {
    bold: identity,
    cyan: identity,
    dim: identity,
    green: identity,
    italic: identity,
    strikethrough: identity,
    underline: identity,
};

export function renderMarkdownPreview(source: string, columns = 88): string {
    return renderBlocks(source, plainColors, columns).join('\n\n');
}

export class TerminalMarkdownStream {
    private buffer = '';
    private wroteBlock = false;

    constructor(
        private readonly write: (value: string) => void,
        private readonly colors: Colors,
        private readonly columns: number
    ) {}

    push(delta: string): void {
        this.buffer += delta;
        const boundary = completeBlockBoundary(this.buffer);
        if (boundary === 0) return;
        const complete = this.buffer.slice(0, boundary);
        this.buffer = this.buffer.slice(boundary);
        this.writeMarkdown(complete);
    }

    flush(): void {
        if (!this.buffer) return;
        this.writeMarkdown(this.buffer);
        this.buffer = '';
    }

    reset(): void {
        this.buffer = '';
        this.wroteBlock = false;
    }

    private writeMarkdown(source: string): void {
        for (const block of renderBlocks(source, this.colors, this.columns)) {
            if (!block) continue;
            if (this.wroteBlock) this.write('\n\n');
            this.write(block);
            this.wroteBlock = true;
        }
    }
}

function renderBlocks(source: string, colors: Colors, columns: number): string[] {
    const safe = sanitizeMarkdown(source);
    if (!safe.trim()) return [];
    try {
        return renderBlockTokens(markdown.lexer(safe), colors, normalizeWidth(columns));
    } catch {
        return wrapPlain(safe, normalizeWidth(columns));
    }
}

function renderBlockTokens(tokens: Token[], colors: Colors, columns: number): string[] {
    const blocks: string[] = [];
    for (const token of tokens) {
        const block = renderBlock(token, colors, columns);
        if (block) blocks.push(block);
    }
    return blocks;
}

function renderBlock(token: Token, colors: Colors, columns: number): string {
    if (token.type === 'space' || token.type === 'def') return '';
    if (token.type === 'heading') {
        const heading = token as Tokens.Heading;
        const styles = heading.depth <= 3 ? [colors.bold, colors.cyan] : [colors.bold];
        const prefix = headingPrefix(heading.depth, colors);
        const width = Math.max(10, columns - visibleWidth(prefix));
        const lines = wrapSegments(
            inlineSegments(heading.tokens, colors, styles),
            width
        );
        return lines
            .map(
                (line, index) =>
                    `${index === 0 ? prefix : ' '.repeat(visibleWidth(prefix))}${line}`
            )
            .join('\n');
    }
    if (token.type === 'paragraph' || token.type === 'text') {
        const paragraph = token as Tokens.Paragraph | Tokens.Text;
        const tokens = paragraph.tokens ?? [];
        const segments = tokens.length
            ? inlineSegments(tokens, colors)
            : [{ text: paragraph.text, styles: [] }];
        return wrapSegments(segments, columns).join('\n');
    }
    if (token.type === 'code') return renderCode(token as Tokens.Code, colors, columns);
    if (token.type === 'blockquote') {
        const blockquote = token as Tokens.Blockquote;
        const inner = renderBlockTokens(
            blockquote.tokens,
            colors,
            Math.max(10, columns - 2)
        );
        const content = inner.join('\n\n');
        return content
            .split('\n')
            .map((line) => `${colors.dim('│')} ${line}`)
            .join('\n');
    }
    if (token.type === 'list') return renderList(token as Tokens.List, colors, columns);
    if (token.type === 'hr') return colors.dim('─'.repeat(Math.min(40, columns)));
    if (token.type === 'table')
        return renderTable(token as Tokens.Table, colors, columns);
    if (token.type === 'html') {
        const plain = (token as Tokens.HTML).text.replace(/<[^>]*>/gu, '');
        return wrapPlain(plain, columns).join('\n');
    }
    const childTokens = tokenChildren(token);
    if (childTokens.length) {
        return wrapSegments(inlineSegments(childTokens, colors), columns).join('\n');
    }
    return wrapPlain(token.raw, columns).join('\n');
}

function renderCode(token: Tokens.Code, colors: Colors, columns: number): string {
    const lines: string[] = [];
    const language = sanitizeMarkdown(token.lang ?? '')
        .trim()
        .split(/\s+/u)[0];
    const label = language || 'code';
    lines.push(colors.dim(`┌─ ${label}`));
    const width = Math.max(1, columns - 2);
    for (const sourceLine of sanitizeMarkdown(token.text).split('\n')) {
        for (const line of hardWrap(sourceLine.replaceAll('\t', '    '), width)) {
            lines.push(`${colors.dim('│')} ${colors.cyan(line)}`);
        }
    }
    lines.push(colors.dim('└─'));
    return lines.join('\n');
}

function renderList(token: Tokens.List, colors: Colors, columns: number): string {
    const start = typeof token.start === 'number' ? token.start : 1;
    return token.items
        .map((item, index) => {
            const marker = item.task
                ? `${item.checked ? colors.green('✓') : colors.dim('○')} `
                : `${token.ordered ? `${start + index}.` : '•'} `;
            const indent = ' '.repeat(visibleWidth(marker));
            const innerWidth = Math.max(10, columns - visibleWidth(marker));
            const blocks = renderBlockTokens(
                item.tokens.filter((child) => child.type !== 'checkbox'),
                colors,
                innerWidth
            );
            const content = blocks.join(item.loose ? '\n\n' : '\n');
            const lines = content.split('\n');
            return lines
                .map((line, lineIndex) => `${lineIndex === 0 ? marker : indent}${line}`)
                .join('\n');
        })
        .join('\n');
}

function renderTable(token: Tokens.Table, colors: Colors, columns: number): string {
    const cells = [token.header, ...token.rows].map((row) =>
        row.map((cell) => plainInline(cell.tokens).replaceAll('\n', ' '))
    );
    if (cells.length === 0 || token.header.length === 0) return '';
    const widths = tableWidths(cells, columns);
    const lines: string[] = [];
    for (const [rowIndex, row] of cells.entries()) {
        const wrapped = row.map((cell, index) => wrapPlain(cell, widths[index] ?? 3));
        const height = Math.max(...wrapped.map((cell) => cell.length));
        for (let lineIndex = 0; lineIndex < height; lineIndex += 1) {
            lines.push(
                wrapped
                    .map((cell, columnIndex) => {
                        const value = cell[lineIndex] ?? '';
                        const padded = alignCell(
                            value,
                            widths[columnIndex] ?? 3,
                            token.align[columnIndex]
                        );
                        return rowIndex === 0 ? colors.bold(padded) : padded;
                    })
                    .join(colors.dim(' │ '))
            );
        }
        if (rowIndex === 0) {
            lines.push(
                widths
                    .map((width) => colors.dim('─'.repeat(width)))
                    .join(colors.dim('─┼─'))
            );
        }
    }
    return lines.join('\n');
}

function headingPrefix(depth: number, colors: Colors): string {
    if (depth === 1) return colors.cyan('▌ ');
    if (depth === 2) return colors.cyan('◆ ');
    if (depth === 3) return colors.cyan('› ');
    return colors.dim('· ');
}

function tableWidths(rows: string[][], columns: number): number[] {
    const count = Math.max(...rows.map((row) => row.length));
    const separatorWidth = Math.max(0, count - 1) * 3;
    const available = Math.max(count * 3, columns - separatorWidth);
    const widths = Array.from({ length: count }, (_, column) =>
        Math.max(3, ...rows.map((row) => visibleWidth(row[column] ?? '')))
    );
    while (widths.reduce((sum, width) => sum + width, 0) > available) {
        const largest = Math.max(...widths);
        const index = widths.findIndex((width) => width === largest && width > 3);
        if (index < 0) break;
        widths[index] = largest - 1;
    }
    return widths;
}

function alignCell(
    value: string,
    width: number,
    alignment: 'center' | 'left' | 'right' | null | undefined
): string {
    const padding = Math.max(0, width - visibleWidth(value));
    if (alignment === 'right') return `${' '.repeat(padding)}${value}`;
    if (alignment === 'center') {
        const left = Math.floor(padding / 2);
        return `${' '.repeat(left)}${value}${' '.repeat(padding - left)}`;
    }
    return `${value}${' '.repeat(padding)}`;
}

function inlineSegments(
    tokens: Token[],
    colors: Colors,
    inherited: Style[] = []
): Segment[] {
    const segments: Segment[] = [];
    for (const token of tokens) {
        if (token.type === 'strong') {
            const strong = token as Tokens.Strong;
            segments.push(
                ...inlineSegments(strong.tokens, colors, [...inherited, colors.bold])
            );
            continue;
        }
        if (token.type === 'em') {
            const emphasis = token as Tokens.Em;
            segments.push(
                ...inlineSegments(emphasis.tokens, colors, [
                    ...inherited,
                    colors.italic,
                ])
            );
            continue;
        }
        if (token.type === 'del') {
            const deleted = token as Tokens.Del;
            segments.push(
                ...inlineSegments(deleted.tokens, colors, [
                    ...inherited,
                    colors.strikethrough,
                ])
            );
            continue;
        }
        if (token.type === 'codespan') {
            const code = token as Tokens.Codespan;
            segments.push({ text: code.text, styles: [...inherited, colors.cyan] });
            continue;
        }
        if (token.type === 'link') {
            const link = token as Tokens.Link;
            segments.push(
                ...inlineSegments(link.tokens, colors, [...inherited, colors.underline])
            );
            const href = safeHref(link.href);
            if (href && href !== link.text) {
                segments.push({ text: ` (${href})`, styles: [colors.dim] });
            }
            continue;
        }
        if (token.type === 'image') {
            const image = token as Tokens.Image;
            segments.push({
                text: `[image: ${image.text.trim() || 'untitled'}]`,
                styles: [colors.dim],
            });
            continue;
        }
        if (token.type === 'br') {
            segments.push({ text: '\n', styles: inherited });
            continue;
        }
        if (token.type === 'html') {
            const plain = (token as Tokens.HTML).text.replace(/<[^>]*>/gu, '');
            if (plain) segments.push({ text: plain, styles: inherited });
            continue;
        }
        const childTokens = tokenChildren(token);
        if (token.type === 'text' && childTokens.length) {
            segments.push(...inlineSegments(childTokens, colors, inherited));
            continue;
        }
        if ('text' in token && typeof token.text === 'string') {
            segments.push({ text: token.text, styles: inherited });
            continue;
        }
        if (childTokens.length) {
            segments.push(...inlineSegments(childTokens, colors, inherited));
        } else if (token.raw) {
            segments.push({ text: token.raw, styles: inherited });
        }
    }
    return segments;
}

function plainInline(tokens: Token[]): string {
    return sanitizeMarkdown(
        tokens
            .map((token) => {
                if (token.type === 'image') {
                    const image = token as Tokens.Image;
                    return `[image: ${image.text || 'untitled'}]`;
                }
                if ('text' in token && typeof token.text === 'string')
                    return token.text;
                const childTokens = tokenChildren(token);
                if (childTokens.length) return plainInline(childTokens);
                return token.raw;
            })
            .join('')
    );
}

function wrapSegments(segments: Segment[], columns: number): string[] {
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
        const safe = sanitizeMarkdown(segment.text).replaceAll('\t', '    ');
        for (const part of safe.split(/(\s+)/u)) {
            if (!part) continue;
            if (/\s+/u.test(part)) {
                for (const character of part) {
                    if (character === '\n') breakLine();
                    else pendingSpace = lineWidth > 0;
                }
                continue;
            }
            for (const chunk of hardWrap(part, width)) {
                const chunkWidth = visibleWidth(chunk);
                const spacer = pendingSpace && lineWidth > 0 ? 1 : 0;
                if (lineWidth > 0 && lineWidth + spacer + chunkWidth > width)
                    breakLine();
                if (pendingSpace && lineWidth > 0) {
                    line += ' ';
                    lineWidth += 1;
                }
                line += applyStyles(chunk, segment.styles);
                lineWidth += chunkWidth;
                pendingSpace = false;
                if (lineWidth >= width) breakLine();
            }
        }
    }
    if (line || lines.length === 0) lines.push(line.replace(/\s+$/u, ''));
    return lines;
}

function wrapPlain(value: string, columns: number): string[] {
    return wrapSegments([{ text: sanitizeMarkdown(value), styles: [] }], columns);
}

function hardWrap(value: string, columns: number): string[] {
    if (!value) return [''];
    const chunks: string[] = [];
    let chunk = '';
    let width = 0;
    for (const character of graphemes(value)) {
        const nextWidth = visibleWidth(character);
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

function graphemes(value: string): string[] {
    const Segmenter = Intl.Segmenter;
    if (!Segmenter) return [...value];
    return [
        ...new Segmenter(undefined, { granularity: 'grapheme' }).segment(value),
    ].map((entry) => entry.segment);
}

function applyStyles(value: string, styles: Style[]): string {
    return styles.reduce((result, style) => style(result), value);
}

function safeHref(value: string): string {
    const href = sanitizeMarkdown(value).trim();
    if (!href) return '';
    try {
        const url = new URL(href);
        return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? href : '';
    } catch {
        return '';
    }
}

function tokenChildren(token: Token): Token[] {
    return 'tokens' in token && Array.isArray(token.tokens) ? token.tokens : [];
}

export function sanitizeMarkdown(value: string): string {
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

function visibleWidth(value: string): number {
    const plain = stripVTControlCharacters(value);
    const bun = (
        globalThis as typeof globalThis & {
            Bun?: { stringWidth?: (input: string) => number };
        }
    ).Bun;
    return bun?.stringWidth?.(plain) ?? [...plain].length;
}

function normalizeWidth(columns: number): number {
    return Number.isFinite(columns) ? Math.max(20, Math.floor(columns)) : 80;
}

function identity(value: string): string {
    return value;
}

function completeBlockBoundary(value: string): number {
    let offset = 0;
    let boundary = 0;
    let fence: OpenFence | undefined;
    let sawContent = false;
    for (const match of value.matchAll(/[^\n]*(?:\n|$)/gu)) {
        const raw = match[0];
        if (!raw?.endsWith('\n')) break;
        offset += raw.length;
        const line = raw.slice(0, -1);
        const marker = fenceMarker(line);
        if (fence) {
            if (
                marker &&
                marker.marker === fence.marker &&
                marker.length >= fence.length &&
                marker.closing
            ) {
                fence = undefined;
                boundary = offset;
            }
            continue;
        }
        if (marker) {
            fence = { marker: marker.marker, length: marker.length };
            sawContent = true;
            continue;
        }
        if (line.trim()) {
            sawContent = true;
            continue;
        }
        if (sawContent) boundary = offset;
    }
    return boundary;
}

function fenceMarker(
    line: string
): { marker: '`' | '~'; length: number; closing: boolean } | undefined {
    const normalized = line.replace(/^[ \t]{0,3}/u, '');
    const match = /^(`{3,}|~{3,})(.*)$/u.exec(normalized);
    if (!match) return undefined;
    const run = match[1] ?? '';
    const suffix = match[2] ?? '';
    if (!run) return undefined;
    return {
        marker: run[0] as '`' | '~',
        length: run.length,
        closing: suffix.trim() === '',
    };
}
