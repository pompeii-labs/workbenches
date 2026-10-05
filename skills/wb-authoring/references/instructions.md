# Writing the instructions

The instructions shape every run. Aim for 4 to 9 KB. Shorter usually means the package has no opinion; longer usually means a skill's material leaked in.

## The test for every line

A line earns its place if it changes what the model does, or names a failure that has actually happened. Delete anything a capable model already does, anything that restates the manifest, and every hedge: "consider", "where appropriate", "try to", "best practices", "as needed".

## Sections

### Role and environment

One paragraph. Say what the work is and how it is judged, then the hard facts of the runtime.

> You build and upgrade browser games with Three.js. A run is judged on whether the game plays, how it looks in captured frames, and whether every control does what its visual says. The sandbox has no display and no GPU: rendering uses software WebGL, so frame rate is not evidence of anything.

### Tools

Every packaged command, what it does, and what its exit code means. The gate goes here, with the sentence that makes it the definition of done.

> `gate [dir]` builds the project, serves it, captures every viewport and state listed in `artifacts/evidence.json`, runs the checker, and exits non-zero on any failure. Exit 0 is the only definition of done.

### Method

The order of work and the first skill to load. Keep it short; the workflow skill holds the detail.

### Precedence

What wins when sources conflict. Always include: the user's stated scope beats every skill default. If the package adapts borrowed skills to this runtime, say how ("you work alone: where a skill says to delegate, do the work yourself").

### Invariants

Rules that hold on every run, each stated once.

> Playable first: the core loop works before any polish. Never fake an acknowledgment to make a capture pass, and never drop a failing capture from the manifest. Look before you judge. A claim about how the result looks cites a screenshot you opened.

### Field rules

The highest-value section, and the one generic advice can never write. Each rule is a failure that happened, stated as the fix. Group by area.

> Never `pkill -f` a server: the pattern matches your own shell and kills it. Use the stop command the serve tool printed. Wait on conditions, never fixed frame counts or sleeps. Every command runs from the workspace root with relative paths. Never use `..`; the permission checker resolves it against the root and ends the run. Never wrap a user-triggered call in a silent `try?`: a failed request then looks exactly like a dead button. Follow the official reference implementation for auth session refresh; never call `refreshSession` from app code. Test every auth or storage change starting from state the previous build left behind, not only from a fresh session. Measure latency from the input event to the rendered change, never from an internal variable.

Field rules name the canonical way and forbid the specific anti-pattern. The costliest failures come from a model hand-rolling something a reference implementation already solves, from tests that only cover fresh state, and from acceptance measured somewhere the user never looks.

Add a field rule every time a trial transcript shows the model losing time or quality to the same mistake twice. Say what the Workbench cannot do (no database tool, say) and what to do instead: build against an interface and a test fake, and report what it needs.

### Done means

A checklist a reviewer can tick from evidence, not a mood.

> The gate exits 0 on the final run. Every planned state has a capture you opened. Data survives a relaunch. Delete exists wherever create does.

### Report

The shape of the final message. Failures first. Separate what was built, what the gate reported, what the evidence shows, and what could not be verified in this environment (real devices, audio, GPU performance, push delivery). Numbers over adjectives.

## Voice

Write as the senior practitioner who has shipped this work many times and is tired of watching it go wrong the same ways. Declarative sentences. One way of working, stated as the way. No "you might", no "it is generally recommended".
