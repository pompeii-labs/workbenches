import packageMetadata from '../package.json' with { type: 'json' };
import { verifyReleaseTag } from './release-support.js';

const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
if (!tag) throw new Error('Pass a release tag or set GITHUB_REF_NAME');

verifyReleaseTag(tag, packageMetadata.version);
console.log(`${tag} matches package version ${packageMetadata.version}`);
