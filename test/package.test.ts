/**
 * Tests for the pi package manifest, the prompt guidance text, and the
 * vendored upstream metadata.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildEgmGuidance } from "../extensions/egm/index.ts";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EGM_ROOT = path.join(PACKAGE_ROOT, "egm");

function readPackageJson(): Record<string, any> {
	return JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"));
}

test("pi manifest points at the extension and the vendored skills dir", () => {
	const pkg = readPackageJson();
	assert.deepEqual(pkg.pi.extensions, ["./extensions/egm/index.ts"]);
	assert.deepEqual(pkg.pi.skills, ["./egm/skills"]);
	assert.ok(pkg.keywords.includes("pi-package"));
	assert.ok(fs.existsSync(path.join(PACKAGE_ROOT, "extensions", "egm", "index.ts")));
	assert.ok(fs.existsSync(path.join(EGM_ROOT, "skills")));
});

test("vendored skills dir contains exactly 7 SKILL.md files", () => {
	const skillsDir = path.join(EGM_ROOT, "skills");
	const skillFiles = fs
		.readdirSync(skillsDir, { withFileTypes: true })
		.filter((d) => d.isDirectory() && fs.existsSync(path.join(skillsDir, d.name, "SKILL.md")))
		.map((d) => d.name);
	assert.deepEqual(
		skillFiles.sort(),
		["egm-bootstrap", "egm-brainstorm", "egm-draft", "egm-drift-report", "egm-resolve", "egm-review", "egm-review-loop"],
	);
});

test("UPSTREAM.json records a resolved 40-char commit SHA", () => {
	const upstream = JSON.parse(fs.readFileSync(path.join(EGM_ROOT, "UPSTREAM.json"), "utf8"));
	assert.match(upstream.commit, /^[0-9a-f]{40}$/);
	assert.equal(upstream.repository, "https://github.com/google/elephant-goldfish-model");
	assert.ok(upstream.syncedAt);
});

test("guidance names the absolute egm root and egm_subagent", () => {
	const guidance = buildEgmGuidance(EGM_ROOT);
	assert.ok(guidance.includes(EGM_ROOT));
	assert.ok(path.isAbsolute(EGM_ROOT));
	assert.ok(guidance.includes("egm_subagent"));
	assert.ok(guidance.includes("EGM artifact directory"));
	assert.ok(guidance.includes("skills/<name>/SKILL.md"), "hidden sibling skills must be reachable");
	assert.ok(guidance.includes("sequential"), "replaces the rule from docs/claude.md");
	assert.ok(guidance.includes("goldfish_review_report_stage<N>_round<M>.md"), "earlier decisions must survive");
});
