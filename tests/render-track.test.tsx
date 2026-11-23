/**
 * Track surfaces, server-rendered (docs/tracks.md §7): the track map's
 * compound layout and status skin, the sidebar's tree row and part meta,
 * the overview body (header pill, the selected-part panel's states, the
 * log), and the delete-track dialog's copy. Same tsx classic-JSX shim as
 * render-cards.test.tsx; pure functions of their inputs.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TrackMap, trackLayout } from "../components/track-map.tsx";
import { TreeRow, partMeta } from "../components/sidebar.tsx";
import { TrackOverviewBody, defaultSelection, progressText, sessionMetaText, splitNote } from "../components/track-overview.tsx";
import { DeleteTrackBody } from "../components/delete-track-dialog.tsx";
import { PartStatusIcon, splitDisplayStatus } from "../components/track-icons.tsx";
import type { TrackChatFacts, TrackEvent, TrackPartSpec, TrackView } from "../src/core/contracts.ts";
import { deriveTrackView, foldTracks } from "../src/core/tracks.ts";

const T = "trk_1";
const at = (n: number) => `2026-11-22T10:${String(n).padStart(2, "0")}:00.000Z`;
function spec(id: string, number: string, title: string, dependsOn: string[] = [], parentPartId?: string): TrackPartSpec {
	return { id, number, title, why: `Why ${title.toLowerCase()}.`, dependsOn, ...(parentPartId ? { parentPartId } : {}) };
}
const PARTS = [
	spec("p1", "1", "Distance fields"),
	spec("p2", "2", "SDFs in a texture", ["p1"]),
	spec("p3", "3", "Influence from distance", ["p2"]),
	spec("p4", "4", "UV and screen space"),
	spec("p5", "5", "SDF gradients", ["p2", "p4"]),
	spec("p6", "6", "Edge distortion and chromatic aberration", ["p3", "p5"]),
	spec("p7", "7", "Camera-driven layer offsets", ["p4"]),
];
const SPLIT = [...PARTS, spec("p5a", "5a", "Gradients of a 2D field", [], "p5"), spec("p5b", "5b", "Finite differences in a material", ["p5a"], "p5")];

function facts(id: string, overrides: Partial<TrackChatFacts> = {}): TrackChatFacts {
	return { id, title: id, createdAt: at(1), updatedAt: at(2), kind: "teach", phase: "teach", busy: false, pendingQuestion: false, pendingProblem: false, partDone: null, ...overrides };
}

/** The mockup's state: 1, 2, 4 done; 3 in progress; 5 split (5a ready, 5b later); 6 later; 7 ready. */
function mockupView(): TrackView {
	const events: TrackEvent[] = [
		{ type: "created", at: at(0), trackId: T, title: "SDF optical post-process shader", goal: "Understand the math behind an SDF-driven optical post-process material in UE5 well enough to design and build it myself.", brief: "I want to understand the mathematics…", explanation: "More than one session.", findings: [{ kind: "held", text: "Unreal material graph basics, so it isn't a part." }], leftOut: "Full shader architecture.", planningChatId: "chat_plan", parts: PARTS },
		{ type: "part-started", at: at(1), trackId: T, partId: "p1", chatId: "c1" },
		{ type: "part-started", at: at(2), trackId: T, partId: "p4", chatId: "c4" },
		{ type: "part-started", at: at(3), trackId: T, partId: "p2", chatId: "c2" },
		{ type: "replanned", at: at(4), trackId: T, afterPartId: "p2", note: "Split SDF gradients into 5a and 5b, because your answers there showed it was too much for one session.", parts: SPLIT },
		{ type: "part-started", at: at(5), trackId: T, partId: "p3", chatId: "c3" },
	];
	const done = (id: string) => facts(id, { partDone: { at: at(6), summary: `${id} held`, shaky: null } });
	return deriveTrackView(foldTracks(events)[0]!, (id) =>
		id === "c1" || id === "c2" || id === "c4" ? done(id) : id === "c3" ? facts(id, { pendingQuestion: true }) : id === "chat_plan" ? facts(id) : null,
	);
}

describe("trackLayout — dagre compound placement", () => {
	it("leaves get boxes, a split parent becomes a group enclosing its children, edges land on leaves", () => {
		const view = mockupView();
		const layout = trackLayout(view.parts, false);
		assert.equal(layout.nodes.size, 8, "7 top-level minus the split parent, plus two sub-parts");
		assert.equal(layout.groups.size, 1);
		const group = layout.groups.get("p5")!;
		for (const kid of ["p5a", "p5b"]) {
			const box = layout.nodes.get(kid)!;
			assert.ok(box.x >= group.x && box.y >= group.y && box.x + box.w <= group.x + group.w && box.y + box.h <= group.y + group.h, `${kid} sits inside its group`);
		}
		const intoSplit = layout.edges.find((e) => e.from === "p2" && e.to === "p5")!;
		assert.equal(intoSplit.dst, "p5a", "a dependency on a split part lands on its first child");
		const outOfSplit = layout.edges.find((e) => e.from === "p5" && e.to === "p6")!;
		assert.equal(outOfSplit.src, "p5b", "a dependent leaves from the last child");
		assert.ok(layout.edges.every((e) => e.points.length >= 2), "every edge has a route");
		assert.ok(layout.width > 0 && layout.height > 0);
		const mini = trackLayout(view.parts, true);
		assert.ok(mini.width < layout.width && mini.height < layout.height, "the compact map is smaller");
	});

	it("an empty track lays out to nothing", () => {
		assert.deepEqual(trackLayout([], false).width, 0);
	});
});

describe("TrackMap — the status skin", () => {
	it("styles every leaf by status, draws the split group with its label, and rings the selection", () => {
		const view = mockupView();
		const html = renderToStaticMarkup(<TrackMap parts={view.parts} selectedId="p3" />);
		assert.match(html, /data-testid="track-map"/);
		assert.match(html, /data-testid="track-node-p1" data-status="done"/);
		assert.match(html, /data-testid="track-node-p3" data-status="in-progress"/);
		assert.match(html, /data-testid="track-node-p5a" data-status="ready"/);
		assert.match(html, /data-testid="track-node-p6" data-status="later"/);
		assert.match(html, /data-testid="track-group-p5"/);
		assert.ok(html.includes("5 · SDF GRADIENTS · SPLIT BY LH"));
		assert.ok(html.includes("3 · IN PROGRESS"));
		assert.ok(html.includes("1 · DONE"));
		assert.ok(html.includes("7 · READY"));
		assert.ok(html.includes("var(--lh-track-accent)"), "the in-progress accent token");
		assert.ok(!html.includes("track-node-p5\""), "a split parent draws no leaf box");
	});

	it("the compact map shows numbers only and marks HERE; the proposal map marks the starts", () => {
		const view = mockupView();
		const mini = renderToStaticMarkup(<TrackMap parts={view.parts} compact hereId="p3" />);
		assert.match(mini, /data-testid="track-mini-map"/);
		assert.ok(mini.includes("3 · HERE"));
		const visible = mini.replace(/<[^>]+>/g, " ");
		assert.ok(!visible.includes("Influence from distance"), "no visible titles in the mini map (aria-labels keep them)");
		assert.ok(mini.includes('aria-label="Part 3, Influence from distance, in progress"'));
		const proposal = renderToStaticMarkup(<TrackMap parts={view.parts} compact proposal />);
		assert.ok(proposal.includes("1 · START"));
		assert.ok(proposal.includes("4 · START"));
		assert.ok(!proposal.includes("2 · START"));
	});
});

describe("TreeRow / partMeta / PartStatusIcon — the sidebar tree", () => {
	it("renders the caret when expandable, the number, the meta, and the accent", () => {
		const html = renderToStaticMarkup(
			<TreeRow depth={1} icon={<PartStatusIcon status="in-progress" />} caret={{ open: true, onToggle: () => {} }} number="3" label="Influence from distance" meta="You are here · Waiting for input" metaAccent onOpen={() => {}} testid="part-row" />,
		);
		assert.match(html, /data-testid="part-row"/);
		assert.match(html, /data-walk=""/);
		assert.match(html, /aria-expanded="true"/);
		assert.match(html, /aria-label="Collapse Influence from distance"/);
		assert.ok(html.includes(">3<"), "the mono number");
		assert.ok(html.includes("You are here · Waiting for input"));
		assert.ok(html.includes("var(--lh-track-accent)"));
		assert.match(html, /data-testid="status-in-progress"/);
		assert.ok(html.includes("padding-left:14px"), "one level of indent");
		const leaf = renderToStaticMarkup(<TreeRow depth={0} icon={<PartStatusIcon status="done" />} label="Done part" meta="Done" onOpen={() => {}} />);
		assert.ok(!leaf.includes("tree-caret"), "no caret without children");
	});

	it("part meta reads the status or what the part waits for", () => {
		const view = mockupView();
		const p = (id: string) => view.parts.find((x) => x.id === id)!;
		assert.equal(partMeta(p("p1"), view.parts), "Done");
		assert.equal(partMeta(p("p3"), view.parts), "In progress");
		assert.equal(partMeta(p("p7"), view.parts), "Ready to start");
		assert.equal(partMeta(p("p5"), view.parts), "Split into 2 parts");
		assert.equal(partMeta(p("p6"), view.parts), "After 3 and 5");
		assert.equal(partMeta(p("p5b"), view.parts), "After 5a");
		assert.equal(splitDisplayStatus(p("p5"), view.parts), "ready", "a split part shows its children's best state");
	});
});

describe("TrackOverviewBody — the overview", () => {
	const view = mockupView();
	const noop = () => {};
	const render = (selected: string | null) =>
		renderToStaticMarkup(
			<TrackOverviewBody view={view} selected={selected} onSelect={noop} busyAction={null} error={null} now={new Date(at(10))} onStartPart={noop} onPractice={noop} onReplan={noop} />,
		);

	it("header: the title, the N OF M pill, the re-plan button; the goal line; the log newest first", () => {
		const html = render("p3");
		assert.ok(html.includes("SDF optical post-process shader"));
		assert.match(html, /data-testid="track-progress"[^>]*>3 of 7 done</);
		assert.match(html, /data-testid="track-replan"/);
		assert.ok(html.includes("Goal: Understand the math behind"));
		assert.match(html, /data-testid="track-log"/);
		const logIdx = html.indexOf("Part 3 · Influence from distance started.");
		const createdIdx = html.indexOf("Track created from your goal.");
		assert.ok(logIdx !== -1 && createdIdx !== -1 && logIdx < createdIdx, "newest first");
		assert.ok(html.includes("Re-planned after part 2 · SDFs in a texture: Split SDF gradients into 5a and 5b"));
	});

	it("the selected part panel: in progress → Continue session; ready → Start part; later → the locked line; split → the note and sub-parts; done → Open + Practice", () => {
		const current = render("p3");
		assert.match(current, /data-testid="part-kicker"[^>]*>Part 3 · In progress</);
		assert.match(current, /data-testid="part-continue"/);
		assert.ok(current.includes("Waiting for your answer"));
		const ready = render("p7");
		assert.match(ready, /data-testid="part-start"[^>]*>Start part 7</);
		assert.ok(ready.includes("Part 4, done"), "builds-on names the done dependency");
		const later = render("p6");
		assert.match(later, /data-testid="part-locked"[^>]*>Unlocks when parts 3 and 5 are done\.</);
		assert.ok(!later.includes("part-start"));
		const split = render("p5");
		assert.match(split, /data-testid="part-kicker"[^>]*>Part 5 · split into 5a and 5b</);
		assert.match(split, /data-testid="part-note"/);
		assert.ok(split.includes("LH split this into 5a and 5b after part 2: Split SDF gradients"));
		const done = render("p1");
		assert.match(done, /data-testid="part-open"/);
		assert.match(done, /data-testid="part-practice"/);
		assert.ok(done.includes("What it established"));
	});

	it("no selection → the track panel with progress and the planning session", () => {
		const html = render(null);
		assert.match(html, /data-testid="part-kicker"[^>]*>Track · 7 parts</);
		assert.ok(html.includes("3 done · 1 in progress · 2 ready · 1 later"));
		assert.match(html, /data-testid="track-planning-session"/);
		assert.match(html, /data-testid="track-continue"[^>]*>Continue part 3</);
	});

	it("pure helpers: the default selection, progress text, session meta, split note", () => {
		assert.equal(defaultSelection(view), "p3", "the part in progress");
		assert.equal(defaultSelection({ parts: view.parts.filter((p) => p.id !== "p3") }), "p5a", "else the first ready leaf in reading order (5a before 7)");
		assert.deepEqual(view.parts.map((p) => p.number), ["1", "2", "3", "4", "5", "5a", "5b", "6", "7"], "sub-parts follow their parent");
		assert.equal(progressText(view), "3 done · 1 in progress · 2 ready · 1 later");
		assert.equal(sessionMetaText({ id: "c", title: "c", kind: "teaching", updatedAt: at(2), busy: true, pendingQuestion: false, pendingProblem: false, phase: "teach", doneAt: null }), "Working…");
		assert.match(sessionMetaText({ id: "c", title: "c", kind: "teaching", updatedAt: at(2), busy: false, pendingQuestion: false, pendingProblem: false, phase: "teach", doneAt: at(6) }, new Date(at(10))), /^Done · /);
		assert.equal(splitNote(view.parts.find((p) => p.id === "p1")!, view), null);
	});
});

describe("DeleteTrackBody — the dialog copy", () => {
	it("names the track and its session count", () => {
		const html = renderToStaticMarkup(
			<DeleteTrackBody track={{ id: T, title: "SDF optical post-process shader", chatIds: ["a", "b", "c"] }} traces={false} busy={false} failure={null} onTraces={() => {}} onClose={() => {}} onRun={() => {}} />,
		);
		assert.match(html, /data-testid="delete-track-dialog"/);
		assert.ok(html.includes("Delete track?"));
		assert.ok(html.includes("the track and its 3 sessions"));
		assert.match(html, /data-testid="delete-confirm"[^>]*>Delete</);
	});
});
