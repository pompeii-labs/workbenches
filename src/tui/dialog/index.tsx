import { type Renderable, RGBA } from '@opentui/core';
import { useKeyboard, useRenderer, useTerminalDimensions } from '@opentui/solid';
import {
    type Accessor,
    createContext,
    createSignal,
    type JSX,
    onCleanup,
    type ParentProps,
    Show,
    useContext,
} from 'solid-js';

import { useTheme } from '../theme/index.js';

interface DialogEntry {
    element: () => JSX.Element;
    onClose?: () => void;
}

export interface DialogContextValue {
    active: () => boolean;
    open: (element: () => JSX.Element, onClose?: () => void) => void;
    close: () => void;
}

const DialogContext = createContext<DialogContextValue>();

export function DialogProvider(props: ParentProps) {
    const renderer = useRenderer();
    const [entry, setEntry] = createSignal<DialogEntry>();
    let previousFocus: Renderable | undefined;

    const close = () => {
        const current = entry();
        if (!current) return;
        current.onClose?.();
        setEntry(undefined);
        setTimeout(() => {
            if (!previousFocus?.isDestroyed) previousFocus?.focus();
            previousFocus = undefined;
        }, 1);
    };
    const value: DialogContextValue = {
        active: () => entry() !== undefined,
        open: (element, onClose) => {
            entry()?.onClose?.();
            if (!entry()) {
                previousFocus = renderer.currentFocusedRenderable ?? undefined;
                previousFocus?.blur();
            }
            setEntry({ element, ...(onClose ? { onClose } : {}) });
        },
        close,
    };

    useKeyboard((key) => {
        if (!entry()) return;
        if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
            key.preventDefault();
            close();
        }
    });
    onCleanup(() => entry()?.onClose?.());

    return (
        <DialogContext.Provider value={value}>
            {props.children}
            <Show when={entry()}>
                {(current: Accessor<DialogEntry>) => (
                    <DialogSurface onClose={close}>{current().element()}</DialogSurface>
                )}
            </Show>
        </DialogContext.Provider>
    );
}

export function useDialog(): DialogContextValue {
    const value = useContext(DialogContext);
    if (!value) throw new Error('useDialog must be used within DialogProvider');
    return value;
}

function DialogSurface(props: ParentProps<{ onClose: () => void }>) {
    const dimensions = useTerminalDimensions();
    const { theme } = useTheme();

    return (
        <box
            width={dimensions().width}
            height={dimensions().height}
            alignItems="center"
            position="absolute"
            zIndex={3000}
            paddingTop={Math.max(1, Math.floor(dimensions().height / 5))}
            left={0}
            top={0}
            backgroundColor={RGBA.fromInts(0, 0, 0, 150)}
        >
            <box
                width={64}
                maxWidth={dimensions().width - 4}
                maxHeight={dimensions().height - 4}
                backgroundColor={theme.backgroundPanel}
                border={['left', 'right']}
                borderColor={theme.border}
            >
                {props.children}
            </box>
        </box>
    );
}
