import { Hono } from "hono";
import * as Bun from "bun";
import { cors } from "hono/cors";
import Router from "./routes";


const app = new Hono().basePath("/v1").use(cors());

app.get("/", (c) => c.text("ok"));

app.route("/", Router);

const server = Bun.serve({
    port: Number(process.env.PORT) || 3000,
    fetch: app.fetch,
});

console.log(`Listening on ${server.url}`);
