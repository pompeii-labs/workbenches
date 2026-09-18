import type { NormalizedRunnerInput } from '../session.js';

export function openCodeParts(input: NormalizedRunnerInput, runtimeReminder?: string) {
    return [
        ...(runtimeReminder
            ? [{ type: 'text', text: runtimeReminder, synthetic: true }]
            : []),
        { type: 'text', text: input.text },
        ...input.images.map((image) => ({
            type: 'file',
            mime: image.mimeType,
            url: `data:${image.mimeType};base64,${image.data}`,
            ...(image.name ? { filename: image.name } : {}),
        })),
    ];
}
