/**
 * Tracks — the pure core (docs/tracks.md): the ledger fold, part numbering,
 * the planner's structural rules, the derived statuses/progress/log, the
 * native-record scans (the proposal, part_done), the part chat's context
 * block, the taught-in link parser, and the sidebar tree. Zero IO.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatListItem, TrackChatFacts, TrackEvent, TrackPartSpec, TrackView } from "../src/core/contracts.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import {
	assignPartNumbers,
	buildsOnText,
	dependencyLabel,
	deriveTrackView,
	describeReplan,
	flattenTrackTree,
	foldTracks,
	hasTrackProposal,
	latestTrackProposal,
	parsePartLink,
	partDoneOf,
	partLinkHref,
	trackChatIds,
	trackContextText,
	trackTree,
	unlocksText,
	validateParts,
	rewritePartLinks,
} from "../src/core/tracks.ts";

const T = "trk_1";
const at = (n: number) => `2026-11-22T10:${String(n).padStart(2, "0")}:00.000Z`;

function spec(id: string, number: string, title: string, dependsOn: string[] = [], parentPartId?: string): TrackPartSpec {
	return { id, number, title, why: `why ${title}`, dependsOn, ...(parentPartId ? { parentPartId } : {}) };
}

/** The mockup's track: 1→2→3, 4 a second start, 5 (split into 5a→5b)
 *  after 2 and 4, 6 after 3 and 5, 7 after 4. */
const PARTS: TrackPartSpec[] = [
	spec("p1", "1", "Distance fields"),
	spec("p2", "2", "SDFs in a texture", ["p1"]),
	spec("p3", "3", "Influence from distance", ["p2"]),
	spec("p4", "4", "UV and screen space"),
	spec("p5", "5", "SDF gradients", ["p2", "p4"]),
	spec("p6", "6", "Edge distortion and chromatic aberration", ["p3", "p5"]),
	spec("p7", "7", "Camera-driven layer offsets", ["p4"]),
];

function created(parts = PARTS): TrackEvent {
	return {
		type: "created",
		at: at(0),
		trackId: T,
		title: "SDF optical post-process shader",
		goal: "Understand the math behind an SDF-driven optical post-process material in UE5.",
		brief: "I want to understand the mathematics…",
		explanation: "This is more than one session can teach well.",
		findings: [
			{ kind: "held", text: "Unreal material graph basics, so it isn't a part." },
			{ kind: "low", text: "Distance fields and UV math both start from the basics." },
		],
		leftOut: "Full shader architecture.",
		planningChatId: "chat_plan",
		parts,
	};
}

function facts(overrides: Partial<TrackChatFacts> & { id: string }): TrackChatFacts {
	return {
		title: overrides.id,
		createdAt: at(1),
		updatedAt: at(2),
		kind: "teach",
		phase: "teach",
		busy: false,
		pendingQuestion: false,
		pendingProblem: false,
		partDone: null,
		...overrides,
	};
}

const done = (id: string, summary = "held") =>
	facts({ id, partDone: { at: at(5), summary, shaky: null } });

describe("foldTracks — the ledger fold", () => {
	it("created → a record; replanned replaces parts but keeps attached chats; starts attach; renamed; deleted drops", () => {
		const events: TrackEvent[] = [
			created(),
			{ type: "part-started", at: at(1), trackId: T, partId: "p1", chatId: "chat_p1" },
			{ type: "practice-attached", at: at(2), trackId: T, partId: "p1", chatId: "chat_p1_prac" },
			{
				type: "replanned",
				at: at(3),
				trackId: T,
				afterPartId: "p1",
				note: "Split SDF gradients.",
				parts: [...PARTS.filter((p) => p.id !== "p5"), spec("p5", "5", "SDF gradients", ["p2", "p4"]), spec("p5a", "5a", "Gradients of a 2D field", [], "p5"), spec("p5b", "5b", "Finite differences", ["p5a"], "p5")],
			},
			{ type: "renamed", at: at(4), trackId: T, title: "Renamed" },
			// Unknown track: ignored, never guessed.
			{ type: "part-started", at: at(4), trackId: "trk_ghost", partId: "x", chatId: "c" },
		];
		const [record] = foldTracks(events);
		assert.ok(record);
		assert.equal(record.title, "Renamed");
		assert.equal(record.updatedAt, at(4));
		assert.equal(record.parts.length, 9);
		assert.equal(record.parts.find((p) => p.id === "p1")?.teachingChatId, "chat_p1", "the chat survives the re-plan");
		assert.deepEqual(record.parts.find((p) => p.id === "p1")?.practiceChatIds, ["chat_p1_prac"]);
		assert.equal(record.parts.find((p) => p.id === "p5a")?.parentPartId, "p5");
		assert.equal(record.replans.length, 1);
		assert.equal(record.createdParts.length, 7, "the created list is kept for the first re-plan's diff");
		assert.deepEqual(record.starts.map((s) => s.kind), ["teaching", "practice"]);
		assert.deepEqual(trackChatIds(record), ["chat_plan", "chat_p1", "chat_p1_prac"]);

		assert.deepEqual(foldTracks([...events, { type: "deleted", at: at(5), trackId: T }]), [], "a tombstone drops the track");
	});

	it("events before their track's creation are ignored", () => {
		assert.deepEqual(foldTracks([{ type: "renamed", at: at(0), trackId: T, title: "x" }]), []);
	});
});

describe("assignPartNumbers — assigned once, by the system", () => {
	it("a proposal numbers 1..N in list order", () => {
		const numbered = assignPartNumbers([], PARTS.map(({ number: _n, ...p }) => p));
		assert.deepEqual(numbered.map((p) => p.number), ["1", "2", "3", "4", "5", "6", "7"]);
	});

	it("a re-plan keeps known numbers, new top-level parts take the next integers, sub-parts take letters", () => {
		const next = [
			...PARTS.map(({ number: _n, ...p }) => p),
			{ id: "p5a", title: "Gradients of a 2D field", why: "w", dependsOn: [], parentPartId: "p5" },
			{ id: "p5b", title: "Finite differences", why: "w", dependsOn: ["p5a"], parentPartId: "p5" },
			{ id: "p8", title: "Lens housing", why: "w", dependsOn: ["p6"] },
		];
		const numbered = assignPartNumbers(PARTS, next);
		const byId = new Map(numbered.map((p) => [p.id, p.number]));
		assert.equal(byId.get("p5"), "5");
		assert.equal(byId.get("p5a"), "5a");
		assert.equal(byId.get("p5b"), "5b");
		assert.equal(byId.get("p8"), "8");
		// A later re-plan adds a third sub-part: it takes the next free letter.
		const again = assignPartNumbers(numbered, [...next, { id: "p5c", title: "c", why: "w", dependsOn: [], parentPartId: "p5" }]);
		assert.equal(again.find((p) => p.id === "p5c")?.number, "5c");
		assert.equal(again.find((p) => p.id === "p5a")?.number, "5a", "existing letters never move");
	});

	it("a dropped number is never reused: the next integer is past the highest ever assigned", () => {
		const kept = assignPartNumbers(PARTS, [...PARTS.filter((p) => p.id !== "p7").map(({ number: _n, ...p }) => p), { id: "p9", title: "n", why: "w", dependsOn: [] }]);
		assert.equal(kept.find((p) => p.id === "p9")?.number, "8");
	});
});

describe("validateParts — the planner's structural rules", () => {
	const inputs = (parts: TrackPartSpec[]) => parts.map(({ number: _n, ...p }) => p);

	it("a sound list has no problems", () => {
		assert.deepEqual(validateParts(inputs(PARTS), null), []);
	});

	it("ids are slugs, unique; dependencies resolve; no self-dependency", () => {
		const problems = validateParts(
			inputs([spec("Bad Id", "1", "x"), spec("p2", "2", "y", ["ghost", "p2"]), spec("p2", "3", "dup")]),
			null,
		);
		assert.ok(problems.some((p) => /not a slug/.test(p)));
		assert.ok(problems.some((p) => /Duplicate part id "p2"/.test(p)));
		assert.ok(problems.some((p) => /unknown part "ghost"/.test(p)));
		assert.ok(problems.some((p) => /depends on itself/.test(p)));
	});

	it("splits go one level deep; a sub-part never depends on its parent; a split part with leaves is fine", () => {
		const nested = inputs([spec("a", "1", "A"), spec("b", "1a", "B", [], "a"), spec("c", "1aa", "C", [], "b")]);
		assert.ok(validateParts(nested, null).some((p) => /one level deep/.test(p)));
		const onParent = inputs([spec("a", "1", "A"), spec("b", "1a", "B", ["a"], "a"), spec("c", "2", "C")]);
		assert.ok(validateParts(onParent, null).some((p) => /depends on its own parent/.test(p)));
		const split = inputs([spec("a", "1", "A"), spec("b", "1a", "B", [], "a")]);
		assert.deepEqual(validateParts(split, null), []);
	});

	it("cycles are refused with plan-tree's message", () => {
		const cyclic = inputs([spec("a", "1", "A", ["b"]), spec("b", "2", "B", ["a"])]);
		assert.ok(validateParts(cyclic, null).some((p) => /cycle/.test(p)));
	});

	it("started or done parts cannot be dropped, split, or re-parented", () => {
		const previous = {
			parts: PARTS.map((p) => ({ ...p, teachingChatId: p.id === "p1" ? "chat_p1" : null, practiceChatIds: [] as string[] })),
			done: new Set(["p1"]),
		};
		const dropped = validateParts(inputs(PARTS.filter((p) => p.id !== "p1")), previous);
		assert.ok(dropped.some((p) => /cannot be dropped/.test(p)), dropped.join("\n"));
		const split = validateParts(inputs([...PARTS, spec("p1a", "1a", "sub", [], "p1")]), previous);
		assert.ok(split.some((p) => /cannot be split/.test(p)), split.join("\n"));
		const moved = validateParts(inputs(PARTS.map((p) => (p.id === "p1" ? spec("p1", "1", "Distance fields", [], "p4") : p))), previous);
		assert.ok(moved.some((p) => /cannot be moved/.test(p)), moved.join("\n"));
	});
});

describe("deriveTrackView — statuses, progress, log", () => {
	function record(extra: TrackEvent[] = []) {
		return foldTracks([created(), ...extra])[0]!;
	}

	it("ready = every dependency done; later otherwise; two starts when nothing is done", () => {
		const view = deriveTrackView(record(), () => null);
		const status = Object.fromEntries(view.parts.map((p) => [p.id, p.status]));
		assert.deepEqual(status, { p1: "ready", p2: "later", p3: "later", p4: "ready", p5: "later", p6: "later", p7: "later" });
		assert.deepEqual(view.progress, { done: 0, total: 7 });
		assert.equal(view.log[0]?.text, "Track created from your goal.");
		assert.ok(view.log.some((e) => e.text === "Placement probe: you already hold unreal material graph basics, so it isn't a part."));
	});

	it("a teaching chat makes the part in progress; a clean part_done makes it done and unlocks dependents", () => {
		const rec = record([
			{ type: "part-started", at: at(1), trackId: T, partId: "p1", chatId: "chat_p1" },
			{ type: "part-started", at: at(2), trackId: T, partId: "p4", chatId: "chat_p4" },
		]);
		const inProgress = deriveTrackView(rec, (id) => (id === "chat_p1" || id === "chat_p4" ? facts({ id }) : null));
		assert.equal(inProgress.parts.find((p) => p.id === "p1")?.status, "in-progress");
		assert.equal(inProgress.parts.find((p) => p.id === "p2")?.status, "later");
		assert.ok(inProgress.log.some((e) => e.kind === "part-started" && e.text === "Part 1 · Distance fields started."));

		const p1Done = deriveTrackView(rec, (id) => (id === "chat_p1" ? done(id, "Distance fields held.") : id === "chat_p4" ? facts({ id }) : null));
		const p1 = p1Done.parts.find((p) => p.id === "p1")!;
		assert.equal(p1.status, "done");
		assert.equal(p1.summary, "Distance fields held.");
		assert.equal(p1.doneAt, at(5));
		assert.equal(p1Done.parts.find((p) => p.id === "p2")?.status, "ready", "p2's one dependency is done");
		assert.equal(p1Done.parts.find((p) => p.id === "p5")?.status, "later", "p5 also waits on p4");
		assert.deepEqual(p1Done.progress, { done: 1, total: 7 });
		assert.ok(p1Done.log.some((e) => e.kind === "part-done" && e.text === "Part 1 · Distance fields done."));
	});

	it("a vanished chat reads as never started — self-healing, no cleanup", () => {
		const rec = record([{ type: "part-started", at: at(1), trackId: T, partId: "p1", chatId: "chat_gone" }]);
		const view = deriveTrackView(rec, () => null);
		assert.equal(view.parts.find((p) => p.id === "p1")?.status, "ready");
		assert.equal(view.parts.find((p) => p.id === "p1")?.teaching, null);
	});

	it("a split parent is split; done when every child is; a dependency on it means all its children", () => {
		const replan: TrackEvent = {
			type: "replanned",
			at: at(3),
			trackId: T,
			afterPartId: "p2",
			note: "Split SDF gradients into 5a and 5b.",
			parts: [...PARTS, spec("p5a", "5a", "Gradients of a 2D field", [], "p5"), spec("p5b", "5b", "Finite differences in a material", ["p5a"], "p5")],
		};
		const rec = record([
			{ type: "part-started", at: at(1), trackId: T, partId: "p2", chatId: "chat_p2" },
			replan,
			{ type: "part-started", at: at(4), trackId: T, partId: "p5a", chatId: "chat_p5a" },
			{ type: "part-started", at: at(5), trackId: T, partId: "p5b", chatId: "chat_p5b" },
			{ type: "part-started", at: at(6), trackId: T, partId: "p1", chatId: "chat_p1" },
			{ type: "part-started", at: at(7), trackId: T, partId: "p4", chatId: "chat_p4" },
			{ type: "part-started", at: at(8), trackId: T, partId: "p3", chatId: "chat_p3" },
		]);
		const allDone = (id: string) => done(id);
		const view = deriveTrackView(rec, allDone);
		const p5 = view.parts.find((p) => p.id === "p5")!;
		assert.equal(p5.status, "split");
		assert.deepEqual(p5.children, ["p5a", "p5b"]);
		assert.equal(view.parts.find((p) => p.id === "p6")?.status, "ready", "p3 done and p5's children both done");
		assert.equal(view.parts.find((p) => p.id === "p7")?.status, "ready", "p7 was never started: ready, since p4 is done");
		assert.deepEqual(view.progress, { done: 5, total: 7 }, "top-level parts: 1,2,3,4 and 5 (every child) done; 6 and 7 not");
		const logText = view.log.find((e) => e.kind === "replanned")?.text ?? "";
		assert.ok(logText.startsWith("Re-planned after part 2 · SDFs in a texture: Split SDF gradients into 5a and 5b."), logText);
		assert.ok(logText.includes("(split 5 into 5a, 5b)"), logText);

		// Only 5a done → the parent is not done, 6 waits.
		const half = deriveTrackView(rec, (id) => (id === "chat_p5b" ? facts({ id }) : done(id)));
		assert.equal(half.parts.find((p) => p.id === "p6")?.status, "later");
		assert.deepEqual(half.progress, { done: 4, total: 7 });
	});

	it("the log is sorted oldest first and the planning session rides the view", () => {
		const rec = record([{ type: "part-started", at: at(1), trackId: T, partId: "p1", chatId: "chat_p1" }]);
		const view = deriveTrackView(rec, (id) => (id === "chat_plan" ? facts({ id, title: "SDF shader" }) : null));
		assert.equal(view.planning?.kind, "planning");
		for (let i = 1; i < view.log.length; i++) assert.ok(view.log[i - 1]!.at <= view.log[i]!.at);
		assert.deepEqual(view.chatIds, ["chat_plan", "chat_p1"]);
	});
});

describe("describeReplan / dependencyLabel / buildsOnText / unlocksText", () => {
	it("names splits, additions and drops; empty when nothing structural changed", () => {
		const after = [...PARTS.filter((p) => p.id !== "p7"), spec("p5a", "5a", "A", [], "p5"), spec("p5b", "5b", "B", [], "p5"), spec("p8", "8", "Lens housing")];
		assert.equal(describeReplan(PARTS, after), "split 5 into 5a, 5b; added 8 · Lens housing; dropped 7 · Camera-driven layer offsets");
		assert.equal(describeReplan(PARTS, PARTS), "");
	});

	it("dependency labels read START / AFTER 1 / AFTER 2 AND 4", () => {
		const numberOf = (id: string) => PARTS.find((p) => p.id === id)!.number;
		assert.equal(dependencyLabel(PARTS[0]!, numberOf), "START");
		assert.equal(dependencyLabel(PARTS[1]!, numberOf), "AFTER 1");
		assert.equal(dependencyLabel(PARTS[4]!, numberOf), "AFTER 2 AND 4");
	});

	it("builds-on and unlocks lines", () => {
		const view = deriveTrackView(foldTracks([created(), { type: "part-started", at: at(1), trackId: T, partId: "p1", chatId: "c1" }])[0]!, (id) =>
			id === "c1" ? done(id) : null,
		);
		const p = (id: string) => view.parts.find((x) => x.id === id)!;
		assert.equal(buildsOnText(p("p1"), view.parts), "Nothing, it's a starting point");
		assert.equal(buildsOnText(p("p2"), view.parts), "Part 1, done");
		assert.equal(buildsOnText(p("p5"), view.parts), "Parts 2 and 4");
		assert.equal(unlocksText(p("p5"), view.parts), "Unlocks when parts 2 and 4 are done.");
		assert.equal(unlocksText(p("p2"), view.parts), "Unlocks when its earlier parts are done.", "p2 IS ready now — nothing waits");
	});
});

// ─── native-record scans ─────────────────────────────────────────────────────

const PROPOSAL = {
	title: "SDF optical post-process shader",
	goal: "Understand the math.",
	explanation: "More than one session.",
	findings: [{ kind: "held" as const, text: "Material basics." }],
	parts: [
		{ id: "distance-fields", title: "Distance fields", why: "The rest measures from the edge.", dependsOn: [] },
		{ id: "sdf-texture", title: "SDFs in a texture", why: "The lens arrives as a texture.", dependsOn: ["distance-fields"] },
	],
};

function assistantCall(id: string, name: string, args: unknown, timestamp = 1000): LhMessage {
	return {
		id,
		role: "assistant",
		content: [{ type: "toolCall", id: `call_${id}`, name, arguments: args as never }],
		api: "openai-completions",
		provider: "openrouter",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		stopReason: "toolUse",
		timestamp,
	} as never;
}

function result(id: string, name: string, isError = false, timestamp = 2000): LhMessage {
	return {
		id: `${id}_r`,
		role: "toolResult",
		toolCallId: `call_${id}`,
		toolName: name,
		content: [{ type: "text", text: isError ? "nope" : "ok" }],
		isError,
		timestamp,
	} as never;
}

describe("latestTrackProposal / hasTrackProposal / partDoneOf", () => {
	it("the LATEST clean propose_track call is the proposal; errored calls don't count; any call is the seam", () => {
		const messages: LhMessage[] = [
			{ id: "u1", role: "user", content: "I want to understand…", timestamp: 1 } as never,
			assistantCall("a1", "propose_track", { ...PROPOSAL, title: "First try" }),
			result("a1", "propose_track"),
			assistantCall("a2", "propose_track", { ...PROPOSAL, title: "Second try" }),
			result("a2", "propose_track"),
			assistantCall("a3", "propose_track", { bad: true }),
			result("a3", "propose_track", true),
		];
		const proposal = latestTrackProposal(messages);
		assert.equal(proposal?.input.title, "Second try");
		assert.equal(proposal?.callId, "call_a2");
		assert.equal(hasTrackProposal(messages), true);
		assert.equal(hasTrackProposal([messages[0]!]), false);
		assert.equal(latestTrackProposal([messages[0]!, assistantCall("x", "propose_track", PROPOSAL)]), null, "a dangling call is not a proposal yet");
	});

	it("partDoneOf reads the clean part_done call's summary and the result's stamp", () => {
		const messages = [assistantCall("d", "part_done", { summary: "Holds distance fields.", shaky: "Signed distance sign." }), result("d", "part_done", false, 1_700_000_000_000)];
		assert.deepEqual(partDoneOf(messages), {
			at: new Date(1_700_000_000_000).toISOString(),
			summary: "Holds distance fields.",
			shaky: "Signed distance sign.",
		});
		assert.equal(partDoneOf([assistantCall("d", "part_done", { summary: "x" }), result("d", "part_done", true)]), null, "an errored call did not conclude");
	});
});

describe("trackContextText — the part chat's context block", () => {
	it("carries the end goal, the brief, this part, the dependencies' summaries, the later parts and the findings", () => {
		const rec = foldTracks([
			created(),
			{ type: "part-started", at: at(1), trackId: T, partId: "p1", chatId: "chat_p1" },
			{ type: "part-started", at: at(2), trackId: T, partId: "p2", chatId: "chat_p2" },
		])[0]!;
		const view = deriveTrackView(rec, (id) => (id === "chat_p1" ? done(id, "Distance means the shortest way to the edge.") : id === "chat_p2" ? done(id, "A texel stores a distance.") : null));
		const text = trackContextText({ track: view, part: view.parts.find((p) => p.id === "p3")!, role: "teaching" });
		assert.ok(text.startsWith("[Track context] — this session is part 3 of 7 of the track"), text.split("\n")[0]);
		assert.ok(text.includes("END GOAL: Understand the math"));
		assert.ok(text.includes("I want to understand the mathematics…"), "the brief rides whole");
		assert.ok(text.includes("THIS PART — 3 · Influence from distance"));
		assert.ok(text.includes("Part 2 · SDFs in a texture (part id p2, session chat_p2)"));
		assert.ok(text.includes("Summary: A texel stores a distance."));
		assert.ok(text.includes("Also done earlier in the track: 1 · Distance fields"));
		assert.ok(text.includes("LATER PARTS (not this session's job): 4 · UV and screen space; 5 · SDF gradients"));
		assert.ok(text.includes("read_part"));
		assert.ok(text.includes("already held: Unreal material graph basics"));
		assert.ok(!text.includes("3 · Influence from distance;"), "this part never lists itself among the later ones");
	});

	it("the practice variant names the summary and the propositions", () => {
		const rec = foldTracks([created(), { type: "part-started", at: at(1), trackId: T, partId: "p1", chatId: "chat_p1" }])[0]!;
		const view = deriveTrackView(rec, (id) => (id === "chat_p1" ? done(id, "Distance fields held.") : null));
		const text = trackContextText({ track: view, part: view.parts[0]!, role: "practice", propositions: ["Distance field: the shortest distance to a shape's edge."] });
		assert.ok(text.startsWith("[Track context] — this is a practice session for part 1 · Distance fields"));
		assert.ok(text.includes("WHAT THE TEACHING ESTABLISHED: Distance fields held."));
		assert.ok(text.includes("- Distance field: the shortest distance"));
	});
});

describe("part:// links", () => {
	it("parses part://<partId>/<messageId> and resolves it to the part's chat anchor", () => {
		assert.deepEqual(parsePartLink("part://p2/msg_abc"), { partId: "p2", messageId: "msg_abc" });
		assert.deepEqual(parsePartLink("part://p2"), { partId: "p2", messageId: null });
		assert.equal(parsePartLink("https://example.com"), null);
		assert.equal(parsePartLink("part://"), null);
		// The pipeline form (the renderer rewrites part:// to a relative path).
		assert.deepEqual(parsePartLink("/part/p2/msg_abc"), { partId: "p2", messageId: "msg_abc" });
		assert.equal(parsePartLink("/part/"), null);
		assert.equal(rewritePartLinks("See [the field](part://p2/msg_abc) and [x](https://a.b)."), "See [the field](/part/p2/msg_abc) and [x](https://a.b).");
		const ctx = { parts: [{ id: "p2", number: "2", title: "SDFs in a texture", teachingChatId: "chat_p2" }, { id: "p9", number: "9", title: "Unstarted", teachingChatId: null }] };
		assert.deepEqual(partLinkHref({ partId: "p2", messageId: "msg_abc" }, ctx), { href: "/chat/chat_p2#message-msg_abc", label: "Taught in part 2 · SDFs in a texture" });
		assert.deepEqual(partLinkHref({ partId: "p2", messageId: null }, ctx), { href: "/chat/chat_p2", label: "Taught in part 2 · SDFs in a texture" });
		assert.equal(partLinkHref({ partId: "p9", messageId: "m" }, ctx), null, "an unstarted part has no chat to land in");
	});
});

// ─── the sidebar tree ────────────────────────────────────────────────────────

function chat(id: string, overrides: Partial<ChatListItem> = {}): ChatListItem {
	return {
		id,
		title: id,
		kind: "teach",
		createdAt: at(1),
		updatedAt: at(2),
		messageCount: 1,
		phase: "probe",
		pendingQuestion: false,
		pendingProblem: false,
		busy: false,
		compacting: false,
		...overrides,
	};
}

describe("trackTree / flattenTrackTree — the sidebar", () => {
	const rec = foldTracks([
		created(),
		{ type: "part-started", at: at(1), trackId: T, partId: "p1", chatId: "chat_p1" },
		{ type: "practice-attached", at: at(2), trackId: T, partId: "p1", chatId: "chat_p1_prac" },
	])[0]!;
	const view: TrackView = deriveTrackView(rec, (id) =>
		id === "chat_p1" ? facts({ id, title: "Distance fields" }) : id === "chat_p1_prac" ? facts({ id, kind: "practice" }) : id === "chat_plan" ? facts({ id }) : null,
	);
	const chats = [chat("chat_loose", { updatedAt: at(9) }), chat("chat_p1"), chat("chat_p1_prac", { kind: "practice" }), chat("chat_plan"), chat("chat_prac_loose", { kind: "practice" })];

	it("owned chats leave the loose list; tracks sort by their newest activity", () => {
		const tree = trackTree([view], chats);
		assert.deepEqual(tree.loose.map((c) => c.id), ["chat_loose", "chat_prac_loose"]);
		assert.equal(tree.tracks[0]?.planning?.id, "chat_plan");
		assert.equal(tree.tracks[0]?.parts.length, 7);
		assert.deepEqual(tree.tracks[0]?.parts[0]?.sessions.map((s) => s.session.kind), ["teaching", "practice"]);
	});

	it("flatten: the active track and the part in progress open by default; stored choices win; PRACTICE hides the tree", () => {
		const tree = trackTree([view], chats);
		const defaults = flattenTrackTree(tree, { isOpen: (_k, fb) => fb, activeChatId: null, filter: "all" });
		assert.equal(defaults[0]?.kind, "track");
		assert.equal((defaults[0] as { open: boolean }).open, true, "a track with a part in progress opens");
		assert.equal(defaults[1]?.kind, "planning");
		const p1 = defaults.find((r) => r.kind === "part" && r.part.id === "p1");
		assert.equal(p1 && (p1 as { open: boolean }).open, true, "the in-progress part opens");
		assert.ok(defaults.some((r) => r.kind === "session" && r.session.kind === "practice"), "ALL shows the practice session");

		const teach = flattenTrackTree(tree, { isOpen: (_k, fb) => fb, activeChatId: null, filter: "teach" });
		assert.ok(!teach.some((r) => r.kind === "session" && r.session.kind === "practice"), "TEACHING hides practice sessions");

		const closed = flattenTrackTree(tree, { isOpen: () => false, activeChatId: null, filter: "all" });
		assert.deepEqual(closed.map((r) => r.kind), ["track"], "a stored collapse hides everything under the track");

		// The overview page of a track opens it too (the sidebar's /track/<id> route).
		const quiet = { ...view, parts: view.parts.map((p) => (p.status === "in-progress" ? { ...p, status: "ready" as const, teaching: null } : p)) };
		const quietTree = trackTree([quiet], chats);
		assert.equal((flattenTrackTree(quietTree, { isOpen: (_k, fb) => fb, activeChatId: null, filter: "all" })[0] as { open: boolean }).open, false, "nothing in progress, nothing active: closed");
		assert.equal((flattenTrackTree(quietTree, { isOpen: (_k, fb) => fb, activeChatId: null, activeTrackId: quiet.id, filter: "all" })[0] as { open: boolean }).open, true, "its overview is open: the track opens");

		assert.deepEqual(flattenTrackTree(tree, { isOpen: () => true, activeChatId: null, filter: "practice" }), []);
	});
});
