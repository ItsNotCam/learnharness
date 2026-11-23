import { Home } from "@/components/home";
import { getTrackView, readSettingsRecord } from "@/src/server";
import { resolveSettings, slotsConfigured } from "@/src/core";

// Dynamic: the configured state is server-rendered into the page (the
// setup CTA's truth on the first frame), and every navigation re-reads
// the record (dynamic routes aren't cached client-side).
export const dynamic = "force-dynamic";

export default async function HomePage({ searchParams }: { searchParams: Promise<{ track?: string }> }) {
	// First-run gate (model-slots wave): chats cannot start until the user
	// has picked all three slots — the dock shows the CTA while the raw
	// record's models section lacks any slot pin.
	const record = readSettingsRecord();
	// LEARNING TRACKS (docs/tracks.md §7): /?track=<id> narrows the graph to
	// the track's sessions. An unknown id shows the whole graph.
	const { track } = await searchParams;
	const view = track ? getTrackView(track) : null;
	const trackFilter = view ? { id: view.id, title: view.title, chatIds: view.chatIds } : null;
	// GRAPH RENDERING (owner, 2026-10-06): off = the home's main view is
	// the chains view. Resolved through the one core resolver (missing
	// section / absent key → factory default on); re-read per navigation.
	const rendering = resolveSettings(record ?? null).graph.rendering;
	return (
		<Home initialConfigured={slotsConfigured(record?.models)} rendering={rendering} trackFilter={trackFilter} />
	);
}
