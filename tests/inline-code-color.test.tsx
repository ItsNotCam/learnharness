/**
 * Inline `code` color: built-in themes define --inline-code (a red tuned to
 * each), an uploaded VS Code theme uses its own inline-code syntax color
 * (most specific scope wins, as in VS Code) or its error red, and the
 * markdown renderer paints inline code with it.
 * (tsx uses the classic JSX transform, hence the React global shim.)
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageResponse } from "../components/ai-elements/message.tsx";
import { customThemeCss, inlineCodeColor, vscodeThemeToCustom } from "../src/core/vscode-theme.ts";

const theme = (tokenColors: unknown[]) => {
	const mapped = vscodeThemeToCustom(
		JSON.stringify({ name: "T", type: "dark", colors: { "editor.background": "#1e1e1e", "editor.foreground": "#d4d4d4" }, tokenColors }),
	);
	return { ...mapped.theme, id: "theme_abcdef12" };
};

describe("an uploaded theme's inline-code color", () => {
	it("is its markdown inline-code syntax color", () => {
		const t = theme([{ scope: ["markup.inline.raw", "markup.fenced_code.block"], settings: { foreground: "#7a5000" } }]);
		assert.equal(inlineCodeColor(t), "#7a5000");
		assert.match(customThemeCss(t), /--inline-code:#7a5000;/);
	});

	it("falls back to raw markup, then to the theme's error red", () => {
		assert.equal(inlineCodeColor(theme([{ scope: "markup.raw", settings: { foreground: "#fd971f" } }])), "#fd971f");
		const none = theme([{ scope: "string", settings: { foreground: "#ce9178" } }]);
		assert.equal(inlineCodeColor(none), null);
		assert.match(customThemeCss(none), /--inline-code:var\(--destructive\);/);
	});

	it("takes the most specific rule, as VS Code does", () => {
		const t = theme([
			{ scope: "markup", settings: { foreground: "#111111" } },
			{ scope: "markup.inline.raw.string.markdown", settings: { foreground: "#222222" } },
			{ scope: "markup.inline", settings: { foreground: "#333333" } },
		]);
		assert.equal(inlineCodeColor(t), "#222222");
	});

	it("matches a nested selector by its last part", () => {
		const t = theme([{ scope: "text.html.markdown markup.inline.raw", settings: { foreground: "#444444" } }]);
		assert.equal(inlineCodeColor(t), "#444444");
	});
});

describe("built-in themes and the renderer", () => {
	it("every built-in theme defines --inline-code", () => {
		const css = fs.readFileSync("app/globals.css", "utf-8");
		for (const [block, color] of [
			[":root {", "#f47067"],
			[".dark {", "#f47067"],
			[".paper {", "#b3372a"],
			[".onedark {", "#e06c75"],
		] as const) {
			const start = css.indexOf(block);
			assert.ok(start >= 0, block);
			const body = css.slice(start, css.indexOf("}", start));
			assert.ok(body.includes(`--inline-code: ${color};`), `${block} ${color}`);
		}
	});

	it("paints inline code with it", () => {
		const html = renderToStaticMarkup(<MessageResponse mode="static">{"use `FMath::Cos` here"}</MessageResponse>);
		assert.match(html, /data-streamdown="inline-code"/);
		assert.ok(html.includes("text-[color:var(--inline-code)]"));
	});
});
