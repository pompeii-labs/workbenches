import { join } from 'node:path';

import packageMetadata from '../../package.json' with { type: 'json' };
import { Connection } from '../database/connection.js';
import { ModelCatalog } from '../models/catalog.js';
import { RegistryClient } from '../registry/client.js';
import { RunnerRegistry } from '../runners/registry.js';
import { SessionRetention } from '../sessions/retention.js';
import { Services } from '../workbench/services.js';
import { WorkerApi } from './api.js';
import { WorkerDaemon } from './daemon.js';
import { WorkerDownloads } from './download.js';
import { WorkerEngine } from './engine.js';
import { WorkerRunEnvironment } from './environment.js';
import { GIT_REFUSAL, WorkerGit } from './git.js';
import { WorkerHome } from './home.js';
import { WorkerJanitor } from './janitor.js';
import { WorkerLog } from './log.js';
import { WorkerMachineProbe } from './machine.js';
import { WorkerRuntimeOffer } from './offer.js';
import { WorkerSignIns } from './signin.js';

/**
 * The daemon process the background service starts. It runs the engine in
 * the worker home and exits when stopped, when the server ends the worker,
 * or when the service manager signals it.
 */
export class WorkerProcess {
    constructor(private readonly home: string) {}

    async run(): Promise<number> {
        const home = new WorkerHome(this.home);
        const registration = await home.requireRegistration();
        const allowed = await home.readSettings();
        const log = new WorkerLog(home, registration.name);
        const machine = new WorkerMachineProbe();
        const offer = await new WorkerRuntimeOffer({ machine }).check(allowed.runtimes);
        if (!offer.runtimes.length) {
            log.write('not started: this machine can run none of its runtimes');
            await log.flush();
            return 1;
        }
        const settings = { runtimes: offer.runtimes, slots: allowed.slots };
        RegistryClient.configureApiUrl(registration.api_url);
        await home.ensure();
        await home.ensure(join(home.root, 'tmp'));
        process.env.TMPDIR = await home.ensure(join(home.root, 'tmp', 'daemon'));
        const git = await new WorkerGit().usable();
        await new ModelCatalog({ home: home.root }).refresh().catch(() => undefined);
        const connection = Connection.open(home.root);
        try {
            const services = new Services(home.root, connection);
            const runners = RunnerRegistry.standard();
            const registry = new RegistryClient({
                home: home.root,
                apiUrl: registration.api_url,
                fetch: new WorkerDownloads(registration.api_url).fetch,
            });
            const api = new WorkerApi(registration.api_url);
            const environment = new WorkerRunEnvironment(
                home,
                runners,
                process.env,
                await machine.dockerHost()
            );
            const daemon = new WorkerDaemon({
                home,
                registration,
                settings,
                api,
                machine,
                log,
                version: packageMetadata.version,
                ...(git ? {} : { repositoryRefusal: GIT_REFUSAL }),
                signIns: (send) =>
                    new WorkerSignIns({ home, runners, environment, log, send }),
                janitor: new WorkerJanitor(
                    home,
                    new SessionRetention(
                        home.root,
                        services.runs,
                        services.sessions,
                        services.writer
                    ),
                    services.writer
                ),
                host: new WorkerEngine({
                    home,
                    services,
                    runners,
                    environment,
                    worker: registration.slug,
                    api: registration.api_url,
                    download: (url, versionId) =>
                        registry.fetchArchive(url, {
                            selector: versionId,
                            source: `${registration.api_url}/v1/workbench-versions/${encodeURIComponent(versionId)}`,
                            revision: versionId,
                        }),
                }),
            });
            const terminate = () => daemon.terminate();
            process.on('SIGTERM', terminate);
            process.on('SIGINT', terminate);
            try {
                return await daemon.run();
            } finally {
                process.off('SIGTERM', terminate);
                process.off('SIGINT', terminate);
            }
        } finally {
            connection.close();
        }
    }
}
