/**
 * Finished figure/demo results held behind an open question: the wake
 * pipeline marks them "ready: arrives after your answer" while the question
 * waits, then delivers once it's answered; the card says so (or shows the
 * result now when the teacher set showBeforeAnswer). Throwaway data dir.
 * (tsx uses the classic JSX transform, hence the React global shim.)
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { JobRecord, SteerMessage } from "../src/core/contracts.ts";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-job-held-"));
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

const openQuiz = {
	id: "a1",
	role: "assistant",
	content: [{ type: "toolCall", id: "quiz-call", name: "quiz", arguments: { question: "q", options: [] } }],
	api: "openai-completions",
	provider: "test",
	model: "test",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	stopReason: "toolUse",
	timestamp: 2,
};

describe("the wake pipeline and an open question", () => {
	it("marks a finished result ready while the question waits, then delivers it after the answer", async () => {
		const chat = chatStore.createChat("held result");
		chatStore.saveMessages(chat.id, [{ id: "u1", role: "user", content: "hi", timestamp: 1 } as never, openQuiz as never]);
		const job = jobStore.createJob({ kind: "visual", chatId: chat.id, toolCallId: "call_fig" });
		const result = { svg: "<svg/>" };
		jobStore.updateJob(job.id, { result, activity: "delivering result" });
		const steer: SteerMessage = core.buildSubagentSteer(job, result);
		let fired = 0;
		server.setTurnRunner(async () => {
			fired++;
			return 200;
		});

		const delivery = server.deliverJobResult(steer);
		await waitFor(() => jobStore.getJob(job.id)!.activity === core.AWAITING_ANSWER_ACTIVITY, 4000, "the ready mark");
		assert.equal(jobStore.getJob(job.id)!.status, "running");
		assert.equal(fired, 0, "no wake while the question is open");

		const record = chatStore.getChat(chat.id)!;
		chatStore.saveMessages(chat.id, [
			...record.messages,
			{ id: "r1", role: "toolResult", toolCallId: "quiz-call", toolName: "quiz", content: [{ type: "text", text: "a" }], details: {}, isError: false, timestamp: 3 } as never,
		]);
		await waitFor(() => fired > 0, 8000, "the wake after the answer");
		await delivery;
		await waitFor(() => jobStore.getJob(job.id)!.status !== "running", 8000, "the job settling");
		assert.equal(jobStore.getJob(job.id)!.status, "done");
		assert.equal(jobStore.getJob(job.id)!.activity, "delivered");
	});
});

describe("results finishing at different times", () => {
	it("a result that finishes while another already waits is marked ready too", async () => {
		const chat = chatStore.createChat("two held results");
		chatStore.saveMessages(chat.id, [{ id: "u1", role: "user", content: "hi", timestamp: 1 } as never, openQuiz as never]);
		server.setTurnRunner(async () => 200);
		const finished = (toolCallId: string) => {
			const job = jobStore.createJob({ kind: "visual", chatId: chat.id, toolCallId });
			const result = { svg: "<svg/>" };
			jobStore.updateJob(job.id, { result, activity: "delivering result" });
			return { job, steer: core.buildSubagentSteer(job, result) };
		};
		const first = finished("call_a");
		const firstDelivery = server.deliverJobResult(first.steer);
		await waitFor(() => jobStore.getJob(first.job.id)!.activity === core.AWAITING_ANSWER_ACTIVITY, 4000, "the first mark");
		const second = finished("call_b");
		const secondDelivery = server.deliverJobResult(second.steer);
		await waitFor(() => jobStore.getJob(second.job.id)!.activity === core.AWAITING_ANSWER_ACTIVITY, 4000, "the second mark");

		// Answer, so both deliveries finish inside the test.
		const record = chatStore.getChat(chat.id)!;
		chatStore.saveMessages(chat.id, [
			...record.messages,
			{ id: "r1", role: "toolResult", toolCallId: "quiz-call", toolName: "quiz", content: [{ type: "text", text: "a" }], details: {}, isError: false, timestamp: 3 } as never,
		]);
		await Promise.all([firstDelivery, secondDelivery]);
	});
});

describe("the job card while a result is held", () => {
	const held = (over: Partial<JobRecord> = {}): JobRecord => ({
		id: "job_1",
		kind: "visual",
		chatId: "chat_1",
		toolCallId: "call_fig",
		status: "running",
		activity: core.AWAITING_ANSWER_ACTIVITY,
		result: { svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle r="4"/></svg>' },
		createdAt: "2026-10-26T15:00:00.000Z",
		updatedAt: "2026-10-26T15:01:00.000Z",
		...over,
	});

	async function render(job: JobRecord, node: (cards: typeof import("../components/artifacts/visual-card.tsx") & typeof import("../components/artifacts/dispatch-card.tsx")) => React.ReactElement) {
		const visual = await import("../components/artifacts/visual-card.tsx");
		const dispatch = await import("../components/artifacts/dispatch-card.tsx");
		const { JobsContext } = await import("../components/jobs-context.ts");
		return renderToStaticMarkup(<JobsContext.Provider value={[job]}>{node({ ...visual, ...dispatch })}</JobsContext.Provider>);
	}

	it("says it's ready and arrives after the answer, with no spinner", async () => {
		const html = await render(held(), ({ DispatchCard }) => <DispatchCard toolCallId="call_fig" kind="visual" />);
		assert.match(html, /data-testid="dispatch-held"/);
		assert.match(html, /ready · arrives after you answer the question/);
		assert.doesNotMatch(html, /data-testid="dispatch-card"/);
	});

	it("shows the figure now when the teacher set showBeforeAnswer", async () => {
		const part = { type: "tool-visual", state: "output-available", toolCallId: "call_fig", input: { brief: "a circle", showBeforeAnswer: true } };
		const html = await render(held(), ({ VisualCard }) => <VisualCard part={part} />);
		assert.match(html, /data-testid="dispatch-early"/);
		assert.match(html, /shown now to help with the question/);
		assert.match(html, /src="data:image\/svg\+xml/, "the figure itself renders");
	});

	it("without the flag the figure waits", async () => {
		const part = { type: "tool-visual", state: "output-available", toolCallId: "call_fig", input: { brief: "a circle" } };
		const html = await render(held(), ({ VisualCard }) => <VisualCard part={part} />);
		assert.doesNotMatch(html, /dispatch-early|data:image/);
		assert.match(html, /arrives after you answer the question/);
	});

	it("a failed result says so now", async () => {
		const html = await render(held({ error: "FAILED: never verified" }), ({ DispatchCard }) => <DispatchCard toolCallId="call_fig" kind="visual" />);
		assert.match(html, /failed · your tutor hears after you answer the question/);
	});
});

describe("the teacher's flag", () => {
	it("is an optional boolean on the demo and visual tools, and only `true` counts", async () => {
		const tools = await import("../src/agent/tools/jobs.ts");
		for (const schema of [tools.visualInputSchema, tools.demoInputSchema]) {
			const field = (schema as { properties: Record<string, { type?: string }> }).properties.showBeforeAnswer;
			assert.equal(field?.type, "boolean");
			assert.ok(!(schema as { required?: string[] }).required?.includes("showBeforeAnswer"));
		}
		assert.equal(core.showsBeforeAnswer({ showBeforeAnswer: true }), true);
		for (const input of [{}, { showBeforeAnswer: "true" }, null, undefined]) assert.equal(core.showsBeforeAnswer(input), false);
	});

	it("the tutor is told when to set it", () => {
		const demos = fs.readFileSync("src/agent/prompts/teacher/50-demos.md", "utf-8");
		assert.match(demos, /Set `showBeforeAnswer: true` \(demo and visual\) only when they should see it WHILE answering/);
		assert.match(demos, /Anything that shows what the question asks for .* never gets it/);
	});
});
