export function normalizeProjectName(value: string): string {
    const name = value.trim();
    if (!name) throw new Error('Project name cannot be empty');
    if (name.length > 64)
        throw new Error('Project name cannot be longer than 64 characters');
    if (/\p{Cc}/u.test(name))
        throw new Error('Project name cannot contain control characters');
    return name;
}

export function projectSlug(name: string): string {
    const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
    if (!slug) throw new Error('Project name must contain a letter or number');
    return slug;
}
