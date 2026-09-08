const credentialFileNames = new Set([
    '.env',
    '.netrc',
    '.npmrc',
    '_netrc',
    'auth.json',
    'credentials.json',
    'id_dsa',
    'id_ecdsa',
    'id_ed25519',
    'id_rsa',
    'oauth.json',
]);

const privateKeySuffixes = ['.key', '.p12', '.pem', '.pfx'];

export class CredentialFilePolicy {
    matches(value: string): boolean {
        const name = value.toLowerCase();
        return (
            credentialFileNames.has(name) ||
            name.startsWith('.env.') ||
            privateKeySuffixes.some((suffix) => name.endsWith(suffix))
        );
    }
}
