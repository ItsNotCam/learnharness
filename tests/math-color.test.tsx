/**
 * Math color: built-in themes define --lh-math (a blue in each: the code
 * blocks' number color in Dark and Paper, One Dark's own blue),
 * an uploaded VS Code theme uses its own number color (constant.numeric, or
 * a broader constant rule; never a narrower one), and the stylesheet paints
 * KaTeX inside teaching prose with it.
 * (tsx uses the classic JSX transform, hence the React global shim.)
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageResponse } from "../components/ai-elements/message.tsx";
import { customThemeCss, inlineCodeColor, mathColor, vscodeThemeToCustom } from "../src/core/vscode-theme.ts";

const theme = (tokenColors: unknown[]) => {
	const mapped = vscodeThemeToCustom(
		JSON.stringify({ name: "T", type: "dark", colors: { "editor.background": "#1e1e1e", "editor.foreground": "#d4d4d4" }, tokenColors }),
	);
	return { ...mapped.theme, id: "theme_abcdef12" };
};

describe("an uploaded theme's math color", () => {
	it("is its number color", () => {
		const t = theme([{ scope: ["constant.numeric", "constant.language"], settings: { foreground: "#b5cea8" } }]);
		assert.equal(mathColor(t), "#b5cea8");
		assert.match(customThemeCss(t), /--lh-math:#b5cea8;/);
	});

	it("falls back to a broader constant rule, then to the text color", () => {
		assert.equal(mathColor(theme([{ scope: "constant", settings: { foreground: "#d19a66" } }])), "#d19a66");
		const none = theme([{ scope: "string", settings: { foreground: "#ce9178" } }]);
		assert.equal(mathColor(none), null);
		assert.match(customThemeCss(none), /--lh-math:var\(--foreground\);/);
	});

	it("prefers constant.numeric over constant, and ignores narrower number rules", () => {
		const t = theme([
			{ scope: "constant", settings: { foreground: "#111111" } },
			{ scope: "constant.numeric", settings: { foreground: "#222222" } },
			// VS Code's Dark+ family colors search-result line numbers this way.
			{ scope: "constant.numeric.line-number.match", settings: { foreground: "#ff0000" } },
		]);
		assert.equal(mathColor(t), "#222222");
	});

	it("matches a nested selector by its last part", () => {
		assert.equal(mathColor(theme([{ scope: "source.js constant.numeric", settings: { foreground: "#444444" } }])), "#444444");
	});

	it("leaves inline code's lookup as it was", () => {
		const t = theme([{ scope: "markup.inline.raw.string.markdown", settings: { foreground: "#555555" } }]);
		assert.equal(inlineCodeColor(t), "#555555", "a rule under markup.inline.raw still counts for inline code");
	});
});

describe("built-in themes and the stylesheet", () => {
	const css = fs.readFileSync("app/globals.css", "utf-8");

	it("every built-in theme defines --lh-math: a blue in each", () => {
		for (const [block, color] of [
			[":root {", "#79b8ff"],
			[".dark {", "#79b8ff"],
			[".paper {", "#005cc5"],
			[".onedark {", "#61afef"],
		] as const) {
			const start = css.indexOf(block);
			assert.ok(start >= 0, block);
			const body = css.slice(start, css.indexOf("}", start));
			assert.ok(body.includes(`--lh-math: ${color};`), `${block} ${color}`);
		}
	});

	it("paints KaTeX inside teaching prose with it", () => {
		assert.match(css, /\.lh-prose \.katex \{\s*color: var\(--lh-math\);\s*\}/);
	});

	it("renders inline and display math inside the prose wrapper", () => {
		const html = renderToStaticMarkup(<MessageResponse mode="static">{"Take $H = 60$ here.\n\n$$\n\\theta_k = k \\cdot \\frac{2\\pi}{N}\n$$"}</MessageResponse>);
		assert.match(html, /class="[^"]*\blh-prose\b/);
		assert.ok((html.match(/class="katex"/g) ?? []).length >= 2, "both formulas are KaTeX");
		assert.match(html, /katex-display/);
	});
});
