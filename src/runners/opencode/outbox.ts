import { isAbsolute, relative, resolve, sep } from 'node:path';

export function isOutboxPermission(
    action: string,
    resources: string[],
    outbox: string | undefined
): boolean {
    if (
        action !== 'external_directory' ||
        !outbox ||
        !isAbsolute(outbox) ||
        /[?*\\\0]/u.test(outbox) ||
        resources.length === 0
    )
        return false;
    const root = resolve(outbox);
    if (root === sep) return false;
    return resources.every((resource) => {
        if (!resource.endsWith('/*')) return false;
        const directory = resource.slice(0, -2);
        if (
            !isAbsolute(directory) ||
            /[?*\\\0]/u.test(directory) ||
            directory.split('/').includes('..')
        )
            return false;
        const path = relative(root, resolve(directory));
        return (
            path === '' ||
            (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
        );
    });
}
