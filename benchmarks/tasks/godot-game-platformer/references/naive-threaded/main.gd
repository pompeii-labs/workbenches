extends Node2D

const SPEED := 200.0
const GRAVITY := 900.0
const JUMP_VELOCITY := -380.0
var player: ColorRect
var velocity_y := 0.0
var on_floor := true
var lanterns_collected := 0
var lanterns: Array = []
var label: Label

func _ready() -> void:
	get_viewport().size = Vector2i(640, 480)
	var bg := ColorRect.new()
	bg.color = Color(0.1, 0.1, 0.2)
	bg.size = Vector2(640, 480)
	add_child(bg)

	var rects = [Rect2(0, 460, 640, 20), Rect2(80, 360, 140, 16), Rect2(280, 280, 140, 16), Rect2(460, 200, 140, 16)]
	for r in rects:
		var plat := ColorRect.new()
		plat.color = Color(0.4, 0.3, 0.2)
		plat.position = r.position
		plat.size = r.size
		add_child(plat)

	player = ColorRect.new()
	player.color = Color(0.9, 0.85, 0.3)
	player.size = Vector2(20, 28)
	player.position = Vector2(40, 420)
	add_child(player)

	label = Label.new()
	label.position = Vector2(10, 10)
	label.text = "Lanterns: 0/3"
	add_child(label)

	for pos in [Vector2(120, 330), Vector2(320, 250), Vector2(500, 170)]:
		var l := ColorRect.new()
		l.color = Color(1.0, 0.8, 0.2)
		l.size = Vector2(14, 14)
		l.position = pos
		add_child(l)
		lanterns.append(l)

func _physics_process(delta: float) -> void:
	var dir := Input.get_axis("move_left", "move_right")
	player.position.x += dir * SPEED * delta
	player.position.x = clamp(player.position.x, 0, 620)

	velocity_y += GRAVITY * delta
	if Input.is_action_just_pressed("jump") and on_floor:
		velocity_y = JUMP_VELOCITY
	player.position.y += velocity_y * delta

	if player.position.y >= 432:
		player.position.y = 432
		velocity_y = 0
		on_floor = true
	else:
		on_floor = false

	for l in lanterns.duplicate():
		if l.position.distance_to(player.position) < 24:
			l.queue_free()
			lanterns.erase(l)
			lanterns_collected += 1
			label.text = "Lanterns: %d/3" % lanterns_collected
