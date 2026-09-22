import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import z from 'zod';
import { MEMBER_ROLES, type MemberEnv, requireRole } from '../../../../middleware';
import type { Invites } from '../../../../types/lux';
import { lux } from '../../../../utils/lux';
import { buildError, buildSuccess } from '../../../../utils/result';
import TeamIdInviteIdRouter from './[inviteId]';

const TeamIdInvitesRouter = new Hono<MemberEnv>();

TeamIdInvitesRouter.get('/', async (c) => {
    const { data, error } = await lux
        .table('invites')
        .select()
        .eq('team_id', c.var.team.id);
    if (error) {
        console.error(error);
        return c.json(buildError('LuxError', error), 500);
    }

    return c.json(buildSuccess<Invites[]>(data));
});

TeamIdInvitesRouter.post(
    '/',
    requireRole('admin'),
    zValidator(
        'json',
        z.object({
            email: z.email(),
            role: z.enum(MEMBER_ROLES),
        })
    ),
    async (c) => {
        const validated = c.req.valid('json');
        const { data: selectInviteData, error: selectInviteError } = await lux
            .table('invites')
            .select()
            .eq('team_id', c.var.team.id)
            .eq('email', validated.email);
        if (selectInviteError) {
            console.error(selectInviteError);
            return c.json(buildError('LuxError', selectInviteError), 500);
        }

        if (selectInviteData.length > 0) {
            return c.json(
                buildError('CustomError', {
                    message: 'This user has already been invited',
                }),
                500
            );
        }

        // TODO: this will stop working at some point above 1000 users
        // either need to be able to join on auth.users, or find a user by email
        // OR we add email to profiles
        const { data: users, error: usersError } = await lux.auth.admin.listUsers();
        if (usersError) {
            console.error(usersError);
            return c.json(buildError('LuxError', usersError), 500);
        }

        const existingUser = users.find(
            (user) => user.email === validated.email.toLowerCase()
        );
        if (existingUser) {
            const { data: selectMemberData, error: selectMemberError } = await lux
                .table('members')
                .select<{ id: string }>('id')
                .eq('team_id', c.var.team.id)
                .eq('user_id', existingUser.id);
            if (selectMemberError) {
                console.error(selectMemberError);
                return c.json(buildError('LuxError', selectMemberError), 500);
            }

            if (selectMemberData.length > 0) {
                return c.json(
                    buildError('CustomError', {
                        message: 'This user is already a member of this team',
                    }),
                    500
                );
            }
        }

        const { data, error } = await lux
            .table('invites')
            .insert({ ...validated, team_id: c.var.team.id });
        if (error) {
            console.error(error);
            return c.json(buildError('LuxError', error), 500);
        }

        return c.json(buildSuccess<Invites>(data));
    }
);

TeamIdInvitesRouter.route('/:inviteId', TeamIdInviteIdRouter);

export default TeamIdInvitesRouter;
