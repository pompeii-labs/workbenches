import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import z from "zod";
import { type MemberEnv } from "../../../../middleware";
import { lux } from "../../../../utils/lux";
import { buildError, buildSuccess } from "../../../../utils/result";
import type { Announcements } from "../../../../types/lux";

const TeamIdAnnouncementsRouter = new Hono<MemberEnv>();

const announcementSchema = z.object({ title: z.string().min(1), body: z.string().min(1) });

TeamIdAnnouncementsRouter.get(
    "/",
    async (c) => {
        const { data, error } = await lux.table("announcements").select().eq("team_id", c.var.team.id).order("created_at", { ascending: false });
        if (error) {
            console.error(error);
            return c.json(buildError("LuxError", error), 500);
        }
        return c.json(buildSuccess<Announcements[]>(data));
    }
);

TeamIdAnnouncementsRouter.post(
    "/",
    zValidator("json", announcementSchema),
    async (c) => {
        const validated = c.req.valid("json");
        const { data, error } = await lux.table("announcements").insert({
            ...validated,
            team_id: c.var.team.id,
            author_id: c.var.user.id,
        });
        if (error) {
            console.error(error);
            return c.json(buildError("LuxError", error), 500);
        }
        return c.json(buildSuccess<Announcements>(data));
    }
);

async function findAnnouncement(id: string, teamId: string) {
    const { data } = await lux.table("announcements").select().eq("id", id).eq("team_id", teamId);
    return data?.[0];
}

TeamIdAnnouncementsRouter.put(
    "/:announcementId",
    zValidator("json", announcementSchema.partial()),
    async (c) => {
        const existing = await findAnnouncement(c.req.param("announcementId"), c.var.team.id);
        if (!existing) return c.json(buildError("CustomError", { message: "Not found" }), 404);
        if (existing.author_id !== c.var.user.id) {
            return c.json(buildError("CustomError", { message: "Only the author can change this announcement" }), 403);
        }
        const validated = c.req.valid("json");
        const { data, error } = await lux.table("announcements").update(validated).eq("id", existing.id).single();
        if (error) {
            console.error(error);
            return c.json(buildError("LuxError", error), 500);
        }
        return c.json(buildSuccess<Announcements>(data));
    }
);

TeamIdAnnouncementsRouter.delete(
    "/:announcementId",
    async (c) => {
        const existing = await findAnnouncement(c.req.param("announcementId"), c.var.team.id);
        if (!existing) return c.json(buildError("CustomError", { message: "Not found" }), 404);
        if (existing.author_id !== c.var.user.id) {
            return c.json(buildError("CustomError", { message: "Only the author can change this announcement" }), 403);
        }
        const { error } = await lux.table("announcements").delete().eq("id", existing.id);
        if (error) {
            console.error(error);
            return c.json(buildError("LuxError", error), 500);
        }
        return c.json(buildSuccess({ id: existing.id }));
    }
);

export default TeamIdAnnouncementsRouter;
