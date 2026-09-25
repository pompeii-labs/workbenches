// Seeds the storefront. Customer 1 ("Heavy Customer") gets a large order
// history so the dashboard's per-order, per-item lookups are clearly slow;
// customer 2 ("Light Customer") gets almost none, as a size contrast and as
// the "small" content-parity check. Everything else is set-based SQL so
// seeding stays fast even at large scale.
import { Client } from 'pg';

const CUSTOMERS = Number(process.env.SEED_CUSTOMERS ?? 200);
const PRODUCTS = Number(process.env.SEED_PRODUCTS ?? 3_000);
const ORDERS = Number(process.env.SEED_ORDERS ?? 8_000);
const HEAVY_CUSTOMER_ORDERS = Number(process.env.HEAVY_CUSTOMER_ORDERS ?? 4_000);
const LIGHT_CUSTOMER_ORDERS = Number(process.env.LIGHT_CUSTOMER_ORDERS ?? 3);

const CATEGORIES = ['kitchen', 'garden', 'office', 'toys', 'pantry', 'hardware'];

async function main() {
    const client = new Client({
        connectionString:
            process.env.DATABASE_URL ?? 'postgres://app:app@localhost:5432/app',
    });
    await client.connect();
    const started = performance.now();

    // Fixed seed: random() below is deterministic across separate runs, so a
    // baseline checkout and a submission checkout seeded independently end up
    // byte-identical, which is what makes an exact content comparison valid.
    await client.query('SELECT setseed(0.42)');

    await client.query('TRUNCATE order_items, orders, products, customers RESTART IDENTITY CASCADE');

    // Customer 1: heavy. Customer 2: light. Then the rest.
    await client.query(
        `INSERT INTO customers (name, email) VALUES
            ('Heavy Customer', 'heavy@example.com'),
            ('Light Customer', 'light@example.com')`
    );
    await client.query(
        `INSERT INTO customers (name, email)
         SELECT 'Customer ' || g, 'customer' || g || '@example.com'
         FROM generate_series(1, $1) AS g`,
        [Math.max(CUSTOMERS - 2, 0)]
    );

    await client.query(
        `INSERT INTO products (name, description, category, price_cents)
         SELECT
             'Product ' || g,
             'A perfectly ordinary item, number ' || g || ', useful around the house.',
             (ARRAY['kitchen','garden','office','toys','pantry','hardware'])[floor(random() * 6 + 1)],
             (random() * 9000 + 100)::int
         FROM generate_series(1, $1) AS g`,
        [PRODUCTS]
    );

    // Heavy customer's orders.
    await client.query(
        `INSERT INTO orders (customer_id, status, created_at)
         SELECT 1, 'completed', timestamptz '2026-01-01 00:00:00+00' - (random() * interval '365 days')
         FROM generate_series(1, $1) AS g`,
        [HEAVY_CUSTOMER_ORDERS]
    );

    // Light customer's orders.
    await client.query(
        `INSERT INTO orders (customer_id, status, created_at)
         SELECT 2, 'completed', timestamptz '2026-01-01 00:00:00+00' - (random() * interval '365 days')
         FROM generate_series(1, $1) AS g`,
        [LIGHT_CUSTOMER_ORDERS]
    );

    // Everyone else, spread across the remaining customers.
    const otherCustomers = Math.max(CUSTOMERS - 2, 1);
    await client.query(
        `INSERT INTO orders (customer_id, status, created_at)
         SELECT (random() * ($1 - 1) + 3)::int, 'completed', timestamptz '2026-01-01 00:00:00+00' - (random() * interval '365 days')
         FROM generate_series(1, $2) AS g`,
        [otherCustomers, ORDERS]
    );

    await client.query(`SELECT setval('products_id_seq', (SELECT max(id) FROM products))`);

    // 1-5 items per order, no JS loop: a lateral generate_series per order.
    await client.query(
        `INSERT INTO order_items (order_id, product_id, quantity, price_cents)
         SELECT o.id,
                (random() * (p.count - 1) + 1)::int,
                (random() * 4 + 1)::int,
                (random() * 5000 + 100)::int
         FROM orders o
         CROSS JOIN (SELECT count(*) AS count FROM products) p
         CROSS JOIN LATERAL generate_series(1, (random() * 4 + 1)::int) AS item_num`
    );

    await client.query('ANALYZE customers, products, orders, order_items');

    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    const counts = await client.query(
        `SELECT
            (SELECT count(*) FROM customers) AS customers,
            (SELECT count(*) FROM products) AS products,
            (SELECT count(*) FROM orders) AS orders,
            (SELECT count(*) FROM order_items) AS order_items`
    );
    console.log(`seed: ${JSON.stringify(counts.rows[0])} in ${seconds}s`);

    await client.end();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
