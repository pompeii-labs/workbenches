// Only known non-secret project settings may cross the workspace boundary.
// Authentication, URLs, paths, interpolation, and unknown settings stay blocked.
const booleanSettings = new Set([
    'engine-strict',
    'strict-peer-dependencies',
    'auto-install-peers',
    'shamefully-hoist',
    'legacy-peer-deps',
    'ignore-scripts',
    'save-exact',
    'package-lock',
    'fund',
    'audit',
]);

export function safeProjectNpmrc(content: Uint8Array): boolean {
    if (content.byteLength > 64 * 1024) return false;
    const source = new TextDecoder('utf-8', { fatal: true });
    let text: string;
    try {
        text = source.decode(content);
    } catch {
        return false;
    }
    return text.split(/\r?\n/).every((line) => {
        const setting = line.trim();
        if (!setting) return true;
        const match = /^([a-z-]+)\s*=\s*(true|false)$/.exec(setting);
        return !!match && booleanSettings.has(match[1] ?? '');
    });
}
