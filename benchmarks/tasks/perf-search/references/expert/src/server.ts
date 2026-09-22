import { query } from './db.ts';
import { heroImageBytes } from './hero-image.ts';
import { vendorJsBytes } from './vendor-lib.ts';
import { renderLanding } from './pages.ts';
import { readFileSync } from 'node:fs';

const port = Number(process.env.PORT ?? 3000);
const STATIC_DIR = `${import.meta.dir}/static`;

function serveStatic(name: string, contentType: string): Response {
    if (name === 'hero.png') {
        return new Response(new Uint8Array(heroImageBytes()), { headers: { 'Content-Type': 'image/png' } });
    }
    if (name === 'vendor.js') {
        return new Response(new Uint8Array(vendorJsBytes()), {
            headers: { 'Content-Type': 'application/javascript' },
        });
    }
    const bytes = readFileSync(`${STATIC_DIR}/${name}`);
    return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': contentType } });
}

Bun.serve({
    port,
    idleTimeout: 60,
    async fetch(req) {
        const url = new URL(req.url);

        if (url.pathname === '/health') {
            return Response.json({ ok: true });
        }

        if (url.pathname === '/static/styles.css') return serveStatic('styles.css', 'text/css');
        if (url.pathname === '/static/font.bin') return serveStatic('font.bin', 'font/woff2');
        if (url.pathname === '/static/hero.png') return serveStatic('hero.png', 'image/png');
        if (url.pathname === '/static/vendor.js') return serveStatic('vendor.js', 'application/javascript');

        if (url.pathname === '/') {
            const featured = (
                await query<{ id: number; name: string; price_cents: number }>(
                    'SELECT id, name, price_cents FROM products ORDER BY id ASC LIMIT 6'
                )
            ).rows;
            const html = renderLanding(
                featured.map((p) => ({ id: p.id, name: p.name, priceCents: p.price_cents }))
            );
            return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        }

        const dashboardMatch = url.pathname.match(/^\/dashboard\/(\d+)$/);
        if (dashboardMatch) {
            return handleDashboard(Number(dashboardMatch[1]));
        }

        if (url.pathname === '/search') {
            return handleSearch(url.searchParams);
        }

        return new Response('Not found', { status: 404 });
    },
});

async function handleDashboard(customerId: number): Promise<Response> {
    const customerRows = (
        await query<{ id: number; name: string; email: string }>(
            'SELECT id, name, email FROM customers WHERE id = $1',
            [customerId]
        )
    ).rows;
    const customer = customerRows[0];
    if (!customer) return new Response('Not found', { status: 404 });

    // Fetches every order for this customer, all columns, then slices in JS
    // for display below. Missing index on orders.customer_id makes this a
    // sequential scan on a large table.
    const orderRows = (
        await query('SELECT * FROM orders WHERE customer_id = $1 ORDER BY id DESC', [customerId])
    ).rows;

    let totalCents = 0;
    const resolvedOrders: {
        id: number;
        status: string;
        createdAt: string;
        totalCents: number;
        items: { productId: number; name: string; quantity: number; priceCents: number }[];
    }[] = [];

    for (const order of orderRows) {
        const itemRows = (
            await query('SELECT * FROM order_items WHERE order_id = $1', [order.id])
        ).rows;
        const items: { productId: number; name: string; quantity: number; priceCents: number }[] = [];
        for (const item of itemRows) {
            const productRows = (
                await query('SELECT * FROM products WHERE id = $1', [item.product_id])
            ).rows;
            const product = productRows[0];
            const lineCents = item.price_cents * item.quantity;
            totalCents += lineCents;
            items.push({
                productId: item.product_id,
                name: product ? product.name : 'Unknown product',
                quantity: item.quantity,
                priceCents: item.price_cents,
            });
        }
        resolvedOrders.push({
            id: order.id,
            status: order.status,
            createdAt: order.created_at.toISOString ? order.created_at.toISOString() : order.created_at,
            totalCents: items.reduce((sum, i) => sum + i.priceCents * i.quantity, 0),
            items,
        });
    }

    const visibleOrders = resolvedOrders.slice(0, 20);

    return Response.json({
        customer: { id: customer.id, name: customer.name, email: customer.email },
        orderCount: orderRows.length,
        totalSpentCents: totalCents,
        orders: visibleOrders,
    });
}

// Ranking and pagination now happen in SQL: the times-ordered count is a
// pre-aggregated LEFT JOIN instead of a per-row correlated subquery, the
// ORDER BY/LIMIT/OFFSET matches the old JS sort + slice exactly (times
// ordered desc, id asc), and pg_trgm lets the ILIKE predicates use an index
// instead of a sequential scan. Default limit is 20 so the default response
// is small and matches what baseline showed first.
async function handleSearch(params: URLSearchParams): Promise<Response> {
    const q = (params.get('q') ?? '').trim();
    if (!q) return Response.json({ query: q, results: [] });

    let limit = Number(params.get('limit') ?? 20);
    if (!Number.isFinite(limit) || limit <= 0) limit = 20;
    limit = Math.min(limit, 100);

    let page = Number(params.get('page') ?? 1);
    if (!Number.isFinite(page) || page <= 0) page = 1;
    const offset = (page - 1) * limit;

    const rows = (
        await query(
            `SELECT p.id, p.name, p.description, p.category, p.price_cents,
                    coalesce(c.times_ordered, 0) AS times_ordered
             FROM products p
             LEFT JOIN (
                 SELECT product_id, count(*) AS times_ordered
                 FROM order_items
                 GROUP BY product_id
             ) c ON c.product_id = p.id
             WHERE p.name ILIKE '%' || $1 || '%' OR p.description ILIKE '%' || $1 || '%'
             ORDER BY times_ordered DESC, p.id ASC
             LIMIT $2 OFFSET $3`,
            [q, limit, offset]
        )
    ).rows as {
        id: number;
        name: string;
        description: string;
        category: string;
        price_cents: number;
        times_ordered: string;
    }[];

    const results = rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        category: r.category,
        priceCents: r.price_cents,
        timesOrdered: Number(r.times_ordered),
    }));

    return Response.json({ query: q, results });
}

console.log(`corner-store listening on :${port}`);
