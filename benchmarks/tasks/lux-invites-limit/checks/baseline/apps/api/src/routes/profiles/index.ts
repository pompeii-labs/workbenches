import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import z from 'zod';
import { verifyUser } from '../../middleware';
import type { Profiles } from '../../types/lux';
import { lux } from '../../utils/lux';
import { buildError, buildSuccess } from '../../utils/result';

const ProfilesRouter = new Hono().use(verifyUser);

ProfilesRouter.get('/me', async (c) => {
    const { data, error } = await lux
        .table('profiles')
        .select()
        .eq('id', c.var.user.id)
        .single();
    if (error) {
        console.error(error);
        return c.json(buildError('LuxError', error), 500);
    }

    return c.json(buildSuccess<Profiles>(data));
});

ProfilesRouter.post(
    '/me',
    zValidator(
        'json',
        z.object({
            full_name: z.string(),
            username: z.string(),
        })
    ),
    async (c) => {
        const validated = c.req.valid('json');
        const { data, error } = await lux
            .table('profiles')
            .insert({ ...validated, id: c.var.user.id });
        if (error) {
            console.error(error);
            return c.json(buildError('LuxError', error), 500);
        }

        return c.json(buildSuccess<Profiles>(data));
    }
);

ProfilesRouter.put(
    '/me',
    zValidator(
        'json',
        z.object({
            full_name: z.string().optional(),
            username: z.string().optional(),
        })
    ),
    async (c) => {
        const validated = c.req.valid('json');
        const { data, error } = await lux
            .table('profiles')
            .update(validated)
            .eq('id', c.var.user.id)
            .single();
        if (error) {
            console.error(error);
            return c.json(buildError('LuxError', error), 500);
        }

        // trigger an update for all members associated with the user to broadcast realtime events
        const { error: memberUpdateError } = await lux
            .table('members')
            .update({ created_at: new Date().getTime() })
            .eq('user_id', c.var.user.id);
        if (memberUpdateError) {
            console.error(memberUpdateError);
            return c.json(buildError('LuxError', memberUpdateError), 500);
        }

        return c.json(buildSuccess<Profiles>(data));
    }
);

// TODO: add delete

export default ProfilesRouter;
