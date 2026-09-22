import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import z from "zod";
import { getAnnouncement, requireAuthor, type AnnouncementEnv } from "../../../../../middleware";
import { lux } from "../../../../../utils/lux";
import { buildError, buildSuccess } from "../../../../../utils/result";
import type { Announcements } from "../../../../../types/lux";
import type { BlankSchema } from "hono/types";

const TeamIdAnnouncementIdRouter = new Hono<AnnouncementEnv, BlankSchema, "/:announcementId">().use(getAnnouncement);

TeamIdAnnouncementIdRouter.get(
    "/",
    async (c) => {
        return c.json(buildSuccess<Announcements>(c.var.announcement));
    }
);

TeamIdAnnouncementIdRouter.put(
    "/",
    requireAuthor,
    zValidator(
        "json",
        z.object({
            title: z.string().min(1).optional(),
            body: z.string().min(1).optional(),
        })
    ),
    async (c) => {
        const validated = c.req.valid("json");
        const { data, error } = await lux.table("announcements").update(validated).eq("id", c.var.announcement.id).single();
        if (error) {
            console.error(error);
            return c.json(buildError("LuxError", error), 500);
        }

        return c.json(buildSuccess<Announcements>(data));
    }
);

TeamIdAnnouncementIdRouter.delete(
    "/",
    requireAuthor,
    async (c) => {
        const { data, error } = await lux.table("announcements").delete().eq("id", c.var.announcement.id).single();
        if (error) {
            console.error(error);
            return c.json(buildError("LuxError", error), 500);
        }

        return c.json(buildSuccess<Announcements>(data));
    }
);

export default TeamIdAnnouncementIdRouter;
