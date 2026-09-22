import type { LuxUser } from '@luxdb/sdk';
import { bearerAuth } from 'hono/bearer-auth';
import { createMiddleware } from 'hono/factory';
import type { Invites, Members, Teams } from '../types/lux';
import { lux } from '../utils/lux';
import { buildError } from '../utils/result';

export type AuthEnv = {
    Variables: {
        user: LuxUser;
    };
};

export const verifyUser = bearerAuth<AuthEnv>({
    verifyToken: async (token, c) => {
        const { data, error } = await lux.auth.getUser(token);
        if (error) {
            console.error(error);
            return false;
        }
        c.set('user', data.user);
        return true;
    },
});

export type TeamEnv = {
    Variables: {
        team: Teams;
    };
} & AuthEnv;

export const getTeam = createMiddleware<TeamEnv, '/:teamId'>(async (c, next) => {
    const teamId = c.req.param('teamId');
    const { data, error } = await lux.table('teams').select().eq('id', teamId).single();
    if (error) {
        console.error(error);
        return c.json(buildError('LuxError', error), 500);
    }

    c.set('team', data);
    await next();
});

export type MemberEnv = {
    Variables: {
        member: Members;
    };
} & TeamEnv;

export const verifyMember = createMiddleware<MemberEnv, '/:teamId'>(async (c, next) => {
    const user = c.var.user;
    const teamId = c.req.param('teamId');

    const { data, error } = await lux
        .table('members')
        .select()
        .eq('user_id', user.id)
        .eq('team_id', teamId)
        .single();

    if (error) {
        return c.json(buildError('LuxError', error), 500);
    }

    c.set('member', data);
    await next();
});

export type InviteEnv = {
    Variables: {
        invite: Invites;
    };
} & MemberEnv;

export const getInvite = createMiddleware<InviteEnv, '/:inviteId'>(async (c, next) => {
    const inviteId = c.req.param('inviteId');

    const { data, error } = await lux
        .table('invites')
        .select()
        .eq('id', inviteId)
        .eq('team_id', c.var.team.id)
        .single();
    if (error) {
        return c.json(buildError('LuxError', error), 500);
    }

    c.set('invite', data);
    await next();
});

export const MEMBER_ROLES = ['user', 'admin', 'owner'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export function getRoleValue(role: MemberRole) {
    return MEMBER_ROLES.indexOf(role) ?? -1;
}

export function requireRole(role: MemberRole) {
    return createMiddleware<MemberEnv>(async (c, next) => {
        const requiredValue = getRoleValue(role);
        const actualValue = getRoleValue(c.var.member.role as MemberRole);

        if (actualValue < requiredValue) {
            return c.json(
                buildError('CustomError', { message: 'Not authorized' }),
                403
            );
        }

        await next();
    });
}
