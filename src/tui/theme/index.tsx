import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SyntaxStyle } from '@opentui/core';
import { useRenderer } from '@opentui/solid';
import {
    createContext,
    createEffect,
    createMemo,
    createSignal,
    onCleanup,
    type ParentProps,
    useContext,
} from 'solid-js';

import catppuccin from './assets/catppuccin.json' with { type: 'json' };
import dracula from './assets/dracula.json' with { type: 'json' };
import flexoki from './assets/flexoki.json' with { type: 'json' };
import github from './assets/github.json' with { type: 'json' };
import rosepine from './assets/rosepine.json' with { type: 'json' };
import tokyonight from './assets/tokyonight.json' with { type: 'json' };

export type ThemeMode = 'dark' | 'light';

type ThemeVariant = { dark: string; light: string };
type ThemeValue = string | ThemeVariant;
type ThemeJson = {
    defs?: Record<string, string>;
    theme: Record<string, ThemeValue>;
};

export interface WorkbenchTheme {
    primary: string;
    secondary: string;
    accent: string;
    error: string;
    warning: string;
    success: string;
    info: string;
    text: string;
    textMuted: string;
    background: string;
    backgroundPanel: string;
    backgroundElement: string;
    border: string;
    borderActive: string;
    borderSubtle: string;
    markdownText: string;
    markdownHeading: string;
    markdownLink: string;
    markdownCode: string;
    markdownBlockQuote: string;
    markdownEmph: string;
    markdownStrong: string;
    markdownListItem: string;
    panel: string;
    panelRaised: string;
    muted: string;
    faint: string;
    accentSoft: string;
    mint: string;
    yellow: string;
    red: string;
}

export interface ThemeOption {
    name: string;
    label: string;
}

const defaultTheme = 'flexoki';
const definitions: Record<string, { label: string; value: ThemeJson }> = {
    flexoki: { label: 'Flexoki', value: flexoki as ThemeJson },
    github: { label: 'GitHub', value: github as ThemeJson },
    catppuccin: { label: 'Catppuccin', value: catppuccin as ThemeJson },
    dracula: { label: 'Dracula', value: dracula as ThemeJson },
    tokyonight: { label: 'Tokyo Night', value: tokyonight as ThemeJson },
    rosepine: { label: 'Rosé Pine', value: rosepine as ThemeJson },
};

type ThemeListener = () => void;

export class ThemeController {
    private active = defaultTheme;
    private mode: ThemeMode = 'dark';
    private readonly listeners = new Set<ThemeListener>();

    constructor(private readonly home: string) {}

    get selected(): string {
        return this.active;
    }

    get current(): WorkbenchTheme {
        return resolveTheme(definitions[this.active]?.value ?? flexoki, this.mode);
    }

    list(): ThemeOption[] {
        return Object.entries(definitions).map(([name, definition]) => ({
            name,
            label: definition.label,
        }));
    }

    has(name: string): boolean {
        return definitions[name] !== undefined;
    }

    async load(): Promise<void> {
        try {
            const saved = JSON.parse(await readFile(this.path, 'utf8')) as unknown;
            const name = themeName(saved);
            if (name && this.has(name)) this.active = name;
        } catch (error) {
            if (!isMissingFile(error)) throw error;
        }
    }

    setMode(mode: ThemeMode): void {
        if (this.mode === mode) return;
        this.mode = mode;
        this.notify();
    }

    preview(name: string): void {
        if (!this.has(name)) throw new Error(`Unknown theme: ${name}`);
        if (this.active === name) return;
        this.active = name;
        this.notify();
    }

    async select(name: string): Promise<void> {
        this.preview(name);
        await this.persist();
    }

    subscribe(listener: ThemeListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private get path(): string {
        return join(this.home, 'tui.json');
    }

    private async persist(): Promise<void> {
        await mkdir(this.home, { recursive: true, mode: 0o700 });
        const temporary = `${this.path}.${process.pid}.tmp`;
        await writeFile(
            temporary,
            `${JSON.stringify({ theme: this.active }, null, 2)}\n`,
            {
                mode: 0o600,
            }
        );
        await rename(temporary, this.path);
    }

    private notify(): void {
        for (const listener of this.listeners) listener();
    }
}

interface ThemeContextValue {
    theme: WorkbenchTheme;
    syntax: () => SyntaxStyle;
    selected: () => string;
    options: () => ThemeOption[];
    preview: (name: string) => void;
    select: (name: string) => Promise<void>;
}

const ThemeContext = createContext<ThemeContextValue>();

export function ThemeProvider(props: ParentProps<{ controller: ThemeController }>) {
    const renderer = useRenderer();
    let revision = 0;
    const [version, setVersion] = createSignal(0);
    const unsubscribe = props.controller.subscribe(() => {
        revision += 1;
        setVersion(revision);
    });
    onCleanup(unsubscribe);

    const theme = createMemo(() => {
        version();
        return props.controller.current;
    });
    const syntax = createMemo(() => markdownStyle(theme()));
    createEffect(() => renderer.setBackgroundColor(theme().background));

    const reactiveTheme = new Proxy({} as WorkbenchTheme, {
        get: (_target, property: keyof WorkbenchTheme) => theme()[property],
    });

    const value: ThemeContextValue = {
        theme: reactiveTheme,
        syntax,
        selected: () => {
            version();
            return props.controller.selected;
        },
        options: () => props.controller.list(),
        preview: (name) => props.controller.preview(name),
        select: (name) => props.controller.select(name),
    };
    return (
        <ThemeContext.Provider value={value}>{props.children}</ThemeContext.Provider>
    );
}

export function useTheme(): ThemeContextValue {
    const value = useContext(ThemeContext);
    if (!value) throw new Error('useTheme must be used within ThemeProvider');
    return value;
}

function resolveTheme(definition: ThemeJson, mode: ThemeMode): WorkbenchTheme {
    const color = (name: keyof WorkbenchTheme) =>
        resolveColor(definition, definition.theme[name], mode, [name]);
    const resolved = {
        primary: color('primary'),
        secondary: color('secondary'),
        accent: color('accent'),
        error: color('error'),
        warning: color('warning'),
        success: color('success'),
        info: color('info'),
        text: color('text'),
        textMuted: color('textMuted'),
        background: color('background'),
        backgroundPanel: color('backgroundPanel'),
        backgroundElement: color('backgroundElement'),
        border: color('border'),
        borderActive: color('borderActive'),
        borderSubtle: color('borderSubtle'),
        markdownText: color('markdownText'),
        markdownHeading: color('markdownHeading'),
        markdownLink: color('markdownLink'),
        markdownCode: color('markdownCode'),
        markdownBlockQuote: color('markdownBlockQuote'),
        markdownEmph: color('markdownEmph'),
        markdownStrong: color('markdownStrong'),
        markdownListItem: color('markdownListItem'),
    };
    return {
        ...resolved,
        panel: resolved.backgroundPanel,
        panelRaised: resolved.backgroundElement,
        muted: resolved.textMuted,
        faint: resolved.border,
        accentSoft: resolved.backgroundElement,
        mint: resolved.success,
        yellow: resolved.warning,
        red: resolved.error,
    };
}

function resolveColor(
    definition: ThemeJson,
    value: ThemeValue | undefined,
    mode: ThemeMode,
    chain: string[]
): string {
    if (!value) throw new Error(`Theme color is missing: ${chain.at(-1)}`);
    const selected = typeof value === 'string' ? value : value[mode];
    if (selected.startsWith('#')) return selected;
    if (chain.includes(selected)) {
        throw new Error(`Circular theme color: ${[...chain, selected].join(' -> ')}`);
    }
    const next = definition.defs?.[selected] ?? definition.theme[selected];
    return resolveColor(definition, next, mode, [...chain, selected]);
}

function markdownStyle(theme: WorkbenchTheme): SyntaxStyle {
    return SyntaxStyle.fromStyles({
        default: { fg: theme.markdownText },
        conceal: { fg: theme.textMuted, dim: true },
        'markup.heading': { fg: theme.markdownHeading, bold: true },
        'markup.heading.1': { fg: theme.markdownHeading, bold: true },
        'markup.heading.2': { fg: theme.secondary, bold: true },
        'markup.heading.3': { fg: theme.text, bold: true },
        'markup.list': { fg: theme.markdownListItem },
        'markup.raw': { fg: theme.markdownCode },
        'markup.strong': { fg: theme.markdownStrong, bold: true },
        'markup.italic': { fg: theme.markdownEmph, italic: true },
        'markup.strikethrough': { fg: theme.textMuted, dim: true },
        'markup.link': { fg: theme.markdownLink, underline: true },
        'markup.link.label': { fg: theme.markdownLink, underline: true },
        'markup.link.url': { fg: theme.textMuted, dim: true },
        'markup.quote': { fg: theme.markdownBlockQuote, italic: true },
    });
}

function themeName(value: unknown): string | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const candidate = Reflect.get(value, 'theme');
    return typeof candidate === 'string' ? candidate : undefined;
}

function isMissingFile(error: unknown): boolean {
    return (
        error instanceof Error &&
        'code' in error &&
        Reflect.get(error, 'code') === 'ENOENT'
    );
}
