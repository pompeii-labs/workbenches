# How the published numbers were measured

## The claim

Same model, same prompts, same money: 36 working results with Workbenches,
20 without.

Eight tasks, two arms, five attempts per task and arm, one model
(`openai/gpt-5.6-terra` through OpenRouter), 80 attempts in all.

| | Working | Model spend | Dollars per working result |
| --- | --- | --- | --- |
| OpenCode | 20 of 40 | $10.59 | $0.530 |
| OpenCode + Workbench | 36 of 40 | $10.64 | $0.296 |

"Dollars per working result" is every attempt's model cost, failures
included, divided by the number of attempts that worked. Failures cost
money too, and that is the number a team actually pays.

## What is compared

Two arms receive the identical request, in the identical starting project,
with the identical model.

**OpenCode**: OpenCode 1.18 in a generic coding image (Debian, node, bun,
git, docker, sudo, network access, psql client), run through `wb` with a
one-line instruction file ("Follow the user request."). No skills, no
tools. It can install whatever it wants.

**OpenCode + Workbench**: the same OpenCode run through `wb` with one of
the four task Workbenches in `.workbenches/`: a short instruction file, one
or two skills, two or three command-line tools, and a Dockerfile that
preinstalls the domain's toolchain (Godot and its web templates, Chromium
and Playwright, the Postgres 16 client). Each package is 150 to 700 lines:
the fastest path, the traps, what "done" means, and a brake on over-work.

A Workbench packages the environment as well as the expertise: the
toolchain is installed, versions are pinned, the tools are on the PATH.
The plain agent starts from a bare image with network access and can
install anything; when it has to install Godot 4 and its export templates
before it can export a game and does not manage to, that is counted as a
fail, because it is one. It managed it more often than not: the plain arm
shipped a complete web export in 7 of its 10 Godot attempts. The benchmark
measures the whole difference. It does not separate how much came from the
environment and how much from the instructions; a third arm with the same
image and no instructions would, and is not in this release.

Two of the eight tasks run on Lux, our own database. The plain agent has
to work out its migration syntax and client from the starter app alone;
the Lux Workbench carries a skill with the exact syntax. That is the
product working as intended, and it is also a knowledge asymmetry a
general-purpose database would not have.

## The tasks

Each task is one request a real person would type, with the expert
consequence hidden in the fixture, and gates that only look at the running
result. The full prompts are in `tasks/*/prompt.md`; there is nothing else.

| Tab | Task | The request |
| --- | --- | --- |
| Ship a Godot game | godot-game-dodger | Make a small Godot game called Meteor Dash. You steer a little ship left and right and dodge falling meteors, and it gets faster the longer you last. Show the score. I want to put it on my site, so leave me a web build I can upload. |
| | godot-game-platformer | Build a one-screen platformer in Godot called Lantern Keep. Jump between platforms, grab the three lanterns, reach the door. Arrow keys and space. Leave me a browser build I can drop on any static host. |
| Build on Lux | lux-announce-team | Add team announcements to this app. Everyone on the team should see them show up live, and only whoever posted one can edit or delete it. Before you call it done: the app should start, and `bun run check` should pass. |
| | lux-invites-limit | People are spamming invites. Cap it at 5 an hour per team. Before you call it done: the app should start, and `bun run check` should pass. |
| Zero-downtime migration | migration-bigint | events.user_id is an int and we're about to run out. Move it to bigint. Table's huge and we can't take the app down. |
| | migration-rename | Rename users.fullname to display_name. The old app version keeps running while the new one rolls out. |
| Make it fast | perf-landing | Our landing page feels slow on phones. Fix it, keep it looking the same. |
| | perf-search | Search gets slower every month as we add products. Fix it before it falls over. |

We wrote the tasks, and we chose domains where an expert's judgment changes
the outcome. That is the point of the benchmark and also its limit: it says
nothing about tasks where expertise does not matter.

## How a result is graded

No judge model. Every task is graded by scripts in its `checks/` directory
that the agent never sees, and every script tests the running outcome:

- Godot: the export exists, loads on a plain static host with no
  cross-origin headers, renders, visibly steers under held keys (measured on
  the canvas), and survives sixty seconds of input.
- Lux: the app boots, a seeded member posts through the API, a teammate
  sees it in the list and on a live subscription, an outsider cannot read it
  through the API or directly against Lux, only the author can edit; the
  invite limit rejects the sixth invite across two running instances and
  still rejects after a restart.
- Migration, bigint: on a ten-million-row table under live writes, no write
  fails, none stalls for more than five seconds, none stalls for more than
  half the migration's own longest statement (above a one-second floor), no
  rows are lost, and the migration finishes within its own five-minute
  budget, which starts after the table is seeded. The column is really
  bigint afterwards and holds values above the old int range.
- Migration, rename: the old app version keeps working with zero errors
  while the migration runs; afterwards the old and new versions run side by
  side with zero errors, and a write through either column name is visible
  through the other. Existing values are preserved.
- Both migrations: the type check passes.
- Performance, landing page: LCP at least five times faster and under
  6.5 s on a throttled phone profile, transferred bytes cut to at most 35%
  of the original, and the page visually unchanged.
- Performance, search: every search query class at least five times faster
  at ten times the data, with results unchanged and memory bounded.

The performance gates compare against a baseline measured in the same run
on the same machine, back to back. The bigint gate uses the shape of the
stall, not a fixed millisecond budget, so slower hardware does not change
its verdicts either.

Every task ships reference solutions: an expert one that must pass every
gate, and naive ones that must each fail the gate written to catch them.
On the final gates, on the benchmark machine, all 21 references graded
correctly. Within every task, both arms' attempts were graded on the
identical version of the gates.

## What we did when a gate was wrong

Gates were wrong several times, in both directions, and each time the gate
was fixed and every attempt of both arms was regraded, never rerun. The
largest case was the Godot input probe: its first version failed correct
games that froze on a game-over screen and, once that was fixed, still
passed a reference whose movement keys were bound to nonsense keycodes.
The probe was rebuilt to measure the player's pinned position with hazards
median-filtered away, and calibrated against fifteen real builds before it
graded anything. Two plain-arm Godot attempts that had passed the earlier
probe fail the final one; their keycodes were hand-typed wrong and only
jump worked.

## What we did when a Workbench was wrong

We iterated the Workbenches against these tasks. When a Workbench cell
lost, we read every failure, changed the package if the failure traced to
its wording or tools, and re-ran that cell in full: all five attempts, in a
new campaign, replacing the old ones. The plain arm was never touched. The
Workbenches in this repository are exactly the ones that produced every
published Workbench number.

The packages contain no task names, fixture identifiers, or expected
values. Where a skill's worked example had drifted toward a task's own
table or column names during authoring, the examples were replaced and the
affected cells re-run.

Some of the packages' tools measure the same properties the gates check:
`perf-audit` reports LCP and bytes and the landing gate checks LCP and
bytes; `game-playcheck` and the input probe both drive the browser build.
The tools work on any URL or project and hold no expected values, and the
plain arm is free to write the same checks (and sometimes did), but the
overlap is real.

## The results

| Tab | Task | OpenCode | + Workbench |
| --- | --- | --- | --- |
| Ship a Godot game | dodger | 4 of 5, $0.285 | 5 of 5, $0.162 |
| | platformer | 1 of 5, $1.124 | 4 of 5, $0.220 |
| Build on Lux | announcements | 2 of 5, $1.156 | 4 of 5, $0.643 |
| | invites limit | 3 of 5, $0.558 | 5 of 5, $0.324 |
| Zero-downtime migration | bigint widen | 0 of 5, never | 3 of 5, $0.433 |
| | column rename | 4 of 5, $0.218 | 5 of 5, $0.253 |
| Make it fast | landing page | 1 of 5, $0.861 | 5 of 5, $0.220 |
| | search endpoint | 5 of 5, $0.205 | 5 of 5, $0.219 |

Every Workbench failure, read:

- bigint, two attempts: the backfill re-selected "the first row not yet
  copied" on every batch, which re-scans the filled prefix each time; on
  ten million rows it did not finish inside the migration's five-minute
  budget. The Workbench's own instruction says to batch by id range.
- announcements, one attempt: the route called `.single()` on an insert,
  which the project's SDK version does not have, so every post threw.
- platformer, one attempt: the player spawns at the edge of its platform
  and drops out of the world on the first Left tap, with no respawn.

The plain arm is cheaper per working result on two tasks: search (five of
five for both arms, $0.205 against $0.219) and column rename (four of five
against five of five, $0.218 against $0.253). On both, the Workbench agent
runs longer (median 4.5 minutes against 1.3 on search, 5.2 against 1.2 on
rename).

## Caveats

- Five attempts per cell. A one-attempt difference between cells is noise;
  the pooled 36 against 20 is not.
- One model. No cheaper-model arm yet.
- We wrote the tasks and the Workbenches, and we iterated the Workbenches
  against these tasks. Several instruction lines exist because a gate
  caught the failure they warn about ("never hand-write a numeric
  keycode", "an endpoint that returns every matching row is a bug",
  "measure the tail"). They are true in general and they were written with
  these gates in front of us. The page says what was run and makes no
  claim about other tasks.
- The comparison measures environment and expertise together, which is
  what a Workbench is; it does not say how much each contributed (see
  "What is compared").
- Gates are outcome probes on a running artifact and can be wrong. Every
  fail was read by a person. Raw trial data is not published.

## Reproduce it

```sh
git clone https://github.com/pompeii-labs/workbenches && cd workbenches/benchmarks
bun install --frozen-lockfile --ignore-scripts
bun workbenchmark.ts images --wb /path/to/linux-amd64/wb
bash scripts/build-godot-references.sh
bun --env-file=.env workbenchmark.ts calibrate --tasks all
bun --env-file=.env workbenchmark.ts run --tasks all --reps 5 --parallel 1 --campaign mine
bun workbenchmark.ts report --campaign mine
```

`calibrate` grades every reference solution of every task and calls no
model (the engine still wants the key present): every `expert` must pass,
every other reference must fail. Linux
amd64, Docker with privileged containers, Bun 1.4, a Linux build of the
`wb` CLI, an OpenRouter key in `.env`. About $10 per arm and a few hours
per arm at one attempt at a time. See the [README](./README.md) for the
CLI and the trial layout.
