/**
 * THE TRACK SERVICE (docs/tracks.md) — the sole writer of the tracks ledger
 * and the one place a track's chats are born, attached and deleted.
 *
 *   trackRecords / listTrackViews / getTrackView — the fold + derivation
 *     against the chat records (statuses, progress, the log), read fresh.
 *   trackOfChat        — a chat's membership (the chat page's breadcrumb,
 *                        rail, chip resolver; the handler's tool registration).
 *   startTrack         — Start track: the planning chat's latest proposal
 *                        becomes the `created` event. Idempotent per chat.
 *   startPart          — Start part: a newborn teaching chat opened by a
 *                        track-context marker + the `part-started` event.
 *                        The ROUTE fires the opening turn (chat-handler is
 *                        above this module — no cycle).
 *   attachPractice     — Practice this part: a newborn practice chat seeded
 *                        with the part's summary and graph propositions.
 *   requestReplan      — ASK LH TO RE-PLAN: a learner-requested re-plan
 *                        steer into the planning chat (the wake pipeline).
 *   deleteTrack        — the track and every session it owns, through the
 *                        session-deletion choreography; then the tombstone.
 *   renameTrack        — the `renamed` event.
 *
 * Every derivation is pure core (core/tracks.ts); this module only joins
 * the stores and the liveness registry and appends events.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ChatDeleteMode } from "../core/graph-deletion.ts";
import type {
	ChatTrackContext,
	TrackChatFacts,
	TrackRecord,
	TrackView,
} from "../core/contracts.ts";
import { trackReplanText } from "../core/contracts.ts";
import { chainsForSelection, formatChainLine } from "../core/chains.ts";
import {
	assignPartNumbers,
	chatTrackContextOf,
	deriveTrackView,
	foldTracks,
	latestTrackProposal,
	membershipOf,
	partDoneOf,
	trackChatIds,
	trackContextText,
	unlocksText,
	validateParts,
} from "../core/tracks.ts";
import {
	activeProblemOf,
	danglingQuestionOf,
	newGraphContextMessage,
	newTrackContextMessage,
	newTrackReplanSteer,
	type GraphContextPick,
	type LhMessage,
} from "../core/native-messages.ts";
import { phaseAt3Lh } from "../core/phases.ts";
import { getGraph, graphSessionPropositions } from "../core/graph.ts";
import { stores } from "./stores.ts";
import { isTurnRunning } from "./turn-liveness.ts";
import { deliverJobResult } from "./jobs.ts";
import { deleteChatSession, newbornChat } from "./chats.ts";
import { graphRevision } from "./graph.ts";

function newTrackId(): string {
	return `trk_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
}

/** What the derivation knows about one chat — the record + the turn registry. */
export function chatFactsFor(chatId: string): TrackChatFacts | null {
	const record = stores.chatStore.getChat(chatId);
	if (!record) return null;
	const kind = record.kind ?? "teach";
	return {
		id: record.id,
		title: record.title,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		kind,
		phase: phaseAt3Lh(record.messages),
		busy: isTurnRunning(chatId),
		pendingQuestion: danglingQuestionOf(record.messages) !== null,
		pendingProblem: kind === "practice" && activeProblemOf(record.messages) !== null,
		partDone: partDoneOf(record.messages),
	};
}

/** The folded records, every read. */
export function trackRecords(): TrackRecord[] {
	return foldTracks(stores.trackStore.readEvents());
}

export function listTrackViews(): TrackView[] {
	return trackRecords().map((record) => deriveTrackView(record, chatFactsFor));
}

export function getTrackView(trackId: string): TrackView | null {
	const record = trackRecords().find((r) => r.id === trackId);
	return record ? deriveTrackView(record, chatFactsFor) : null;
}

/** A chat's track membership, or null for a loose chat. */
export function trackOfChat(chatId: string): ChatTrackContext | null {
	const member = membershipOf(trackRecords(), chatId);
	return member ? chatTrackContextOf(member) : null;
}

/** The learner's first message of a chat — the brief, verbatim. */
function firstUserText(messages: readonly LhMessage[]): string | null {
	for (const m of messages) {
		if ((m as { role?: string }).role !== "user") continue;
		const content = (m as { content: unknown }).content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			const text = content
				.filter((c): c is { type: "text"; text: string } => (c as { type?: string }).type === "text")
				.map((c) => c.text)
				.join("\n");
			if (text.trim()) return text;
		}
	}
	return null;
}

export type StartTrackOutcome =
	| { ok: true; track: TrackView; created: boolean }
	| { ok: false; status: 404 | 409 | 400; error: string };

/** Start track: the planning chat's latest clean proposal becomes the track.
 *  Idempotent — a second click returns the existing track. */
export function startTrack(planningChatId: string): StartTrackOutcome {
	const chat = stores.chatStore.getChat(planningChatId);
	if (!chat) return { ok: false, status: 404, error: "Unknown session" };
	const existing = trackRecords().find((r) => r.planningChatId === planningChatId);
	if (existing) return { ok: true, track: deriveTrackView(existing, chatFactsFor), created: false };
	const proposal = latestTrackProposal(chat.messages);
	if (!proposal) return { ok: false, status: 409, error: "This session has no track proposal yet." };
	const parts = assignPartNumbers([], proposal.input.parts.map((p) => ({ ...p, dependsOn: [...p.dependsOn] })));
	const problems = validateParts(parts, null);
	if (problems.length > 0) return { ok: false, status: 400, error: problems.join(" ") };
	const trackId = newTrackId();
	const at = new Date().toISOString();
	stores.trackStore.appendEvent({
		type: "created",
		at,
		trackId,
		title: proposal.input.title,
		goal: proposal.input.goal,
		brief: firstUserText(chat.messages) ?? chat.title,
		explanation: proposal.input.explanation,
		findings: proposal.input.findings.map((f) => ({ kind: f.kind, text: f.text })),
		leftOut: proposal.input.leftOut ?? null,
		planningChatId,
		parts,
	});
	const view = getTrackView(trackId);
	if (!view) return { ok: false, status: 400, error: "The track could not be read back after creation." };
	return { ok: true, track: view, created: true };
}

export type StartPartOutcome =
	| { ok: true; chatId: string; created: boolean }
	| { ok: false; status: 404 | 409; error: string };

/** Start part: the part's teaching chat, born with its track context. A
 *  started part returns its existing chat (Continue session). The caller
 *  fires the opening turn when `created`. */
export function startPart(trackId: string, partId: string): StartPartOutcome {
	const view = getTrackView(trackId);
	if (!view) return { ok: false, status: 404, error: "Unknown track" };
	const part = view.parts.find((p) => p.id === partId);
	if (!part) return { ok: false, status: 404, error: "Unknown part" };
	if (part.teaching) return { ok: true, chatId: part.teaching.id, created: false };
	if (part.status === "split") {
		return { ok: false, status: 409, error: `Part ${part.number} is split into sub-parts — start one of them.` };
	}
	if (part.status !== "ready") {
		return { ok: false, status: 409, error: `Part ${part.number} is not ready. ${unlocksText(part, view.parts)}` };
	}
	const chat = newbornChat(part.title);
	const content = trackContextText({ track: view, part, role: "teaching" });
	stores.chatStore.saveMessages(chat.id, [newTrackContextMessage(content, { trackId, partId, role: "teaching" })]);
	stores.trackStore.appendEvent({ type: "part-started", at: new Date().toISOString(), trackId, partId, chatId: chat.id });
	return { ok: true, chatId: chat.id, created: true };
}

/** Practice this part: a newborn practice session attached to the part,
 *  seeded with the part's summary and the propositions the graph has born
 *  in its teaching chat (the graph-context pick, exactly as the home
 *  composer seeds a practice session). */
export function attachPractice(trackId: string, partId: string): StartPartOutcome {
	const view = getTrackView(trackId);
	if (!view) return { ok: false, status: 404, error: "Unknown track" };
	const part = view.parts.find((p) => p.id === partId);
	if (!part) return { ok: false, status: 404, error: "Unknown part" };
	if (!part.teaching) return { ok: false, status: 409, error: `Part ${part.number} has no teaching session yet — start the part first.` };
	// The propositions born in the part's teaching chat — practice material.
	const graph = getGraph(stores.graphStore);
	const byId = new Map(graph.nodes.map((n) => [n.id, n]));
	const born = graphSessionPropositions(stores, part.teaching.id)
		.map((p) => byId.get(p.nodeId))
		.filter((n): n is NonNullable<typeof n> => n !== undefined)
		.sort((a, b) => a.name.localeCompare(b.name));
	const picks: GraphContextPick[] = born.map((n) => ({ id: n.id, name: n.name, statement: n.statement }));
	const chat = newbornChat(`Practice · ${part.title}`, "practice");
	const content = trackContextText({
		track: view,
		part,
		role: "practice",
		propositions: born.map((n) => `${n.name}: ${n.statement}`),
	});
	const messages: LhMessage[] = [newTrackContextMessage(content, { trackId, partId, role: "practice" })];
	if (picks.length > 0) {
		const chainLines = chainsForSelection(born, graph.chains).map((c) => formatChainLine(c, Object.fromEntries(byId)));
		messages.push(newGraphContextMessage(picks, chainLines));
	}
	stores.chatStore.saveMessages(chat.id, messages);
	stores.trackStore.appendEvent({ type: "practice-attached", at: new Date().toISOString(), trackId, partId, chatId: chat.id });
	return { ok: true, chatId: chat.id, created: true };
}

export type ReplanRequestOutcome = { ok: true; planningChatId: string } | { ok: false; status: 404; error: string };

/** ASK LH TO RE-PLAN: a learner-requested re-plan wake into the planning
 *  chat — the same wake pipeline part_done uses, a fresh id each time. */
export function requestReplan(trackId: string): ReplanRequestOutcome {
	const record = trackRecords().find((r) => r.id === trackId);
	if (!record) return { ok: false, status: 404, error: "Unknown track" };
	const steer = newTrackReplanSteer(trackReplanText({ trackTitle: record.title, part: null, summary: null, shaky: null }), {
		trackId,
		planningChatId: record.planningChatId,
		partId: null,
		partNumber: null,
		partTitle: null,
	});
	void deliverJobResult(steer).catch((err: unknown) => {
		console.error(`[track ${trackId}] re-plan steer delivery failed:`, err);
	});
	return { ok: true, planningChatId: record.planningChatId };
}

export type DeleteTrackOutcome =
	| { ok: true; sessionsRemoved: number; graphRevision: number }
	| { ok: false; status: 404 | 409 | 503; code: string; error: string };

/**
 * Delete a track and EVERY session it owns (delegated ruling 2026-11-22):
 * gates first — a turn or a background job running in any of its sessions
 * refuses with 409 — then each session through the session-deletion
 * choreography (the same preserve-graph / delete-nodes mode for all), then
 * the tombstone. A failing session stops the run honestly: the track stays,
 * its vanished sessions read as not started (self-healing derivation), and
 * Delete can be pressed again.
 */
export async function deleteTrack(trackId: string, mode: ChatDeleteMode): Promise<DeleteTrackOutcome> {
	const record = trackRecords().find((r) => r.id === trackId);
	if (!record) return { ok: false, status: 404, code: "not_found", error: "No such track" };
	const chatIds = trackChatIds(record).filter((id) => stores.chatStore.getChat(id) !== null);
	for (const id of chatIds) {
		if (isTurnRunning(id)) {
			return {
				ok: false,
				status: 409,
				code: "turn_in_flight",
				error: `A turn is running in "${stores.chatStore.getChat(id)?.title ?? id}" — try again when it finishes`,
			};
		}
		if (stores.jobStore.listJobs(id).some((job) => job.status === "running")) {
			return {
				ok: false,
				status: 409,
				code: "jobs_running",
				error: `Background jobs are still running in "${stores.chatStore.getChat(id)?.title ?? id}" — try again when they finish`,
			};
		}
	}
	let removed = 0;
	for (const id of chatIds) {
		const title = stores.chatStore.getChat(id)?.title ?? id;
		const outcome = await deleteChatSession(id, mode);
		if (!outcome.ok) {
			if (outcome.status === 404) continue; // raced away — nothing to remove
			return { ok: false, status: outcome.status, code: outcome.code, error: `${outcome.error} (session "${title}")` };
		}
		removed++;
	}
	stores.trackStore.appendEvent({ type: "deleted", at: new Date().toISOString(), trackId });
	return { ok: true, sessionsRemoved: removed, graphRevision: graphRevision() };
}

export type RenameTrackOutcome = { ok: true; title: string } | { ok: false; status: 404 | 400; error: string };

export function renameTrack(trackId: string, title: string): RenameTrackOutcome {
	const t = title.trim();
	if (t === "") return { ok: false, status: 400, error: "title must be a non-empty string" };
	const record = trackRecords().find((r) => r.id === trackId);
	if (!record) return { ok: false, status: 404, error: "No such track" };
	stores.trackStore.appendEvent({ type: "renamed", at: new Date().toISOString(), trackId, title: t });
	return { ok: true, title: t };
}

/** The planning chat's assistant message carrying a tool call — exported
 *  for the tools' seams and tests (the proposal's provenance). */
export function assistantMessageOfCall(messages: readonly LhMessage[], toolCallId: string): (LhMessage & AssistantMessage) | null {
	for (const m of messages) {
		if ((m as { role?: string }).role !== "assistant") continue;
		const assistant = m as LhMessage & AssistantMessage;
		if (assistant.content.some((b) => b.type === "toolCall" && b.id === toolCallId)) return assistant;
	}
	return null;
}
