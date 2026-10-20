import { stripVTControlCharacters } from 'node:util';

/**
 * Model-authored text made safe to display on one line: terminal escapes and
 * control characters are removed and every run of whitespace becomes a single
 * space.
 */
export function displayText(value: string): string {
    return Array.from(stripVTControlCharacters(value))
        .filter((character) => {
            const code = character.charCodeAt(0);
            return (
                code === 9 ||
                code === 10 ||
                code === 13 ||
                (code >= 32 && !(code >= 127 && code <= 159))
            );
        })
        .join('')
        .replace(/\s+/gu, ' ');
}
