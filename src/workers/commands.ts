import type { WorkerRunAdmission } from './admission.js';
import type { WorkerAssignments } from './assignments.js';
import type { WorkerRunHost } from './contracts.js';
import type { WorkerCommand, WorkerMessage } from './protocol.js';
import type { WorkerRunTracker } from './tracker.js';

/** Relays commands without letting a stuck session hold its acknowledgement forever. */
export class WorkerCommands {
    constructor(
        private readonly assignments: WorkerAssignments,
        private readonly host: WorkerRunHost,
        private readonly admission: Pick<WorkerRunAdmission, 'cancel'>,
        private readonly tracker: Pick<WorkerRunTracker, 'wake'>,
        private readonly send: (message: WorkerMessage) => boolean
    ) {}

    async deliver(command: WorkerCommand): Promise<void> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                this.relay(command),
                new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(
                        () =>
                            reject(
                                new Error(
                                    'The command was not delivered within 60 seconds'
                                )
                            ),
                        60_000
                    );
                }),
            ]);
            this.send({
                type: 'command.done',
                command_id: command.command_id,
                status: 'delivered',
            });
        } catch (error) {
            this.send({
                type: 'command.done',
                command_id: command.command_id,
                status: 'rejected',
                reason:
                    error instanceof Error
                        ? error.message
                        : 'The command was not delivered',
            });
        } finally {
            clearTimeout(timer);
        }
    }

    private async relay(command: WorkerCommand): Promise<void> {
        const assignment = this.assignments.get(command.run_id);
        if (!assignment?.session_id) {
            if (assignment?.state === 'launching') {
                if (command.kind === 'cancel')
                    return this.admission.cancel(command.run_id);
                throw new Error('The run is still launching; only cancel is available');
            }
            throw new Error('This worker has no session for the run');
        }
        const start = this.assignments.start(command.run_id);
        await this.host.command(assignment.session_id, command, {
            run: {
                run_id: assignment.run_id,
                runtime: assignment.runtime,
                member_id: assignment.member_id,
                runner: assignment.runner,
                connection: assignment.connection,
            },
            ...(start ? { start } : {}),
        });
        // A finished session continued with send is followed again.
        if (command.kind !== 'cancel') this.tracker.wake(assignment.run_id);
    }
}
