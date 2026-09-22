import { Hono } from 'hono';
import { verifyUser } from '../../middleware';
import type { Invites } from '../../types/lux';
import { lux } from '../../utils/lux';
import { buildError, buildSuccess } from '../../utils/result';
import InviteIdRouter from './[inviteId]';

const InvitesRouter = new Hono().use(verifyUser);

InvitesRouter.get('/', async (c) => {
    const { data, error } = await lux
        .table('invites')
        .select()
        .eq('email', c.var.user.email);
    if (error) {
        console.error(error);
        return c.json(buildError('LuxError', error), 500);
    }

    return c.json(buildSuccess<Invites[]>(data));
});

InvitesRouter.route('/:inviteId', InviteIdRouter);

export default InvitesRouter;
