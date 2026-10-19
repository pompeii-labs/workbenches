import type { StudioServices } from './services.js';
import type { StudioState } from './state.js';

/** The detached `__studio` process: serves the API until it is signalled. */
export class StudioProcess {
    constructor(
        private readonly state: Pick<StudioState, 'read'>,
        private readonly studio: Pick<StudioServices, 'server'>
    ) {}

    async run(): Promise<number> {
        const record = this.state.read();
        if (!record) return 1;
        const server = this.studio.server(record.token, record.api_port);
        await server.start();
        return new Promise<number>((resolve) => {
            const stop = () => {
                void server.stop().finally(() => resolve(0));
            };
            process.once('SIGTERM', stop);
            process.once('SIGINT', stop);
        });
    }
}
