/** Values shorter than this are too common in ordinary text to redact exactly. */
const MINIMUM_SECRET_LENGTH = 4;

/** A variable named like a credential, such as `OPENAI_API_KEY` or `GH_TOKEN`. */
export function isCredentialName(name: string): boolean {
    return /(?:^|_)(?:API_?KEY|AUTH|CREDENTIALS?|PASSWORD|PRIVATE_?KEY|SECRET|TOKEN)(?:_|$)/i.test(
        name
    );
}

/**
 * The values the engine passes into a run that must never appear in what the
 * run reports: every variable in `names`, such as those the Workbench declares,
 * provider keys, and runtime keys, and every variable named like a credential.
 * Longest first, so a value that contains another is replaced whole.
 */
export function injectedSecrets(
    environment: Record<string, string | undefined>,
    names: Iterable<string> = []
): string[] {
    const selected = new Set([
        ...names,
        ...Object.keys(environment).filter(isCredentialName),
    ]);
    return uniqueSecrets(
        [...selected].flatMap((name) => {
            const value = environment[name];
            return value ? [value] : [];
        })
    );
}

/** The values long enough to redact, without duplicates, longest first. */
export function uniqueSecrets(values: Iterable<string>): string[] {
    return [...new Set(values)]
        .filter((value) => value.length >= MINIMUM_SECRET_LENGTH)
        .toSorted((left, right) => right.length - left.length);
}
