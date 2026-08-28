import { SyntaxStyle } from '@opentui/core';

export const theme = {
    background: '#101014',
    panel: '#17171d',
    panelRaised: '#1e1e26',
    text: '#f1efe8',
    muted: '#85838e',
    faint: '#55535f',
    accent: '#a58af9',
    accentSoft: '#332c4d',
    mint: '#72d6b4',
    yellow: '#e7bd72',
    red: '#f07f8f',
} as const;

export const markdownStyle = SyntaxStyle.fromStyles({
    default: { fg: theme.text },
    conceal: { fg: theme.faint, dim: true },
    'markup.heading': { fg: theme.accent, bold: true },
    'markup.heading.1': { fg: theme.accent, bold: true },
    'markup.heading.2': { fg: theme.mint, bold: true },
    'markup.heading.3': { fg: theme.text, bold: true },
    'markup.list': { fg: theme.accent },
    'markup.raw': { fg: theme.mint },
    'markup.strong': { fg: theme.text, bold: true },
    'markup.italic': { fg: theme.text, italic: true },
    'markup.strikethrough': { fg: theme.muted, dim: true },
    'markup.link': { fg: theme.accent, underline: true },
    'markup.link.label': { fg: theme.accent, underline: true },
    'markup.link.url': { fg: theme.faint, dim: true },
    'markup.quote': { fg: theme.muted, italic: true },
});
