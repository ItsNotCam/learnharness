/**
 * Track contracts — a learning goal too big for one session (docs/tracks.md).
 *
 * A TRACK is split by LearnHarness into PARTS, each taught in its own teaching
 * session; the parts form a dependency DAG; after every part the track is
 * re-planned automatically. The stored truth is an APPEND-ONLY EVENT LEDGER
 * (data/tracks/tracks.jsonl — owner ruling 2026-11-22): created / replanned /
 * part-started / practice-attached / renamed / deleted. Everything else — the
 * track record, each part's status, the progress pill, the track log — is
 * DERIVED at read time (core/tracks.ts) against the chat records: a part is
 * done when its teaching chat holds a clean `part_done` result, never because
 * anything stored says so.
 *
 * Part of the domain-split contracts (src/core/contracts/): pure types, the
 * tool schemas (the probe_done law — the SAME TypeBox schema runs at the model
 * boundary and at every consumer parse) and the model-facing ack texts.
 */

import { Type, type Static } from "typebox";
import type { Phase3 } from "../phases.ts";

// ─── the stored part spec and the ledger events ──────────────────────────────

/** One part as the planner authored it — the shape every ledger event carries.
 *  `id` is the planner's permanent slug (plan_init's rule); `number` is the
 *  display number the SYSTEM assigns once ("1", "5", "5a") and never changes. */
export interface TrackPartSpec {
	id: string;
	number: string;
	title: string;
	/** The one-line reason this part exists for the end goal. */
	why: string;
	/** Part ids that must be done before this part is ready. */
	dependsOn: string[];
	/** The part this one was split out of (one level deep, by rule). */
	parentPartId?: string;
}

/** One placement-probe finding shown on the proposal and in the log. */
export interface TrackFinding {
	/** held = already held, so it isn't a part; low = starts from the basics. */
	kind: "held" | "low";
	text: string;
}

export type TrackEvent =
	| {
			type: "created";
			at: string;
			trackId: string;
			title: string;
			goal: string;
			/** The learner's first message in the planning chat, verbatim. */
			brief: string;
			/** LH's one-paragraph explanation of why a track, and how it is cut. */
			explanation: string;
			findings: TrackFinding[];
			leftOut: string | null;
			planningChatId: string;
			parts: TrackPartSpec[];
	  }
	| {
			type: "replanned";
			at: string;
			trackId: string;
			/** The part whose end triggered the re-plan; null = the learner asked. */
			afterPartId: string | null;
			/** The planner's learner-facing note: what changed and why. */
			note: string;
			/** The FULL new parts list — history is a real diff, never a lossy note. */
			parts: TrackPartSpec[];
	  }
	| { type: "part-started"; at: string; trackId: string; partId: string; chatId: string }
	| { type: "practice-attached"; at: string; trackId: string; partId: string; chatId: string }
	| { type: "renamed"; at: string; trackId: string; title: string }
	| { type: "deleted"; at: string; trackId: string };

export type TrackEventType = TrackEvent["type"];

// ─── the folded record (core/tracks.ts foldTracks) ───────────────────────────

/** A part with the chats the ledger attached to it. */
export interface TrackPart extends TrackPartSpec {
	teachingChatId: string | null;
	practiceChatIds: string[];
}

export interface TrackReplan {
	at: string;
	afterPartId: string | null;
	note: string;
	parts: TrackPartSpec[];
}

/** One session start the ledger recorded (the log's "Part N started"). */
export interface TrackStart {
	at: string;
	partId: string;
	chatId: string;
	kind: "teaching" | "practice";
}

export interface TrackRecord {
	id: string;
	title: string;
	goal: string;
	brief: string;
	explanation: string;
	findings: TrackFinding[];
	leftOut: string | null;
	planningChatId: string;
	createdAt: string;
	/** The newest ledger event's stamp. */
	updatedAt: string;
	parts: TrackPart[];
	/** The list the track was created with — the first re-plan's "before". */
	createdParts: TrackPartSpec[];
	replans: TrackReplan[];
	starts: TrackStart[];
}

// ─── the derived view (core/tracks.ts deriveTrackView) ───────────────────────

export type TrackPartStatus = "done" | "in-progress" | "ready" | "later" | "split";

/** What the derivation needs to know about ONE chat — the server builds it
 *  from the chat record + the turn registry; tests hand in literals. */
export interface TrackChatFacts {
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	kind: "teach" | "practice";
	phase: Phase3;
	busy: boolean;
	pendingQuestion: boolean;
	pendingProblem: boolean;
	/** The clean `part_done` result's facts, when the chat carries one. */
	partDone: PartDoneFacts | null;
}

export interface PartDoneFacts {
	at: string;
	summary: string;
	shaky: string | null;
}

/** A session as the overview / sidebar / rail show it. */
export interface TrackSessionView {
	id: string;
	title: string;
	kind: "teaching" | "practice" | "planning";
	updatedAt: string;
	busy: boolean;
	pendingQuestion: boolean;
	pendingProblem: boolean;
	phase: Phase3;
	/** Teaching sessions: when part_done landed; null while in progress. */
	doneAt: string | null;
}

export interface TrackPartView extends TrackPartSpec {
	status: TrackPartStatus;
	/** Child part ids (a split part), in list order. */
	children: string[];
	teaching: TrackSessionView | null;
	practice: TrackSessionView[];
	/** The part_done summary (done parts). */
	summary: string | null;
	shaky: string | null;
	doneAt: string | null;
	startedAt: string | null;
}

export type TrackLogKind = "created" | "finding" | "part-started" | "part-done" | "replanned" | "practice" | "renamed";

export interface TrackLogEntry {
	at: string;
	kind: TrackLogKind;
	text: string;
	partId?: string;
}

export interface TrackView {
	id: string;
	title: string;
	goal: string;
	brief: string;
	explanation: string;
	findings: TrackFinding[];
	leftOut: string | null;
	planningChatId: string;
	createdAt: string;
	updatedAt: string;
	parts: TrackPartView[];
	replans: TrackReplan[];
	/** Top-level parts done / top-level parts ("3 OF 7 DONE"). */
	progress: { done: number; total: number };
	/** Newest last; the UI reverses. */
	log: TrackLogEntry[];
	planning: TrackSessionView | null;
	/** Every chat the track owns: planning, teaching, practice. */
	chatIds: string[];
}

/** What a chat page needs to know about its track membership (the breadcrumb,
 *  the TRACK button, the rail, the chip resolver). Resolved server-side. */
export interface ChatTrackContext {
	trackId: string;
	trackTitle: string;
	planningChatId: string;
	role: "planning" | "teaching" | "practice";
	/** The part this chat belongs to (teaching/practice roles). */
	partId: string | null;
	partNumber: string | null;
	partTitle: string | null;
	/** Top-level part count (the breadcrumb's "OF M"). */
	totalParts: number;
	/** Every part's chip facts — the renderer resolves part://<id>/<msg>. */
	parts: Array<{ id: string; number: string; title: string; teachingChatId: string | null }>;
}

// ─── tool schemas (boundary-valid ⇔ consumer-parseable) ──────────────────────

/** Part ids are permanent lowercase slugs — the plan_init rule. */
export const PART_SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;

const partIdField = Type.String({
	minLength: 1,
	pattern: PART_SLUG_RE.source,
	description: "A permanent lowercase slug for the part (a-z, 0-9, hyphens/underscores), e.g. distance-fields.",
});

const proposedPartSchema = Type.Object({
	id: partIdField,
	title: Type.String({ minLength: 1, description: "A short title — a few words, the session's name." }),
	why: Type.String({
		minLength: 1,
		description: "One line: why this part exists for the END GOAL — the reason the learner gets for learning it.",
	}),
	dependsOn: Type.Array(Type.String(), {
		description: "Part ids that must be DONE before this part can start. Empty = a place to start. Only genuine prerequisites.",
	}),
});

export const proposeTrackInputSchema = Type.Object({
	title: Type.String({ minLength: 1, description: "A short title for the track (shown as the track's name)." }),
	goal: Type.String({ minLength: 1, description: "The end goal in one sentence, in the learner's terms." }),
	explanation: Type.String({
		minLength: 1,
		description:
			"One paragraph for the learner: why this is more than one session, how the placement probe informed the cut, and how the track reads.",
	}),
	findings: Type.Array(
		Type.Object({
			kind: Type.Union([Type.Literal("held"), Type.Literal("low")], {
				description: "held = already held, so it is not a part; low = starts from the basics.",
			}),
			text: Type.String({ minLength: 1 }),
		}),
		{ description: "What the placement probe found, one line each." },
	),
	parts: Type.Array(proposedPartSchema, {
		minItems: 2,
		description: "The parts in reading order — each one teaching session's worth, numbered 1..N by the system.",
	}),
	leftOut: Type.Optional(
		Type.String({ description: "What the track deliberately leaves out, per the learner's brief (one line)." }),
	),
});

export type ProposeTrackInput = Static<typeof proposeTrackInputSchema>;

const replannedPartSchema = Type.Object({
	id: partIdField,
	title: Type.String({ minLength: 1 }),
	why: Type.String({ minLength: 1 }),
	dependsOn: Type.Array(Type.String()),
	parentPartId: Type.Optional(
		Type.String({
			description:
				"When this part is a SUB-PART of a split part: the id of the part it was split out of. One level only; a started or done part can never be split.",
		}),
	),
});

export const replanTrackInputSchema = Type.Object({
	afterPartId: Type.Optional(
		Type.String({
			description: "The id of the part whose end triggered this re-plan (copy it from the re-plan message). Omit when the learner asked.",
		}),
	),
	note: Type.String({
		minLength: 1,
		description: "For the learner, one or two sentences: what changed and why — or why nothing needed to change.",
	}),
	parts: Type.Array(replannedPartSchema, {
		minItems: 1,
		description:
			"The FULL parts list after the re-plan (it replaces the old one). Keep every started or done part with its id. Numbers are assigned by the system.",
	}),
});

export type ReplanTrackInput = Static<typeof replanTrackInputSchema>;

export const partDoneInputSchema = Type.Object({
	summary: Type.String({
		minLength: 1,
		description:
			"What the learner now holds from this part, as the next parts' prober and the track's re-plan will read it: the propositions established, how far the understanding carries.",
	}),
	shaky: Type.Optional(
		Type.String({ description: "What stayed shaky or was left out, if anything — one or two lines." }),
	),
});

export type PartDoneInput = Static<typeof partDoneInputSchema>;

export const readPartInputSchema = Type.Object({
	partId: Type.String({ minLength: 1, description: "The part id exactly as the track context lists it." }),
	offset: Type.Optional(
		Type.Integer({ minimum: 0, description: "Continue from this passage index (the previous result names it). Omit to start at the top." }),
	),
});

export type ReadPartInput = Static<typeof readPartInputSchema>;

/** Schema ↔ interface locks: the declarations and their Static shapes can never drift apart. */
export const proposeTrackSchemaLock = (v: Static<typeof proposeTrackInputSchema>): ProposeTrackInput => v;
export const replanTrackSchemaLock = (v: Static<typeof replanTrackInputSchema>): ReplanTrackInput => v;
export const partDoneSchemaLock = (v: Static<typeof partDoneInputSchema>): PartDoneInput => v;

// ─── model-facing texts (single-sourced here, the marker law) ────────────────

/** propose_track's ack — the proposal is the CALL's arguments (durable,
 *  streamed live), so the result never echoes it. */
export const PROPOSE_TRACK_ACK_TEXT =
	"Proposal recorded — the learner sees the proposed track now. Say one closing sentence and end your turn; they will start the track or ask for changes here.";

/** replan_track's ack. */
export const REPLAN_TRACK_ACK_TEXT =
	"Re-plan recorded and logged — the learner's track map is updated. Say one closing sentence about what changed (or that nothing did) and end your turn.";

/** part_done's ack. */
export const PART_DONE_ACK_TEXT =
	"Part recorded as done — the track re-plans from your summary now, and the next parts read it. Say your closing words for this part and end your turn; this session stays open for the learner's questions.";

/** The planner's re-plan wake, after a finished part. The marker flattens to
 *  a user message on the wire (toLlmMessages), so it reads as injected
 *  context, never as learner speech. */
export function trackReplanText(args: {
	trackTitle: string;
	part: { id: string; number: string; title: string } | null;
	summary: string | null;
	shaky: string | null;
}): string {
	if (args.part) {
		return [
			`[Track re-plan] — part ${args.part.number} · ${args.part.title} (id ${args.part.id}) of the track "${args.trackTitle}" is done.`,
			`Teacher's summary of what the learner now holds: ${args.summary ?? "(none given)"}`,
			args.shaky ? `What stayed shaky: ${args.shaky}` : null,
			"Re-plan the track now: read the summary (and read_part when the passages matter), keep every started or done part, split what proved too big, add a foundation that proved missing, drop what the summary shows is already held, and re-check the order. " +
				`Then call replan_track exactly once with afterPartId "${args.part.id}" — also when nothing needs to change (say so in the note).`,
		]
			.filter(Boolean)
			.join("\n");
	}
	return (
		`[Track re-plan] — the learner asked you to re-plan the track "${args.trackTitle}". ` +
		"Re-read the parts and what the finished ones established (read_part when the passages matter), reconsider the cut and the order, and call replan_track exactly once — also when nothing needs to change (say so in the note)."
	);
}
