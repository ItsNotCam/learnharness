/**
 * One delivery per result, however often it's re-queued (the 25-copies
 * incident, 2026-10-26: a figure and a demo held behind an open question
 * across a restart were re-queued by crash recovery on every jobs poll,
 * then all fired into one turn). Throwaway data dir.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-job-redelivery-"));
process.env.LH_DATA_DIR = dataDir;

let core: typeof import("../src/core/contracts.ts");
let server: typeof import("../src/server/jobs.ts");
let chatStore: typeof import("../src/store/chats.ts").chatStore;
let jobStore: typeof import("../src/store/jobs.ts").jobStore;

before(async () => {
	core = await import("../src/core/contracts.ts");
	server = await import("../src/server/jobs.ts");
	({ chatStore } = await import("../src/store/chats.ts"));
	({ jobStore } = await import("../src/store/jobs.ts"));
});
after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check: () => boolean, ms: number, what: string): Promise<void> {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await delay(50);
	}
}

/** A chat with an open question and a finished figure waiting behind it. */
function heldFigure() {
	const chat = chatStore.createChat("held figure");
	chatStore.saveMessages(chat.id, [
		{ id: "u1", role: "user", content: "hi", timestamp: 1 } as never,
		{
			id: "a1",
			role: "assistant",
			content: [{ type: "toolCall", id: "quiz-call", name: "quiz", arguments: { question: "q", options: [] } }],
			api: "openai-completions",
			provider: "test",
			model: "test",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			stopReason: "toolUse",
			timestamp: 2,
		} as never,
	]);
	const job = jobStore.createJob({ kind: "visual", chatId: chat.id, toolCallId: "call_fig" });
	const result = { svg: "<svg/>" };
	jobStore.updateJob(job.id, { result, activity: "delivering result" });
	return { chatId: chat.id, job, steer: core.buildSubagentSteer(job, result) };
}

function answer(chatId: string) {
	const record = chatStore.getChat(chatId)!;
	chatStore.saveMessages(chatId, [
		...record.messages,
		{ id: "r1", role: "toolResult", toolCallId: "quiz-call", toolName: "quiz", content: [{ type: "text", text: "a" }], details: {}, isError: false, timestamp: 3 } as never,
	]);
}

describe("re-delivering a held result", () => {
	it("crash recovery leaves a result alone while it's already queued", async () => {
		const { chatId, job, steer } = heldFigure();
		const wakes: string[][] = [];
		server.setTurnRunner(async (_chat, input) => {
			wakes.push(((input as { steers: { id: string }[] }).steers ?? []).map((s) => s.id));
			return 200;
		});
		const delivery = server.deliverJobResult(steer);
		await waitFor(() => jobStore.getJob(job.id)!.activity === core.AWAITING_ANSWER_ACTIVITY, 4000, "the held mark");

		// The job reads "running" with a result and no live loop (as after a
		// restart): recovery would re-deliver it, but it's already in line.
		server.recoverStaleJobs();
		assert.equal(jobStore.getJob(job.id)!.activity, core.AWAITING_ANSWER_ACTIVITY, "not re-queued");

		answer(chatId);
		await delivery;
		assert.deepEqual(wakes, [[steer.id]], "one wake carrying the result once");
	});

	it("the same result queued several times reaches the tutor once, and every caller resolves", async () => {
		const { chatId, steer } = heldFigure();
		const wakes: string[][] = [];
		server.setTurnRunner(async (_chat, input) => {
			wakes.push(((input as { steers: { id: string }[] }).steers ?? []).map((s) => s.id));
			return 200;
		});
		const deliveries = [server.deliverJobResult(steer), server.deliverJobResult(steer), server.deliverJobResult(steer)];
		await delay(600);
		answer(chatId);
		await Promise.all(deliveries);
		assert.deepEqual(wakes, [[steer.id]]);
	});
});
