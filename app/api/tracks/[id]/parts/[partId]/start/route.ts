import { handleChatInput, startPart } from "@/src/server";

/**
 * Start part (docs/tracks.md §5): the part's teaching chat is born with its
 * track-context block, and LH OPENS IT — the first turn fires at once on the
 * context alone (`continue` appends nothing; the marker is the whole context),
 * so the learner lands on a session where the prober is already asking. A
 * started part returns its existing chat (Continue session) and fires nothing.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string; partId: string }> }) {
	const { id, partId } = await params;
	const outcome = startPart(id, partId);
	if (!outcome.ok) return Response.json({ error: outcome.error }, { status: outcome.status });
	let turn: number | null = null;
	if (outcome.created) {
		const res = await handleChatInput(outcome.chatId, { type: "continue" });
		turn = res.status; // 200 = running; 503 = the BYOK gate refused (the session waits, the composer's send shows setup)
		await res.arrayBuffer().catch(() => undefined);
	}
	return Response.json({ chatId: outcome.chatId, created: outcome.created, turn }, { status: outcome.created ? 201 : 200 });
}
