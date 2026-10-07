These fixtures model the Claude Code 2.1.292 stream JSON and stdio control protocol.

The lifecycle fixtures are reduced, sanitized reproductions of traces captured from Claude Code 2.1.292. They preserve message order and command, request, tool, and session cross-references while replacing identifiers and paths and removing host metadata, thinking signatures, rate-limit details, usage details, and model content that is not needed by the tests.

The traces establish that `command_lifecycle` is the primary command boundary, each native turn starts with `system/init`, and steering folds at a tool-result boundary only when it is written while that tool call is in flight. Input written without an active tool call starts a separate turn. The separate-turn fixture preserves the remaining race where a steer written during a tool call still starts independently. The traces also establish that interruption cancels queued commands and pending requests, background task notifications can start an unprompted turn, and `--setting-sources user` excludes project settings and repository `CLAUDE.md`, so repository instructions are injected explicitly without loading repository hooks.

Permission and question fixtures use the same sanitized request and response shapes observed in those traces. No fixture contains credentials or user-specific paths.
