import { AuthenticationRequiredError } from '../connections/error.js';
import { RegistryRequestError } from '../registry/error.js';
import { RunControlRejected } from '../runs/handle.js';
import type { SessionInputResult } from '../sessions/control.js';

/** A cloud receipt also carries the API's command status: accepted is not yet delivered. */
type Receipt = SessionInputResult & { command_status?: string };

export class CliReceipt {
    async execute(json: boolean, operation: () => Promise<Receipt>): Promise<void> {
        try {
            const result = await operation();
            process.stdout.write(
                json
                    ? `${JSON.stringify(result)}\n`
                    : `${result.receipt?.disposition ?? result.command_status ?? 'delivered'} · ${result.session_id} · ${result.input_id}\n`
            );
        } catch (error) {
            if (!json) throw error;
            const code =
                error instanceof AuthenticationRequiredError ||
                error instanceof RegistryRequestError
                    ? error.code
                    : 'input_unavailable';
            process.stdout.write(
                `${JSON.stringify(error instanceof RunControlRejected ? { receipt: error.receipt, error: error.receipt.error } : { error: { code, message: error instanceof Error ? error.message : String(error) } })}\n`
            );
            process.exitCode =
                error instanceof AuthenticationRequiredError ? error.exitCode : 1;
        }
    }
}
