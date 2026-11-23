/**
 * The track service (docs/tracks.md) under an isolated LH_DATA_DIR: Start
 * track from a planning chat's proposal, Start part (the newborn chat, its
 * track-context marker, the opening turn left to the route), part_done
 * read off the chat record, Practice this part, the learner-requested
 * re-plan steer through the wake pipeline, rename, delete — plus the route
 * handlers driven directly (the chat-birth-stamp pattern). No LLM anywhere.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-tracks-server-"));
process.env.LH_DATA_DIR = TMP_DATA;
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const { chatStore } = await import("../src/store/chats.ts");
const { trackStore } = await import("../src/store/tracks.ts");
const tracks = await import("../src/server/tracks.ts");
const { setTurnRunner } = await import("../src/server/jobs.ts");
const listRoute = await import("../app/api/tracks/route.ts");
const oneRoute = await import("../app/api/tracks/[id]/route.ts");
type LhMessage = import("../src/core/native-messages.ts").LhMessage;
type TurnInput = import("../src/core/input-events.ts").TurnInput;

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});
afterEach(() => {
	setTurnRunner(async () => 200);
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
	leftOut: "The finished material.",
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
function cleanResult(id: string, name: string): LhMessage {
	return {
		id: `${id}_r`,
		role: "toolResult",
		toolCallId: `call_${id}`,
		toolName: name,
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: Date.now(),
	} as never;
}

/** A planning chat: the brief, then the prober's clean propose_track. */
function planningChat(title = "I want to understand the SDF shader"): string {
	const chat = chatStore.createChat(title);
	chatStore.saveMessages(chat.id, [
		{ id: "u1", role: "user", content: "I want to understand the mathematics of the SDF shader, fully.", timestamp: 1 } as never,
		assistantCall("a1", "propose_track", PROPOSAL),
		cleanResult("a1", "propose_track"),
	]);
	return chat.id;
}

function waitFor(cond: () => boolean, timeoutMs = 6000, what = "condition"): Promise<void> {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const tick = () => {
			if (cond()) return resolve();
			if (Date.now() - started > timeoutMs) return reject(new Error(`timeout waiting for ${what}`));
			setTimeout(tick, 25);
		};
		tick();
	});
}

describe("startTrack — the planning chat's proposal becomes the track", () => {
	it("refuses an unknown chat and a chat without a proposal", () => {
		assert.deepEqual(tracks.startTrack("chat_nope"), { ok: false, status: 404, error: "Unknown session" });
		const plain = chatStore.createChat("plain");
		const out = tracks.startTrack(plain.id);
		assert.equal(out.ok, false);
		assert.equal(!out.ok && out.status, 409);
	});

	it("creates the track from the latest proposal — numbered parts, the brief verbatim — and is idempotent per chat", () => {
		const chatId = planningChat();
		assert.equal(chatStore.listChats().find((c) => c.id === chatId)?.proposedTrack, PROPOSAL.title, "the sidebar sees the proposal before the start");
		const out = tracks.startTrack(chatId);
		assert.ok(out.ok);
		if (!out.ok) return;
		assert.equal(out.created, true);
		assert.equal(out.track.title, PROPOSAL.title);
		assert.equal(out.track.goal, PROPOSAL.goal);
		assert.equal(out.track.brief, "I want to understand the mathematics of the SDF shader, fully.");
		assert.equal(out.track.leftOut, "The finished material.");
		assert.deepEqual(out.track.parts.map((p) => [p.id, p.number, p.status]), [
			["distance-fields", "1", "ready"],
			["sdf-texture", "2", "later"],
			["uv-space", "3", "ready"],
		]);
		assert.deepEqual(out.track.progress, { done: 0, total: 3 });
		assert.equal(out.track.planningChatId, chatId);
		assert.equal(out.track.planning?.kind, "planning");
		assert.ok(out.track.log.some((e) => e.text.startsWith("Placement probe: you already hold unreal material")));

		const again = tracks.startTrack(chatId);
		assert.ok(again.ok && !again.created && again.track.id === out.track.id, "a second Start track returns the same track");
		assert.equal(trackStore.readEvents().filter((e) => e.type === "created" && e.trackId === out.track.id).length, 1);

		const ctx = tracks.trackOfChat(chatId);
		assert.equal(ctx?.role, "planning");
		assert.equal(ctx?.trackId, out.track.id);
		assert.equal(ctx?.totalParts, 3);
	});
});

describe("startPart / part_done / attachPractice", () => {
	it("a ready part gets a newborn chat opened by its track-context marker; a second start returns it; a later part refuses", () => {
		const chatId = planningChat();
		const started = tracks.startTrack(chatId);
		assert.ok(started.ok);
		if (!started.ok) return;
		const trackId = started.track.id;

		const later = tracks.startPart(trackId, "sdf-texture");
		assert.equal(later.ok, false);
		assert.ok(!later.ok && later.status === 409 && /not ready/.test(later.error));
		assert.deepEqual(tracks.startPart(trackId, "ghost"), { ok: false, status: 404, error: "Unknown part" });
		assert.deepEqual(tracks.startPart("trk_ghost", "x"), { ok: false, status: 404, error: "Unknown track" });

		const first = tracks.startPart(trackId, "distance-fields");
		assert.ok(first.ok && first.created);
		if (!first.ok) return;
		const chat = chatStore.getChat(first.chatId);
		assert.ok(chat);
		assert.equal(chat.title, "Distance fields");
		assert.equal(chat.kind, undefined, "a teaching session");
		assert.equal(chat.messages.length, 1);
		const marker = chat.messages[0] as { role: string; customType?: string; content?: string; details?: unknown };
		assert.equal(marker.role, "custom");
		assert.equal(marker.customType, "track-context");
		assert.ok(marker.content?.startsWith("[Track context] — this session is part 1 of 3"));
		assert.ok(marker.content?.includes("END GOAL: Understand the math behind the shader."));
		assert.deepEqual(marker.details, { trackId, partId: "distance-fields", role: "teaching" });

		const view = tracks.getTrackView(trackId)!;
		assert.equal(view.parts[0]?.status, "in-progress");
		assert.equal(view.parts[0]?.teaching?.id, first.chatId);
		assert.ok(view.log.some((e) => e.text === "Part 1 · Distance fields started."));

		const again = tracks.startPart(trackId, "distance-fields");
		assert.deepEqual(again, { ok: true, chatId: first.chatId, created: false });

		const ctx = tracks.trackOfChat(first.chatId);
		assert.equal(ctx?.role, "teaching");
		assert.equal(ctx?.partNumber, "1");
		assert.equal(ctx?.partTitle, "Distance fields");
		assert.deepEqual(ctx?.parts.map((p) => p.teachingChatId), [first.chatId, null, null]);

		// part_done lands in the chat record: the part reads done, the dependent is ready.
		chatStore.saveMessages(first.chatId, [
			...chat.messages,
			assistantCall("d1", "part_done", { summary: "Distance fields held: a field measures the shortest way to the edge.", shaky: "Sign conventions." }),
			cleanResult("d1", "part_done"),
		]);
		const doneView = tracks.getTrackView(trackId)!;
		assert.equal(doneView.parts[0]?.status, "done");
		assert.equal(doneView.parts[0]?.summary, "Distance fields held: a field measures the shortest way to the edge.");
		assert.equal(doneView.parts[0]?.shaky, "Sign conventions.");
		assert.equal(doneView.parts[1]?.status, "ready");
		assert.deepEqual(doneView.progress, { done: 1, total: 3 });
		assert.ok(doneView.log.some((e) => e.kind === "part-done"));

		// The next part's context block carries the summary.
		const second = tracks.startPart(trackId, "sdf-texture");
		assert.ok(second.ok && second.created);
		if (!second.ok) return;
		const secondMarker = chatStore.getChat(second.chatId)!.messages[0] as { content: string };
		assert.ok(secondMarker.content.includes("Summary: Distance fields held"));
		assert.ok(secondMarker.content.includes("Shaky: Sign conventions."));

		// Practice this part: a practice newborn with the track context.
		const practice = tracks.attachPractice(trackId, "distance-fields");
		assert.ok(practice.ok && practice.created);
		if (!practice.ok) return;
		const practiceChat = chatStore.getChat(practice.chatId)!;
		assert.equal(practiceChat.kind, "practice");
		assert.equal(practiceChat.title, "Practice · Distance fields");
		const pm = practiceChat.messages[0] as { customType?: string; content?: string; details?: unknown };
		assert.equal(pm.customType, "track-context");
		assert.ok(pm.content?.startsWith("[Track context] — this is a practice session for part 1"));
		assert.deepEqual(pm.details, { trackId, partId: "distance-fields", role: "practice" });
		assert.equal(tracks.getTrackView(trackId)!.parts[0]?.practice.length, 1);
		assert.equal(tracks.trackOfChat(practice.chatId)?.role, "practice");
		assert.ok(!tracks.attachPractice(trackId, "uv-space").ok, "an unstarted part has nothing to practice");
	});
});

describe("requestReplan — the learner's re-plan wake", () => {
	it("delivers a track-replan steer to the planning chat through the wake pipeline", async () => {
		const chatId = planningChat();
		const started = tracks.startTrack(chatId);
		assert.ok(started.ok);
		if (!started.ok) return;
		const fired: Array<{ chatId: string; input: TurnInput }> = [];
		setTurnRunner(async (id, input) => {
			fired.push({ chatId: id, input });
			// The wake persists the steer under its own turn claim in production;
			// mimic the landing so the pump's idempotency check settles.
			if (input.type === "steers") chatStore.saveMessages(id, [...chatStore.getChat(id)!.messages, ...input.steers]);
			return 200;
		});
		const out = tracks.requestReplan(started.track.id);
		assert.deepEqual(out, { ok: true, planningChatId: chatId });
		await waitFor(() => fired.length > 0, 6000, "the re-plan wake");
		assert.equal(fired[0]!.chatId, chatId);
		const input = fired[0]!.input;
		assert.equal(input.type, "steers");
		if (input.type !== "steers") return;
		const steer = input.steers[0] as { customType?: string; content?: string; details?: { partId: unknown } };
		assert.equal(steer.customType, "track-replan");
		assert.ok(steer.content?.includes("the learner asked you to re-plan"));
		assert.equal(steer.details?.partId, null);
		assert.deepEqual(tracks.requestReplan("trk_ghost"), { ok: false, status: 404, error: "Unknown track" });
		// The planning session deleted on its own: nothing to re-plan in.
		chatStore.deleteChat(chatId);
		const gone = tracks.requestReplan(started.track.id);
		assert.equal(gone.ok, false);
		assert.equal(!gone.ok && gone.status, 409);
	});
});

describe("renameTrack / deleteTrack", () => {
	it("rename appends the event; delete removes every session and leaves a tombstone", async () => {
		const chatId = planningChat();
		const started = tracks.startTrack(chatId);
		assert.ok(started.ok);
		if (!started.ok) return;
		const trackId = started.track.id;
		assert.deepEqual(tracks.renameTrack(trackId, "  Lens math  "), { ok: true, title: "Lens math" });
		assert.equal(tracks.getTrackView(trackId)?.title, "Lens math");
		assert.equal(tracks.renameTrack(trackId, "   ").ok, false);
		const part = tracks.startPart(trackId, "distance-fields");
		assert.ok(part.ok);
		if (!part.ok) return;

		const deleted = await tracks.deleteTrack(trackId, "preserve-graph");
		assert.ok(deleted.ok, JSON.stringify(deleted));
		if (!deleted.ok) return;
		assert.equal(deleted.sessionsRemoved, 2, "the planning chat and the part chat");
		assert.equal(chatStore.getChat(chatId), null);
		assert.equal(chatStore.getChat(part.chatId), null);
		assert.equal(tracks.getTrackView(trackId), null);
		assert.equal(tracks.trackOfChat(part.chatId), null);
		assert.deepEqual(await tracks.deleteTrack(trackId, "preserve-graph"), { ok: false, status: 404, code: "not_found", error: "No such track" });
	});
});

describe("the routes — GET /api/tracks, POST /api/tracks, GET/PUT/DELETE /api/tracks/[id]", () => {
	it("list, create (201 then 200), read one, 404 for a stranger", async () => {
		const chatId = planningChat();
		const create = await listRoute.POST(new Request("http://test/api/tracks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId }) }));
		assert.equal(create.status, 201);
		const { track } = (await create.json()) as { track: { id: string } };
		const again = await listRoute.POST(new Request("http://test/api/tracks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId }) }));
		assert.equal(again.status, 200, "idempotent");
		const list = await listRoute.GET();
		const body = (await list.json()) as { tracks: Array<{ id: string }> };
		assert.ok(body.tracks.some((t) => t.id === track.id));
		const one = await oneRoute.GET(new Request("http://test"), { params: Promise.resolve({ id: track.id }) });
		assert.equal(one.status, 200);
		const missing = await oneRoute.GET(new Request("http://test"), { params: Promise.resolve({ id: "trk_nope" }) });
		assert.equal(missing.status, 404);
		const badMode = await oneRoute.DELETE(new Request("http://test/api/tracks/x?mode=whatever"), { params: Promise.resolve({ id: track.id }) });
		assert.equal(badMode.status, 400);
		const noChat = await listRoute.POST(new Request("http://test/api/tracks", { method: "POST", body: "{}" }));
		assert.equal(noChat.status, 400);
	});
});
