/**
 * Tracks — the pure core (docs/tracks.md): the ledger fold, part numbering,
 * the planner's structural rules, the derived view (statuses, progress, the
 * log), the native-record scans (the proposal, part_done), the part chat's
 * context block, and the sidebar tree.
 *
 * Nothing here stores state: the ledger (contracts/track.ts TrackEvent) is
 * the evidence, the chat records are the other evidence, and every function
 * recomputes from them. Browser-safe — the shell derives sidebar rows and
 * dependency labels from the same code the server derives views with.
 */

import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { ChatListItem } from "./contracts/chat.ts";
import type {
	ChatTrackContext,
	PartDoneFacts,
	ProposeTrackInput,
	TrackChatFacts,
	TrackEvent,
	TrackLogEntry,
	TrackPart,
	TrackPartSpec,
	TrackPartStatus,
	TrackPartView,
	TrackRecord,
	TrackSessionView,
	TrackView,
} from "./contracts/track.ts";
import { PART_SLUG_RE } from "./contracts/track.ts";
import type { LhMessage } from "./native-messages.ts";
import { createTree, PlanTreeError } from "./plan-tree.ts";
import { parsePartDoneInput, parseProposeTrackInput } from "./tool-parts.ts";

// ─── the fold: ledger events → track records ─────────────────────────────────

/** Fold the ledger into the live track records, append order. A `deleted`
 *  tombstone drops its track; events for unknown tracks are ignored (a torn
 *  ledger never guesses). */
export function foldTracks(events: readonly TrackEvent[]): TrackRecord[] {
	const records = new Map<string, TrackRecord>();
	for (const event of events) {
		if (event.type === "created") {
			records.set(event.trackId, {
				id: event.trackId,
				title: event.title,
				goal: event.goal,
				brief: event.brief,
				explanation: event.explanation,
				findings: [...event.findings],
				leftOut: event.leftOut,
				planningChatId: event.planningChatId,
				createdAt: event.at,
				updatedAt: event.at,
				parts: event.parts.map((p) => ({ ...p, dependsOn: [...p.dependsOn], teachingChatId: null, practiceChatIds: [] })),
				createdParts: event.parts.map((p) => ({ ...p, dependsOn: [...p.dependsOn] })),
				replans: [],
				starts: [],
			});
			continue;
		}
		const record = records.get(event.trackId);
		if (!record) continue;
		record.updatedAt = event.at;
		switch (event.type) {
			case "replanned": {
				// The new list replaces the old; chats stay attached by part id —
				// a started part keeps its id by the planner's rules.
				const chats = new Map(record.parts.map((p) => [p.id, p]));
				record.parts = event.parts.map((p) => {
					const prev = chats.get(p.id);
					return {
						...p,
						dependsOn: [...p.dependsOn],
						teachingChatId: prev?.teachingChatId ?? null,
						practiceChatIds: prev ? [...prev.practiceChatIds] : [],
					};
				});
				record.replans.push({ at: event.at, afterPartId: event.afterPartId, note: event.note, parts: event.parts.map((p) => ({ ...p })) });
				break;
			}
			case "part-started": {
				const part = record.parts.find((p) => p.id === event.partId);
				if (part) part.teachingChatId = event.chatId;
				record.starts.push({ at: event.at, partId: event.partId, chatId: event.chatId, kind: "teaching" });
				break;
			}
			case "practice-attached": {
				const part = record.parts.find((p) => p.id === event.partId);
				if (part && !part.practiceChatIds.includes(event.chatId)) part.practiceChatIds.push(event.chatId);
				record.starts.push({ at: event.at, partId: event.partId, chatId: event.chatId, kind: "practice" });
				break;
			}
			case "renamed":
				record.title = event.title;
				break;
			case "deleted":
				records.delete(event.trackId);
				break;
		}
	}
	return [...records.values()];
}

/** Every chat a track owns: the planning chat, then the parts' teaching and
 *  practice chats in part order. */
export function trackChatIds(record: Pick<TrackRecord, "planningChatId" | "parts">): string[] {
	const out = [record.planningChatId];
	for (const part of record.parts) {
		if (part.teachingChatId) out.push(part.teachingChatId);
		out.push(...part.practiceChatIds);
	}
	return out;
}

// ─── numbering: assigned by the system, once ─────────────────────────────────

/** A planner-authored part before the system numbers it. */
export type PartInput = Omit<TrackPartSpec, "number">;

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

/** Assign display numbers: parts the previous list knew keep theirs; new
 *  top-level parts take the next integers in list order; new sub-parts take
 *  their parent's number plus the next free letter in list order. Pure. */
export function assignPartNumbers(previous: readonly TrackPartSpec[], next: readonly PartInput[]): TrackPartSpec[] {
	const known = new Map(previous.map((p) => [p.id, p.number]));
	const numbered = new Map<string, string>();
	// Top-level first: integers.
	let maxInt = 0;
	for (const p of previous) {
		if (!p.parentPartId) maxInt = Math.max(maxInt, Number.parseInt(p.number, 10) || 0);
	}
	for (const p of next) {
		if (p.parentPartId) continue;
		const kept = known.get(p.id);
		if (kept !== undefined && !previous.find((q) => q.id === p.id)?.parentPartId) {
			numbered.set(p.id, kept);
			maxInt = Math.max(maxInt, Number.parseInt(kept, 10) || 0);
		}
	}
	for (const p of next) {
		if (p.parentPartId || numbered.has(p.id)) continue;
		maxInt += 1;
		numbered.set(p.id, String(maxInt));
	}
	// Then children: parent number + letter.
	const usedLetters = new Map<string, Set<string>>();
	for (const p of next) {
		if (!p.parentPartId) continue;
		const kept = known.get(p.id);
		const prev = previous.find((q) => q.id === p.id);
		if (kept !== undefined && prev?.parentPartId === p.parentPartId) {
			numbered.set(p.id, kept);
			const letters = usedLetters.get(p.parentPartId) ?? new Set<string>();
			letters.add(kept.slice(-1));
			usedLetters.set(p.parentPartId, letters);
		}
	}
	for (const p of next) {
		if (!p.parentPartId || numbered.has(p.id)) continue;
		const parentNumber = numbered.get(p.parentPartId) ?? known.get(p.parentPartId) ?? "?";
		const letters = usedLetters.get(p.parentPartId) ?? new Set<string>();
		let letter = "a";
		for (const candidate of LETTERS) {
			if (!letters.has(candidate)) {
				letter = candidate;
				break;
			}
		}
		letters.add(letter);
		usedLetters.set(p.parentPartId, letters);
		numbered.set(p.id, `${parentNumber}${letter}`);
	}
	return next.map((p) => ({ ...p, dependsOn: [...p.dependsOn], number: numbered.get(p.id) ?? "?" }));
}

// ─── the planner's structural rules ──────────────────────────────────────────

/** What a re-plan is validated against: the current parts (with their chats)
 *  and which of them are done. Null for the first proposal. */
export interface PreviousParts {
	parts: readonly TrackPart[];
	done: ReadonlySet<string>;
}

/** Every problem with a proposed parts list, written for the agent (the
 *  plan-tree error style — it flows back as the tool's error). Empty = valid. */
export function validateParts(next: readonly PartInput[], previous: PreviousParts | null): string[] {
	const problems: string[] = [];
	if (next.length === 0) return ["The parts list is empty — a track needs at least one part."];
	const ids = new Set<string>();
	for (const p of next) {
		if (!PART_SLUG_RE.test(p.id)) problems.push(`Part id "${p.id}" is not a slug (lowercase a-z, 0-9, hyphens/underscores).`);
		if (ids.has(p.id)) problems.push(`Duplicate part id "${p.id}" — ids must be unique.`);
		ids.add(p.id);
		if (p.title.trim() === "") problems.push(`Part "${p.id}" needs a title.`);
		if (p.why.trim() === "") problems.push(`Part "${p.id}" needs a why — the reason it exists for the end goal.`);
	}
	const byId = new Map(next.map((p) => [p.id, p]));
	for (const p of next) {
		for (const dep of p.dependsOn) {
			if (!byId.has(dep)) problems.push(`Part "${p.id}" depends on unknown part "${dep}".`);
			if (dep === p.id) problems.push(`Part "${p.id}" depends on itself.`);
		}
		if (p.parentPartId !== undefined) {
			const parent = byId.get(p.parentPartId);
			if (!parent) problems.push(`Part "${p.id}" names unknown parent "${p.parentPartId}".`);
			else {
				if (parent.id === p.id) problems.push(`Part "${p.id}" is its own parent.`);
				if (parent.parentPartId !== undefined) problems.push(`Part "${p.id}" nests under "${parent.id}", which is itself a sub-part — splits go one level deep.`);
				if (p.dependsOn.includes(parent.id)) problems.push(`Sub-part "${p.id}" depends on its own parent "${parent.id}" — a split part is its children; depend on sibling sub-parts instead.`);
			}
		}
	}
	const parents = new Set(next.filter((p) => p.parentPartId !== undefined).map((p) => p.parentPartId!));
	if (next.every((p) => parents.has(p.id))) problems.push("Every part is split — at least one part must be a leaf that can be taught.");
	// The DAG rule over dependsOn — plan-tree's validator, verbatim messages
	// (only when the endpoints resolve: a dangling id is already reported).
	if (problems.length === 0) {
		try {
			createTree(
				next.map((p) => ({ id: p.id, title: p.title || p.id })),
				next.flatMap((p) => p.dependsOn.map((dep) => ({ from: dep, to: p.id }))),
			);
		} catch (err) {
			if (err instanceof PlanTreeError) problems.push(err.message);
			else throw err;
		}
	}
	// The started-part rules run regardless of the above — a dropped part
	// that other parts still name must read as "cannot be dropped", not only
	// as their dangling dependency.
	if (previous) {
		for (const prev of previous.parts) {
			const started = prev.teachingChatId !== null || prev.practiceChatIds.length > 0;
			const isDone = previous.done.has(prev.id);
			if (!started && !isDone) continue;
			const label = `${prev.number} · ${prev.title}`;
			const kept = byId.get(prev.id);
			if (!kept) {
				problems.push(`Part ${label} (id "${prev.id}") has a session — it cannot be dropped. Keep it in the list.`);
				continue;
			}
			if ((kept.parentPartId ?? undefined) !== (prev.parentPartId ?? undefined)) {
				problems.push(`Part ${label} (id "${prev.id}") has a session — it cannot be moved under another part.`);
			}
			if (parents.has(prev.id)) {
				problems.push(`Part ${label} (id "${prev.id}") has a session — it cannot be split. Finish it, or add the missing ground as a NEW part it leads into.`);
			}
		}
	}
	return problems;
}

// ─── the derived view ────────────────────────────────────────────────────────

function sessionView(facts: TrackChatFacts, kind: TrackSessionView["kind"]): TrackSessionView {
	return {
		id: facts.id,
		title: facts.title,
		kind,
		updatedAt: facts.updatedAt,
		busy: facts.busy,
		pendingQuestion: facts.pendingQuestion,
		pendingProblem: facts.pendingProblem,
		phase: facts.phase,
		doneAt: facts.partDone?.at ?? null,
	};
}

/** The derived view: statuses, progress, log — recomputed on every read.
 *  `facts` answers for ONE chat id (null = the record is gone, which reads
 *  as never started: self-healing by construction). */
/**
 * Reading order: top-level parts as the planner listed them, each split
 * parent followed at once by its sub-parts — "5, 5a, 5b, 6, 7" wherever
 * parts are listed, whatever order the re-plan call named them in.
 */
export function canonicalPartOrder<T extends { id: string; parentPartId?: string }>(parts: readonly T[]): T[] {
	const out: T[] = [];
	for (const p of parts) {
		if (p.parentPartId !== undefined) continue;
		out.push(p, ...parts.filter((kid) => kid.parentPartId === p.id));
	}
	// A child whose parent is missing (never valid past validateParts) still shows.
	for (const p of parts) if (!out.includes(p)) out.push(p);
	return out;
}

export function deriveTrackView(record: TrackRecord, facts: (chatId: string) => TrackChatFacts | null): TrackView {
	const children = new Map<string, string[]>();
	for (const p of record.parts) {
		if (p.parentPartId === undefined) continue;
		const list = children.get(p.parentPartId) ?? [];
		list.push(p.id);
		children.set(p.parentPartId, list);
	}
	const teachingFacts = new Map<string, TrackChatFacts | null>();
	for (const p of record.parts) {
		if (p.teachingChatId) teachingFacts.set(p.id, facts(p.teachingChatId));
	}
	// done: a leaf with a clean part_done; a split parent when every child is.
	const doneMemo = new Map<string, boolean>();
	const isDone = (id: string, visiting = new Set<string>()): boolean => {
		const memo = doneMemo.get(id);
		if (memo !== undefined) return memo;
		if (visiting.has(id)) return false;
		visiting.add(id);
		const kids = children.get(id) ?? [];
		let done: boolean;
		if (kids.length > 0) done = kids.every((kid) => isDone(kid, visiting));
		else done = teachingFacts.get(id)?.partDone != null;
		visiting.delete(id);
		doneMemo.set(id, done);
		return done;
	};
	const statusOf = (p: TrackPart): TrackPartStatus => {
		if ((children.get(p.id) ?? []).length > 0) return "split";
		const chat = p.teachingChatId ? teachingFacts.get(p.id) ?? null : null;
		if (chat?.partDone) return "done";
		if (chat) return "in-progress";
		if (p.dependsOn.every((dep) => isDone(dep))) return "ready";
		return "later";
	};
	const parts: TrackPartView[] = canonicalPartOrder(record.parts).map((p) => {
		const chat = p.teachingChatId ? teachingFacts.get(p.id) ?? null : null;
		const started = record.starts.find((s) => s.partId === p.id && s.kind === "teaching" && s.chatId === p.teachingChatId);
		return {
			id: p.id,
			number: p.number,
			title: p.title,
			why: p.why,
			dependsOn: [...p.dependsOn],
			...(p.parentPartId !== undefined ? { parentPartId: p.parentPartId } : {}),
			status: statusOf(p),
			children: [...(children.get(p.id) ?? [])],
			teaching: chat ? sessionView(chat, "teaching") : null,
			practice: p.practiceChatIds
				.map((id) => facts(id))
				.filter((f): f is TrackChatFacts => f !== null)
				.map((f) => sessionView(f, "practice")),
			summary: chat?.partDone?.summary ?? null,
			shaky: chat?.partDone?.shaky ?? null,
			doneAt: chat?.partDone?.at ?? null,
			startedAt: chat ? (started?.at ?? chat.createdAt) : null,
		};
	});
	const topLevel = parts.filter((p) => p.parentPartId === undefined);
	const progress = { done: topLevel.filter((p) => isDone(p.id)).length, total: topLevel.length };
	const planningFacts = facts(record.planningChatId);
	const planning = planningFacts ? sessionView(planningFacts, "planning") : null;
	return {
		id: record.id,
		title: record.title,
		goal: record.goal,
		brief: record.brief,
		explanation: record.explanation,
		findings: [...record.findings],
		leftOut: record.leftOut,
		planningChatId: record.planningChatId,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		parts,
		replans: record.replans,
		progress,
		log: trackLog(record, parts),
		planning,
		chatIds: trackChatIds(record),
	};
}

/** The TRACK LOG, oldest first: created, the placement findings, part started,
 *  part done (from the chat's part_done stamp), re-planned, practice started. */
export function trackLog(record: TrackRecord, parts: readonly TrackPartView[]): TrackLogEntry[] {
	const out: TrackLogEntry[] = [{ at: record.createdAt, kind: "created", text: "Track created from your goal." }];
	for (const f of record.findings) {
		out.push({
			at: record.createdAt,
			kind: "finding",
			text: f.kind === "held" ? `Placement probe: you already hold ${lowerFirst(f.text)}` : `Placement probe: ${lowerFirst(f.text)}`,
		});
	}
	const numberOf = (partId: string): string => {
		const live = parts.find((p) => p.id === partId);
		if (live) return `${live.number} · ${live.title}`;
		for (const replan of [...record.replans].reverse()) {
			const old = replan.parts.find((p) => p.id === partId);
			if (old) return `${old.number} · ${old.title}`;
		}
		return partId;
	};
	for (const start of record.starts) {
		out.push(
			start.kind === "teaching"
				? { at: start.at, kind: "part-started", text: `Part ${numberOf(start.partId)} started.`, partId: start.partId }
				: { at: start.at, kind: "practice", text: `Practice session for part ${numberOf(start.partId)} started.`, partId: start.partId },
		);
	}
	for (const p of parts) {
		if (p.doneAt) out.push({ at: p.doneAt, kind: "part-done", text: `Part ${p.number} · ${p.title} done.`, partId: p.id });
	}
	let before: readonly TrackPartSpec[] = record.createdParts;
	for (const replan of record.replans) {
		const diff = describeReplan(before, replan.parts);
		const head = replan.afterPartId ? `Re-planned after part ${numberOf(replan.afterPartId)}:` : "Re-planned at your request:";
		out.push({
			at: replan.at,
			kind: "replanned",
			text: `${head} ${replan.note}${diff ? ` (${diff})` : ""}`,
			...(replan.afterPartId ? { partId: replan.afterPartId } : {}),
		});
		before = replan.parts;
	}
	return out.sort((a, b) => a.at.localeCompare(b.at));
}

function lowerFirst(text: string): string {
	return text.length > 0 ? text[0]!.toLowerCase() + text.slice(1) : text;
}

/** The structural diff of a re-plan, as a short clause: added, dropped,
 *  split. Empty when the lists carry the same ids and parents. */
export function describeReplan(before: readonly TrackPartSpec[], after: readonly TrackPartSpec[]): string {
	const beforeIds = new Map(before.map((p) => [p.id, p]));
	const afterIds = new Map(after.map((p) => [p.id, p]));
	const label = (p: TrackPartSpec) => `${p.number} · ${p.title}`;
	// Added: a new top-level part, or a new sub-part under a part that was
	// ALREADY split (a first split is reported as the split itself).
	const added = after.filter(
		(p) => !beforeIds.has(p.id) && (p.parentPartId === undefined || before.some((k) => k.parentPartId === p.parentPartId)),
	);
	const dropped = before.filter((p) => !afterIds.has(p.id));
	const splits: string[] = [];
	for (const p of after) {
		const kids = after.filter((k) => k.parentPartId === p.id);
		if (kids.length === 0) continue;
		const hadKids = before.some((k) => k.parentPartId === p.id);
		if (!hadKids) splits.push(`split ${p.number} into ${kids.map((k) => k.number).join(", ")}`);
	}
	const clauses: string[] = [];
	if (splits.length > 0) clauses.push(...splits);
	if (added.length > 0) clauses.push(`added ${added.map(label).join(", ")}`);
	if (dropped.length > 0) clauses.push(`dropped ${dropped.map(label).join(", ")}`);
	return clauses.join("; ");
}

/** The proposal list's dependency label: START / AFTER 1 / AFTER 2 AND 4. */
export function dependencyLabel(part: Pick<TrackPartSpec, "dependsOn">, numberOf: (id: string) => string): string {
	if (part.dependsOn.length === 0) return "START";
	const numbers = part.dependsOn.map(numberOf);
	if (numbers.length === 1) return `AFTER ${numbers[0]}`;
	return `AFTER ${numbers.slice(0, -1).join(", ")} AND ${numbers[numbers.length - 1]}`;
}

/** "Parts 2 and 4, both done" — the selected-part panel's BUILDS ON line. */
export function buildsOnText(part: Pick<TrackPartView, "dependsOn">, parts: readonly TrackPartView[]): string {
	if (part.dependsOn.length === 0) return "Nothing, it's a starting point";
	const deps = part.dependsOn.map((id) => parts.find((p) => p.id === id)).filter((p): p is TrackPartView => p !== undefined);
	const numbers = deps.map((d) => d.number);
	const head = numbers.length === 1 ? `Part ${numbers[0]}` : `Parts ${numbers.slice(0, -1).join(", ")} and ${numbers[numbers.length - 1]}`;
	const doneCount = deps.filter((d) => d.status === "done").length;
	if (doneCount === deps.length) return deps.length === 1 ? `${head}, done` : `${head}, all done`;
	if (doneCount === 0) return head;
	return `${head} (${doneCount} of ${deps.length} done)`;
}

/** The locked part's line: "Unlocks when 5a is done." */
export function unlocksText(part: Pick<TrackPartView, "dependsOn">, parts: readonly TrackPartView[]): string {
	const waiting = part.dependsOn
		.map((id) => parts.find((p) => p.id === id))
		.filter((p): p is TrackPartView => p !== undefined && p.status !== "done")
		.map((p) => p.number);
	if (waiting.length === 0) return "Unlocks when its earlier parts are done.";
	if (waiting.length === 1) return `Unlocks when ${waiting[0]} is done.`;
	return `Unlocks when parts ${waiting.slice(0, -1).join(", ")} and ${waiting[waiting.length - 1]} are done.`;
}

// ─── native-record scans ─────────────────────────────────────────────────────

/** The ids of tool calls whose results are CLEAN (not errored). */
function cleanResults(messages: readonly LhMessage[]): Map<string, ToolResultMessage & { id: string }> {
	const out = new Map<string, ToolResultMessage & { id: string }>();
	for (const m of messages) {
		if ((m as { role?: string }).role !== "toolResult") continue;
		const result = m as ToolResultMessage & { id: string };
		if (!result.isError) out.set(result.toolCallId, result);
	}
	return out;
}

/** The latest clean `propose_track` call — THE proposal of a planning chat. */
export interface TrackProposal {
	callId: string;
	/** The proposing assistant message's stamp (ms). */
	at: number;
	input: ProposeTrackInput;
}

export function latestTrackProposal(messages: readonly LhMessage[]): TrackProposal | null {
	const clean = cleanResults(messages);
	let found: TrackProposal | null = null;
	for (const m of messages) {
		if ((m as { role?: string }).role !== "assistant") continue;
		const content = (m as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const block of content as Array<{ type?: string; id?: string; name?: string; arguments?: unknown }>) {
			if (block.type !== "toolCall" || block.name !== "propose_track" || !block.id || !clean.has(block.id)) continue;
			const input = parseProposeTrackInput(block.arguments);
			if (!input) continue;
			found = { callId: block.id, at: (m as { timestamp?: number }).timestamp ?? 0, input };
		}
	}
	return found;
}

/** The planning seam (chat-handler): any propose_track CALL in the record —
 *  clean or not — means the prober has proposed; the planner takes the chat.
 *  Mirrors hasProbeDone (a call, any state, is the seam). */
export function hasTrackProposal(messages: readonly LhMessage[]): boolean {
	for (const m of messages) {
		if ((m as { role?: string }).role !== "assistant") continue;
		const content = (m as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		if ((content as Array<{ type?: string; name?: string }>).some((b) => b.type === "toolCall" && b.name === "propose_track")) return true;
	}
	return false;
}

/** The clean `part_done` of a part chat: its stamp and summary. Null while in progress. */
export function partDoneOf(messages: readonly LhMessage[]): PartDoneFacts | null {
	const clean = cleanResults(messages);
	for (const m of messages) {
		if ((m as { role?: string }).role !== "assistant") continue;
		const content = (m as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const block of content as Array<{ type?: string; id?: string; name?: string; arguments?: unknown }>) {
			if (block.type !== "toolCall" || block.name !== "part_done" || !block.id) continue;
			const result = clean.get(block.id);
			if (!result) continue;
			const input = parsePartDoneInput(block.arguments);
			return {
				at: new Date(result.timestamp ?? (m as { timestamp?: number }).timestamp ?? 0).toISOString(),
				summary: input?.summary ?? "",
				shaky: input?.shaky ?? null,
			};
		}
	}
	return null;
}

/** Has a CLEAN part_done landed in the record? The tool's once-only gate:
 *  a refused call (error result) does not count, so the model may retry. */
export function hasPartDone(messages: readonly LhMessage[]): boolean {
	return partDoneOf(messages) !== null;
}

// ─── a chat's membership ─────────────────────────────────────────────────────

export interface TrackMembership {
	record: TrackRecord;
	role: ChatTrackContext["role"];
	/** The part this chat belongs to (teaching/practice roles). */
	part: TrackPart | null;
}

/** Which track a chat belongs to, and as what — the one search behind the
 *  chat page's context, the tools' gates and the sidebar's ownership. Null
 *  for a loose chat. */
export function membershipOf(records: readonly TrackRecord[], chatId: string): TrackMembership | null {
	for (const record of records) {
		if (record.planningChatId === chatId) return { record, role: "planning", part: null };
		for (const part of record.parts) {
			if (part.teachingChatId === chatId) return { record, role: "teaching", part };
			if (part.practiceChatIds.includes(chatId)) return { record, role: "practice", part };
		}
	}
	return null;
}

/** The chat page's context from a membership (ChatTrackContext). */
export function chatTrackContextOf(member: TrackMembership): ChatTrackContext {
	const { record, role, part } = member;
	return {
		trackId: record.id,
		trackTitle: record.title,
		planningChatId: record.planningChatId,
		role,
		partId: part?.id ?? null,
		partNumber: part?.number ?? null,
		partTitle: part?.title ?? null,
		totalParts: record.parts.filter((p) => p.parentPartId === undefined).length,
		parts: canonicalPartOrder(record.parts).map((p) => ({ id: p.id, number: p.number, title: p.title, teachingChatId: p.teachingChatId })),
	};
}

// ─── read_part: a part's teaching prose, windowed ────────────────────────────

/** One teacher passage: an assistant message's prose, by message id. */
export interface PartPassage {
	messageId: string;
	text: string;
}

/** The teacher's prose of a part chat, passage per assistant message (text
 *  blocks joined; tool calls, thinking and the learner's side dropped).
 *  Message ids ride along — the citation targets of part://<part>/<msg>. */
export function partPassages(messages: readonly LhMessage[]): PartPassage[] {
	const out: PartPassage[] = [];
	for (const m of messages) {
		if ((m as { role?: string }).role !== "assistant") continue;
		const content = (m as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		const text = (content as Array<{ type?: string; text?: string }>)
			.filter((b) => b.type === "text" && typeof b.text === "string")
			.map((b) => b.text!.trim())
			.filter(Boolean)
			.join("\n\n");
		if (text) out.push({ messageId: (m as { id?: string }).id ?? "", text });
	}
	return out;
}

/** The read_part window: ~4 chars per token. */
export const READ_PART_BUDGET_CHARS = 24_000;

/** A window of passages from `offset`, as the tool returns it: `TEACHER
 *  [msg] …` blocks under the budget, plus the continuation offset (null =
 *  that was the end). At least one passage always fits, however long. */
export function readPartWindow(
	passages: readonly PartPassage[],
	offset: number,
	budgetChars = READ_PART_BUDGET_CHARS,
): { text: string; nextOffset: number | null; total: number } {
	const start = Math.max(0, Math.min(offset, passages.length));
	const blocks: string[] = [];
	let used = 0;
	let i = start;
	for (; i < passages.length; i++) {
		const p = passages[i]!;
		const block = `TEACHER [${p.messageId}]\n${p.text}`;
		if (blocks.length > 0 && used + block.length > budgetChars) break;
		blocks.push(block);
		used += block.length;
	}
	return { text: blocks.join("\n\n---\n\n"), nextOffset: i < passages.length ? i : null, total: passages.length };
}

// ─── the part chat's context block ───────────────────────────────────────────

/** The model-facing [Track context] block (the marker's content). Written for
 *  the prober and teacher of a part chat — or the practice agent of a part's
 *  practice session. The brief rides whole: it is the learner's own words. */
export function trackContextText(args: {
	track: Pick<TrackView, "title" | "goal" | "brief" | "findings" | "parts" | "progress">;
	part: TrackPartView;
	role: "teaching" | "practice";
	/** Practice: the propositions the graph has born in the part's teaching
	 *  chat ("name: statement" lines). */
	propositions?: readonly string[];
}): string {
	const { track, part, role } = args;
	const byId = new Map(track.parts.map((p) => [p.id, p]));
	const leafDeps = (ids: readonly string[]): TrackPartView[] => {
		const out: TrackPartView[] = [];
		for (const id of ids) {
			const dep = byId.get(id);
			if (!dep) continue;
			if (dep.children.length > 0) out.push(...leafDeps(dep.children));
			else out.push(dep);
		}
		return out;
	};
	const deps = leafDeps(part.dependsOn);
	const depIds = new Set(deps.map((d) => d.id));
	const earlierDone = track.parts.filter((p) => p.status === "done" && !depIds.has(p.id) && p.id !== part.id && p.children.length === 0);
	const later = track.parts.filter((p) => p.status !== "done" && p.id !== part.id && p.children.length === 0 && p.parentPartId !== part.id);
	const lines: Array<string | null> = [];
	if (role === "teaching") {
		lines.push(
			`[Track context] — this session is part ${part.number} of ${track.progress.total} of the track "${track.title}".`,
			"",
			`END GOAL: ${track.goal}`,
			"",
			"THE LEARNER'S BRIEF (verbatim):",
			track.brief,
			"",
			`THIS PART — ${part.number} · ${part.title}`,
			`Why: ${part.why}`,
			"Teach exactly this part's goal as one full session — probe, plan, teach — and call part_done when it is held. Nothing from the later parts; nothing already held from the earlier ones.",
		);
	} else {
		lines.push(
			`[Track context] — this is a practice session for part ${part.number} · ${part.title} of the track "${track.title}".`,
			"",
			`END GOAL: ${track.goal}`,
			`THIS PART'S WHY: ${part.why}`,
			part.summary ? `WHAT THE TEACHING ESTABLISHED: ${part.summary}` : "The teaching session of this part is still in progress — practice what it has covered so far.",
			part.shaky ? `WHAT STAYED SHAKY: ${part.shaky}` : null,
		);
		if (args.propositions && args.propositions.length > 0) {
			lines.push("", "Propositions the graph holds from this part (practice material):", ...args.propositions.map((p) => `- ${p}`));
		}
	}
	if (deps.length > 0) {
		lines.push("", "BUILDS ON (done earlier in this track — take these summaries as held; re-probe only where this part needs more):");
		for (const dep of deps) {
			lines.push(`- Part ${dep.number} · ${dep.title} (part id ${dep.id}${dep.teaching ? `, session ${dep.teaching.id}` : ""})`);
			lines.push(`  Summary: ${dep.summary ?? "(no summary recorded)"}`);
			if (dep.shaky) lines.push(`  Shaky: ${dep.shaky}`);
		}
		lines.push("Use read_part with a part id to read an earlier part's exact passages, with message ids.");
	}
	if (earlierDone.length > 0) {
		lines.push("", `Also done earlier in the track: ${earlierDone.map((p) => `${p.number} · ${p.title}`).join("; ")}.`);
	}
	if (later.length > 0) {
		lines.push("", `LATER PARTS (not this session's job): ${later.map((p) => `${p.number} · ${p.title}`).join("; ")}.`);
	}
	if (track.findings.length > 0) {
		lines.push(
			"",
			"PLACEMENT PROBE FINDINGS (when the track was proposed):",
			...track.findings.map((f) => `- ${f.kind === "held" ? "already held" : "starts low"}: ${f.text}`),
		);
	}
	return lines.filter((l): l is string => l !== null).join("\n");
}

// ─── taught-in links ─────────────────────────────────────────────────────────

/** The teacher's citation link target: part://<partId>/<messageId>. */
export const PART_LINK_PREFIX = "part://";
/** The same link as the markdown pipeline carries it: a relative path. The
 *  renderer's three URL gates (react-markdown's urlTransform, rehype-
 *  sanitize's protocol schema, rehype-harden) all pass relative paths and
 *  all strip an unknown `part:` protocol, so the model-facing syntax is
 *  rewritten to this form at the renderer boundary (rewritePartLinks). */
export const PART_LINK_PATH = "/part/";

/** `[text](part://a/b)` → `[text](/part/a/b)` — applied to assistant prose
 *  before markdown parsing (the model writes the documented `part://`
 *  form; the pipeline sees a relative path it lets through). */
export function rewritePartLinks(markdown: string): string {
	return markdown.replaceAll(`](${PART_LINK_PREFIX}`, `](${PART_LINK_PATH}`);
}

/** Parse a part link in either form; null for anything else. The message id
 *  may be absent (a link to the part's session, not a passage). */
export function parsePartLink(href: string | undefined): { partId: string; messageId: string | null } | null {
	if (!href) return null;
	const prefix = href.startsWith(PART_LINK_PREFIX) ? PART_LINK_PREFIX : href.startsWith(PART_LINK_PATH) ? PART_LINK_PATH : null;
	if (!prefix) return null;
	const rest = href.slice(prefix.length);
	const slash = rest.indexOf("/");
	const partId = slash === -1 ? rest : rest.slice(0, slash);
	if (partId.length === 0) return null;
	const messageId = slash === -1 ? "" : rest.slice(slash + 1);
	return { partId, messageId: messageId.length > 0 ? decodeURIComponent(messageId) : null };
}

/** Where a part:// link lands: the part's teaching chat, at the message. */
export function partLinkHref(
	link: { partId: string; messageId: string | null },
	context: Pick<ChatTrackContext, "parts">,
): { href: string; label: string } | null {
	const part = context.parts.find((p) => p.id === link.partId);
	if (!part || !part.teachingChatId) return null;
	const anchor = link.messageId ? `#${encodeURIComponent(`message-${link.messageId}`)}` : "";
	return {
		href: `/chat/${encodeURIComponent(part.teachingChatId)}${anchor}`,
		label: `Taught in part ${part.number} · ${part.title}`,
	};
}

// ─── the sidebar tree ────────────────────────────────────────────────────────

export interface TrackTreeSession {
	session: TrackSessionView;
	/** The chat list's own row (liveness, meta); null when the list lacks it. */
	chat: ChatListItem | null;
}

export interface TrackTreePart {
	part: TrackPartView;
	children: TrackTreePart[];
	sessions: TrackTreeSession[];
}

export interface TrackTreeNode {
	track: TrackView;
	planning: ChatListItem | null;
	parts: TrackTreePart[];
	/** The newest activity across the track's chats — the sort key. */
	latestActivity: string;
}

export interface TrackTree {
	/** Tracks, most recently active first. */
	tracks: TrackTreeNode[];
	/** Chats no track owns (planning chats of unstarted proposals included —
	 *  the component styles those by `proposedTrack`). */
	loose: ChatListItem[];
}

/** Build the sidebar's tree: tracks (parts → sub-parts → sessions) and the
 *  loose chats. Pure; the component owns expansion and labels. */
export function trackTree(tracks: readonly TrackView[], chats: readonly ChatListItem[]): TrackTree {
	const byChat = new Map(chats.map((c) => [c.id, c]));
	const owned = new Set<string>();
	const nodes: TrackTreeNode[] = tracks.map((track) => {
		for (const id of track.chatIds) owned.add(id);
		const partNode = (part: TrackPartView): TrackTreePart => ({
			part,
			children: part.children
				.map((id) => track.parts.find((p) => p.id === id))
				.filter((p): p is TrackPartView => p !== undefined)
				.map(partNode),
			sessions: [
				...(part.teaching ? [{ session: part.teaching, chat: byChat.get(part.teaching.id) ?? null }] : []),
				...part.practice.map((s) => ({ session: s, chat: byChat.get(s.id) ?? null })),
			],
		});
		let latest = track.updatedAt;
		for (const id of track.chatIds) {
			const chat = byChat.get(id);
			if (chat && chat.updatedAt > latest) latest = chat.updatedAt;
		}
		return {
			track,
			planning: byChat.get(track.planningChatId) ?? null,
			parts: track.parts.filter((p) => p.parentPartId === undefined).map(partNode),
			latestActivity: latest,
		};
	});
	nodes.sort((a, b) => b.latestActivity.localeCompare(a.latestActivity));
	return { tracks: nodes, loose: chats.filter((c) => !owned.has(c.id)) };
}

/** The sidebar's flattened rows — the tree walked with the learner's
 *  expand/collapse state. Pure: labels and meta are the component's. */
export type SidebarTreeRow =
	| { kind: "track"; key: string; depth: number; node: TrackTreeNode; open: boolean }
	| { kind: "planning"; key: string; depth: number; node: TrackTreeNode; chat: ChatListItem | null }
	| { kind: "part"; key: string; depth: number; node: TrackTreeNode; part: TrackPartView; expandable: boolean; open: boolean }
	| { kind: "session"; key: string; depth: number; node: TrackTreeNode; part: TrackPartView; session: TrackSessionView; chat: ChatListItem | null }
	| { kind: "loose"; key: string; depth: number; chat: ChatListItem };

/** The persisted-open-state keys: `t:<trackId>` and `p:<trackId>:<partId>`. */
export function trackOpenKey(trackId: string): string {
	return `t:${trackId}`;
}
export function partOpenKey(trackId: string, partId: string): string {
	return `p:${trackId}:${partId}`;
}

/** A part's default expansion: open when it holds the active chat or a
 *  session in progress — the mockup's "current part expanded". */
function partDefaultOpen(part: TrackTreePart, activeChatId: string | null): boolean {
	if (part.sessions.some((s) => s.session.id === activeChatId)) return true;
	if (part.part.status === "in-progress") return true;
	return part.children.some((child) => partDefaultOpen(child, activeChatId));
}

export function flattenTrackTree(
	tree: TrackTree,
	opts: {
		/** The learner's stored choice for a key, or the given default. */
		isOpen: (key: string, fallback: boolean) => boolean;
		activeChatId: string | null;
		/** The track whose OVERVIEW is open (/track/<id>) — open by default too. */
		activeTrackId?: string | null;
		/** TEACHING hides practice sessions; PRACTICE shows nothing from here
		 *  (the component lists practice chats flat); ALL shows everything. */
		filter: "teach" | "practice" | "all";
	},
): SidebarTreeRow[] {
	const rows: SidebarTreeRow[] = [];
	if (opts.filter === "practice") return rows;
	for (const node of tree.tracks) {
		const trackKey = trackOpenKey(node.track.id);
		const active = node.track.chatIds.includes(opts.activeChatId ?? "") || node.track.id === (opts.activeTrackId ?? null);
		const open = opts.isOpen(trackKey, active || node.track.parts.some((p) => p.status === "in-progress"));
		rows.push({ kind: "track", key: trackKey, depth: 0, node, open });
		if (!open) continue;
		rows.push({ kind: "planning", key: `${trackKey}:planning`, depth: 1, node, chat: node.planning });
		const walk = (part: TrackTreePart, depth: number): void => {
			const key = partOpenKey(node.track.id, part.part.id);
			const sessions = part.sessions.filter((s) => opts.filter === "all" || s.session.kind !== "practice");
			const expandable = part.children.length > 0 || sessions.length > 0;
			const partOpen = expandable && opts.isOpen(key, partDefaultOpen(part, opts.activeChatId));
			rows.push({ kind: "part", key, depth, node, part: part.part, expandable, open: partOpen });
			if (!partOpen) return;
			for (const child of part.children) walk(child, depth + 1);
			for (const s of sessions) {
				rows.push({ kind: "session", key: `${key}:${s.session.id}`, depth: depth + 1, node, part: part.part, session: s.session, chat: s.chat });
			}
		};
		for (const part of node.parts) walk(part, 1);
	}
	return rows;
}
