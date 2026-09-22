import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import z from "zod";
import { type MemberEnv } from "../../../../middleware";
import { lux } from "../../../../utils/lux";
import { buildError, buildSuccess } from "../../../../utils/result";
import type { Announcements } from "../../../../types/lux";
import TeamIdAnnouncementIdRouter from "./[announcementId]";

const TeamIdAnnouncementsRouter = new Hono<MemberEnv>();

TeamIdAnnouncementsRouter.get(
    "/",
    async (c) => {
        const { data, error } = await lux
            .table("announcements")
            .select()
            .eq("team_id", c.var.team.id)
            .order("created_at", { ascending: false });
        if (error) {
            console.error(error);
            return c.json(buildError("LuxError", error), 500);
        }

        return c.json(buildSuccess<Announcements[]>(data));
    }
);

TeamIdAnnouncementsRouter.post(
    "/",
    zValidator(
        "json",
        z.object({
            title: z.string().min(1),
            body: z.string().min(1),
        })
    ),
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

TeamIdAnnouncementsRouter.route("/:announcementId", TeamIdAnnouncementIdRouter);

export default TeamIdAnnouncementsRouter;
