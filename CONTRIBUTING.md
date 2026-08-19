# Contributing

Workbench is a pre-1.0 open standard and reference implementation. Focused bug
reports, design feedback, compatibility fixtures, and implementation changes
are welcome.

Before starting a substantial change, open an issue describing the problem and
the portable behavior you want to change. Use GitHub Discussions for
open-ended design questions. Security reports must follow [SECURITY.md](SECURITY.md)
instead of using a public issue.

## Pull requests

1. Fork the repository and create a focused branch.
2. Add or update tests for observable behavior.
3. Update the specification when portable behavior changes.
4. Run the complete local gate:

   ```sh
   bun install --frozen-lockfile
   bun run check
   bun run test:coverage
   bun audit
   bun run build
   ```

5. Open a pull request that explains the problem, the chosen behavior, and how
   it was verified.

Pull requests must pass the protected GitHub checks and receive maintainer
approval. Commits use Conventional Commits. Do not include credentials,
machine-specific paths, generated output, private tracker material, or
proprietary Workbench packages.

Compatibility is deliberate. A change must not reinterpret a valid package for
an already released `spec` number; incompatible format changes require a new
parser and schema version.

## Contribution license

This project uses an inbound-equals-outbound policy. By submitting a
contribution, you represent that you have the right to submit it and agree that
it is licensed under the repository's Apache License 2.0. No separate CLA or
DCO sign-off is currently required.
