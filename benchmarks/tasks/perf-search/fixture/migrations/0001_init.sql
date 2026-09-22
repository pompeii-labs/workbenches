CREATE TABLE customers (
    id serial PRIMARY KEY,
    name text NOT NULL,
    email text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE products (
    id serial PRIMARY KEY,
    name text NOT NULL,
    description text NOT NULL,
    category text NOT NULL,
    price_cents integer NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE orders (
    id serial PRIMARY KEY,
    customer_id integer NOT NULL REFERENCES customers(id),
    status text NOT NULL DEFAULT 'completed',
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE order_items (
    id serial PRIMARY KEY,
    order_id integer NOT NULL REFERENCES orders(id),
    product_id integer NOT NULL REFERENCES products(id),
    quantity integer NOT NULL,
    price_cents integer NOT NULL
);
