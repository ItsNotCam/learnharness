import { requestReplan } from "@/src/server";

/**
 * ASK LH TO RE-PLAN (docs/tracks.md §6): a learner-requested re-plan steer
 * into the planning chat — the same wake pipeline part_done uses. The client
 * then opens the planning chat to watch the planner work.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const outcome = requestReplan(id);
	if (!outcome.ok) return Response.json({ error: outcome.error }, { status: outcome.status });
	return Response.json({ ok: true, planningChatId: outcome.planningChatId }, { status: 202 });
}
