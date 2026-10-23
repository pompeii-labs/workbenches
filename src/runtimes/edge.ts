/** Cloudflare could not reach the origin, so the request never arrived. */
const undelivered = new Set([521, 522, 523, 525]);
/** The edge or the origin failed after the request may have arrived. */
const uncertain = new Set([502, 503, 504, 520, 524]);

/**
 * Whether a failed response from a sandbox provider's edge is worth sending
 * the request again for: always when the request never arrived, and only for
 * a `repeatable` request when its outcome is unknown.
 */
export function resendable(status: number, repeatable: boolean): boolean {
    return undelivered.has(status) || (repeatable && uncertain.has(status));
}
