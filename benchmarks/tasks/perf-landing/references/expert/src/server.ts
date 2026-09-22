import { query } from './db.ts';
import { heroImageBytes } from './hero-image.ts';
import { renderLanding } from './pages.ts';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const port = Number(process.env.PORT ?? 3000);
const STATIC_DIR = `${import.meta.dir}/static`;

const CACHE_CONTROL_IMMUTABLE = 'public, max-age=31536000, immutable';
const COMPRESSIBLE = new Set(['text/css', 'application/javascript', 'text/html; charset=utf-8']);

function serveStatic(req: Request, name: string, contentType: string): Response {
    const bytes: Buffer = name === 'hero.png' ? heroImageBytes() : readFileSync(`${STATIC_DIR}/${name}`);
    return respond(req, bytes, contentType, { 'Cache-Control': CACHE_CONTROL_IMMUTABLE });
}

// Gzips compressible responses when the client says it accepts gzip, and
// tags every response with a cache header.
function respond(req: Request, bytes: Buffer, contentType: string, extraHeaders: Record<string, string> = {}): Response {
    const headers: Record<string, string> = { 'Content-Type': contentType, ...extraHeaders };
    const acceptsGzip = (req.headers.get('accept-encoding') ?? '').includes('gzip');
    if (acceptsGzip && COMPRESSIBLE.has(contentType) && bytes.length > 256) {
        const compressed = gzipSync(bytes);
        headers['Content-Encoding'] = 'gzip';
        return new Response(new Uint8Array(compressed), { headers });
    }
    return new Response(new Uint8Array(bytes), { headers });
}

Bun.serve({
    port,
    idleTimeout: 60,
    async fetch(req) {
        const url = new URL(req.url);

        if (url.pathname === '/health') {
            return Response.json({ ok: true });
        }

        if (url.pathname === '/static/styles.css') return serveStatic(req, 'styles.css', 'text/css');
        if (url.pathname === '/static/font.bin') return serveStatic(req, 'font.bin', 'font/woff2');
        if (url.pathname === '/static/hero.png') return serveStatic(req, 'hero.png', 'image/png');

        if (url.pathname === '/') {
            const featured = (
                await query<{ id: number; name: string; price_cents: number }>(
                    'SELECT id, name, price_cents FROM products ORDER BY id ASC LIMIT 6'
                )
            ).rows;
            const html = renderLanding(
                featured.map((p) => ({ id: p.id, name: p.name, priceCents: p.price_cents }))
            );
            return respond(req, Buffer.from(html, 'utf-8'), 'text/html; charset=utf-8');
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

    // N+1: one query per order for its items, then one query per item for
    // its product, across every order this customer has ever placed.
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

async function handleSearch(params: URLSearchParams): Promise<Response> {
    const q = (params.get('q') ?? '').trim();
    if (!q) return Response.json({ query: q, results: [] });

    // Unindexed leading-wildcard ILIKE, a per-row correlated subquery for the
    // "times ordered" aggregate, and no LIMIT: every match comes back, and
    // the ranking happens in JS after the fact.
    const rows = (
        await query(
            `SELECT p.id, p.name, p.description, p.category, p.price_cents,
                    (SELECT count(*) FROM order_items oi WHERE oi.product_id = p.id) AS times_ordered
             FROM products p
             WHERE p.name ILIKE '%' || $1 || '%' OR p.description ILIKE '%' || $1 || '%'`,
            [q]
        )
    ).rows as {
        id: number;
        name: string;
        description: string;
        category: string;
        price_cents: number;
        times_ordered: string;
    }[];

    const results = rows
        .map((r) => ({
            id: r.id,
            name: r.name,
            description: r.description,
            category: r.category,
            priceCents: r.price_cents,
            timesOrdered: Number(r.times_ordered),
        }))
        .sort((a, b) => b.timesOrdered - a.timesOrdered || a.id - b.id);

    return Response.json({ query: q, results });
}

console.log(`corner-store listening on :${port}`);
