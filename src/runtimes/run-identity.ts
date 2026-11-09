/**
 * The identity a host gives a run in `RuntimePrepareRequest.run`. Providers
 * label what they create with it, so cleanup can find a run's sandboxes and
 * containers again. Labels are restricted, so both parts have fixed formats.
 */
export interface RunIdentity {
    /** `wb_` and 20 to 64 lowercase letters and digits. */
    id: string;
    /** 24 lowercase hexadecimal characters, such as a truncated SHA-256 digest. */
    scope: string;
}

const runIdPattern = /^wb_[a-z0-9]{20,64}$/;
const scopePattern = /^[a-f0-9]{24}$/;

/** Whether `id` is a valid run ID. */
export function validRunId(id: string): boolean {
    return runIdPattern.test(id);
}

/** Whether `scope` is a valid run scope. */
export function validRunScope(scope: string): boolean {
    return scopePattern.test(scope);
}

/**
 * Throws when a host-supplied run identity is malformed. A provider calls it
 * first in `prepare`, before anything is built or created, so a bad identity
 * costs nothing.
 */
export function checkRunIdentity(run: RunIdentity | undefined): void {
    if (!run) return;
    if (!validRunId(run.id)) {
        throw new Error(
            `Invalid Workbench run ID: ${run.id}. A run ID is wb_ followed by 20 to 64 lowercase letters and digits.`
        );
    }
    if (!validRunScope(run.scope)) {
        throw new Error(
            `Invalid Workbench run scope: ${run.scope}. A scope is 24 lowercase hexadecimal characters.`
        );
    }
}
