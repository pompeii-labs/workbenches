# Gate probes

All five gates run outcome-only headless-Chromium checks against whatever
web export exists in the delivered repo. None of them know the name,
premise, or code of the game being graded. The same `lib/probe.mjs` is
used, byte for byte, by every `godot-game-*` task.

## Build discovery

`lib/find-build.mjs` walks the repo (skipping `.git`, `node_modules`,
`.import`, `.godot`) for `.pck` files, and for each one checks the same
directory for a same-named non-empty `.wasm` and any non-empty `.html`
(preferring one whose contents mention the build's basename). Candidates are
sorted by the `.pck`'s mtime and the newest complete one wins. This does not
assume `index.html` or any fixed path.

## Serving

`lib/common.sh#serve_static` runs `python3 -m http.server` bound to
`127.0.0.1` with no extra headers: no COOP/COEP, no cache-control, nothing a
bare static host (GitHub Pages, S3, etc.) would not also omit. This is what
makes `loads-on-plain-static-host` fail a threaded Godot Web export: without
COOP/COEP, `SharedArrayBuffer` is unavailable and the threaded runtime
cannot start.

## `responds-to-input`

The question is whether holding a direction puts the game in a visibly
different state from holding the opposite direction, by more than the
game's own ambient motion accounts for. Every earlier version of this gate
that compared frame-diff statistics (means, signed centroid shifts, sign
tests, rank tests) was eventually fooled by ambient motion in one direction
or the other: real games with falling hazards failed, and a reference whose
movement keys were bound to nonsense keycodes passed. The current method
measures the player's position instead of frame activity.

Pinned-position test:

- Hold one direction (Left) for up to 4 s so a steerable player is driven
  to a screen edge, and capture at 1 s, 2.5 s and 4 s: each capture is the
  per-cell median of 8 frames taken 75 ms apart on a 96x96 downscale of the
  canvas. Moving hazards occupy any cell for only part of that window, so
  the median erases them; a pinned player is in the same cells throughout
  and survives. Then hold Right the same way, in a fresh life (revive:
  Enter, Space, R, click), and diff the two medians with a per-channel dead
  zone of 20 (a scrolling starfield averages into low-amplitude flicker in
  every cell and must not count). The latest capture on which the game was
  still alive is used, so a dense dodger yields its 1 s or 2.5 s frame and
  a slow platformer on a wide level its 4 s frame.
- Floor: the same key held in two separate lives, diffed the same way.
  What is left is exactly the part of a trial's diff the keys did not
  cause.
- Death detection: a capture is "frozen" (game over, and discarded) when
  fewer than 6 of its 7 consecutive frame pairs moved, where a pair moved
  when at least a quarter of the run's live reference worth of channel
  values changed by 80 or more. The live reference is the highest median
  per-pair motion seen on any IDLE capture (no key held), sampled at
  several points in the run. A scene whose reference never reaches 40 is
  static and never loses a capture to this rule, which keeps a
  static-scenery platformer (a jump transient moves one or two pairs) out
  of it. Every sample is re-judged against the final reference before use.
- Score: axes are screened with one trial each (arrows, then WASD, since a
  game that binds only WASD is playable), then the promising axes get two
  more trials, best first. The axis score is the second-largest valid trial
  (a value two trials reached; one contaminated trial can never decide).
  Decisive at `score >= 3 * floor` and `score >= 1600` (the diff a ~16 px
  object at a quarter of full contrast makes at this grid, moving between
  two places).

Instantaneous test, only if the pinned test decided nothing: some real
games have no pinned state (a platformer that walks off its starting ledge
and respawns). Reload the page (a game with no restart key keeps whatever
state the holds left), then 400 ms taps with single-frame captures, same
rule against the tap-to-tap idle floor. On a busy scene that floor is huge,
so this test cannot pass there by construction.

The gate runs the probe twice inside a 600 s timeout; the probe is close to
deterministic per build (reference builds repeat their score to the unit),
so the second attempt covers a run that lost its time budget to a game
dying through its retries, not a statistical near-miss.

Calibrated on the benchmark machine's amd64 image against 15 builds: every
reference and real submission that steers passes, both `naive-badkeys`
references (movement keys bound to nonsense keycodes) fail, a real
submission with hand-typed Insert/Pause keycodes (only jump works) fails,
and a real submission whose player spawns on a platform edge and falls out
of the world on the first Left tap fails. Known limits: a game that reacts
only through audio or off-canvas UI passes nothing here, since every
signal reads the canvas; a game whose player never holds still AND whose
scene is busy has no test that can see it.

## `survives-play`

60 s of the same click + key sequence, repeated, while watching for
uncaught page errors, the canvas element disappearing (a crash), and a
requestAnimationFrame / heartbeat liveness counter so a hard freeze fails
even with zero errors.

## `renders`

One screenshot after load; downscale to 48x48 and fail if every sampled
pixel is within noise of the same color (blank canvas or a single flat
fill).

## Where gates run

`prepareEvaluationRuntime` (`lib/packaging.ts`) stages and builds this
task's own Workbench (`godot-web-games`) to resolve the grading image, for
both arms. So gates run in the `godot-web-games` image for the plain arm
and the Workbench arm alike, with Chromium and `playwright` present.
`ensure_browser` in `lib/common.sh` is a no-op in every real trial; its
apt-get/npm branch is a fallback for running these scripts outside the
harness. `checks/calibrate-local.sh` builds the real Dockerfile so the
gates run under the same contract locally.

## Reference sources (`../references/`)

`references/expert/`, `references/naive-no-export/`,
`references/naive-threaded/` and `references/naive-badkeys/` hold PROJECT
SOURCE (`project.godot`, `.gd` scripts, `.tscn` scenes,
`export_presets.cfg` where relevant), never a built `.wasm`/`.pck`.
`scripts/build-godot-references.sh` exports each one with the Workbench's
own `game-export` tool into an ignored `references/<name>-built/`
directory, and `calibrate` grades the built copy in place of the source.
`naive-no-export` is marked by a `.skip-export` file and never exported,
since that variant's whole point is shipping no build.
`calibrate-local.sh` does the same export and grading on an arm64 machine
without the harness.
