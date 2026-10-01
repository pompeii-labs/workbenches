/** Checks for the plain values every manifest section is made of. */
export class ManifestValues {
    protected optionalRecord(value: unknown, field: string): Record<string, unknown> {
        if (value === undefined) return {};
        return this.record(value, field);
    }

    protected record(value: unknown, field: string): Record<string, unknown> {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error(`${field} must be an object`);
        }
        return value as Record<string, unknown>;
    }

    protected text(value: unknown, field: string): string {
        if (typeof value !== 'string' || !value.trim()) {
            throw new Error(`${field} must be a non-empty string`);
        }
        return value.trim();
    }
}
