import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import z from 'zod';
import { getTeam, requireRole, verifyMember, verifyUser } from '../../../middleware';
import type { Teams } from '../../../types/lux';
import { lux } from '../../../utils/lux';
import { buildError, buildSuccess } from '../../../utils/result';
import TeamIdInvitesRouter from './invites';
import TeamIdMembersRouter from './members';

const TeamIdRouter = new Hono().use(verifyUser).use(getTeam).use(verifyMember);

TeamIdRouter.get('/', async (c) => {
    return c.json(buildSuccess<Teams>(c.var.team));
});

TeamIdRouter.put(
    '/',
    requireRole('admin'),
    zValidator(
        'json',
        z.object({
            name: z.string().optional(),
            slug: z.string().optional(),
        })
    ),
    async (c) => {
        const validated = c.req.valid('json');
        const { data, error } = await lux
            .table('teams')
            .update(validated)
            .eq('id', c.var.team.id)
            .single();
        if (error) {
            console.error(error);
            return c.json(buildError('LuxError', error), 500);
        }

        return c.json(buildSuccess<Teams>(data));
    }
);

TeamIdRouter.delete('/', requireRole('owner'), async (c) => {
    const { data, error } = await lux
        .table('teams')
        .delete()
        .eq('id', c.var.team.id)
        .single();
    if (error) {
        console.error(error);
        return c.json(buildError('LuxError', error), 500);
    }

    return c.json(buildSuccess<Teams>(data));
});

TeamIdRouter.route('/invites', TeamIdInvitesRouter);
TeamIdRouter.route('/members', TeamIdMembersRouter);

export default TeamIdRouter;
