/** What replaces a credential in text the engine records. */
export const REDACTED = '[REDACTED]';

/**
 * Credential shapes recognizable without knowing the value: provider key
 * prefixes, bearer and basic authorization, JSON Web Tokens, private key
 * blocks, and assignments to variables named like a secret.
 *
 * A host that knows the values it injected can redact them exactly, which is
 * stronger. These patterns also cover local runs and credentials no host
 * injected, such as a key a repository keeps in a file.
 */
const PATTERNS: readonly (readonly [RegExp, string])[] = [
    [
        /-----BEGIN [^-\r\n]+ PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]+ PRIVATE KEY-----/gu,
        '[REDACTED PRIVATE KEY]',
    ],
    [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu, `$1 ${REDACTED}`],
    [/\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{12,}/gu, REDACTED],
    [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, REDACTED],
    [
        /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?))\s*=\s*([^\s]+)/gu,
        `$1=${REDACTED}`,
    ],
    [/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/gu, REDACTED],
    [/\bglpat-[A-Za-z0-9_-]{20,}/gu, REDACTED],
    [/\bxox[baprs]-[A-Za-z0-9-]{16,}/gu, REDACTED],
    [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu, REDACTED],
    [/\bAIza[0-9A-Za-z_-]{35}/gu, REDACTED],
    [/\b(?:hf|npm|e2b|dtn)_[A-Za-z0-9]{20,}/gu, REDACTED],
];

/** The text with every recognizable credential replaced. */
export function redactCredentials(text: string): string {
    let result = text;
    for (const [pattern, replacement] of PATTERNS) {
        result = result.replace(pattern, replacement);
    }
    return result;
}
