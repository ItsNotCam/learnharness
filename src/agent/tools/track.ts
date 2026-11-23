import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import {
	PART_DONE_ACK_TEXT,
	PROPOSE_TRACK_ACK_TEXT,
	REPLAN_TRACK_ACK_TEXT,
	partDoneInputSchema,
	proposeTrackInputSchema,
	readPartInputSchema,
	replanTrackInputSchema,
	trackReplanText,
	type SteerMessage,
	type TrackRecord,
} from "../../core/contracts.ts";
import {
	assignPartNumbers,
	canonicalPartOrder,
	describeReplan,
	foldTracks,
	hasPartDone,
	membershipOf,
	partDoneOf,
	partPassages,
	readPartWindow,
	validateParts,
} from "../../core/tracks.ts";
import { danglingQuestionOf, newTrackReplanSteer } from "../../core/native-messages.ts";
import type { ChatStore, TrackStore } from "../../core/ports.ts";

/**
 * THE TRACK TOOLS (docs/tracks.md §4) — four server-side tools over the
 * tracks ledger, each closing over the chat they run in:
 *
 *   propose_track  the PROBER's (and, until the track starts, the PLANNER's)
 *                  proposal: the call's arguments ARE the proposal (durable,
 *                  streamed live — the probe_done law); the ledger is
 *                  untouched until the learner clicks Start track. Refused
 *                  while a question is open and once the track has started.
 *   replan_track   the PLANNER's re-plan after a part (or on request): the
 *                  FULL replacement list, validated against the started and
 *                  done parts (ids kept, nothing dropped/split/re-parented),
 *                  numbered by the system, appended as `replanned` — also
 *                  when nothing changed.
 *   part_done      the TEACHER's one done signal in a part chat: refused
 *                  while a question is open, once per chat; its side effect
 *                  is the re-plan steer into the planning chat (the same
 *                  wake pipeline as the probe handoff).
 *   read_part      a dependency part's teaching prose with message ids
 *                  (`TEACHER [msg_…]`), windowed with a continuation offset.
 *
 * Every refusal returns to the agent as an error result (the return-to-agent
 * doctrine); every ack is CONTEXT-SLIM (the arguments already carry the
 * payload). The gates read FRESH truth per call: the ledger and the chat
 * records, never a construction-time snapshot — Start track can land
 * between a turn's construction and the call.
 */

/** What the track tools close over. `deliver` is the wake pipeline
 *  (src/server/jobs.ts deliverJobResult), injected so this module never
 *  imports the server seam — the probe_done discipline. */
export interface TrackToolContext {
	chatId: string;
	chatStore: ChatStore;
	trackStore: TrackStore;
	deliver: (steer: SteerMessage) => void;
}

/** The live (undeleted) records, folded fresh. */
function liveRecords(ctx: Pick<TrackToolContext, "trackStore">): TrackRecord[] {
	return foldTracks(ctx.trackStore.readEvents());
}

/** The track this chat PLANS, if it has started. */
function plannedTrack(ctx: Pick<TrackToolContext, "chatId" | "trackStore">): TrackRecord | null {
	return liveRecords(ctx).find((r) => r.planningChatId === ctx.chatId) ?? null;
}

/** The done parts of a record, read off the part chats (the derivation's
 *  rule — a clean part_done in the teaching chat). */
function doneParts(record: TrackRecord, chatStore: ChatStore): Set<string> {
	const done = new Set<string>();
	for (const part of record.parts) {
		if (!part.teachingChatId) continue;
		const chat = chatStore.getChat(part.teachingChatId);
		if (chat && partDoneOf(chat.messages)) done.add(part.id);
	}
	// A split parent is done when every child is (the derivation's rule).
	let grew = true;
	while (grew) {
		grew = false;
		for (const part of record.parts) {
			if (done.has(part.id)) continue;
			const kids = record.parts.filter((k) => k.parentPartId === part.id);
			if (kids.length > 0 && kids.every((k) => done.has(k.id))) {
				done.add(part.id);
				grew = true;
			}
		}
	}
	return done;
}

const OPEN_QUESTION =
	"A question is still open — resolve it (or let the learner answer) before this call. It only fires with no question outstanding.";

// ─── propose_track ───────────────────────────────────────────────────────────

export function proposeTrackTool(ctx: Pick<TrackToolContext, "chatId" | "chatStore" | "trackStore">): Record<string, AgentTool<any>> {
	return {
		propose_track: {
			name: "propose_track",
			label: "propose_track",
			description:
				"Propose a LEARNING TRACK instead of concluding a single-session probe: the goal is more than one session can teach well, " +
				"so you cut it into PARTS — each one teaching session's worth, with the parts it depends on — and the learner sees the " +
				"proposal (title, goal, your explanation, the placement findings, the parts with their why and dependencies, what is left out) " +
				"and starts the track or asks for changes. Nothing starts until they click Start track. Part ids are permanent lowercase slugs; " +
				"dependsOn names only genuine prerequisites (an empty list = a place to start); the system numbers the parts 1..N in the order given. " +
				"Re-callable until the track starts (the latest clean call is the proposal). Refused while a question is open and once the track has started. " +
				"After it succeeds, say one closing sentence and end your turn.",
			parameters: proposeTrackInputSchema,
			execute: serverExecute("propose_track", proposeTrackInputSchema, async (input) => {
				const record = ctx.chatStore.getChat(ctx.chatId);
				if (!record) return { ok: false, error: `Chat not found: ${ctx.chatId}` };
				if (danglingQuestionOf(record.messages) !== null) return { ok: false, error: OPEN_QUESTION };
				if (plannedTrack(ctx)) {
					return {
						ok: false,
						error: "The track has already started — propose_track is closed. Use replan_track to change the parts.",
					};
				}
				const parts = assignPartNumbers([], input.parts.map((p) => ({ ...p, dependsOn: [...p.dependsOn] })));
				const problems = validateParts(parts, null);
				if (problems.length > 0) return { ok: false, error: problems.join("\n") };
				// The planning chat takes the proposal's title (docs/tracks.md §7):
				// the sidebar shows the track's name from this moment on.
				try {
					if (record.title !== input.title.trim() && input.title.trim() !== "") ctx.chatStore.renameChat(ctx.chatId, input.title.trim());
				} catch (err) {
					console.error(`[chat ${ctx.chatId}] renaming the planning chat failed:`, err);
				}
				return { text: PROPOSE_TRACK_ACK_TEXT, details: { ok: true, parts: parts.map((p) => ({ id: p.id, number: p.number })) } };
			}),
		},
	};
}

// ─── replan_track ────────────────────────────────────────────────────────────

export function replanTrackTool(ctx: Pick<TrackToolContext, "chatId" | "chatStore" | "trackStore">): Record<string, AgentTool<any>> {
	return {
		replan_track: {
			name: "replan_track",
			label: "replan_track",
			description:
				"Re-plan the track this session plans: pass the FULL parts list after the re-plan (it replaces the old one). Keep every started or " +
				"done part with its id — such a part cannot be dropped, split or moved under another part; split an UNSTARTED part by listing its " +
				"sub-parts with parentPartId (one level only; a dependency on the split part means all its sub-parts); add a missing foundation " +
				"as a new part; drop what the summaries show is already held; fix the order through dependsOn. Numbers are assigned by the system. " +
				"Call it exactly once per re-plan, also when nothing changes (say so in the note). Pass afterPartId when a finished part triggered " +
				"the re-plan (its id is in the re-plan message); omit it when the learner asked. Refused while a question is open.",
			parameters: replanTrackInputSchema,
			execute: serverExecute("replan_track", replanTrackInputSchema, async (input) => {
				const chat = ctx.chatStore.getChat(ctx.chatId);
				if (!chat) return { ok: false, error: `Chat not found: ${ctx.chatId}` };
				if (danglingQuestionOf(chat.messages) !== null) return { ok: false, error: OPEN_QUESTION };
				const record = plannedTrack(ctx);
				if (!record) {
					return { ok: false, error: "No track has started from this session yet — propose_track is the tool until the learner starts it." };
				}
				if (input.afterPartId !== undefined && !record.parts.some((p) => p.id === input.afterPartId)) {
					return { ok: false, error: `afterPartId "${input.afterPartId}" is not a part of this track. Copy the id from the re-plan message, or omit it.` };
				}
				const next = input.parts.map((p) => ({
					id: p.id,
					title: p.title,
					why: p.why,
					dependsOn: [...p.dependsOn],
					...(p.parentPartId !== undefined ? { parentPartId: p.parentPartId } : {}),
				}));
				const numbered = assignPartNumbers(record.parts, next);
				const problems = validateParts(numbered, { parts: record.parts, done: doneParts(record, ctx.chatStore) });
				if (problems.length > 0) return { ok: false, error: problems.join("\n") };
				const ordered = canonicalPartOrder(numbered);
				ctx.trackStore.appendEvent({
					type: "replanned",
					at: new Date().toISOString(),
					trackId: record.id,
					afterPartId: input.afterPartId ?? null,
					note: input.note.trim(),
					parts: ordered,
				});
				const changed = describeReplan(record.parts, ordered);
				return {
					text: REPLAN_TRACK_ACK_TEXT,
					details: { ok: true, changed, parts: ordered.map((p) => ({ id: p.id, number: p.number })) },
				};
			}),
		},
	};
}

// ─── part_done ───────────────────────────────────────────────────────────────

export function partDoneTool(ctx: TrackToolContext): Record<string, AgentTool<any>> {
	return {
		part_done: {
			name: "part_done",
			label: "part_done",
			description:
				"Record this part of the track as DONE — the one done signal there is (the learner has no checkbox). Call it ONCE, when this " +
				"part's goal is held: every step of this session's plan has landed and been verified. The input is what the learner now holds " +
				"from this part, written for the next parts' prober and the track's re-plan — the propositions established and how far the " +
				"understanding carries — plus what stayed shaky. The track re-plans from it at once. Refused while a question is open, and after " +
				"the part is already done. The session stays open afterwards for the learner's questions. After it succeeds, say your closing " +
				"words and end your turn.",
			parameters: partDoneInputSchema,
			execute: serverExecute("part_done", partDoneInputSchema, async (input) => {
				const chat = ctx.chatStore.getChat(ctx.chatId);
				if (!chat) return { ok: false, error: `Chat not found: ${ctx.chatId}` };
				if (danglingQuestionOf(chat.messages) !== null) return { ok: false, error: OPEN_QUESTION };
				if (hasPartDone(chat.messages)) return { ok: false, error: "This part is already done — part_done fires exactly once." };
				const member = membershipOf(liveRecords(ctx), ctx.chatId);
				if (!member || member.role !== "teaching" || !member.part) {
					return { ok: false, error: "This session is not a track part's teaching session — part_done does not apply here." };
				}
				const { record, part } = member;
				try {
					ctx.deliver(
						newTrackReplanSteer(
							trackReplanText({
								trackTitle: record.title,
								part: { id: part.id, number: part.number, title: part.title },
								summary: input.summary,
								shaky: input.shaky ?? null,
							}),
							{ trackId: record.id, planningChatId: record.planningChatId, partId: part.id, partNumber: part.number, partTitle: part.title },
						),
					);
				} catch (err) {
					// The re-plan is recoverable (ASK LH TO RE-PLAN fires the same
					// steer); the done stamp is the call's clean result — record it.
					console.error(`[chat ${ctx.chatId}] re-plan steer queueing failed:`, err);
				}
				return { text: PART_DONE_ACK_TEXT, details: { ok: true } };
			}),
		},
	};
}

// ─── read_part ───────────────────────────────────────────────────────────────

export function readPartTool(ctx: Pick<TrackToolContext, "chatId" | "chatStore" | "trackStore">): Record<string, AgentTool<any>> {
	return {
		read_part: {
			name: "read_part",
			label: "read_part",
			description:
				"Read what an earlier part of this track actually taught: the teacher's passages from that part's session, each under its " +
				"message id (`TEACHER [msg_…]`) — cite a passage with a part link, part://<partId>/<messageId>. Windowed: a long part " +
				"returns its first passages and the offset to continue from; call again with that offset for the rest. The part ids are the " +
				"ones the track context lists.",
			parameters: readPartInputSchema,
			execute: serverExecute("read_part", readPartInputSchema, async (input): Promise<string | { ok: false; error: string }> => {
				const member = membershipOf(liveRecords(ctx), ctx.chatId);
				if (!member) return { ok: false, error: "This session belongs to no track — there are no parts to read." };
				const part = member.record.parts.find((p) => p.id === input.partId);
				if (!part) {
					const known = member.record.parts.map((p) => `${p.id} (${p.number} · ${p.title})`).join(", ");
					return { ok: false, error: `No part "${input.partId}" in this track. Parts: ${known}.` };
				}
				if (!part.teachingChatId) return { ok: false, error: `Part ${part.number} · ${part.title} has not been taught yet — there is nothing to read.` };
				const chat = ctx.chatStore.getChat(part.teachingChatId);
				if (!chat) return { ok: false, error: `Part ${part.number}'s session is gone — nothing to read.` };
				const passages = partPassages(chat.messages);
				if (passages.length === 0) return `Part ${part.number} · ${part.title}: no teaching prose yet.`;
				const window = readPartWindow(passages, input.offset ?? 0);
				const head = `Part ${part.number} · ${part.title} — passages ${Math.min(input.offset ?? 0, passages.length) + 1}–${window.nextOffset ?? passages.length} of ${passages.length} (part id ${part.id}, session ${part.teachingChatId}).`;
				const tail = window.nextOffset !== null ? `\n\n[continues — call read_part again with offset ${window.nextOffset}]` : "\n\n[end of part]";
				return `${head}\n\n${window.text}${tail}`;
			}),
		},
	};
}
