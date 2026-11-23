"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import { TRACES_COPY } from "@/components/delete-session-dialog";
import type { ChatDeleteMode, TrackView } from "@/src/core";

/**
 * Track deletion (docs/tracks.md §8, delegated ruling 2026-11-22): the
 * session dialog's exact shape — red title, the name in JetBrains Mono, ONE
 * graph-traces checkbox, Cancel + destructive Delete — for a track and EVERY
 * session it owns (the body names the count). The server deletes each
 * session through the session-deletion choreography with the chosen mode,
 * then appends the tombstone; 409/503 refusals render with Try again.
 */
export function DeleteTrackDialog({
	track,
	onClose,
	onDeleted,
}: {
	track: Pick<TrackView, "id" | "title" | "chatIds"> | null;
	onClose: () => void;
	onDeleted: (id: string, mode: ChatDeleteMode, graphRevision: number) => void;
}) {
	const [traces, setTraces] = useState(false);
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<{ code: string; error: string } | null>(null);
	const backdropDismiss = useBackdropDismiss(() => {
		if (!busy) onClose();
	});

	useEffect(() => {
		if (!track) {
			setTraces(false);
			setBusy(false);
			setFailure(null);
		}
	}, [track]);

	useEffect(() => {
		if (!track) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				if (!busy) onClose(); // like the backdrop: an in-flight delete is not dismissable
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [track, busy, onClose]);

	const run = async () => {
		if (!track || busy) return;
		const mode: ChatDeleteMode = traces ? "delete-nodes" : "preserve-graph";
		setBusy(true);
		setFailure(null);
		try {
			const res = await fetch(`/api/tracks/${encodeURIComponent(track.id)}?mode=${mode}`, { method: "DELETE" });
			const body = (await res.json()) as { ok?: boolean; error?: string; code?: string; graphRevision?: number };
			if (!res.ok) {
				setFailure({ code: body.code ?? "error", error: body.error ?? `Delete failed (${res.status})` });
				setBusy(false);
				return;
			}
			onDeleted(track.id, mode, body.graphRevision ?? 0);
		} catch {
			setFailure({ code: "network", error: "Delete failed — network error. Try again." });
			setBusy(false);
		}
	};

	if (!track) return null;

	return createPortal(
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80" {...backdropDismiss}>
			<DeleteTrackBody
				track={track}
				traces={traces}
				busy={busy}
				failure={failure}
				onTraces={setTraces}
				onClose={onClose}
				onRun={() => void run()}
			/>
		</div>,
		document.body,
	);
}

/** The dialog's pure body — exported for SSR pins. */
export function DeleteTrackBody({
	track,
	traces,
	busy,
	failure,
	onTraces,
	onClose,
	onRun,
}: {
	track: Pick<TrackView, "id" | "title" | "chatIds">;
	traces: boolean;
	busy: boolean;
	failure: { code: string; error: string } | null;
	onTraces: (next: boolean) => void;
	onClose: () => void;
	onRun: () => void;
}) {
	const n = track.chatIds.length;
	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label="Delete track"
			data-testid="delete-track-dialog"
			onClick={(e) => e.stopPropagation()}
			className="w-[32rem] max-w-[calc(100vw-2rem)] rounded-xl border bg-card p-5 shadow-xl"
		>
			<h2 className="text-sm font-semibold text-destructive">Delete track?</h2>
			<div className="mt-1.5">
				<code data-testid="track-name-code" className="font-mono text-sm text-foreground">
					{track.title}
				</code>
			</div>
			<p className="mt-2 text-sm text-muted-foreground" data-testid="delete-track-copy">
				This permanently removes the track and its {n} session{n === 1 ? "" : "s"} — the planning session and every
				part's teaching and practice sessions, with their messages, background jobs, and extraction records.
				Everything they added to the graph stays unless you check below. This cannot be undone.
			</p>
			<label data-testid={TRACES_COPY.testid} className="mt-4 flex cursor-pointer items-start gap-2.5 rounded-lg border border-border/60 px-4 py-3">
				<input
					type="checkbox"
					data-testid={TRACES_COPY.checkbox}
					checked={traces}
					onChange={(e) => onTraces(e.target.checked)}
					disabled={busy}
					className="mt-0.5 size-4 shrink-0 accent-primary"
				/>
				<span className="min-w-0">
					<span className="block text-sm text-foreground">Also remove their graph traces</span>
					<span className="mt-1 block text-xs text-muted-foreground">
						The sessions’ topics, links, and events leave the graph too. Topics other sessions or imported notes also
						cover survive; topics only these sessions created are removed entirely.
					</span>
				</span>
			</label>
			{failure && (
				<div role="alert" data-testid="delete-failure" className="mt-3 rounded-sm border border-border/60 px-3 py-2 text-xs">
					<span className="text-foreground">{failure.error}</span>
					<button
						type="button"
						data-testid="delete-retry"
						onClick={onRun}
						disabled={busy}
						className="ml-3 text-xs text-foreground underline-offset-2 hover:underline disabled:opacity-40"
					>
						Try again
					</button>
				</div>
			)}
			<div className="mt-4 flex justify-end gap-2">
				<button
					type="button"
					data-testid="delete-cancel"
					onClick={onClose}
					disabled={busy}
					className="rounded-sm px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
				>
					Cancel
				</button>
				<button
					type="button"
					data-testid="delete-confirm"
					onClick={onRun}
					disabled={busy}
					className="rounded-sm border border-destructive/50 bg-destructive/10 px-3 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/20 disabled:opacity-40"
				>
					{busy ? "Deleting…" : "Delete"}
				</button>
			</div>
		</div>
	);
}
