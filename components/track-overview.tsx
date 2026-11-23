"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowUpRightIcon, DumbbellIcon, RefreshCwIcon, WaypointsIcon } from "lucide-react";
import { TopBar } from "@/components/top-bar";
import { TrackMap } from "@/components/track-map";
import { timeAgo } from "@/components/sidebar";
import { useServerEvent, useServerResync } from "@/components/server-events";
import { STATUS_LABEL, splitDisplayStatus } from "@/components/track-icons";
import { Hint } from "@/components/ui/hint";
import { cn } from "@/lib/utils";
import { buildsOnText, unlocksText, type TrackPartView, type TrackSessionView, type TrackView } from "@/src/core";

/**
 * THE TRACK OVERVIEW (docs/tracks.md §7.2, the approved mockup): header
 * (kicker TRACK, serif title, the "N OF M DONE" pill, ASK LH TO RE-PLAN), the
 * goal sentence, the TRACK MAP with its legend, the SELECTED PART panel, and
 * the TRACK LOG. Live through the events channel: the tracks ledger, turn
 * lifecycle and chat-list writes all refetch the view (notify → fetch).
 *
 * The page's first paint is the server's view (app/track/[id]/page.tsx);
 * everything here is a pure render of the view plus three actions (start a
 * part, practice a part, ask for a re-plan), each a POST + navigation.
 */

/** The initial selection: the part in progress, else the first ready one,
 *  else the track node. Pure, exported for tests. */
export function defaultSelection(view: Pick<TrackView, "parts">): string | null {
	const leaf = (p: TrackPartView) => p.status !== "split";
	return (
		view.parts.find((p) => leaf(p) && p.status === "in-progress")?.id ??
		view.parts.find((p) => leaf(p) && p.status === "ready")?.id ??
		null
	);
}

/** "3 done · 1 in progress · 2 ready · 2 later" over the top-level parts. */
export function progressText(view: Pick<TrackView, "parts">): string {
	const counts = { done: 0, "in-progress": 0, ready: 0, later: 0 };
	for (const p of view.parts) {
		if (p.parentPartId !== undefined) continue;
		const status = p.status === "split" ? splitDisplayStatus(p, view.parts) : p.status;
		counts[status]++;
	}
	return `${counts.done} done · ${counts["in-progress"]} in progress · ${counts.ready} ready · ${counts.later} later`;
}

/** A session row's meta line. */
export function sessionMetaText(session: TrackSessionView, now = new Date()): string {
	if (session.busy) return "Working…";
	if (session.kind === "teaching" && session.doneAt) return `Done · ${timeAgo(session.doneAt, now)}`;
	if (session.pendingQuestion) return `Waiting for your answer · ${timeAgo(session.updatedAt, now)}`;
	if (session.pendingProblem) return `Problem waiting · ${timeAgo(session.updatedAt, now)}`;
	return timeAgo(session.updatedAt, now);
}

/** The split note: "LH split this into 5a and 5b after part 2: <note>". */
export function splitNote(part: TrackPartView, view: Pick<TrackView, "replans" | "parts">): string | null {
	if (part.children.length === 0) return null;
	const replan = view.replans.find((r) => r.parts.some((p) => p.parentPartId === part.id));
	const kids = part.children.map((id) => view.parts.find((p) => p.id === id)?.number ?? id);
	const into = kids.length === 1 ? kids[0] : `${kids.slice(0, -1).join(", ")} and ${kids[kids.length - 1]}`;
	if (!replan) return `LH split this into ${into}.`;
	const after = replan.afterPartId ? view.parts.find((p) => p.id === replan.afterPartId) : null;
	return `LH split this into ${into}${after ? ` after part ${after.number}` : ""}: ${replan.note}`;
}

const KICKER = "font-ui text-[11px] uppercase tracking-[0.08em] text-muted-foreground";

export function TrackOverview({ initial, initialPartId }: { initial: TrackView; initialPartId: string | null }) {
	const router = useRouter();
	const [view, setView] = useState(initial);
	const [selected, setSelected] = useState<string | null>(() =>
		initialPartId && initial.parts.some((p) => p.id === initialPartId) ? initialPartId : defaultSelection(initial),
	);
	const [busyAction, setBusyAction] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [now, setNow] = useState(() => new Date());

	// The clock for the log's "2D AGO" stamps — once a minute is plenty.
	useEffect(() => {
		const id = setInterval(() => setNow(new Date()), 60_000);
		return () => clearInterval(id);
	}, []);

	// PUSH (architecture §10): the view refetches on every event that can
	// move it — the ledger, any turn (a part_done lands in a turn), the chat
	// list (a session renamed or deleted). Trailing debounce, one fetch.
	const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const refresh = useCallback(async () => {
		try {
			const res = await fetch(`/api/tracks/${encodeURIComponent(initial.id)}`, { cache: "no-store" });
			if (res.status === 404) {
				router.push("/");
				return;
			}
			if (!res.ok) return;
			const body = (await res.json()) as { track: TrackView };
			setView(body.track);
		} catch {
			/* transient — the next event refetches */
		}
	}, [initial.id, router]);
	const schedule = () => {
		if (debounceRef.current) clearTimeout(debounceRef.current);
		debounceRef.current = setTimeout(() => {
			debounceRef.current = undefined;
			void refresh();
		}, 250);
	};
	useServerEvent("tracks-changed", schedule);
	useServerEvent("turn-started", schedule);
	useServerEvent("turn-settled", schedule);
	useServerEvent("chats-changed", schedule);
	useServerResync(() => void refresh());
	useEffect(
		() => () => {
			if (debounceRef.current) clearTimeout(debounceRef.current);
		},
		[],
	);

	// A selected part that a re-plan dropped falls back to the default.
	useEffect(() => {
		if (selected && !view.parts.some((p) => p.id === selected)) setSelected(defaultSelection(view));
	}, [view, selected]);

	// The selection rides the URL (the sidebar's part rows deep-link here).
	useEffect(() => {
		const url = selected ? `/track/${encodeURIComponent(view.id)}?part=${encodeURIComponent(selected)}` : `/track/${encodeURIComponent(view.id)}`;
		if (typeof window !== "undefined" && window.location.pathname + window.location.search !== url) {
			window.history.replaceState(null, "", url);
		}
	}, [selected, view.id]);

	const post = useCallback(
		async (key: string, url: string, onDone: (body: Record<string, unknown>) => void) => {
			if (busyAction) return;
			setBusyAction(key);
			setError(null);
			try {
				const res = await fetch(url, { method: "POST" });
				const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
				if (!res.ok) {
					setError(typeof body.error === "string" ? body.error : `The request failed (${res.status}).`);
					return;
				}
				onDone(body);
			} catch {
				setError("The request failed — network error.");
			} finally {
				setBusyAction(null);
			}
		},
		[busyAction],
	);
	const startPart = (partId: string) =>
		void post(`start:${partId}`, `/api/tracks/${encodeURIComponent(view.id)}/parts/${encodeURIComponent(partId)}/start`, (body) => {
			if (typeof body.chatId === "string") router.push(`/chat/${encodeURIComponent(body.chatId)}`);
		});
	const practicePart = (partId: string) =>
		void post(`practice:${partId}`, `/api/tracks/${encodeURIComponent(view.id)}/parts/${encodeURIComponent(partId)}/practice`, (body) => {
			if (typeof body.chatId === "string") router.push(`/chat/${encodeURIComponent(body.chatId)}`);
		});
	const replan = () =>
		void post("replan", `/api/tracks/${encodeURIComponent(view.id)}/replan`, (body) => {
			const id = typeof body.planningChatId === "string" ? body.planningChatId : view.planningChatId;
			router.push(`/chat/${encodeURIComponent(id)}`);
		});

	return (
		<TrackOverviewBody
			view={view}
			selected={selected}
			onSelect={setSelected}
			busyAction={busyAction}
			error={error}
			now={now}
			onStartPart={startPart}
			onPractice={practicePart}
			onReplan={replan}
		/>
	);
}

/** The overview's pure body — exported for SSR pins (the DraftShell
 *  pattern): every input is data or a callback; the wrapper owns state,
 *  the events channel, the router and the three POSTs. */
export function TrackOverviewBody({
	view,
	selected,
	onSelect,
	busyAction,
	error,
	now,
	onStartPart,
	onPractice,
	onReplan,
}: {
	view: TrackView;
	selected: string | null;
	onSelect: (partId: string | null) => void;
	busyAction: string | null;
	error: string | null;
	now: Date;
	onStartPart: (partId: string) => void;
	onPractice: (partId: string) => void;
	onReplan: () => void;
}) {
	const part = useMemo(() => (selected ? view.parts.find((p) => p.id === selected) ?? null : null), [view, selected]);
	const log = useMemo(() => [...view.log].reverse(), [view.log]);
	const setSelected = onSelect;
	const startPart = onStartPart;
	const practicePart = onPractice;
	const replan = onReplan;

	return (
		<div className="flex h-dvh flex-col">
			<TopBar>
				<div className="flex min-w-0 flex-col justify-center">
					<span className={KICKER}>Track</span>
					<h1 className="truncate font-title text-2xl tracking-tight" data-testid="track-title">
						{view.title}
					</h1>
				</div>
				<div className="min-w-4 flex-1" aria-hidden="true" />
				<span
					data-testid="track-progress"
					className="shrink-0 rounded-full border border-border px-3 py-1 font-ui text-[11px] uppercase tracking-[0.08em] text-foreground/80"
				>
					{view.progress.done} of {view.progress.total} done
				</span>
				<Hint label="Open this track's nodes in the graph" side="bottom">
					<Link
						href={`/?track=${encodeURIComponent(view.id)}`}
						data-testid="track-graph-link"
						className="flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-border px-3 font-ui text-[11px] uppercase tracking-[0.08em] text-muted-foreground transition-colors hover:border-muted-foreground/60 hover:text-foreground"
					>
						<WaypointsIcon className="size-3" aria-hidden="true" />
						Graph
					</Link>
				</Hint>
				<button
					type="button"
					data-testid="track-replan"
					onClick={replan}
					disabled={busyAction !== null}
					className="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-border px-3 font-ui text-[11px] uppercase tracking-[0.08em] text-foreground transition-colors hover:border-muted-foreground/60 hover:bg-accent disabled:opacity-50"
				>
					<RefreshCwIcon className={cn("size-3", busyAction === "replan" && "animate-spin")} aria-hidden="true" />
					Ask LH to re-plan
				</button>
			</TopBar>

			<div className="min-h-0 flex-1 overflow-y-auto">
				<p className="max-w-[920px] px-8 pt-5 font-prose text-[17px] leading-[1.45] text-foreground/75" data-testid="track-goal">
					Goal: {view.goal}
				</p>
				{error && (
					<div role="alert" className="mx-8 mt-3 rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm">
						{error}
					</div>
				)}

				<div className="flex flex-wrap items-start gap-6 px-8 pb-6 pt-5">
					{/* THE TRACK MAP */}
					<section aria-label="Track map" className="min-w-0 flex-[999_1_560px] rounded-xl border bg-card/60">
						<div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
							<h2 className="font-ui text-[11px] font-medium uppercase tracking-[0.08em] text-foreground/80">Track map</h2>
							<div className="flex flex-wrap gap-3.5 font-ui text-[10.5px] uppercase tracking-[0.06em] text-muted-foreground">
								<span className="flex items-center gap-1.5">
									<span className="h-2.5 w-4 rounded-[3px] border border-border bg-card" />
									Done
								</span>
								<span className="flex items-center gap-1.5">
									<span className="h-2.5 w-4 rounded-[3px] border-2" style={{ borderColor: "var(--lh-track-accent)" }} />
									In progress
								</span>
								<span className="flex items-center gap-1.5">
									<span className="h-2.5 w-4 rounded-[3px] border border-muted-foreground" />
									Ready
								</span>
								<span className="flex items-center gap-1.5">
									<span className="h-2.5 w-4 rounded-[3px] border border-dashed border-border" />
									Later
								</span>
							</div>
						</div>
						<div className="overflow-x-auto p-4">
							<TrackMap parts={view.parts} selectedId={selected} onSelect={(id) => setSelected(id)} className="mx-auto block h-auto w-full" />
						</div>
						<div className="border-t border-border px-4 py-2">
							<button
								type="button"
								data-testid="track-select-track"
								onClick={() => setSelected(null)}
								className={cn(
									"font-ui text-[11px] uppercase tracking-[0.08em] transition-colors hover:text-foreground",
									selected === null ? "text-foreground" : "text-muted-foreground",
								)}
							>
								The whole track
							</button>
						</div>
					</section>

					{/* THE SELECTED PART */}
					<aside aria-label="Selected part" className="flex min-w-0 flex-[1_1_300px] flex-col gap-4 rounded-xl border bg-card/60 p-5" data-testid="track-part-panel">
						{part ? (
							<PartPanel
								view={view}
								part={part}
								now={now}
								busy={busyAction}
								onStart={() => startPart(part.id)}
								onPractice={() => practicePart(part.id)}
								onSelect={setSelected}
							/>
						) : (
							<TrackPanel view={view} now={now} onSelect={setSelected} onStart={startPart} busy={busyAction} />
						)}
					</aside>
				</div>

				{/* THE TRACK LOG */}
				<section aria-label="Track log" className="mx-8 mb-8 flex flex-col gap-2.5 rounded-xl border px-5 py-4" data-testid="track-log">
					<h2 className="font-ui text-[11px] font-medium uppercase tracking-[0.08em] text-foreground/80">Track log</h2>
					<ul className="m-0 flex list-none flex-col gap-2 p-0 font-prose text-[15px] text-foreground/85">
						{log.map((entry, i) => (
							<li key={`${entry.at}-${entry.kind}-${i}`} className="flex items-baseline gap-4">
								<span className="w-[76px] shrink-0 font-ui text-[11px] uppercase text-muted-foreground">{timeAgo(entry.at, now)}</span>
								<span>{entry.text}</span>
							</li>
						))}
					</ul>
				</section>
			</div>
		</div>
	);
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex flex-col gap-1.5">
			<h3 className={cn("m-0 font-normal", KICKER)}>{label}</h3>
			<div className="font-prose text-[15px] leading-[1.45] text-foreground/90">{children}</div>
		</div>
	);
}

function SessionRows({ sessions, now }: { sessions: TrackSessionView[]; now: Date }) {
	if (sessions.length === 0) return <p className="m-0 font-prose text-[15px] text-muted-foreground">No sessions yet.</p>;
	return (
		<div className="flex flex-col rounded-lg border border-border">
			{sessions.map((s) => (
				<Link
					key={s.id}
					href={`/chat/${encodeURIComponent(s.id)}`}
					data-testid={`track-session-${s.id}`}
					className="flex items-baseline justify-between gap-3 border-b border-border/60 px-3 py-2.5 text-foreground no-underline transition-colors last:border-b-0 hover:bg-accent/60"
				>
					<span className="flex items-center gap-1.5 font-prose text-[15px]">
						{s.kind === "practice" && <DumbbellIcon className="size-3 text-muted-foreground" aria-hidden="true" />}
						{s.kind === "teaching" ? "Teaching" : s.kind === "practice" ? "Practice" : "Planning"}
					</span>
					<span className="text-right font-ui text-[11px] text-muted-foreground">{sessionMetaText(s, now)}</span>
				</Link>
			))}
		</div>
	);
}

const PRIMARY =
	"inline-flex w-fit items-center gap-1.5 rounded-lg bg-primary px-4 py-2.5 font-ui text-[13px] text-primary-foreground no-underline transition-opacity hover:opacity-90 disabled:opacity-50";
const SECONDARY =
	"inline-flex w-fit items-center gap-1.5 rounded-lg border border-border px-4 py-2.5 font-ui text-[13px] text-foreground no-underline transition-colors hover:bg-accent disabled:opacity-50";

function PartPanel({
	view,
	part,
	now,
	busy,
	onStart,
	onPractice,
	onSelect,
}: {
	view: TrackView;
	part: TrackPartView;
	now: Date;
	busy: string | null;
	onStart: () => void;
	onPractice: () => void;
	onSelect: (id: string) => void;
}) {
	const display = part.status === "split" ? splitDisplayStatus(part, view.parts) : part.status;
	const kicker =
		part.status === "split"
			? `Part ${part.number} · split into ${part.children.map((id) => view.parts.find((p) => p.id === id)?.number ?? id).join(" and ")}`
			: `Part ${part.number} · ${STATUS_LABEL[part.status]}`;
	const sessions: TrackSessionView[] = [...(part.teaching ? [part.teaching] : []), ...part.practice];
	const note = splitNote(part, view);
	return (
		<>
			<div className="flex flex-col gap-1.5">
				<p className={cn("m-0", KICKER)} style={display === "in-progress" ? { color: "var(--lh-track-accent)" } : display === "ready" ? { color: "var(--foreground)" } : undefined} data-testid="part-kicker">
					{kicker}
				</p>
				<h2 className="m-0 font-title text-2xl leading-[1.15] tracking-tight" data-testid="part-title">
					{part.title}
				</h2>
			</div>
			<Field label="Why this part">{part.why}</Field>
			<Field label="Builds on">{buildsOnText(part, view.parts)}</Field>
			{part.status === "split" ? (
				<Field label="Sub-parts">
					<div className="flex flex-col gap-1">
						{part.children.map((id) => {
							const child = view.parts.find((p) => p.id === id);
							if (!child) return null;
							return (
								<button key={id} type="button" onClick={() => onSelect(id)} className="flex items-baseline gap-2.5 text-left hover:text-foreground">
									<span className="font-ui text-[11px] text-muted-foreground">{child.number}</span>
									<span>{child.title}</span>
									<span className="ml-auto font-ui text-[10.5px] uppercase tracking-[0.06em] text-muted-foreground">{STATUS_LABEL[child.status]}</span>
								</button>
							);
						})}
					</div>
				</Field>
			) : (
				<Field label="Sessions">
					<SessionRows sessions={sessions} now={now} />
				</Field>
			)}
			{part.summary && (
				<Field label="What it established">
					{part.summary}
					{part.shaky && <span className="block pt-1 text-muted-foreground">Shaky: {part.shaky}</span>}
				</Field>
			)}
			{note && (
				<p className="m-0 rounded-lg border border-border px-3 py-2.5 font-prose text-[15px] leading-[1.45] text-foreground/75" data-testid="part-note">
					{note}
				</p>
			)}
			<div className="flex flex-wrap gap-2 pt-1">
				{part.status === "ready" && (
					<button type="button" data-testid="part-start" onClick={onStart} disabled={busy !== null} className={PRIMARY}>
						{busy === `start:${part.id}` ? "Starting…" : `Start part ${part.number}`}
					</button>
				)}
				{part.status === "in-progress" && part.teaching && (
					<Link href={`/chat/${encodeURIComponent(part.teaching.id)}`} data-testid="part-continue" className={PRIMARY}>
						Continue session
					</Link>
				)}
				{part.status === "done" && part.teaching && (
					<Link href={`/chat/${encodeURIComponent(part.teaching.id)}`} data-testid="part-open" className={PRIMARY}>
						Open teaching session
					</Link>
				)}
				{part.teaching && (
					<button type="button" data-testid="part-practice" onClick={onPractice} disabled={busy !== null} className={SECONDARY}>
						<DumbbellIcon className="size-3.5" aria-hidden="true" />
						{busy === `practice:${part.id}` ? "Starting…" : "Practice this part"}
					</button>
				)}
			</div>
			{part.status === "later" && (
				<p className="m-0 font-ui text-xs text-muted-foreground" data-testid="part-locked">
					{unlocksText(part, view.parts)}
				</p>
			)}
		</>
	);
}

function TrackPanel({
	view,
	now,
	onSelect,
	onStart,
	busy,
}: {
	view: TrackView;
	now: Date;
	onSelect: (id: string) => void;
	onStart: (partId: string) => void;
	busy: string | null;
}) {
	const current = view.parts.find((p) => p.status === "in-progress");
	const ready = view.parts.filter((p) => p.status === "ready");
	const replans = view.replans.length;
	return (
		<>
			<div className="flex flex-col gap-1.5">
				<p className={cn("m-0", KICKER)} data-testid="part-kicker">
					Track · {view.progress.total} part{view.progress.total === 1 ? "" : "s"}
				</p>
				<h2 className="m-0 font-title text-2xl leading-[1.15] tracking-tight">{view.title}</h2>
			</div>
			<Field label="Goal">{view.goal}</Field>
			<Field label="Progress">{progressText(view)}</Field>
			<Field label="Sessions">
				{view.planning ? (
					<div className="flex flex-col rounded-lg border border-border">
						<Link
							href={`/chat/${encodeURIComponent(view.planning.id)}`}
							data-testid="track-planning-session"
							className="flex items-baseline justify-between gap-3 px-3 py-2.5 text-foreground no-underline transition-colors hover:bg-accent/60"
						>
							<span className="font-prose text-[15px]">Planning</span>
							<span className="text-right font-ui text-[11px] text-muted-foreground">
								placement probe{replans > 0 ? ` · ${replans} re-plan${replans === 1 ? "" : "s"}` : ""}
							</span>
						</Link>
					</div>
				) : (
					<p className="m-0 font-prose text-[15px] text-muted-foreground">The planning session is gone.</p>
				)}
			</Field>
			{view.leftOut && <Field label="Left out, per your brief">{view.leftOut}</Field>}
			<div className="flex flex-wrap gap-2 pt-1">
				{current?.teaching ? (
					<Link href={`/chat/${encodeURIComponent(current.teaching.id)}`} className={PRIMARY} data-testid="track-continue">
						Continue part {current.number}
					</Link>
				) : ready[0] ? (
					<button type="button" className={PRIMARY} data-testid="track-start-first" disabled={busy !== null} onClick={() => onStart(ready[0]!.id)}>
						Start part {ready[0].number}
					</button>
				) : null}
				{ready.slice(current ? 0 : 1).map((p) => (
					<button key={p.id} type="button" className={SECONDARY} onClick={() => onSelect(p.id)}>
						Part {p.number} is ready
						<ArrowUpRightIcon className="size-3.5" aria-hidden="true" />
					</button>
				))}
			</div>
		</>
	);
}
