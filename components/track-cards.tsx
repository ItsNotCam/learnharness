"use client";

import { useContext, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowUpRightIcon, ChevronRightIcon, CircleCheckIcon, RefreshCwIcon, WaypointsIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { TrackMap } from "@/components/track-map";
import { blurAfterPointerClick } from "@/components/focus-hygiene";
import { TrackChatContext } from "@/components/track-context";
import {
	assignPartNumbers,
	dependencyLabel,
	parsePartDoneInput,
	parseProposeTrackInput,
	parseReplanTrackInput,
	type ArtifactPartProps,
	type TrackPartSpec,
} from "@/src/core";

/**
 * THE TRACK CARDS (docs/tracks.md §7, the approved Proposal mockup) — what a
 * planning chat and a part chat render for the track machinery:
 *
 *   TrackProposalCard   the prober's/planner's propose_track call: the
 *                       explanation, the placement findings, the proposed
 *                       map + the numbered parts with their dependency
 *                       labels, what is left out, and the two actions —
 *                       Start track / Change something — on the LATEST
 *                       clean proposal while the track has not started.
 *   TrackReplanCard     the planner's replan_track call: the note and what
 *                       changed, with OPEN TRACK →.
 *   TrackReplanDivider  the re-plan wake marker in the planning chat —
 *                       "Re-plan · after part N" (or at your request).
 *   TrackContextCard    a part chat's message[0]: the [Track context] block
 *                       as a collapsible card (the graph-context idiom).
 *
 * The cards read the CALL's input (parse, don't cast — the same schema the
 * tool declared); the output is our own ack (a cast). Which proposal is the
 * live one, and whether the track has started, comes from the chat through
 * TrackChatContext (components/track-context.tsx; the Chat component
 * provides it).
 */

const MONO = "font-mono text-[11px] uppercase tracking-[0.06em] text-muted-foreground";

/** "ONE PLACE TO START: 1" / "TWO PLACES TO START: 1 AND 4" — the proposal
 *  header's right-hand line. Pure, exported for tests. */
export function startsText(parts: readonly Pick<TrackPartSpec, "number" | "dependsOn" | "parentPartId">[]): string {
	const starts = parts.filter((p) => p.parentPartId === undefined && p.dependsOn.length === 0).map((p) => p.number);
	if (starts.length === 0) return "NO PLACE TO START";
	const WORDS = ["ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN", "EIGHT", "NINE"];
	const count = WORDS[starts.length - 1] ?? String(starts.length);
	const list = starts.length === 1 ? starts[0]! : `${starts.slice(0, -1).join(", ")} AND ${starts.at(-1)}`;
	return `${count} PLACE${starts.length === 1 ? "" : "S"} TO START: ${list}`;
}

/** The proposal card's stage: the actions it offers. */
export type ProposalStage = "live" | "superseded" | "started";

/** The hook-bearing wrapper: reads the chat's track context, owns the
 *  Start track POST + navigation; the body is a pure render (tests). */
export function TrackProposalCard({ part }: ArtifactPartProps) {
	const ctx = useContext(TrackChatContext);
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const started = ctx.track?.role === "planning";
	const stage: ProposalStage = started ? "started" : ctx.latestProposalCallId === part.toolCallId ? "live" : "superseded";
	const startTrack = async () => {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			const res = await fetch("/api/tracks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId: ctx.chatId }) });
			const body = (await res.json().catch(() => null)) as { track?: { id: string }; error?: string } | null;
			if (!res.ok || !body?.track) throw new Error(body?.error ?? `Start track failed: ${res.status}`);
			router.push(`/track/${encodeURIComponent(body.track.id)}`);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setBusy(false);
		}
	};
	return (
		<TrackProposalBody
			part={part}
			stage={stage}
			trackId={started ? ctx.track?.trackId ?? null : null}
			busy={busy}
			error={error}
			onStart={() => void startTrack()}
			onChange={ctx.focusComposer}
		/>
	);
}

export function TrackProposalBody({
	part,
	stage,
	trackId,
	busy,
	error,
	onStart,
	onChange,
}: {
	part: ArtifactPartProps["part"];
	stage: ProposalStage;
	/** The started track (stage "started"): the OPEN TRACK link's target. */
	trackId: string | null;
	busy: boolean;
	error: string | null;
	onStart: () => void;
	onChange: () => void;
}) {
	const output = part.output as { ok?: boolean; error?: string } | undefined;
	const input = parseProposeTrackInput(part.input);
	if (output && output.ok === false) {
		return (
			<div data-testid="track-proposal-card" data-state="refused" className="my-3 rounded-xl border border-dashed bg-card/40 px-4 py-3 text-sm text-muted-foreground">
				LH retried the proposal: {output.error}
			</div>
		);
	}
	if (!input) {
		return (
			<div data-testid="track-proposal-card" data-state="pending" className="my-3 rounded-xl border bg-card/60 px-4 py-3 text-sm text-muted-foreground">
				{part.state === "output-error" ? "The proposal was malformed — LH retried with a corrected one." : "Writing the proposal…"}
			</div>
		);
	}
	const parts = assignPartNumbers([], input.parts.map((p) => ({ ...p, dependsOn: [...p.dependsOn] })));
	const numberOf = (id: string) => parts.find((p) => p.id === id)?.number ?? id;
	const mapParts = parts.map((p) => ({ ...p, status: p.dependsOn.length === 0 ? ("ready" as const) : ("later" as const), children: [] as string[] }));

	return (
		<section data-testid="track-proposal-card" data-state={stage} className="my-3 overflow-hidden rounded-2xl border border-border bg-card/60">
			<div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/70 px-4 py-3">
				<h3 className="m-0 flex items-center gap-2 font-mono text-xs font-medium uppercase tracking-[0.08em] text-foreground/80">
					<WaypointsIcon className="size-3.5 text-primary" aria-hidden />
					Proposed track · {parts.filter((p) => p.parentPartId === undefined).length} parts
				</h3>
				<span className={MONO} data-testid="track-proposal-starts">
					{startsText(parts)}
				</span>
			</div>
			<div className="space-y-4 px-4 py-4">
				<p className="m-0 text-base leading-relaxed text-foreground" data-testid="track-proposal-explanation">
					{input.explanation}
				</p>
				{input.findings.length > 0 && (
					<ul className="m-0 list-none space-y-1.5 p-0 text-sm" data-testid="track-proposal-findings">
						{input.findings.map((f, i) => (
							<li key={i} className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
								<span className={cn(MONO, "w-28 shrink-0")}>{f.kind === "held" ? "Already held" : "Starts low"}</span>
								<span className="text-foreground/90">{f.text}</span>
							</li>
						))}
					</ul>
				)}
				<div className="flex flex-wrap gap-6">
					<TrackMap parts={mapParts} compact proposal className="w-[260px] max-w-full shrink-0 self-start" ariaLabel={`Proposed track map: ${startsText(parts).toLowerCase()}`} />
					<ol className="m-0 min-w-[280px] flex-1 list-none divide-y divide-border/60 p-0" data-testid="track-proposal-parts">
						{parts.map((p) => (
							<li key={p.id} className="flex gap-3 py-2.5" data-testid={`track-proposal-part-${p.id}`}>
								<span className="w-6 shrink-0 font-mono text-sm text-muted-foreground">{p.number}</span>
								<span className="flex min-w-0 flex-1 flex-col gap-0.5">
									<span className="text-base leading-snug">{p.title}</span>
									<span className="text-sm leading-snug text-muted-foreground">{p.why}</span>
								</span>
								<span className={cn(MONO, "shrink-0 pt-1", p.dependsOn.length === 0 && "text-foreground/80")}>{dependencyLabel(p, numberOf)}</span>
							</li>
						))}
					</ol>
				</div>
				{input.leftOut && (
					<p className="m-0 text-sm leading-snug text-muted-foreground" data-testid="track-proposal-left-out">
						<span className={cn(MONO, "mr-2.5")}>Left out, per your brief</span>
						{input.leftOut}
					</p>
				)}
			</div>
			<div className="flex flex-wrap items-center gap-2.5 border-t border-border/70 px-4 py-3">
				{stage === "started" && trackId ? (
					<Link
						href={`/track/${encodeURIComponent(trackId)}`}
						data-testid="track-proposal-open"
						className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 font-mono text-xs uppercase tracking-[0.06em] text-foreground transition-colors hover:bg-accent"
					>
						Track started · Open track
						<ArrowUpRightIcon className="size-3.5" aria-hidden />
					</Link>
				) : stage === "live" ? (
					<>
						<button
							type="button"
							data-testid="track-proposal-start"
							disabled={busy}
							onClick={(e) => {
								blurAfterPointerClick(e);
								onStart();
							}}
							className="cursor-pointer rounded-lg bg-foreground px-4 py-2 font-mono text-sm text-background transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-60"
						>
							{busy ? "Starting…" : "Start track"}
						</button>
						<button
							type="button"
							data-testid="track-proposal-change"
							onClick={(e) => {
								blurAfterPointerClick(e);
								onChange();
							}}
							className="cursor-pointer rounded-lg border border-border px-4 py-2 font-mono text-sm text-foreground transition-colors hover:bg-accent"
						>
							Change something
						</button>
						{error && <span className="text-sm text-destructive">{error}</span>}
					</>
				) : (
					<span className={MONO} data-testid="track-proposal-superseded">
						Superseded by a later proposal
					</span>
				)}
			</div>
		</section>
	);
}

export function TrackReplanCard({ part }: ArtifactPartProps) {
	const ctx = useContext(TrackChatContext);
	const output = part.output as { ok?: boolean; error?: string; changed?: string } | undefined;
	const input = parseReplanTrackInput(part.input);
	if (output && output.ok === false) {
		return (
			<div data-testid="track-replan-card" data-state="refused" className="my-3 rounded-xl border border-dashed bg-card/40 px-4 py-3 text-sm text-muted-foreground">
				LH retried the re-plan: {output.error}
			</div>
		);
	}
	if (!input) {
		return (
			<div data-testid="track-replan-card" data-state="pending" className="my-3 rounded-xl border bg-card/60 px-4 py-3 text-sm text-muted-foreground">
				{part.state === "output-error" ? "The re-plan was malformed — LH retried with a corrected one." : "Re-planning the track…"}
			</div>
		);
	}
	const changed = output?.changed;
	return (
		<section data-testid="track-replan-card" data-state="ok" className="my-3 rounded-2xl border border-border bg-card/60 px-4 py-3">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h3 className="m-0 flex items-center gap-2 font-mono text-xs font-medium uppercase tracking-[0.08em] text-foreground/80">
					<RefreshCwIcon className="size-3.5 text-primary" aria-hidden />
					Re-planned · {input.parts.filter((p) => p.parentPartId === undefined).length} parts
				</h3>
				{ctx.track && (
					<Link href={`/track/${encodeURIComponent(ctx.track.trackId)}`} data-testid="track-replan-open" className={cn(MONO, "inline-flex items-center gap-1 hover:text-foreground")}>
						Open track
						<ArrowUpRightIcon className="size-3" aria-hidden />
					</Link>
				)}
			</div>
			<p className="mb-0 mt-2 text-base leading-relaxed text-foreground" data-testid="track-replan-note">
				{input.note}
			</p>
			<p className={cn(MONO, "mb-0 mt-2")} data-testid="track-replan-changed">
				{changed ? `Changed: ${changed}` : "No part was added, dropped or split."}
			</p>
		</section>
	);
}

/** The teacher's part_done call in a part chat: the summary the track
 *  re-plans from, and what stayed shaky. */
export function PartDoneCard({ part }: ArtifactPartProps) {
	const ctx = useContext(TrackChatContext);
	const output = part.output as { ok?: boolean; error?: string } | undefined;
	const input = parsePartDoneInput(part.input);
	if (output && output.ok === false) {
		return (
			<div data-testid="part-done-card" data-state="refused" className="my-3 rounded-xl border border-dashed bg-card/40 px-4 py-3 text-sm text-muted-foreground">
				LH retried: {output.error}
			</div>
		);
	}
	if (!input) {
		return (
			<div data-testid="part-done-card" data-state="pending" className="my-3 rounded-xl border bg-card/60 px-4 py-3 text-sm text-muted-foreground">
				{part.state === "output-error" ? "The summary was malformed — LH retried with a corrected one." : "Recording the part as done…"}
			</div>
		);
	}
	const label = ctx.track?.partNumber ? `Part ${ctx.track.partNumber} done` : "Part done";
	return (
		<section data-testid="part-done-card" data-state="ok" className="my-3 rounded-2xl border bg-card/60 px-4 py-3" style={{ borderColor: "color-mix(in oklab, var(--border) 40%, var(--lh-track-accent))" }}>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h3 className="m-0 flex items-center gap-2 font-mono text-xs font-medium uppercase tracking-[0.08em] text-foreground/80">
					<CircleCheckIcon className="size-3.5" style={{ color: "var(--lh-track-accent)" }} aria-hidden />
					{label} · the track re-plans from this
				</h3>
				{ctx.track && (
					<Link href={`/track/${encodeURIComponent(ctx.track.trackId)}`} data-testid="part-done-open" className={cn(MONO, "inline-flex items-center gap-1 hover:text-foreground")}>
						Open track
						<ArrowUpRightIcon className="size-3" aria-hidden />
					</Link>
				)}
			</div>
			<p className="mb-0 mt-2 text-base leading-relaxed text-foreground" data-testid="part-done-summary">
				{input.summary}
			</p>
			{input.shaky && (
				<p className="mb-0 mt-2 text-sm leading-snug text-muted-foreground" data-testid="part-done-shaky">
					<span className={cn(MONO, "mr-2.5")}>Shaky</span>
					{input.shaky}
				</p>
			)}
		</section>
	);
}

/** The re-plan wake's divider (data-track-replan): the planning chat's
 *  "Re-plan · after part N" rule, the phase-divider register. */
export function TrackReplanDivider({ data }: { data: { partNumber: string | null; partTitle: string | null } | undefined }) {
	const label = data?.partNumber ? `Re-plan · after part ${data.partNumber}${data.partTitle ? ` · ${data.partTitle}` : ""}` : "Re-plan · at your request";
	return (
		<div className="my-4 flex w-full items-center gap-3" data-testid="track-replan-divider">
			<span className="h-0 flex-1 border-t-2 border-dotted border-border/50" aria-hidden />
			<span className="rounded-full border border-border/80 px-2.5 py-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
			<span className="h-0 flex-1 border-t-2 border-dotted border-border/50" aria-hidden />
		</div>
	);
}

/** The track-context marker's view payload (core/view.ts). */
export interface TrackContextData {
	content: string;
	details: { trackId: string; partId: string; role: "teaching" | "practice" };
}

/** A part chat's message[0]: the [Track context] block, collapsed to its
 *  first line — the graph-context card's idiom. */
export function TrackContextCard({ data }: { data: TrackContextData }) {
	const [open, setOpen] = useState(false);
	const ctx = useContext(TrackChatContext);
	const content = data?.content ?? "";
	const firstLine = content.split("\n")[0]?.replace(/^\[Track context\]\s*—\s*/, "") ?? "";
	return (
		<div data-testid="track-context-card" className="my-1">
			<button
				type="button"
				data-testid="track-context-toggle"
				onClick={() => setOpen((v) => !v)}
				className="flex w-full cursor-pointer items-center gap-2 rounded-lg border border-dashed border-border/70 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
			>
				<ChevronRightIcon aria-hidden="true" className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
				<WaypointsIcon aria-hidden="true" className="size-3.5 shrink-0" style={{ color: "var(--lh-track-accent)" }} />
				<span className="font-medium">Track context</span>
				<span className="min-w-0 flex-1 truncate">{firstLine}</span>
				{ctx.track && (
					<Link href={`/track/${encodeURIComponent(ctx.track.trackId)}`} onClick={(e) => e.stopPropagation()} className={cn(MONO, "shrink-0 hover:text-foreground")}>
						Open track
					</Link>
				)}
			</button>
			{open && (
				<pre data-testid="track-context-body" className="mt-1 whitespace-pre-wrap rounded-lg border border-dashed border-border/70 px-4 py-3 font-sans text-xs leading-relaxed text-foreground/90">
					{content}
				</pre>
			)}
		</div>
	);
}
