import { RuntimeError } from '../error.js';
import type { DaytonaClock, DaytonaSandbox } from './contracts.js';

const maximumAttempts = 4;
const firstRetryDelayMs = 500;

/**
 * Asks a sandbox for a signed preview URL of one port and shares it.
 * Concurrent calls share one request. A failed request is retried a few times
 * with a growing delay, and one that still fails is not kept, so the next call
 * asks again.
 */
export class PreviewUrl {
    private pending: Promise<URL> | undefined;

    constructor(
        private readonly sandbox: Pick<DaytonaSandbox, 'previewUrl'>,
        private readonly port: number,
        private readonly clock: Pick<DaytonaClock, 'sleep'>
    ) {}

    /** The URL, valid for at least `ttlSeconds` when it is first requested. */
    get(ttlSeconds: number): Promise<URL> {
        if (this.pending) return this.pending;
        const started = this.request(ttlSeconds);
        this.pending = started;
        started.catch(() => {
            if (this.pending === started) this.pending = undefined;
        });
        return started;
    }

    private async request(ttlSeconds: number): Promise<URL> {
        for (let attempt = 1; ; attempt++) {
            try {
                return this.parse(await this.sandbox.previewUrl(this.port, ttlSeconds));
            } catch (error) {
                if (error instanceof RuntimeError || attempt >= maximumAttempts) {
                    throw error;
                }
                await this.clock.sleep(firstRetryDelayMs * 2 ** (attempt - 1));
            }
        }
    }

    /** The signed URL carries an access token, so it never appears in an error. */
    private parse(signed: string): URL {
        try {
            return new URL(signed);
        } catch {
            throw new RuntimeError(
                'daytona',
                'launch',
                'Daytona returned a malformed preview URL'
            );
        }
    }
}
