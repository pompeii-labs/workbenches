import type {
    OutcomeContentDescriptor,
    OutcomeDigest,
    RunOutcome,
} from './contracts.js';
import { OutcomeLimitError } from './limit.js';
import { formatOutcomeBytes } from './presentation.js';

/** Owns capture admission and names omitted content in the committed outcome. */
export class OutcomeAdmission {
    private readonly captured = new Map<OutcomeDigest, number>();
    private readonly skipped = new Map<OutcomeDigest, string>();
    private bytes = 0;
    private pending: Promise<void> = Promise.resolve();

    constructor(
        private readonly maximumContentBytes: number,
        private readonly maximumOutcomeBytes: number
    ) {}

    capture(
        descriptor: OutcomeContentDescriptor,
        operation: () => Promise<void>
    ): Promise<void> {
        const next = this.pending.then(async () => {
            try {
                if (descriptor.size_bytes > this.maximumContentBytes)
                    throw new OutcomeLimitError(
                        `exceeds the ${formatOutcomeBytes(this.maximumContentBytes)} per-file safety limit`
                    );
                if (
                    !this.captured.has(descriptor.digest) &&
                    descriptor.size_bytes > this.maximumOutcomeBytes - this.bytes
                )
                    throw new OutcomeLimitError('exceeds the per-outcome safety limit');
                await operation();
                if (!this.captured.has(descriptor.digest)) {
                    this.captured.set(descriptor.digest, descriptor.size_bytes);
                    this.bytes += descriptor.size_bytes;
                }
                this.skipped.delete(descriptor.digest);
            } catch (error) {
                if (
                    !(error instanceof OutcomeLimitError) &&
                    !(
                        error instanceof Error &&
                        'code' in error &&
                        error.code === 'ENOSPC'
                    )
                )
                    throw error;
                this.skipped.set(descriptor.digest, error.message);
            }
        });
        this.pending = next.catch(() => undefined);
        return next;
    }

    filter(outcome: RunOutcome): RunOutcome {
        const warnings = [...outcome.warnings];
        const retained = new Map<OutcomeDigest, number>();
        let bytes = 0;
        const keep = (content: OutcomeContentDescriptor, path: string) => {
            const existing = retained.get(content.digest);
            if (existing !== undefined && existing !== content.size_bytes)
                throw new Error(
                    'Outcome references disagree about shared content size'
                );
            const reason =
                this.skipped.get(content.digest) ??
                (content.size_bytes > this.maximumContentBytes
                    ? `exceeds the ${formatOutcomeBytes(this.maximumContentBytes)} per-file safety limit`
                    : existing === undefined &&
                        content.size_bytes > this.maximumOutcomeBytes - bytes
                      ? 'exceeds the per-outcome safety limit'
                      : undefined);
            if (!reason) {
                if (existing === undefined) {
                    retained.set(content.digest, content.size_bytes);
                    bytes += content.size_bytes;
                }
                return true;
            }
            warnings.push({
                code: 'outcome_file_skipped',
                message: `Skipped ${path}: ${reason}`,
            });
            return false;
        };
        return {
            ...outcome,
            artifacts: outcome.artifacts.filter((artifact) =>
                keep(artifact.content, artifact.path ?? artifact.name)
            ),
            changesets: outcome.changesets.map((changeset) => {
                const entries = changeset.entries.filter(
                    (entry) =>
                        entry.after?.kind !== 'file' ||
                        keep(entry.after.content, entry.path)
                );
                const { review, ...rest } = changeset;
                return {
                    ...rest,
                    entries,
                    ...(review && keep(review, `${changeset.id}/review.diff`)
                        ? { review }
                        : {}),
                    stats: {
                        ...changeset.stats,
                        additions: entries.filter((entry) => entry.operation === 'add')
                            .length,
                        modifications: entries.filter(
                            (entry) => entry.operation === 'modify'
                        ).length,
                        deletions: entries.filter(
                            (entry) => entry.operation === 'delete'
                        ).length,
                    },
                };
            }),
            warnings,
        };
    }

    clear(): void {
        this.captured.clear();
        this.skipped.clear();
        this.bytes = 0;
    }
}
