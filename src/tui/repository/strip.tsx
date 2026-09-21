import { type Accessor, Show } from 'solid-js';
import type { RepositoryDeliveryReceipt } from '../../repositories/index.js';
import { useTheme } from '../theme/index.js';
import type { RepositoryController } from './controller.js';

export function RepositoryStrip(props: { controller: RepositoryController }) {
    const { theme } = useTheme();
    const binding = () =>
        props.controller.state().status?.binding ?? props.controller.binding;
    const receipt = () => props.controller.state().status?.receipt;
    const authentication = () =>
        binding()
            ? binding()?.delivery === 'pr'
                ? 'GitHub auth enabled'
                : 'legacy read-only'
            : 'GitHub auth on launch';
    return (
        <Show when={props.controller.available}>
            <box flexDirection="column" flexShrink={0}>
                <text fg={theme.textMuted} truncate={true}>
                    {props.controller.target} · base{' '}
                    {binding()?.base_branch ??
                        props.controller.request?.ref ??
                        'default'}{' '}
                    · {authentication()} · ctrl+g GitHub
                </text>
                <Show when={receipt()}>
                    {(value: Accessor<RepositoryDeliveryReceipt>) => (
                        <text
                            fg={value().state === 'failed' ? theme.error : theme.accent}
                            truncate={true}
                        >
                            <Show
                                when={value().pull_request}
                                fallback={`PR: ${value().state}`}
                            >
                                {(pull: Accessor<{ url: string; number: number }>) => (
                                    <a href={pull().url}>PR #{pull().number}</a>
                                )}
                            </Show>
                            {' · '}
                            {value().state}
                            {props.controller.state().checks
                                ? ` · CI ${props.controller.state().checks?.state} (observed)`
                                : ''}
                        </text>
                    )}
                </Show>
                <Show when={props.controller.state().error}>
                    <text fg={theme.warning} truncate={true}>
                        {props.controller.state().error}
                    </text>
                </Show>
            </box>
        </Show>
    );
}
