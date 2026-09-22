---
name: godot-web-quickref
description: Exact syntax for single-threaded Web export presets, InputMap setup, and canvas focus in Godot 4.7.
---

## export_presets.cfg (single-threaded Web)

```ini
[preset.0]

name="Web"
platform="Web"
runnable=true
export_filter="all_resources"
export_path="build/web/index.html"

[preset.0.options]

variant/extensions_support=false
variant/thread_support=false
html/canvas_resize_policy=2
html/focus_canvas_on_start=true
```

## InputMap in code (autoload or `_ready()`), no numeric keycodes

```gdscript
func _ensure_action(action: String, key: Key) -> void:
    if not InputMap.has_action(action):
        InputMap.add_action(action)
    var ev := InputEventKey.new()
    ev.keycode = key
    InputMap.action_add_event(action, ev)

func _ready() -> void:
    _ensure_action("move_left", KEY_LEFT)
    _ensure_action("move_right", KEY_RIGHT)
    _ensure_action("jump", KEY_SPACE)
```

Or declare actions in Project Settings > Input Map and reference by name only
(`Input.is_action_pressed("move_left")`). Either way, use `KEY_*` constants,
never a bare integer.

## `_physics_process` movement skeleton (CharacterBody2D)

```gdscript
extends CharacterBody2D

const SPEED := 220.0
const GRAVITY := 900.0
const JUMP_VELOCITY := -350.0

func _physics_process(delta: float) -> void:
    velocity.y += GRAVITY * delta
    var dir := Input.get_axis("move_left", "move_right")
    velocity.x = dir * SPEED
    if is_on_floor() and Input.is_action_just_pressed("jump"):
        velocity.y = JUMP_VELOCITY
    move_and_slide()
```

## Canvas focus

Browser input needs the canvas focused. `html/focus_canvas_on_start=true`
above does this on load; if input still doesn't reach the game after a user
clicks elsewhere on the page, call in GDScript:

```gdscript
DisplayServer.window_move_to_foreground()
```

There is no first-class "focus canvas" API from inside GDScript beyond that;
the export option is the real fix.
