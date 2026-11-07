import type { StdinProgress } from '../stdin/progress.js';

/**
 * What a session has delivered, as a complete-line UTF-8 byte count and the
 * events of the next line, with the native session and process it belongs to and
 * the request ids answered on stdin. A host persists it as plain JSON and passes
 * the whole value as start progress after a restart. Replay rebuilds native state
 * without emitting saved lines, raising answered requests, or writing to stdin,
 * then `resumeTurn` follows the turn.
 *
 * An event counts once its host `emit` resolves, so one whose `emit` failed is
 * sent again. Delivery is exactly once when the host stores the progress read
 * after an `emit` atomically with the events it received. An older value repeats
 * events; a newer one skips events the host never stored. Keep the latest value
 * whole: do not edit, merge, or trim it. The process log must remain available.
 */
export interface PiProgress extends StdinProgress {
    runner: 'pi';
    sequence: number;
    cancelling: boolean;
    pendingCommands: Array<{ id: string; command: string }>;
    runtimeReminderPending: boolean;
    closedRequests: string[];
    requestDeadlines: Record<string, number>;
}
