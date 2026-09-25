import { zValidator } from '@hono/zod-validator';
import type { LuxUser } from '@luxdb/sdk';
import { Hono } from 'hono';
import z from 'zod';
import { verifyUser } from '../../middleware';
import type { Teams } from '../../types/lux';
import { lux } from '../../utils/lux';
import { buildError, buildSuccess } from '../../utils/result';
import TeamIdRouter from './[teamId]';

async function getTeamsForUser(userId: LuxUser['id']) {
    return await lux
        .table('members')
        .select<Teams>(
            't.id AS id,t.slug AS slug,t.name AS name,t.created_by AS created_by'
        )
        .join('teams', 't', 'team_id', 'id')
        .eq('user_id', userId);
}

const TeamsRouter = new Hono().use(verifyUser);

TeamsRouter.post(
    '/',
    zValidator(
        'json',
        z.object({
            name: z.string(),
            slug: z.string(),
        })
    ),
    async (c) => {
        // TODO: check if user is allowed to create another team
        const validated = c.req.valid('json');
        const { data: teamData, error: teamError } = await lux
            .table('teams')
            .insert(validated);
        if (teamError) {
            console.error(teamError);
            return c.json(buildError('LuxError', teamError), 500);
        }

        const { data: memberData, error: memberError } = await lux
            .table('members')
            .insert({
                role: 'owner',
                team_id: teamData.id,
                user_id: c.var.user.id,
            });

        if (memberError) {
            console.error(memberError);
            return c.json(buildError('LuxError', memberError), 500);
        }

        return c.json(buildSuccess<Teams>(teamData));
    }
);

TeamsRouter.get('/', async (c) => {
    const { data, error } = await getTeamsForUser(c.var.user.id);
    if (error) {
        console.error(error);
        return c.json(buildError('LuxError', error), 500);
    }

    return c.json(buildSuccess<Teams[]>(data));
});

TeamsRouter.route('/:teamId', TeamIdRouter);

export default TeamsRouter;
