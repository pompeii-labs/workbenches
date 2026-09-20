import { createHash } from 'node:crypto';
import type { RuntimePrepareRequest } from './contracts.js';

export function needsRepositoryTools(request: RuntimePrepareRequest): boolean {
    return request.repository !== undefined;
}

export const installRepositoryTools = [
    'set -eu',
    'if command -v apk >/dev/null 2>&1; then',
    '  apk add --no-cache git github-cli ca-certificates',
    'elif command -v apt-get >/dev/null 2>&1; then',
    '  apt-get update',
    '  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends git gh ca-certificates',
    '  rm -rf /var/lib/apt/lists/*',
    'elif command -v dnf >/dev/null 2>&1; then',
    '  dnf install -y git gh ca-certificates',
    'elif command -v microdnf >/dev/null 2>&1; then',
    '  microdnf install -y git gh ca-certificates',
    'else',
    '  echo "Workbench cannot provision Git tools in this image: no supported package manager" >&2',
    '  exit 1',
    'fi',
    'command -v git >/dev/null 2>&1',
    'command -v gh >/dev/null 2>&1',
].join('\n');

export const repositoryToolsCacheKey = createHash('sha256')
    .update(installRepositoryTools)
    .digest('hex');
