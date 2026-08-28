import { RegistryClient } from '../client.js';

export function registryImageReference(
    publisher: string,
    name: string,
    tag: string,
    registry = new RegistryClient()
): string {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(publisher)) {
        throw new Error(`Invalid publisher slug: ${publisher}`);
    }
    if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(name)) {
        throw new Error(`Invalid registry image name: ${name}`);
    }
    if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(tag)) {
        throw new Error(`Invalid registry image tag: ${tag}`);
    }
    return `${registry.imageHost}/${publisher}/${name}:${tag}`;
}
