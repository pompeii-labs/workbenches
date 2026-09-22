extends Node2D

const SPEED := 300.0
var player: ColorRect
var meteors: Array = []
var score := 0
var score_label: Label
var meteor_speed := 120.0
var spawn_timer := 0.0
var elapsed := 0.0
var game_over := false
var over_label: Label

func _ready() -> void:
	get_viewport().size = Vector2i(640, 480)
	var bg := ColorRect.new()
	bg.color = Color(0.05, 0.05, 0.15)
	bg.size = Vector2(640, 480)
	add_child(bg)

	player = ColorRect.new()
	player.color = Color(0.2, 0.9, 0.9)
	player.size = Vector2(28, 16)
	player.position = Vector2(306, 440)
	add_child(player)

	score_label = Label.new()
	score_label.position = Vector2(10, 10)
	score_label.text = "Score: 0"
	add_child(score_label)

	over_label = Label.new()
	over_label.position = Vector2(220, 220)
	over_label.text = "Game over. Press Enter to restart"
	over_label.visible = false
	add_child(over_label)

func _restart() -> void:
	for m in meteors:
		m.queue_free()
	meteors.clear()
	elapsed = 0.0
	spawn_timer = 0.0
	player.position.x = 306
	over_label.visible = false
	game_over = false

func _physics_process(delta: float) -> void:
	if game_over:
		if Input.is_action_just_pressed("ui_accept"):
			_restart()
		return
	elapsed += delta
	meteor_speed = 120.0 + elapsed * 4.0
	score = int(elapsed * 10)
	score_label.text = "Score: %d" % score

	var dir := Input.get_axis("move_left", "move_right")
	player.position.x += dir * SPEED * delta
	player.position.x = clamp(player.position.x, 0, 612)

	spawn_timer -= delta
	if spawn_timer <= 0.0:
		spawn_timer = 0.6
		_spawn_meteor()

	var player_rect := Rect2(player.position, player.size)
	for m in meteors.duplicate():
		m.position.y += meteor_speed * delta
		if Rect2(m.position, m.size).intersects(player_rect):
			game_over = true
			over_label.visible = true
			return
		if m.position.y > 480:
			m.queue_free()
			meteors.erase(m)

func _spawn_meteor() -> void:
	var m := ColorRect.new()
	m.color = Color(0.8, 0.5, 0.2)
	m.size = Vector2(20, 20)
	m.position = Vector2(randf_range(0, 620), -20)
	add_child(m)
	meteors.append(m)
