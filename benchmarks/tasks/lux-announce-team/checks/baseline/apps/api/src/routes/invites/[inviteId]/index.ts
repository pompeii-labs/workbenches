import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { AuthEnv } from '../../../middleware';
import type { Invites } from '../../../types/lux';
import { lux } from '../../../utils/lux';
import { buildError, buildSuccess } from '../../../utils/result';

const InviteIdRouter = new Hono<AuthEnv, {}, '/:inviteId'>();

InviteIdRouter.post(
    '/accept',
    createMiddleware<AuthEnv & { Variables: { invite: Invites } }, '/:inviteId'>(
        async (c, next) => {
            const { data, error } = await lux
                .table('invites')
                .select()
                .eq('id', c.req.param('inviteId'))
                .single();
            if (error) {
                console.error(error);
                return c.json(buildError('LuxError', error), 500);
            }

            if (c.var.user.email !== data.email) {
                console.error("Emails don't match");
                return c.json(
                    buildError('CustomError', {
                        message: 'Not found',
                    }),
                    404
                );
            }

            c.set('invite', data);
            await next();
        }
    ),
    async (c) => {
        const { data: selectData, error: selectError } = await lux
            .table('invites')
            .delete()
            .eq('id', c.var.invite.id);
        if (selectError) {
            console.error(selectError);
            return c.json(buildError('LuxError', selectError), 500);
        }

        if (selectData.length === 0) {
            console.error('Could not find invite');
            return c.json(
                buildError('CustomError', {
                    message: 'Not found',
                }),
                404
            );
        }

        const { data: memberData, error: memberError } = await lux
            .table('members')
            .insert({
                role: c.var.invite.role,
                user_id: c.var.user.id,
                team_id: c.var.invite.team_id,
            });
        if (memberError) {
            console.error(memberError);
            return c.json(buildError('LuxError', memberError), 500);
        }

        const { data: teamData, error: teamError } = await lux
            .table('teams')
            .select()
            .eq('id', memberData.team_id)
            .single();
        if (teamError) {
            console.error(teamError);
            return c.json(buildError('LuxError', teamError), 500);
        }

        return c.json(buildSuccess(teamData));
    }
);

export default InviteIdRouter;
