/**
 * The question and practice docks fit the column: the WHOLE dock is capped
 * by --dock-max-h (the chat view sets it on the shell: the column less the
 * stats row, padding and anything stacked above), and only the question or
 * problem area gives way and scrolls, so the answer box keeps its size and a
 * tall question's top can never be pushed off screen.
 * (tsx uses the classic JSX transform, hence the React global shim.)
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QuestionDock } from "../components/question-dock.tsx";
import { PracticeDock } from "../components/practice-dock.tsx";

/** The full opening tag of the element carrying a testid (or the first tag after a marker). */
function tagAt(html: string, marker: string): string {
	const i = html.indexOf(marker);
	assert.ok(i >= 0, `missing ${marker}`);
	return html.slice(html.lastIndexOf("<", i), html.indexOf(">", i) + 1);
}

describe("the dock height cap", () => {
	const quiz = {
		question: "Which planet is closest to the sun?",
		options: [{ label: "Venus" }, { label: "Mercury" }],
		correctAnswer: "Mercury",
		explanation: "Mercury is the innermost planet.",
	};

	it("caps the whole question dock; only the question area scrolls", () => {
		const html = renderToStaticMarkup(
			<QuestionDock toolName="quiz" toolCallId="t1" input={quiz as never} expanded={true} onExpand={() => {}} onSubmit={() => {}} />,
		);
		const root = tagAt(html, 'data-testid="question-dock"');
		assert.match(root, /flex max-h-\[var\(--dock-max-h,55dvh\)\] flex-col/);
		const area = tagAt(html, 'data-session-find-root=""');
		assert.match(area, /min-h-0 overflow-y-auto/);
		assert.ok(!/max-h-/.test(area), "the area has no cap of its own (it would ignore the answer box)");
		assert.match(tagAt(html, "<form"), /shrink-0/, "the answer box keeps its size");
	});

	it("caps the whole practice dock; only the statement scrolls", () => {
		const html = renderToStaticMarkup(
			<PracticeDock problemCallId="p1" input={{ statement: "Show that the sum is even." }} expanded={true} onExpand={() => {}} onSubmit={() => {}} />,
		);
		assert.match(tagAt(html, 'data-testid="practice-dock"'), /flex max-h-\[var\(--dock-max-h,40vh\)\] flex-col/);
		assert.match(tagAt(html, 'data-testid="practice-thinking-field"'), /shrink-0/);
	});
});
