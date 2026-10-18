import { ImprovementEvidence } from '../authoring/evidence.js';
import { AuthoringJob } from '../authoring/job.js';
import { SnapshotGuard } from '../catalog/guard.js';
import { SavedWorkbenchCatalog } from '../catalog/saved.js';
import { CatalogSnapshots } from '../catalog/snapshots.js';
import { CatalogWriter } from '../catalog/writer.js';
import { RepositoryCheckoutStore } from '../database/checkouts.js';
import type { Connection } from '../database/connection.js';
import { LeaseStore } from '../database/leases.js';
import { NoticeStore } from '../database/notices.js';
import { LegacyLayout } from '../legacy/layout.js';
import { LegacyNotice } from '../legacy/notice.js';
import { ProcessProbe } from '../processes/probe.js';
import { RepositoryDeliveryStore } from '../repositories/receipts.js';
import { RunContinuation } from '../runs/continuation.js';
import { RunDispatcher } from '../runs/dispatcher.js';
import { RunStore } from '../runs/store.js';
import { RunSupervision } from '../runs/supervision.js';
import { RunWorker } from '../runs/worker.js';
import { SessionControl } from '../sessions/control.js';
import { SessionLifecycle } from '../sessions/lifecycle.js';
import { SessionResolver } from '../sessions/resolver.js';
import { SessionStore } from '../sessions/store.js';
import { SessionSupervision } from '../sessions/supervision.js';

/**
 * Every store and service of one Workbench home, wired once over the
 * process's single database connection. A command builds it after opening
 * the connection and hands out the parts it needs.
 */
export class Services {
    readonly probe = new ProcessProbe();
    readonly runs: RunStore;
    readonly sessions: SessionStore;
    readonly checkouts: RepositoryCheckoutStore;
    readonly receipts: RepositoryDeliveryStore;
    readonly catalog: SavedWorkbenchCatalog;
    readonly writer: CatalogWriter;
    readonly legacy: LegacyNotice;
    readonly lifecycle: SessionLifecycle;
    readonly resolver: SessionResolver;
    readonly dispatcher: RunDispatcher;
    readonly continuation: RunContinuation;
    readonly supervision: RunSupervision;
    readonly sessionSupervision: SessionSupervision;
    readonly jobs: AuthoringJob;
    readonly evidence: ImprovementEvidence;
    readonly control: SessionControl;
    readonly worker: RunWorker;

    constructor(home: string, connection: Connection) {
        this.runs = new RunStore(connection, home, this.probe);
        this.sessions = new SessionStore(connection, home, this.probe);
        this.checkouts = new RepositoryCheckoutStore(connection);
        this.receipts = new RepositoryDeliveryStore(connection);
        const layout = new LegacyLayout(home, this.probe);
        this.legacy = new LegacyNotice(layout, new NoticeStore(connection));
        const snapshots = new CatalogSnapshots(home);
        const guard = new SnapshotGuard(
            snapshots,
            new LeaseStore(connection, this.probe),
            this.sessions
        );
        this.catalog = new SavedWorkbenchCatalog(home);
        this.writer = new CatalogWriter(this.catalog, snapshots, guard);
        this.lifecycle = new SessionLifecycle(this.runs, this.sessions);
        this.resolver = new SessionResolver(this.lifecycle);
        this.dispatcher = new RunDispatcher(
            home,
            connection,
            this.runs,
            this.sessions,
            layout,
            snapshots,
            guard,
            this.writer,
            this.checkouts
        );
        this.continuation = new RunContinuation(
            this.dispatcher,
            this.runs,
            this.sessions
        );
        this.supervision = new RunSupervision(this.runs, this.receipts);
        this.jobs = new AuthoringJob(home, connection, this.runs, this.dispatcher);
        this.evidence = new ImprovementEvidence(home, this.runs);
        this.sessionSupervision = new SessionSupervision(
            this.runs,
            this.sessions,
            this.jobs,
            this.supervision
        );
        this.control = new SessionControl(
            connection,
            this.lifecycle,
            this.runs,
            this.supervision,
            this.continuation,
            this.resolver
        );
        this.worker = new RunWorker(
            home,
            connection,
            this.runs,
            this.sessions,
            this.checkouts
        );
    }
}
