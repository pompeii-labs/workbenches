/**
 * The variable a worker names the environment variables a docker run's
 * container receives beyond what the Workbench declares, as a JSON array of
 * names. The values come from the same environment. The engine consumes it
 * and neither the container nor the runner sees it.
 */
export const CONTAINER_FORWARD_VARIABLE = 'WORKBENCH_FORWARD';

/** The names a worker asked to forward into the container. Throws when the list is present but malformed. */
export function readContainerForwardNames(
    environment: Record<string, string | undefined>
): string[] {
    const text = environment[CONTAINER_FORWARD_VARIABLE];
    if (text === undefined) return [];
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        throw new Error('The run forwarded variables are not JSON');
    }
    if (
        !Array.isArray(value) ||
        !value.every(
            (name): name is string =>
                typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
        )
    )
        throw new Error('The run forwarded variables are malformed');
    return value;
}

/**
 * The variable a worker names the host directory holding the starting
 * member's runner sign-ins in: their data home, where a local run of theirs
 * finds them. A docker run mounts it, read-write, as the runner's credential
 * root, so their sign-ins and renewals are the same ones. The engine consumes
 * it and the runner never sees it.
 */
export const CREDENTIAL_ROOT_VARIABLE = 'WORKBENCH_CREDENTIAL_ROOT';

/** The host directory a worker named for the member's sign-ins. Throws when it is not absolute. */
export function readCredentialRoot(
    environment: Record<string, string | undefined>
): string | undefined {
    const root = environment[CREDENTIAL_ROOT_VARIABLE];
    if (root === undefined) return undefined;
    if (!root.startsWith('/'))
        throw new Error('The run credential root is not absolute');
    return root;
}

/** The environment without the variables a worker hands the engine, for the runner. */
export function withoutHostVariables(
    environment: Record<string, string | undefined>
): Record<string, string | undefined> {
    const {
        [CONTAINER_FORWARD_VARIABLE]: _forward,
        [CREDENTIAL_ROOT_VARIABLE]: _root,
        ...rest
    } = environment;
    return rest;
}
