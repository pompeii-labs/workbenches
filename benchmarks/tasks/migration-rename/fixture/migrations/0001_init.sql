CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    fullname TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE orders (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id),
    amount_cents INT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE events (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL,
    kind TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_orders_user_id ON orders (user_id);
CREATE INDEX idx_events_user_id ON events (user_id);
