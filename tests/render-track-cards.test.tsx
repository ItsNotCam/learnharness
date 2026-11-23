/**
 * The track cards, the rail and the part:// chip, server-rendered
 * (docs/tracks.md §7): the proposal card's header/findings/list/actions by
 * stage (live / superseded / started), the re-plan card, the part_done
 * card, the re-plan divider, the track-context card, the rail's sections,
 * the md anchor's chip resolution, the graph filter's visible set, and the
 * registry entries. Pure functions of their inputs + a context value.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PartDoneCard, TrackContextCard, TrackProposalBody, TrackProposalCard, TrackReplanCard, TrackReplanDivider, startsText, type ProposalStage } from "../components/track-cards.tsx";
import { TrackChatContext, type TrackChatContextValue } from "../components/track-context.tsx";
import { TrackRailBody, readyParts } from "../components/track-rail.tsx";
import { MarkdownAnchor, mdComponents } from "../components/md-blocks.tsx";
import { MessageResponse } from "../components/ai-elements/message.tsx";
import { artifactRenderers } from "../components/artifacts/index.ts";
import { ToolCallCard } from "../components/artifacts/tool-call-card.tsx";
import { filteredNodeIds } from "../components/graph-view.tsx";
import type { ChatTrackContext, TrackChatFacts, TrackEvent, TrackPartSpec } from "../src/core/contracts.ts";
import { deriveTrackView, foldTracks } from "../src/core/tracks.ts";

const PROPOSAL = {
	title: "SDF optical post-process shader",
	goal: "Understand the math behind the shader.",
	explanation: "This is more than one session can teach well.",
	findings: [
		{ kind: "held", text: "Unreal material graph basics, so it isn’t a part." },
		{ kind: "low", text: "Distance fields and UV math: both start from the basics." },
	],
	parts: [
		{ id: "distance-fields", title: "Distance fields", why: "The rest measures from the edge.", dependsOn: [] },
		{ id: "sdf-texture", title: "SDFs in a texture", why: "The lens arrives as a texture.", dependsOn: ["distance-fields"] },
		{ id: "uv-space", title: "UV and screen space", why: "Every layer moves in UV space.", dependsOn: [] },
		{ id: "gradients", title: "SDF gradients", why: "Distortion follows the edge.", dependsOn: ["sdf-texture", "uv-space"] },
	],
	leftOut: "Full shader architecture, the finished material.",
};

const TRACK: ChatTrackContext = {
	trackId: "trk_1",
	trackTitle: PROPOSAL.title,
	planningChatId: "chat_plan",
	role: "teaching",
	partId: "sdf-texture",
	partNumber: "2",
	partTitle: "SDFs in a texture",
	totalParts: 4,
	parts: [
		{ id: "distance-fields", number: "1", title: "Distance fields", teachingChatId: "chat_p1" },
		{ id: "sdf-texture", number: "2", title: "SDFs in a texture", teachingChatId: "chat_p2" },
		{ id: "uv-space", number: "3", title: "UV and screen space", teachingChatId: null },
		{ id: "gradients", number: "4", title: "SDF gradients", teachingChatId: null },
	],
};

function withCtx(value: Partial<TrackChatContextValue>, node: React.ReactNode): string {
	const v: TrackChatContextValue = { chatId: "chat_plan", track: null, latestProposalCallId: null, focusComposer: () => {}, ...value };
	return renderToStaticMarkup(<TrackChatContext.Provider value={v}>{node}</TrackChatContext.Provider>);
}
const part = (type: string, input: unknown, output: unknown = { ok: true }, state = "output-available") => ({ type, state, toolCallId: "call_1", input, output });
const proposal = (stage: ProposalStage, p = part("tool-propose_track", PROPOSAL), trackId: string | null = null) =>
	renderToStaticMarkup(<TrackProposalBody part={p} stage={stage} trackId={trackId} busy={false} error={null} onStart={() => {}} onChange={() => {}} />);

describe("TrackProposalCard", () => {
	it("live: header count + starts line, explanation, findings, the numbered list with dependency labels, left out, and both actions", () => {
		const html = proposal("live");
		assert.match(html, /data-testid="track-proposal-card" data-state="live"/);
		assert.ok(html.includes("Proposed track · 4 parts"));
		assert.match(html, /data-testid="track-proposal-starts"[^>]*>TWO PLACES TO START: 1 AND 3</);
		assert.ok(html.includes("This is more than one session can teach well."));
		assert.ok(html.includes("Already held") && html.includes("Starts low"));
		assert.match(html, /track-proposal-part-gradients/);
		assert.ok(html.includes(">START<") && html.includes(">AFTER 1<") && html.includes(">AFTER 2 AND 3<"));
		assert.ok(html.includes("Left out, per your brief") && html.includes("Full shader architecture"));
		assert.match(html, /data-testid="track-proposal-start"[^>]*>Start track</);
		assert.match(html, /data-testid="track-proposal-change"/);
		assert.match(html, /data-testid="track-mini-map"/);
		assert.ok(html.includes("1 · START") && html.includes("3 · START"));
	});

	it("superseded, started, refused and pending states", () => {
		const superseded = proposal("superseded");
		assert.match(superseded, /data-state="superseded"/);
		assert.ok(!superseded.includes("track-proposal-start\""));
		assert.ok(superseded.includes("Superseded by a later proposal"));
		const started = proposal("started", undefined, "trk_1");
		assert.match(started, /data-state="started"/);
		assert.match(started, /data-testid="track-proposal-open"[^>]*href="\/track\/trk_1"/);
		const refused = proposal("live", part("tool-propose_track", PROPOSAL, { ok: false, error: "A question is still open" }));
		assert.match(refused, /data-state="refused"/);
		assert.ok(refused.includes("A question is still open"));
		const pending = proposal("live", part("tool-propose_track", { title: "half" }, undefined, "input-streaming"));
		assert.match(pending, /data-state="pending"/);
		assert.ok(pending.includes("Writing the proposal…"));
		assert.equal(typeof TrackProposalCard, "function", "the registry's hook-bearing wrapper");
	});

	it("startsText counts the places to start", () => {
		const p = (number: string, deps: string[], parent?: string): TrackPartSpec => ({ id: number, number, title: "t", why: "w", dependsOn: deps, ...(parent ? { parentPartId: parent } : {}) });
		assert.equal(startsText([p("1", []), p("2", ["1"])]), "ONE PLACE TO START: 1");
		assert.equal(startsText([p("1", []), p("2", []), p("3", []), p("4", ["1"])]), "THREE PLACES TO START: 1, 2 AND 3");
		assert.equal(startsText([p("1", []), p("1a", [], "1")]), "ONE PLACE TO START: 1", "sub-parts never count");
	});
});

describe("TrackReplanCard / PartDoneCard / TrackReplanDivider / TrackContextCard", () => {
	it("the re-plan card shows the note and what changed; refused shows the error", () => {
		const input = { afterPartId: "distance-fields", note: "Split gradients into two sessions.", parts: PROPOSAL.parts };
		const html = withCtx({ track: { ...TRACK, role: "planning" } }, <TrackReplanCard part={part("tool-replan_track", input, { ok: true, changed: "split 4 into 4a, 4b" })} />);
		assert.match(html, /data-testid="track-replan-card" data-state="ok"/);
		assert.ok(html.includes("Re-planned · 4 parts"));
		assert.ok(html.includes("Split gradients into two sessions."));
		assert.ok(html.includes("Changed: split 4 into 4a, 4b"));
		assert.match(html, /data-testid="track-replan-open"[^>]*href="\/track\/trk_1"/);
		const same = withCtx({}, <TrackReplanCard part={part("tool-replan_track", input, { ok: true, changed: "" })} />);
		assert.ok(same.includes("No part was added, dropped or split."));
		const refused = withCtx({}, <TrackReplanCard part={part("tool-replan_track", input, { ok: false, error: "cannot be dropped" })} />);
		assert.ok(refused.includes("LH retried the re-plan: cannot be dropped"));
	});

	it("the part_done card names the part and shows the summary + shaky", () => {
		const html = withCtx({ track: TRACK }, <PartDoneCard part={part("tool-part_done", { summary: "A field measures the shortest way to the edge.", shaky: "Sign conventions." })} />);
		assert.match(html, /data-testid="part-done-card" data-state="ok"/);
		assert.ok(html.includes("Part 2 done"));
		assert.match(html, /data-testid="part-done-summary"[^>]*>A field measures/);
		assert.ok(html.includes("Sign conventions."));
		assert.ok(html.includes("var(--lh-track-accent)"));
	});

	it("the divider labels the finished part or the learner's request", () => {
		assert.ok(renderToStaticMarkup(<TrackReplanDivider data={{ partNumber: "2", partTitle: "SDFs in a texture" }} />).includes("Re-plan · after part 2 · SDFs in a texture"));
		assert.ok(renderToStaticMarkup(<TrackReplanDivider data={{ partNumber: null, partTitle: null }} />).includes("Re-plan · at your request"));
	});

	it("the context card collapses to the first line and links the track", () => {
		const content = "[Track context] — this session is part 2 of 4 of the track \"SDF optical post-process shader\".\n\nEND GOAL: x";
		const html = withCtx({ track: TRACK }, <TrackContextCard data={{ content, details: { trackId: "trk_1", partId: "sdf-texture", role: "teaching" } }} />);
		assert.match(html, /data-testid="track-context-card"/);
		assert.ok(html.includes("this session is part 2 of 4 of the track"));
		assert.ok(!html.includes("track-context-body"), "collapsed by default");
		assert.ok(html.includes('href="/track/trk_1"'));
	});
});

describe("TrackRailBody", () => {
	const at = (n: number) => `2026-11-22T10:${String(n).padStart(2, "0")}:00.000Z`;
	const facts = (id: string, done: boolean): TrackChatFacts => ({ id, title: id, createdAt: at(1), updatedAt: at(2), kind: "teach", phase: "teach", busy: false, pendingQuestion: false, pendingProblem: false, partDone: done ? { at: at(3), summary: "held", shaky: null } : null });
	const events: TrackEvent[] = [
		{ type: "created", at: at(0), trackId: "trk_1", title: PROPOSAL.title, goal: PROPOSAL.goal, brief: "b", explanation: "e", findings: [], leftOut: null, planningChatId: "chat_plan", parts: PROPOSAL.parts.map((p, i) => ({ ...p, number: String(i + 1) })) },
		{ type: "part-started", at: at(1), trackId: "trk_1", partId: "distance-fields", chatId: "chat_p1" },
		{ type: "part-started", at: at(2), trackId: "trk_1", partId: "sdf-texture", chatId: "chat_p2" },
	];
	const view = deriveTrackView(foldTracks(events)[0]!, (id) => (id === "chat_p1" ? facts(id, true) : id === "chat_p2" ? facts(id, false) : null));

	it("the track card with progress + HERE, the plan slot, and the ready list without this part", () => {
		const html = renderToStaticMarkup(<TrackRailBody view={view} track={TRACK} plan={<svg data-testid="plan-svg" />} />);
		assert.match(html, /data-testid="track-rail"/);
		assert.match(html, /data-testid="track-rail-progress"[^>]*>1 of 4 done</);
		assert.ok(html.includes("2 · HERE"));
		assert.match(html, /data-testid="track-rail-plan"/);
		assert.ok(html.includes("plan-svg"));
		assert.match(html, /data-testid="track-rail-ready"/);
		const ready = html.slice(html.indexOf('data-testid="track-rail-ready"'));
		assert.ok(ready.includes("UV and screen space") && ready.includes('href="/track/trk_1?part=uv-space"'));
		assert.ok(!ready.includes("SDF gradients"), "a later part is not ready");
		assert.deepEqual(readyParts(view, "sdf-texture").map((p) => p.id), ["uv-space"]);
		const noPlan = renderToStaticMarkup(<TrackRailBody view={view} track={TRACK} />);
		assert.ok(!noPlan.includes("track-rail-plan"));
	});
});

describe("MarkdownAnchor — the part:// chip", () => {
	it("resolves a part link through the chat's track context, stays inert without one, and leaves other links alone", () => {
		const resolved = withCtx({ track: TRACK }, <MarkdownAnchor href="part://distance-fields/msg_a1">the signed field</MarkdownAnchor>);
		assert.match(resolved, /data-testid="part-link-chip" data-part="distance-fields" data-resolved="true"/);
		assert.ok(resolved.includes('href="/chat/chat_p1#message-msg_a1"'));
		assert.ok(resolved.includes("Taught in part 1 · Distance fields"));
		const unstarted = withCtx({ track: TRACK }, <MarkdownAnchor href="part://uv-space/msg_z">x</MarkdownAnchor>);
		assert.match(unstarted, /data-resolved="false"/);
		assert.ok(unstarted.includes("Part uv-space") && !unstarted.includes("href="));
		const loose = withCtx({}, <MarkdownAnchor href="part://distance-fields/msg_a1">x</MarkdownAnchor>);
		assert.match(loose, /data-resolved="false"/);
		const plain = withCtx({ track: TRACK }, <MarkdownAnchor href="https://example.com">site</MarkdownAnchor>);
		assert.ok(plain.includes('<a href="https://example.com">site</a>'));
		assert.equal((mdComponents as { a?: unknown }).a, MarkdownAnchor);
	});

	it("end to end: the teacher's part:// link survives the markdown pipeline as a chip", () => {
		const html = withCtx({ track: TRACK }, <MessageResponse mode="static">{"You already hold that [the server copy decides](part://distance-fields/msg_a1). A replicated property carries it."}</MessageResponse>);
		assert.match(html, /data-testid="part-link-chip" data-part="distance-fields" data-resolved="true"/);
		assert.ok(html.includes('href="/chat/chat_p1#message-msg_a1"'));
		assert.ok(html.includes("Taught in part 1 · Distance fields"));
		assert.ok(!html.includes("[blocked]"));
	});
});

describe("the registry and the graph filter", () => {
	it("registers the track renderers", () => {
		assert.equal(artifactRenderers.propose_track, TrackProposalCard);
		assert.equal(artifactRenderers.replan_track, TrackReplanCard);
		assert.equal(artifactRenderers.part_done, PartDoneCard);
		assert.equal(artifactRenderers.read_part, ToolCallCard);
	});

	it("filteredNodeIds keeps the track's propositions and the chains that survive whole", () => {
		const snapshot = {
			nodes: [
				{ id: "a", name: "A", statement: "a" },
				{ id: "b", name: "B", statement: "b" },
				{ id: "c", name: "C", statement: "c" },
				{ id: "imp1", name: "", statement: "" },
				{ id: "imp2", name: "", statement: "" },
			],
			nodeSessions: { a: ["chat_p1"], b: ["chat_p1", "other"], c: ["other"] },
			impLinks: [
				{ id: "imp1", premises: ["a"], conclusion: "b" },
				{ id: "imp2", premises: ["b"], conclusion: "c" },
			],
		} as never;
		assert.deepEqual([...filteredNodeIds(snapshot, "", { chatIds: ["chat_p1"] })].sort(), ["a", "b", "imp1"]);
		assert.deepEqual([...filteredNodeIds(snapshot, "", null)].sort(), ["a", "b", "c", "imp1", "imp2"]);
		assert.deepEqual([...filteredNodeIds(snapshot, "B", { chatIds: ["chat_p1"] })].sort(), ["b"], "the query composes with the filter");
	});
});
