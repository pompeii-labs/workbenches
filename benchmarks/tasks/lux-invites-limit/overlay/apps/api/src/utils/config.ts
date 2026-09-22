// Limits the app reads from env rather than hard-codes, so they can be
// tuned per-environment (and shortened for local testing) without a code
// change.
export const RATE_LIMIT_MAX_INVITES = Number(process.env.RATE_LIMIT_MAX_INVITES ?? 5);
export const RATE_LIMIT_WINDOW_SECONDS = Number(process.env.RATE_LIMIT_WINDOW_SECONDS ?? 3600);
