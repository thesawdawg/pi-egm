/**
 * Tests for PersonaRegistry loading and per-persona tool policies.
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { GENERAL_PERSONA, PersonaRegistry, policyForPersona } from "../extensions/egm/personas.ts";
import { SubagentRunner } from "../extensions/egm/runner.ts";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AGENTS_DIR = path.join(PACKAGE_ROOT, "egm", "agents");
const EGM_ROOT = path.join(PACKAGE_ROOT, "egm");
const EXTENSION_PATH = path.join(PACKAGE_ROOT, "extensions", "egm", "index.ts");

const EXPECTED_PERSONAS = [
	"egm-bootstrap-orchestrator",
	"egm-codebase-details",
	"egm-comprehension",
	"egm-design",
	"egm-implementation-readiness",
	"egm-structural",
	"egm-style",
	"egm-synthesizer",
	"egm-zoom-out",
];

function makeRunner(): SubagentRunner {
	return new SubagentRunner(PersonaRegistry.load(AGENTS_DIR), EGM_ROOT, EXTENSION_PATH);
}

test("registry loads exactly the 9 vendored personas", () => {
	const registry = PersonaRegistry.load(AGENTS_DIR);
	for (const name of EXPECTED_PERSONAS) {
		const persona = registry.get(name);
		assert.ok(persona, `missing persona ${name}`);
		assert.ok(persona.description.length > 0, `${name} has no description`);
		assert.ok(persona.body.trim().length > 200, `${name} body is unexpectedly short`);
	}
	assert.deepEqual(registry.validNames().filter((n) => n !== GENERAL_PERSONA), [...EXPECTED_PERSONAS].sort());
});

test("reviewers and general are read-only; orchestrator personas can nest", () => {
	for (const name of ["egm-design", "egm-zoom-out", "egm-style", "egm-codebase-details", GENERAL_PERSONA]) {
		const policy = policyForPersona(name);
		assert.deepEqual(policy.tools, ["read", "grep", "find", "ls"], `${name} should be read-only`);
		assert.equal(policy.canNest, false);
	}
	assert.deepEqual(policyForPersona("egm-synthesizer").tools, [
		"read",
		"grep",
		"find",
		"ls",
		"write",
		"egm_subagent",
	]);
	assert.equal(policyForPersona("egm-synthesizer").canNest, true);
	assert.deepEqual(policyForPersona("egm-bootstrap-orchestrator").tools, [
		"read",
		"grep",
		"find",
		"ls",
		"write",
		"edit",
		"egm_subagent",
	]);
	assert.equal(policyForPersona("egm-bootstrap-orchestrator").canNest, true);
});

test("unknown persona fails validation and lists valid names", () => {
	const runner = makeRunner();
	const error = runner.validateTasks([{ persona: "egm-nope", task: "x" }]);
	assert.ok(error?.includes('Unknown persona(s): "egm-nope"'));
	assert.ok(error?.includes('"general"'));
	assert.ok(error?.includes('"egm-design"'));
});

test("general persona is valid and read-only", () => {
	const runner = makeRunner();
	assert.equal(runner.validateTasks([{ persona: GENERAL_PERSONA, task: "x" }]), undefined);
	assert.deepEqual(policyForPersona(GENERAL_PERSONA).tools, ["read", "grep", "find", "ls"]);
});

test("task count validation enforces the 1..8 range", () => {
	const runner = makeRunner();
	assert.ok(runner.validateTasks([])?.includes("at least one"));
	const tooMany = Array.from({ length: 9 }, () => ({ persona: "egm-design", task: "x" }));
	assert.ok(runner.validateTasks(tooMany)?.includes("Too many tasks"));
});
