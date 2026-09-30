export const orgArgument = {
    type: 'string',
    description: 'Held organization slug to use instead of the default',
} as const;

/**
 * `--publisher` is not declared, so it stays out of help. Old scripts that
 * still pass it fail loudly instead of publishing under the wrong organization.
 */
export function rejectPublisherFlag(args: object): void {
    if (Reflect.get(args, 'publisher') !== undefined) {
        throw new Error('--publisher was replaced by --org. Use --org <slug>');
    }
    if (Reflect.get(args, 'private') !== undefined) {
        throw new Error(
            'Unknown option --private. Pushed workbenches are internal by default; wb publish makes a version public'
        );
    }
}
