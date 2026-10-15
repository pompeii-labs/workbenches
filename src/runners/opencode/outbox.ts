import { isAbsolute, pathStyle, relative, resolve } from '../../platform/paths.js';
import { isWindowsPath } from '../windows.js';

export function isOutboxPermission(
    action: string,
    resources: string[],
    outbox: string | undefined
): boolean {
    if (outbox && isWindowsPath(outbox)) outbox = outbox.replaceAll('\\', '/');
    if (
        action !== 'external_directory' ||
        !outbox ||
        !isAbsolute(outbox) ||
        /[?*\\\0]/u.test(outbox) ||
        resources.length === 0
    )
        return false;
    const root = resolve(outbox);
    if (root === pathStyle(root).parse(root).root) return false;
    return resources.every((resource) => {
        if (!resource.endsWith('/*')) return false;
        const source = resource.slice(0, -2);
        const directory = isWindowsPath(source) ? source.replaceAll('\\', '/') : source;
        if (
            !isAbsolute(directory) ||
            /[?*\\\0]/u.test(directory) ||
            directory.split('/').includes('..')
        )
            return false;
        const path = relative(root, resolve(directory));
        return (
            path === '' ||
            (path !== '..' && !/^\.\.[\\/]/.test(path) && !isAbsolute(path))
        );
    });
}
