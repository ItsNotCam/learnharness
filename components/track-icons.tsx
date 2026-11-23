"use client";

import {
	CircleCheckIcon,
	CircleDashedIcon,
	CircleDotIcon,
	CircleIcon,
	DumbbellIcon,
	MessageSquareIcon,
	WaypointsIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { TrackPartStatus, TrackPartView } from "@/src/core";

/**
 * The track status language (docs/tracks.md §7.1, the approved mockup): done
 * = check in a circle, in progress = filled dot in the track accent, ready =
 * open circle, later = dashed circle; track = the waypoints glyph, session =
 * chat bubble, practice = dumbbell. Lucide glyphs, the app's icon set.
 */

export const TrackGlyph = WaypointsIcon;
export const SessionGlyph = MessageSquareIcon;
export const PracticeGlyph = DumbbellIcon;

/** A split part shows its children's aggregate: done when all are, in
 *  progress when any is, ready when any is, else later. Pure. */
export function splitDisplayStatus(part: Pick<TrackPartView, "children">, parts: readonly TrackPartView[]): Exclude<TrackPartStatus, "split"> {
	const kids = part.children.map((id) => parts.find((p) => p.id === id)).filter((p): p is TrackPartView => p !== undefined);
	const statuses = kids.map((k) => (k.status === "split" ? splitDisplayStatus(k, parts) : k.status));
	if (statuses.length > 0 && statuses.every((s) => s === "done")) return "done";
	if (statuses.includes("in-progress")) return "in-progress";
	if (statuses.includes("ready")) return "ready";
	return "later";
}

export const STATUS_LABEL: Record<TrackPartStatus, string> = {
	done: "Done",
	"in-progress": "In progress",
	ready: "Ready to start",
	later: "Later",
	split: "Split",
};

export function PartStatusIcon({
	status,
	className,
}: {
	status: Exclude<TrackPartStatus, "split">;
	className?: string;
}) {
	const base = cn("shrink-0", className);
	switch (status) {
		case "done":
			return <CircleCheckIcon data-testid="status-done" className={base} aria-hidden="true" />;
		case "in-progress":
			return (
				<CircleDotIcon
					data-testid="status-in-progress"
					className={base}
					style={{ color: "var(--lh-track-accent)" }}
					aria-hidden="true"
				/>
			);
		case "ready":
			return <CircleIcon data-testid="status-ready" className={base} aria-hidden="true" />;
		case "later":
			return <CircleDashedIcon data-testid="status-later" className={cn(base, "text-muted-foreground")} aria-hidden="true" />;
	}
}
