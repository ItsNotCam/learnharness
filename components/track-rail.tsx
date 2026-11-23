"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowRightIcon } from "lucide-react";
import { TrackMap } from "@/components/track-map";
import { useServerEvent, useServerResync } from "@/components/server-events";
import type { ChatTrackContext, TrackView } from "@/src/core";

/**
 * THE RIGHT RAIL of a part chat (docs/tracks.md §7, the Session mockup's
 * aside): WHERE YOU ARE — the track card (kicker TRACK + "N OF M DONE",
 * the title, the compact map with this part marked HERE, OPEN TRACK →),
 * THIS SESSION'S PLAN (the plan marginalia the chat already derives), and
 * READY TO START IN THIS TRACK (links into the overview with the part
 * selected). Live through the events channel: the ledger, turn lifecycle
 * and chat-list writes refetch the view (notify → fetch, the 250ms
 * trailing debounce). Hidden below xl — the overview is one click away.
 */

/** The ready leaves, in reading order, excluding this chat's own part.
 *  Pure, exported for tests. */
export function readyParts(view: Pick<TrackView, "parts">, hereId: string | null): TrackView["parts"] {
	return view.parts.filter((p) => p.status === "ready" && p.children.length === 0 && p.id !== hereId);
}

export function TrackRailBody({ view, track, plan }: { view: TrackView; track: ChatTrackContext; plan?: ReactNode }) {
	const ready = readyParts(view, track.partId);
	const href = `/track/${encodeURIComponent(track.trackId)}`;
	const mono = "font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground";
	return (
		<aside aria-label="Where you are" data-testid="track-rail" className="flex w-[300px] shrink-0 flex-col gap-4 overflow-y-auto border-l border-border px-4 py-5">
			<Link href={href} data-testid="track-rail-card" className="flex flex-col gap-3 rounded-2xl border border-border bg-card/60 p-4 text-foreground no-underline transition-colors hover:border-muted-foreground/50">
				<span className={`flex justify-between gap-2 ${mono}`}>
					<span>Track</span>
					<span data-testid="track-rail-progress">
						{view.progress.done} of {view.progress.total} done
					</span>
				</span>
				<span className="font-title text-lg leading-tight">{view.title}</span>
				<TrackMap parts={view.parts} compact hereId={track.partId} className="w-full" ariaLabel={`Track map: part ${track.partNumber ?? ""} of ${view.progress.total}`} />
				<span className={`${mono} flex items-center gap-1 text-foreground/80`}>
					Open track
					<ArrowRightIcon className="size-3" aria-hidden />
				</span>
			</Link>
			{plan && (
				<div className="flex flex-col gap-3 rounded-2xl border border-border bg-card/60 p-4" data-testid="track-rail-plan">
					<span className={mono}>This session’s plan</span>
					<div className="min-h-[120px]">{plan}</div>
				</div>
			)}
			{ready.length > 0 && (
				<div className="flex flex-col gap-2 rounded-2xl border border-border bg-card/60 p-4" data-testid="track-rail-ready">
					<span className={mono}>Ready to start in this track</span>
					{ready.map((p) => (
						<Link key={p.id} href={`${href}?part=${encodeURIComponent(p.id)}`} className="flex items-baseline gap-2.5 text-sm text-foreground no-underline hover:underline">
							<span className="font-mono text-xs text-muted-foreground">{p.number}</span>
							{p.title}
						</Link>
					))}
				</div>
			)}
		</aside>
	);
}

export function TrackRail({ track, plan }: { track: ChatTrackContext; plan?: ReactNode }) {
	const [view, setView] = useState<TrackView | null>(null);
	const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const refresh = useCallback(async () => {
		try {
			const res = await fetch(`/api/tracks/${encodeURIComponent(track.trackId)}`);
			if (!res.ok) return;
			const body = (await res.json()) as { track?: TrackView };
			if (body.track) setView(body.track);
		} catch {
			/* transient — the next announcement refetches */
		}
	}, [track.trackId]);
	useEffect(() => {
		void refresh();
	}, [refresh]);
	const schedule = useCallback(() => {
		if (debounce.current) clearTimeout(debounce.current);
		debounce.current = setTimeout(() => void refresh(), 250);
	}, [refresh]);
	useServerEvent("tracks-changed", (p) => {
		if (p.trackId && p.trackId !== track.trackId) return;
		schedule();
	});
	useServerEvent("turn-settled", () => schedule());
	useServerEvent("chats-changed", () => schedule());
	useServerResync(() => void refresh());
	useEffect(() => () => {
		if (debounce.current) clearTimeout(debounce.current);
	}, []);
	if (!view) return null;
	return <TrackRailBody view={view} track={track} plan={plan} />;
}
