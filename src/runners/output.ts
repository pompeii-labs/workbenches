/** Removes credential-shaped environment values from runner diagnostics. */
export function redactRunnerEnvironment(
    source: string,
    environment: Record<string, string | undefined>
): string {
    let result = source;
    const values = Object.entries(environment)
        .filter(([name]) => isCredentialName(name))
        .flatMap(([, value]) => (value && value.length >= 4 ? [value] : []))
        .toSorted((left, right) => right.length - left.length);
    for (const value of values) result = result.replaceAll(value, '[REDACTED]');
    return result;
}

function isCredentialName(name: string): boolean {
    return /(?:^|_)(?:API_?KEY|AUTH|CREDENTIALS?|PASSWORD|PRIVATE_?KEY|SECRET|TOKEN)(?:_|$)/i.test(
        name
    );
}
