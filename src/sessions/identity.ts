const maximumNameLength = 80;
const untitledSession = 'Untitled session';

export class SessionIdentity {
    normalize(name: string): string {
        const normalized = name.trim().replace(/ +/gu, ' ');
        if (!normalized) throw new Error('Session name cannot be empty');
        if ([...normalized].some(isTerminalControlCharacter)) {
            throw new Error('Session name cannot contain terminal control characters');
        }
        if ([...normalized].length > maximumNameLength) {
            throw new Error(
                `Session name cannot be longer than ${maximumNameLength} characters`
            );
        }
        return normalized;
    }

    isNormalized(name: string): boolean {
        try {
            return this.normalize(name) === name;
        } catch {
            return false;
        }
    }

    fromPrompt(prompt: string): string | undefined {
        const flattened = [...prompt]
            .map((character) =>
                isTerminalControlCharacter(character) ? ' ' : character
            )
            .join('')
            .replace(/\s+/gu, ' ')
            .trim();
        if (!flattened) return;
        const characters = [...flattened];
        if (characters.length <= maximumNameLength) return flattened;
        return `${characters.slice(0, maximumNameLength - 3).join('')}...`;
    }

    label(session: { name?: string }): string {
        return session.name ?? untitledSession;
    }
}

function isTerminalControlCharacter(character: string): boolean {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
}
