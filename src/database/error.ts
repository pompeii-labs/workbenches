type MigrationFailure = 'newer' | 'checksum' | 'gap';

/** A database whose recorded schema history this build cannot continue. */
export class MigrationError extends Error {
    readonly code: MigrationFailure;

    constructor(code: MigrationFailure, message: string) {
        super(message);
        this.name = 'MigrationError';
        this.code = code;
    }
}

type DatabaseConstraint = 'unique' | 'foreign_key';

/** A write the database refused because it breaks a declared constraint. */
export class DatabaseConstraintError extends Error {
    readonly code: DatabaseConstraint;

    constructor(code: DatabaseConstraint, message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'DatabaseConstraintError';
        this.code = code;
    }

    /** Translates a bun:sqlite error by its code, or returns undefined. */
    static from(error: unknown): DatabaseConstraintError | undefined {
        if (!(error instanceof Error) || !('code' in error)) return undefined;
        const code = error.code;
        if (
            code === 'SQLITE_CONSTRAINT_UNIQUE' ||
            code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
        )
            return new DatabaseConstraintError('unique', error.message, {
                cause: error,
            });
        if (code === 'SQLITE_CONSTRAINT_FOREIGNKEY')
            return new DatabaseConstraintError('foreign_key', error.message, {
                cause: error,
            });
        return undefined;
    }
}
