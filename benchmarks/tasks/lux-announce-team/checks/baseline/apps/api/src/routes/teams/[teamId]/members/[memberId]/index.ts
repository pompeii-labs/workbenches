import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import z from 'zod';
import {
    getRoleValue,
    MEMBER_ROLES,
    type MemberEnv,
    type MemberRole,
    requireRole,
} from '../../../../../middleware';
import type { Members } from '../../../../../types/lux';
import { lux } from '../../../../../utils/lux';
import { buildError, buildSuccess } from '../../../../../utils/result';

const TeamIdMemberIdRouter = new Hono<MemberEnv, {}, '/:memberId'>();

TeamIdMemberIdRouter.put(
    '/',
    requireRole('admin'),
    zValidator(
        'json',
        z.object({
            role: z.enum(MEMBER_ROLES).optional(),
        })
    ),
    async (c) => {
        const validated = c.req.valid('json');
        const requestingMember = c.var.member;

        if (requestingMember.id === c.req.param('memberId')) {
            return c.json(
                buildError('CustomError', {
                    message: 'You cannot modify your own membership',
                }),
                403
            );
        }

        if (validated.role === 'owner') {
            return c.json(
                buildError('CustomError', {
                    message: 'You cannot promote another member to owner',
                }),
                403
            );
        }

        const { data: selectData, error: selectError } = await lux
            .table('members')
            .select()
            .eq('id', c.req.param('memberId'));
        if (selectError) {
            console.error(selectError);
            return c.json(buildError('LuxError', selectError), 500);
        }
        const memberToModify = selectData.at(0);
        if (!memberToModify) {
            return c.json(buildError('CustomError', { message: 'Not found' }), 404);
        }

        if (
            getRoleValue(requestingMember.role as MemberRole) <
            getRoleValue(memberToModify.role as MemberRole)
        ) {
            return c.json(
                buildError('CustomError', { message: 'Not authorized' }),
                403
            );
        }

        if (validated.role) {
            if (
                getRoleValue(requestingMember.role as MemberRole) <
                getRoleValue(validated.role)
            ) {
                return c.json(
                    buildError('CustomError', { message: 'Not authorized' }),
                    403
                );
            }
        }

        const { data: deleteData, error: deleteError } = await lux
            .table('members')
            .update(validated)
            .eq('id', c.req.param('memberId'))
            .single();
        if (deleteError) {
            console.error(deleteError);
            return c.json(buildError('LuxError', deleteError), 500);
        }

        return c.json(buildSuccess<Members>(deleteData));
    }
);

TeamIdMemberIdRouter.delete('/', requireRole('admin'), async (c) => {
    const requestingMember = c.var.member;

    if (requestingMember.id === c.req.param('memberId')) {
        return c.json(
            buildError('CustomError', {
                message: 'You cannot remove yourself from a team',
            }),
            403
        );
    }

    const { data: selectData, error: selectError } = await lux
        .table('members')
        .select()
        .eq('id', c.req.param('memberId'));
    if (selectError) {
        console.error(selectError);
        return c.json(buildError('LuxError', selectError), 500);
    }
    const memberToDelete = selectData.at(0);
    if (!memberToDelete) {
        return c.json(buildError('CustomError', { message: 'Not found' }), 404);
    }

    if (
        getRoleValue(requestingMember.role as MemberRole) <
        getRoleValue(memberToDelete.role as MemberRole)
    ) {
        return c.json(buildError('CustomError', { message: 'Not authorized' }), 403);
    }

    const { data: deleteData, error: deleteError } = await lux
        .table('members')
        .delete()
        .eq('id', c.req.param('memberId'))
        .single();
    if (deleteError) {
        console.error(deleteError);
        return c.json(buildError('LuxError', deleteError), 500);
    }

    return c.json(buildSuccess<Members>(deleteData));
});

export default TeamIdMemberIdRouter;
