# Security

Workbench executes AI harnesses, reads repository content, binds credentials,
and may eventually provision isolated runtimes. Treat security boundary
failures, credential exposure, unsafe package ingestion, and execution escapes
as vulnerabilities.

## Supported versions

During pre-1.0 development, only the latest published release and the current
`main` branch receive security fixes. Older prereleases are unsupported.

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/pompeii-labs/workbenches/security/advisories/new).
If GitHub reporting is unavailable, email `hello@pompeiilabs.com` with the
subject `Workbench security report`.

Include the affected version, impact, reproduction steps, and any proposed
mitigation. Do not include live credentials or sensitive third-party data.
Please allow maintainers to investigate and coordinate a fix before public
disclosure.

Public issues are appropriate for ordinary bugs that do not create a security
or privacy risk.
