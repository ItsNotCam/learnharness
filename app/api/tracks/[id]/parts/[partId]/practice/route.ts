import { attachPractice, handleChatInput } from "@/src/server";

/**
 * Practice this part (docs/tracks.md §5): a newborn practice session attached
 * to the part, seeded with the part's summary and its graph propositions; the
 * practice agent opens it (the first turn fires on the context alone).
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string; partId: string }> }) {
	const { id, partId } = await params;
	const outcome = attachPractice(id, partId);
	if (!outcome.ok) return Response.json({ error: outcome.error }, { status: outcome.status });
	const res = await handleChatInput(outcome.chatId, { type: "continue" });
	await res.arrayBuffer().catch(() => undefined);
	return Response.json({ chatId: outcome.chatId, created: true, turn: res.status }, { status: 201 });
}
