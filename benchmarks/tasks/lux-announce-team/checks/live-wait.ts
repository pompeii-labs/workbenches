// Subscribes directly to Lux's own `.live()` primitive (not the app's own
// realtime wiring) so the "reaches an open session live" probe stays
// implementation-independent: it only requires a read grant + no reload,
// which is the smallest true observable of "shows up live".
import { createClient } from "@luxdb/sdk";

const [, , url, publishableKey, accessToken, teamId, timeoutMsRaw] = process.argv;
const timeoutMs = Number(timeoutMsRaw ?? 8000);

const lux: any = createClient(url!, publishableKey!, { auth: { persistSession: false, autoRefreshToken: false } });
await lux.auth.setSession(accessToken);

const { live, error } = await lux.table("announcements").eq("team_id", teamId).live();
if (error) {
    console.log(JSON.stringify({ ok: false, error }));
    process.exit(1);
}

console.log(JSON.stringify({ ok: true, subscribed: true }));

const timer = setTimeout(() => {
    console.log(JSON.stringify({ ok: false, timeout: true }));
    process.exit(1);
}, timeoutMs);

for await (const event of live) {
    if (event.type === "insert") {
        clearTimeout(timer);
        console.log(JSON.stringify({ ok: true, event: "insert", row: event.new ?? event.row }));
        process.exit(0);
    }
}
