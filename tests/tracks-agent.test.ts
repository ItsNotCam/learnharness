/**
 * The track tools and the planner (docs/tracks.md §4): registry gating by
 * the chat's track role, every refusal (open question, started track, bad
 * parts, dropped started part, once-only part_done), the re-plan event,
 * the part_done steer, read_part's windows, and the planner's composed
 * prompt. Isolated LH_DATA_DIR; no LLM.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-tracks-agent-"));
process.env.LH_DATA_DIR = TMP_DATA;
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { trackStore } = await import("../src/store/tracks.ts");
const tracks = await import("../src/server/tracks.ts");
const { createPlannerTools, createProberTools, createTeacherTools } = await import("../src/agent/tools.ts");
const { partDoneTool, proposeTrackTool, readPartTool, replanTrackTool } = await import("../src/agent/tools/track.ts");
const { composeInstructions, createPlannerAgent } = await import("../src/agent/teacher-agent.ts");
const { allSegmentPaths, listSourceSegments } = await import("../src/agent/prompt-segments.ts");
const { readPartWindow } = await import("../src/core/tracks.ts");
const { toolActivityLabel } = await import("../src/core/pending.ts");
type LhMessage = import("../src/core/native-messages.ts").LhMessage;
type SteerMessage = import("../src/core/contracts.ts").SteerMessage;

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

const PROPOSAL = {
	title: "SDF optical post-process shader",
	goal: "Understand the math behind the shader.",
	explanation: "More than one session can teach well.",
	findings: [{ kind: "held", text: "Unreal material graph basics." }],
	parts: [
		{ id: "distance-fields", title: "Distance fields", why: "The rest measures from the edge.", dependsOn: [] },
		{ id: "sdf-texture", title: "SDFs in a texture", why: "The lens arrives as a texture.", dependsOn: ["distance-fields"] },
		{ id: "uv-space", title: "UV and screen space", why: "Every layer moves in UV space.", dependsOn: [] },
	],
};

function assistantCall(id: string, name: string, args: unknown): LhMessage {
	return {
		id,
		role: "assistant",
		content: [{ type: "toolCall", id: `call_${id}`, name, arguments: args as never }],
		api: "openai-completions",
		provider: "openrouter",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		stopReason: "toolUse",
		timestamp: Date.now(),
	} as never;
}
function assistantText(id: string, text: string): LhMessage {
	return {
		id,
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "openrouter",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		stopReason: "stop",
		timestamp: Date.now(),
	} as never;
}
function cleanResult(id: string, name: string): LhMessage {
	return { id: `${id}_r`, role: "toolResult", toolCallId: `call_${id}`, toolName: name, content: [{ type: "text", text: "ok" }], isError: false, timestamp: Date.now() } as never;
}
/** An ask_user_question CALL with no result — the dangling question. */
function openQuestion(id: string): LhMessage {
	return assistantCall(id, "ask_user_question", { question: "Which?", options: [{ label: "A" }, { label: "B" }] });
}

function planningChat(): string {
	const chat = chatStore.createChat("I want to understand the SDF shader");
	chatStore.saveMessages(chat.id, [
		{ id: "u1", role: "user", content: "I want to understand the SDF shader, fully.", timestamp: 1 } as never,
		assistantCall("a1", "propose_track", PROPOSAL),
		cleanResult("a1", "propose_track"),
	]);
	return chat.id;
}

function startedTrack(): { planningChatId: string; trackId: string } {
	const planningChatId = planningChat();
	const out = tracks.startTrack(planningChatId);
	assert.ok(out.ok);
	if (!out.ok) throw new Error("unreachable");
	return { planningChatId, trackId: out.track.id };
}

async function run(tools: Record<string, { execute: (id: string, input: never) => Promise<unknown> }>, name: string, input: unknown) {
	const t = tools[name];
	assert.ok(t, `tool ${name} registered`);
	const r = (await t.execute("tc", input as never)) as { details: unknown; content: Array<{ text?: string }>; isError?: boolean };
	return { details: r.details as { ok?: boolean; error?: string; changed?: string }, text: r.content.map((c) => c.text ?? "").join("") };
}

const jobsCtx = { jobStore, spawn: () => {}, searchAvailable: () => false };

describe("registries — the track tools follow the chat's role", () => {
	it("prober: loose chat → propose_track; part chat → read_part; planning chat → neither; no trackStore → no track tools", () => {
		const base = { chatId: "c", chatStore, deliver: () => {}, ...jobsCtx };
		const plain = Object.keys(createProberTools(base));
		assert.ok(!plain.includes("propose_track") && !plain.includes("read_part"));
		const loose = Object.keys(createProberTools({ ...base, trackStore, trackRole: null }));
		assert.ok(loose.includes("propose_track") && !loose.includes("read_part"));
		assert.ok(loose.includes("probe_done"), "probe_done stays");
		const part = Object.keys(createProberTools({ ...base, trackStore, trackRole: "teaching" }));
		assert.ok(part.includes("read_part") && !part.includes("propose_track"));
		const planning = Object.keys(createProberTools({ ...base, trackStore, trackRole: "planning" }));
		assert.ok(!planning.includes("read_part") && !planning.includes("propose_track"));
	});

	it("teacher: a part chat gets part_done (always-on) + read_part; a loose chat gets neither", () => {
		const base = { chatId: "c", chatStore, ...jobsCtx };
		const loose = Object.keys(createTeacherTools(base));
		assert.ok(!loose.includes("part_done") && !loose.includes("read_part"));
		assert.ok(loose.includes("plan_init"));
		const part = createTeacherTools({ ...base, trackStore, trackRole: "teaching", deliver: () => {} }, { part_done: false, read_part: false });
		assert.ok(Object.keys(part).includes("part_done"), "part_done cannot be toggled off");
		assert.ok(!Object.keys(part).includes("read_part"), "read_part is an ordinary toggleable");
		const partOn = Object.keys(createTeacherTools({ ...base, trackStore, trackRole: "teaching", deliver: () => {} }));
		assert.ok(partOn.includes("read_part") && partOn.includes("part_done") && partOn.includes("quiz"));
	});

	it("planner: propose_track until the track starts, then replan_track + read_part; never quiz/plan tools", () => {
		const planningChatId = planningChat();
		const ctx = { chatId: planningChatId, chatStore, trackStore, ...jobsCtx };
		const before = Object.keys(createPlannerTools(ctx));
		assert.ok(before.includes("propose_track") && !before.includes("replan_track") && !before.includes("read_part"));
		assert.ok(before.includes("ask_user_question") && before.includes("read") && before.includes("pdf"));
		assert.ok(!before.includes("quiz") && !before.includes("probe") && !before.includes("plan_init") && !before.includes("probe_done"));
		assert.ok(tracks.startTrack(planningChatId).ok);
		const after = Object.keys(createPlannerTools(ctx, { replan_track: false }));
		assert.ok(after.includes("replan_track") && after.includes("read_part") && !after.includes("propose_track"), "stage tools are always-on");
		const agent = createPlannerAgent(ctx, { engine: { model: { provider: "openrouter", id: "test" }, level: "off", streamFn: (async () => {}) as never } as never });
		assert.ok(agent, "the planner constructs");
	});
});

describe("propose_track", () => {
	it("refuses an open question, invalid parts, and a started track; records otherwise and renames the chat", async () => {
		const chat = chatStore.createChat("Brief");
		const tools = proposeTrackTool({ chatId: chat.id, chatStore, trackStore });
		chatStore.saveMessages(chat.id, [openQuestion("q1")]);
		const open = await run(tools, "propose_track", PROPOSAL);
		assert.equal(open.details.ok, false);
		assert.match(open.details.error ?? "", /question is still open/);
		chatStore.saveMessages(chat.id, []);
		const bad = await run(tools, "propose_track", { ...PROPOSAL, parts: [...PROPOSAL.parts, { id: "x", title: "X", why: "w", dependsOn: ["ghost"] }] });
		assert.equal(bad.details.ok, false);
		assert.match(bad.details.error ?? "", /unknown part "ghost"/);
		const ok = await run(tools, "propose_track", PROPOSAL);
		assert.equal(ok.details.ok, true);
		assert.match(ok.text, /Proposal recorded/);
		assert.equal(chatStore.getChat(chat.id)?.title, PROPOSAL.title, "the planning chat takes the proposal's title");
		assert.equal(trackStore.readEvents().some((e) => e.type === "created" && e.planningChatId === chat.id), false, "nothing touches the ledger");
		// Start the track from a proposal in the record, then the tool is closed.
		chatStore.saveMessages(chat.id, [assistantCall("a1", "propose_track", PROPOSAL), cleanResult("a1", "propose_track")]);
		assert.ok(tracks.startTrack(chat.id).ok);
		const closed = await run(tools, "propose_track", PROPOSAL);
		assert.equal(closed.details.ok, false);
		assert.match(closed.details.error ?? "", /already started/);
	});
});

describe("replan_track", () => {
	it("refuses before the start, a bad afterPartId and dropping a started part; otherwise appends the replanned event with system numbers", async () => {
		const fresh = planningChat();
		const early = await run(replanTrackTool({ chatId: fresh, chatStore, trackStore }), "replan_track", { note: "n", parts: PROPOSAL.parts });
		assert.equal(early.details.ok, false);
		assert.match(early.details.error ?? "", /No track has started/);

		const { planningChatId, trackId } = startedTrack();
		const tools = replanTrackTool({ chatId: planningChatId, chatStore, trackStore });
		const started = tracks.startPart(trackId, "distance-fields");
		assert.ok(started.ok);
		const blank = await run(tools, "replan_track", { note: "   ", parts: PROPOSAL.parts });
		assert.match(blank.details.error ?? "", /note is empty/);
		const badAfter = await run(tools, "replan_track", { afterPartId: "nope", note: "n", parts: PROPOSAL.parts });
		assert.match(badAfter.details.error ?? "", /afterPartId "nope"/);
		const dropped = await run(tools, "replan_track", { note: "n", parts: PROPOSAL.parts.filter((p) => p.id !== "distance-fields").map((p) => ({ ...p, dependsOn: [] })) });
		assert.match(dropped.details.error ?? "", /cannot be dropped/);
		const split = await run(tools, "replan_track", {
			afterPartId: "distance-fields",
			note: "SDFs in a texture is two sessions: the texture, then the material.",
			parts: [
				PROPOSAL.parts[0],
				PROPOSAL.parts[1],
				{ id: "sdf-texture-pixels", title: "What the pixels hold", why: "w", dependsOn: ["distance-fields"], parentPartId: "sdf-texture" },
				{ id: "sdf-texture-material", title: "Reading it in a material", why: "w", dependsOn: ["sdf-texture-pixels"], parentPartId: "sdf-texture" },
				PROPOSAL.parts[2],
				{ id: "gradients", title: "SDF gradients", why: "w", dependsOn: ["sdf-texture", "uv-space"] },
			],
		});
		assert.equal(split.details.ok, true, split.details.error);
		assert.equal(split.details.changed, "split 2 into 2a, 2b; added 4 · SDF gradients");
		assert.match(split.text, /Re-plan recorded/);
		const view = tracks.getTrackView(trackId)!;
		assert.deepEqual(view.parts.map((p) => p.number), ["1", "2", "2a", "2b", "3", "4"]);
		assert.equal(view.parts.find((p) => p.id === "sdf-texture")?.status, "split");
		assert.equal(view.replans.length, 1);
		assert.equal(view.replans[0]?.afterPartId, "distance-fields");
		assert.ok(view.log.some((e) => e.kind === "replanned" && e.text.includes("split 2 into 2a, 2b")));
	});
});

describe("part_done", () => {
	it("refuses outside a part chat, with an open question, and twice; delivers the re-plan steer once", async () => {
		const loose = chatStore.createChat("loose");
		const delivered: SteerMessage[] = [];
		const looseTools = partDoneTool({ chatId: loose.id, chatStore, trackStore, deliver: (s) => delivered.push(s) });
		const notPart = await run(looseTools, "part_done", { summary: "held" });
		assert.match(notPart.details.error ?? "", /not a track part/);

		const { planningChatId, trackId } = startedTrack();
		const started = tracks.startPart(trackId, "distance-fields");
		assert.ok(started.ok);
		if (!started.ok) return;
		const chatId = started.chatId;
		const tools = partDoneTool({ chatId, chatStore, trackStore, deliver: (s) => delivered.push(s) });
		const marker = chatStore.getChat(chatId)!.messages;
		chatStore.saveMessages(chatId, [...marker, openQuestion("q1")]);
		const open = await run(tools, "part_done", { summary: "held" });
		assert.match(open.details.error ?? "", /question is still open/);
		chatStore.saveMessages(chatId, [...marker, assistantText("t1", "Distance fields: the shortest way to the edge.")]);
		const ok = await run(tools, "part_done", { summary: "A field measures the shortest way to the edge.", shaky: "Sign conventions." });
		assert.equal(ok.details.ok, true);
		assert.match(ok.text, /Part recorded as done/);
		assert.equal(delivered.length, 1);
		assert.equal(delivered[0]!.id, `steer_track_${trackId}_distance-fields`);
		assert.equal(delivered[0]!.customType, "track-replan");
		assert.ok(delivered[0]!.content.includes("part 1 · Distance fields (id distance-fields)"));
		assert.ok(delivered[0]!.content.includes("A field measures the shortest way to the edge."));
		assert.ok(delivered[0]!.content.includes("What stayed shaky: Sign conventions."));
		assert.deepEqual(delivered[0]!.details, { trackId, planningChatId, partId: "distance-fields", partNumber: "1", partTitle: "Distance fields" });
		// Once the call landed cleanly in the record, a second one refuses.
		chatStore.saveMessages(chatId, [...chatStore.getChat(chatId)!.messages, assistantCall("d1", "part_done", { summary: "x" }), cleanResult("d1", "part_done")]);
		const twice = await run(tools, "part_done", { summary: "again" });
		assert.match(twice.details.error ?? "", /already done/);
		assert.equal(delivered.length, 1);
	});
});

describe("read_part", () => {
	it("names the parts on an unknown id, refuses an untaught part, returns TEACHER passages with ids and a continuation", async () => {
		const { planningChatId, trackId } = startedTrack();
		const plannerTools = readPartTool({ chatId: planningChatId, chatStore, trackStore });
		const unknown = await run(plannerTools, "read_part", { partId: "ghost" });
		assert.match(unknown.details.error ?? "", /No part "ghost".*distance-fields \(1 · Distance fields\)/);
		const untaught = await run(plannerTools, "read_part", { partId: "uv-space" });
		assert.match(untaught.details.error ?? "", /has not been taught yet/);
		const started = tracks.startPart(trackId, "distance-fields");
		assert.ok(started.ok);
		if (!started.ok) return;
		const marker = chatStore.getChat(started.chatId)!.messages;
		chatStore.saveMessages(started.chatId, [
			...marker,
			assistantText("t1", "A distance field stores, per point, the shortest distance to the shape."),
			{ id: "u2", role: "user", content: "ok", timestamp: 2 } as never,
			assistantText("t2", "Signed: negative inside, positive outside."),
		]);
		// A dependent part's chat reads it too.
		chatStore.saveMessages(started.chatId, [...chatStore.getChat(started.chatId)!.messages, assistantCall("d1", "part_done", { summary: "held" }), cleanResult("d1", "part_done")]);
		const second = tracks.startPart(trackId, "sdf-texture");
		assert.ok(second.ok);
		if (!second.ok) return;
		const partTools = readPartTool({ chatId: second.chatId, chatStore, trackStore });
		const read = await run(partTools, "read_part", { partId: "distance-fields" });
		assert.ok(read.text.startsWith("Part 1 · Distance fields — passages 1–2 of 2"), read.text);
		assert.ok(read.text.includes("TEACHER [t1]\nA distance field stores"));
		assert.ok(read.text.includes("TEACHER [t2]\nSigned:"));
		assert.ok(!read.text.includes("\nok\n"), "the learner's side is not in the passages");
		assert.ok(read.text.endsWith("[end of part]"));
		const past = await run(partTools, "read_part", { partId: "distance-fields", offset: 40 });
		assert.match(past.text, /has 2 passages — offset 40 is past the end/);
	});

	it("readPartWindow: budgets by characters, always fits one passage, and points at the continuation", () => {
		const passages = [
			{ messageId: "m1", text: "a".repeat(100) },
			{ messageId: "m2", text: "b".repeat(100) },
			{ messageId: "m3", text: "c".repeat(100) },
		];
		const first = readPartWindow(passages, 0, 250);
		assert.equal(first.nextOffset, 2, "two passages fit in 250 chars");
		assert.ok(first.text.includes("TEACHER [m1]") && first.text.includes("TEACHER [m2]") && !first.text.includes("[m3]"));
		const rest = readPartWindow(passages, 2, 250);
		assert.equal(rest.nextOffset, null);
		assert.ok(rest.text.startsWith("TEACHER [m3]"));
		const tiny = readPartWindow(passages, 0, 10);
		assert.equal(tiny.nextOffset, 1, "the first passage always fits, however long");
		assert.equal(readPartWindow(passages, 99, 250).text, "");
	});
});

describe("prompts — the planner composes its own directory + the curated appendix", () => {
	it("segments and composition", () => {
		const paths = allSegmentPaths();
		for (const p of ["planner/10-track-planning.md", "prober/20-tracks.md", "shared/35-track-parts.md"]) assert.ok(paths.includes(p), p);
		const planner = listSourceSegments("planner").map((s) => s.path);
		assert.equal(planner[0], "system-prompt.md");
		assert.ok(planner.includes("planner/10-track-planning.md"));
		assert.ok(planner.includes("shared/10-voice.md") && planner.includes("shared/30-learner-files.md") && planner.includes("shared/40-formatting.md"));
		assert.ok(!planner.includes("shared/20-question-tools.md") && !planner.includes("shared/35-track-parts.md") && !planner.includes("shared/25-confidence.md"));
		assert.ok(!planner.some((p) => p.startsWith("prober/") || p.startsWith("teacher/")));
		const text = composeInstructions("planner");
		assert.ok(text.includes("# The track planner") && text.includes("replan_track") && text.includes("propose_track"));
		assert.ok(!text.includes("## The question tools"));
		assert.ok(composeInstructions("prober").includes("`propose_track`"));
		assert.ok(composeInstructions("teacher").includes("## Inside a track part"));
		assert.ok(composeInstructions("prober").includes("## Inside a track part"));
		assert.ok(!composeInstructions("practice").includes("## Inside a track part"));
		assert.equal(toolActivityLabel("propose_track"), "Proposing a track…");
		assert.equal(toolActivityLabel("part_done"), "Recording the part as done…");
	});
});
