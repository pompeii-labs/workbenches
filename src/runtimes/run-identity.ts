/** A host's run identity. Providers label what they create with it. */
export interface RunIdentity {
    /** `wb_` and 20 to 64 lowercase letters and digits. */
    id: string;
    /** 24 lowercase hexadecimal characters, such as a truncated SHA-256 digest. */
    scope: string;
}

const runIdPattern = /^wb_[a-z0-9]{20,64}$/;
const scopePattern = /^[a-f0-9]{24}$/;

export function validRunId(id: string): boolean {
    return runIdPattern.test(id);
}

export function validRunScope(scope: string): boolean {
    return scopePattern.test(scope);
}

/** Throws when a run identity is malformed. Providers call it first in `prepare`. */
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
