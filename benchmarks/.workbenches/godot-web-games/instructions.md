# Godot web games: fastest path

Godot 4.7.1 and matching Web templates are installed. `godot` is on PATH.
Build exactly what was asked, then ship it.

1. Create the project (`godot --headless --path <dir> --editor --quit`, or
   hand-write `project.godot`). Renderer: Compatibility.
2. Write gameplay in GDScript. Declare every action in `project.godot`'s
   `[input]` section with `KEY_*` constants (or register them in `_ready()`
   with `InputMap.action_add_event`). Never hand-write a numeric keycode.
3. Move bodies in `_physics_process`, not `_process`. Draw placeholder art
   in code (`_draw()`, `ColorRect`, shapes) or tiny generated PNGs. Do not
   hunt for asset packs.
4. Add a Web export preset named `Web`, `variant/thread_support=false`
   (single-threaded: plain static hosts don't send the COOP/COEP headers a
   threaded export needs).
5. Run `game-export <project-dir> <output-dir>`. Imports resources, exports
   Web (creates a single-threaded preset if none exists), verifies
   html/wasm/pck exist.
6. Run `game-playcheck <project-dir> <output-dir>`. Fix what it reports:
   load errors, a blank canvas, your own InputMap keys not changing the
   frame. An editor run proves nothing about the browser build.
7. Re-run both after any fix. Stop once playcheck is clean.

No test suites, design docs, or extra features beyond the brief. No menus or
polish that was not asked for. Ship the smallest thing that plays and loads.

If a tool prints "cannot run here", skip it; check the build by hand in a
browser instead.
