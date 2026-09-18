import { RunControlRejected } from '../runs/handle.js';
import type { SessionInputResult } from '../sessions/control.js';

export class CliReceipt {
    async execute(
        json: boolean,
        operation: () => Promise<SessionInputResult>
    ): Promise<void> {
        try {
            const result = await operation();
            process.stdout.write(
                json
                    ? `${JSON.stringify(result)}\n`
                    : `${result.receipt?.disposition ?? 'delivered'} · ${result.session_id} · ${result.input_id}\n`
            );
        } catch (error) {
            if (!json) throw error;
            process.stdout.write(
                `${JSON.stringify(error instanceof RunControlRejected ? { receipt: error.receipt, error: error.receipt.error } : { error: { code: 'input_unavailable', message: error instanceof Error ? error.message : String(error) } })}\n`
            );
            process.exitCode = 1;
        }
    }
}
