/**
 * Outcome contracts, validation, and in-memory collection, without a
 * filesystem. The disk store, quotas, leases, and applying changes to a
 * workspace are `./outcomes/disk`.
 */
export type {
    CollectedOutput,
    OutcomeSink,
    RuntimeOutcomeCollection,
} from '../collection.js';
export type * from '../contracts.js';
export {
    DeclaredOutput,
    maximumDeclarationBytes,
    type OutboxContent,
    outcomeDeclarationName,
    parseDeclarationSource,
} from '../declared.js';
export { inferMediaType } from '../media.js';
export { MemoryOutcomeSink, type MemoryOutcomeSinkOptions } from '../memory.js';
export {
    assertOutcomeDigest,
    assertOutcomeRunId,
    parseDeclaredOutcome,
    parseOutcomeApplicationReceipt,
    parseRunOutcome,
} from '../validation.js';
