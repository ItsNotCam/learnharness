import { notFound } from "next/navigation";
import { TrackOverview } from "@/components/track-overview";
import { getTrackView } from "@/src/server";

export const dynamic = "force-dynamic";

/**
 * The track overview (docs/tracks.md §7.2): the server reads the derived view
 * for the first paint; the client component keeps it live through the events
 * channel. `?part=<id>` pre-selects a part (the sidebar's part rows link here).
 */
export default async function TrackPage({
	params,
	searchParams,
}: {
	params: Promise<{ id: string }>;
	searchParams: Promise<{ part?: string }>;
}) {
	const [{ id }, { part }] = await Promise.all([params, searchParams]);
	const track = getTrackView(id);
	if (!track) notFound();
	const initialPartId = typeof part === "string" && part.length > 0 ? part : null;
	// Keyed on track AND part: a sidebar part row on this same overview
	// navigates to ?part=<other>, and the selection must follow (the
	// component seeds its selection once, at mount).
	return <TrackOverview key={`${track.id}:${initialPartId ?? ""}`} initial={track} initialPartId={initialPartId} />;
}
