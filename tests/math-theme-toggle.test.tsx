/**
 * The "use theme colors for math shit" appearance toggle: off by default
 * (math keeps the text color), saved and validated like the other
 * appearance booleans, applied as --lh-math-ink only while on (and cleared
 * when switched back off), and shown in Appearance with the owner's label.
 * (tsx uses the classic JSX transform, hence the React global shim.)
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { appearanceVars, resolveAppearance, staleVarNames } from "../components/settings/appearance.tsx";
import { AppearanceSection } from "../components/settings/appearance-section.tsx";
import { FACTORY_SETTINGS, sanitizeUserSettings } from "../src/core/settings.ts";
import { resolveSettings } from "../src/core/settings-resolution.ts";
import { parseAppearanceSettingsBody } from "../src/server/settings-body.ts";

const LABEL = "use theme colors for math shit";

describe("the math theme-colors setting", () => {
	it("is off by default", () => {
		assert.equal(FACTORY_SETTINGS.appearance.mathThemeColors, false);
		assert.equal(resolveAppearance(undefined).mathThemeColors, false);
		assert.equal(resolveSettings(null).appearance.mathThemeColors, false);
	});

	it("is saved as a boolean and anything else is refused or dropped", () => {
		const on = parseAppearanceSettingsBody({ mathThemeColors: true });
		assert.ok(on.ok);
		assert.deepEqual(on.settings, { mathThemeColors: true });
		assert.equal(parseAppearanceSettingsBody({ mathThemeColors: "yes" }).ok, false);
		assert.deepEqual(sanitizeUserSettings({ appearance: { mathThemeColors: true } })?.appearance, { mathThemeColors: true });
		assert.deepEqual(sanitizeUserSettings({ appearance: { mathThemeColors: 1 } })?.appearance, {}, "junk drops to the default");
		assert.equal(resolveSettings({ version: 1, appearance: { mathThemeColors: true } }).appearance.mathThemeColors, true);
	});

	it("colors math only while on, and switching it off clears the color", () => {
		const off = appearanceVars(resolveAppearance(undefined));
		assert.equal(off["--lh-math-ink"], undefined, "off: math keeps the text color");
		const on = appearanceVars(resolveAppearance({ mathThemeColors: true }));
		assert.equal(on["--lh-math-ink"], "var(--lh-math)");
		assert.ok(staleVarNames(Object.keys(on), off).includes("--lh-math-ink"), "toggling off removes it");
	});

	it("the stylesheet uses the theme color only when the toggle sets it", () => {
		const css = fs.readFileSync("app/globals.css", "utf-8");
		assert.match(css, /\.lh-prose \.katex \{\s*color: var\(--lh-math-ink, currentColor\);\s*\}/);
	});

	it("shows in Appearance with the owner's label, off by default", () => {
		const html = renderToStaticMarkup(<AppearanceSection appearance={undefined} onSectionChange={() => {}} />);
		const i = html.indexOf('data-testid="row-math-theme-colors"');
		assert.ok(i >= 0, "the row");
		const row = html.slice(i, html.indexOf("</button>", i));
		assert.ok(row.includes(LABEL), "the label, verbatim");
		assert.match(row, new RegExp(`role="switch" aria-checked="false" aria-label="${LABEL}"`));
		const onHtml = renderToStaticMarkup(<AppearanceSection appearance={{ mathThemeColors: true }} onSectionChange={() => {}} />);
		const j = onHtml.indexOf('data-testid="row-math-theme-colors"');
		assert.match(onHtml.slice(j, onHtml.indexOf("</button>", j)), /aria-checked="true"/);
	});
});
