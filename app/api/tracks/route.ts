import { listTrackViews, startTrack } from "@/src/server";

/**
 * Tracks (docs/tracks.md): the sidebar's and overview's list (GET — derived
 * views, statuses included) and Start track (POST {chatId} — the planning
 * chat's latest proposal becomes the track; idempotent per chat).
 */
export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json({ tracks: listTrackViews() });
}

export async function POST(req: Request) {
	const body = (await req.json().catch(() => ({}))) as { chatId?: unknown };
	const chatId = typeof body.chatId === "string" ? body.chatId : "";
	if (!chatId) return Response.json({ error: "chatId is required" }, { status: 400 });
	const outcome = startTrack(chatId);
	if (!outcome.ok) return Response.json({ error: outcome.error }, { status: outcome.status });
	return Response.json({ track: outcome.track, created: outcome.created }, { status: outcome.created ? 201 : 200 });
}
