import { deleteTrack, getTrackView, renameTrack, type ChatDeleteMode } from "@/src/server";

/** One track (docs/tracks.md): the overview's view, rename, and deletion. */
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const track = getTrackView(id);
	if (!track) return Response.json({ error: "Not found" }, { status: 404 });
	return Response.json({ track });
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = (await req.json().catch(() => null)) as { title?: unknown } | null;
	if (typeof body?.title !== "string") return Response.json({ error: "title must be a non-empty string" }, { status: 400 });
	const outcome = renameTrack(id, body.title);
	if (!outcome.ok) return Response.json({ error: outcome.error }, { status: outcome.status });
	return Response.json({ title: outcome.title });
}

/**
 * DELETE /api/tracks/[id]?mode=preserve-graph|delete-nodes — the track and
 * EVERY session it owns (delegated ruling 2026-11-22), each through the
 * session-deletion choreography with the same mode. Gates: 409 while any
 * of its sessions has a turn or job running; 503 while an extraction winds
 * down — both retryable, like a single session's deletion.
 */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const mode = new URL(req.url).searchParams.get("mode");
	if (mode !== "preserve-graph" && mode !== "delete-nodes") {
		return Response.json({ error: 'mode is required and must be "preserve-graph" or "delete-nodes"', code: "bad_mode" }, { status: 400 });
	}
	const outcome = await deleteTrack(id, mode as ChatDeleteMode);
	if (!outcome.ok) return Response.json({ error: outcome.error, code: outcome.code }, { status: outcome.status });
	return Response.json({ ok: true, sessionsRemoved: outcome.sessionsRemoved, graphRevision: outcome.graphRevision });
}
