import { SelectDialog } from '../dialog/select.js';
import type { TuiCommand, TuiCommandRegistry } from './registry.js';

export function CommandPalette(props: {
    commands: TuiCommandRegistry;
    onSelect: (command: TuiCommand) => void;
}) {
    return (
        <SelectDialog
            title="Commands"
            placeholder="Search commands"
            options={props.commands.list().map((command) => ({
                title: `/${command.name}`,
                description: command.description,
                category: command.category,
                value: command,
                disabled: command.enabled === false,
            }))}
            onSelect={(option) => props.onSelect(option.value)}
        />
    );
}
