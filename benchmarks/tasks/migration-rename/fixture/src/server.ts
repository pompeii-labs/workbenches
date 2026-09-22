import { query } from './db.ts';

const port = Number(process.env.PORT ?? 3000);

Bun.serve({
    port,
    async fetch(req) {
        const url = new URL(req.url);

        if (url.pathname === '/health') {
            return Response.json({ ok: true });
        }

        if (url.pathname === '/users' && req.method === 'POST') {
            const body = (await req.json()) as { fullname: string; email: string };
            const r = await query(
                'INSERT INTO users (fullname, email) VALUES ($1, $2) RETURNING id, fullname, email',
                [body.fullname, body.email]
            );
            return Response.json(r.rows[0], { status: 201 });
        }

        if (url.pathname === '/orders' && req.method === 'POST') {
            const body = (await req.json()) as { userId: number; amountCents: number };
            const r = await query(
                'INSERT INTO orders (user_id, amount_cents) VALUES ($1, $2) RETURNING id, user_id, amount_cents, created_at',
                [body.userId, body.amountCents]
            );
            return Response.json(r.rows[0], { status: 201 });
        }

        if (url.pathname === '/orders' && req.method === 'GET') {
            const status = url.searchParams.get('status');
            const r = status
                ? await query(
                      'SELECT id, user_id, amount_cents, created_at FROM orders WHERE status = $1 ORDER BY id DESC LIMIT 100',
                      [status]
                  )
                : await query(
                      'SELECT id, user_id, amount_cents, created_at FROM orders ORDER BY id DESC LIMIT 100'
                  );
            return Response.json(r.rows);
        }

        if (url.pathname === '/events' && req.method === 'POST') {
            const body = (await req.json()) as { userId: number; kind: string };
            const r = await query(
                'INSERT INTO events (user_id, kind) VALUES ($1, $2) RETURNING id, user_id, kind, created_at',
                [body.userId, body.kind]
            );
            return Response.json(r.rows[0], { status: 201 });
        }

        return new Response('Not found', { status: 404 });
    },
});

console.log(`orders-service listening on :${port}`);
