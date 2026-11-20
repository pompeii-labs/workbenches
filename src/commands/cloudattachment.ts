import type { CloudClient } from '../cloud/client.js';
import { standardEvent } from '../cloud/contracts.js';
import { AuthenticationRequiredError } from '../connections/error.js';
import { createEventRenderer } from '../rendering/index.js';

/** Follows a cloud run in the same output modes as a local attach. */
export class CloudAttachment {
    constructor(private readonly client: Pick<CloudClient, 'follow'>) {}

    async execute(
        id: string,
        args: { json: boolean; final: boolean; color?: boolean | undefined }
    ): Promise<void> {
        const renderer = createEventRenderer({
            mode: args.json ? 'json' : args.final ? 'final' : 'human',
            ...(args.color === undefined ? {} : { color: args.color }),
        });
        const abort = new AbortController();
        const stop = () => abort.abort();
        process.once('SIGINT', stop);
        try {
            for await (const event of this.client.follow(id, 0, abort.signal)) {
                // Events the engine does not define still reach JSON output unchanged.
                if (standardEvent(event)) renderer.render(event);
                else if (args.json) console.log(JSON.stringify(event));
                if (event.type === 'run.failed')
                    process.exitCode = AuthenticationRequiredError.exitCodeFor(
                        event.data
                    );
                if (event.type === 'run.cancelled') process.exitCode = 130;
            }
            if (abort.signal.aborted) process.exitCode = 130;
        } finally {
            process.off('SIGINT', stop);
            renderer.finish();
        }
    }
}
