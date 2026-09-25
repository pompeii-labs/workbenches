import { Hono } from 'hono';
import type { MemberEnv } from '../../../../middleware';
import type { Members } from '../../../../types/lux';
import { lux } from '../../../../utils/lux';
import { buildError, buildSuccess } from '../../../../utils/result';
import TeamIdMemberIdRouter from './[memberId]';

const TeamIdMembersRouter = new Hono<MemberEnv>();

TeamIdMembersRouter.get('/', async (c) => {
    const { data, error } = await lux
        .table('members')
        .select<{
            id: string;
            created_at: number | null;
            role: string | null;
            team_id: string | null;
            user_id: string | null;
            profile_id: string;
            username: string | null;
            full_name: string | null;
        }>('id,role,team_id,user_id,p.id AS profile_id,p.username,p.full_name,')
        .join('profiles', 'p', 'user_id', 'id')
        .eq('team_id', c.var.team.id);

    if (error) {
        console.error(error);
        return c.json(buildError('LuxError', error), 500);
    }
    return c.json(buildSuccess<Members[]>(data));
});

TeamIdMembersRouter.route('/:memberId', TeamIdMemberIdRouter);

export default TeamIdMembersRouter;
