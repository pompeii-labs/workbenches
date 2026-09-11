import type { WorkbenchTheme } from './theme/index.js';

export const workbenchWordmark = {
    work: [
        '                    ',
        '█   █ █▀▀█ █▀▀▄ █ ▄▀',
        '█_█_█ █__█ █^█  █^▄ ',
        '▀▀ ▀▀ ▀▀▀▀ ▀  ▀ ▀  ▀',
    ],
    bench: [
        '                        ',
        '█▀▀▄ █▀▀█ █▀▀▄ █▀▀▀ █  █',
        '█^^█ █^^^ █__█ █___ █^^█',
        '▀▀▀▀ ▀▀▀▀ ▀~~▀ ▀▀▀▀ ▀  ▀',
    ],
};

const markerCharacters = new Set(['_', '^', '~', ',']);

export class WorkbenchBrand {
    lines(): string[] {
        return workbenchWordmark.work.map((line, index) =>
            `${line} ${workbenchWordmark.bench[index] ?? ''}`
                .split('')
                .map((character) => printableCharacter(character))
                .join('')
                .trimEnd()
        );
    }

    styledLines(
        theme: Pick<WorkbenchTheme, 'textMuted' | 'accent' | 'background'>
    ): string[] {
        const workShadow = tint(theme.background, theme.textMuted, 0.25);
        const benchShadow = tint(theme.background, theme.accent, 0.25);
        return workbenchWordmark.work.map((work, index) => {
            const bench = workbenchWordmark.bench[index] ?? '';
            const combined = `${work} ${bench}`.trimEnd();
            return [...combined]
                .map((character, cell) => {
                    const isBench = cell > work.length;
                    return styledCharacter(
                        character,
                        isBench ? theme.accent : theme.textMuted,
                        isBench ? benchShadow : workShadow,
                        isBench
                    );
                })
                .join('');
        });
    }
}

function printableCharacter(character: string): string {
    if (!markerCharacters.has(character)) return character;
    if (character === ',') return '▄';
    if (character === '_') return ' ';
    return '▀';
}

function styledCharacter(
    character: string,
    foreground: string,
    shadow: string,
    bold: boolean
): string {
    if (character === ' ') return character;
    if (character === '_') return ansi(' ', undefined, shadow, bold);
    if (character === '^') return ansi('▀', foreground, shadow, bold);
    if (character === '~') return ansi('▀', shadow, undefined, bold);
    if (character === ',') return ansi('▄', shadow, undefined, bold);
    return ansi(character, foreground, undefined, bold);
}

function ansi(
    value: string,
    foreground: string | undefined,
    background: string | undefined,
    bold: boolean
): string {
    const codes = [
        ...(bold ? ['1'] : []),
        ...(foreground ? [`38;2;${rgb(foreground).join(';')}`] : []),
        ...(background ? [`48;2;${rgb(background).join(';')}`] : []),
    ];
    return codes.length > 0 ? `\u001b[${codes.join(';')}m${value}\u001b[0m` : value;
}

function tint(base: string, overlay: string, alpha: number): string {
    const baseRgb = rgb(base);
    const overlayRgb = rgb(overlay);
    return `#${baseRgb
        .map((channel, index) =>
            Math.round(channel + ((overlayRgb[index] ?? channel) - channel) * alpha)
                .toString(16)
                .padStart(2, '0')
        )
        .join('')}`;
}

function rgb(hex: string): [number, number, number] {
    const normalized = hex.replace(/^#/u, '');
    if (!/^[0-9a-f]{6}$/iu.test(normalized)) {
        throw new Error(`Invalid Workbench brand color: ${hex}`);
    }
    return [
        Number.parseInt(normalized.slice(0, 2), 16),
        Number.parseInt(normalized.slice(2, 4), 16),
        Number.parseInt(normalized.slice(4, 6), 16),
    ];
}

export const workbenchBrand = new WorkbenchBrand();
