/**
 * Tests for SubagentRunner's pure helpers: child argv construction, the
 * appended system prompt, and the delegation-depth guard. Nothing here spawns
 * a child process.
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PersonaRegistry } from "../extensions/egm/personas.ts";
import { MAX_SPAWN_DEPTH, SubagentRunner } from "../extensions/egm/runner.ts";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EGM_ROOT = path.join(PACKAGE_ROOT, "egm");
const AGENTS_DIR = path.join(EGM_ROOT, "agents");
const EXTENSION_PATH = path.join(PACKAGE_ROOT, "extensions", "egm", "index.ts");

function makeRunner(): SubagentRunner {
	return new SubagentRunner(PersonaRegistry.load(AGENTS_DIR), EGM_ROOT, EXTENSION_PATH);
}

test("reviewer child args: read-only tools, isolation flags, no extension load", () => {
	const runner = makeRunner();
	const args = runner.buildChildArgs({ persona: "egm-design", task: "review X" }, {}, "/tmp/p.md");
	assert.ok(args.includes("--tools"));
	assert.equal(args[args.indexOf("--tools") + 1], "read,grep,find,ls");
	for (const flag of ["--mode", "json", "-p", "--no-session", "-nc", "-ns", "-np", "--no-themes", "-ne", "-na"]) {
		assert.ok(args.includes(flag), `missing isolation flag ${flag}`);
	}
	assert.ok(!args.includes("-e"), "reviewer must not load the extension");
	assert.equal(args[args.indexOf("--append-system-prompt") + 1], "/tmp/p.md");
	assert.equal(args[args.length - 1], "Task: review X");
});

test("orchestrator child args: extension load plus nesting tool allowlist", () => {
	const runner = makeRunner();
	const args = runner.buildChildArgs({ persona: "egm-synthesizer", task: "compile" }, {}, "/tmp/p.md");
	const extIndex = args.indexOf("-e");
	assert.ok(extIndex >= 0, "orchestrator must load the extension");
	assert.equal(args[extIndex + 1], EXTENSION_PATH);
	assert.ok(path.isAbsolute(args[extIndex + 1]));
	const tools = args[args.indexOf("--tools") + 1].split(",");
	assert.ok(tools.includes("egm_subagent"));
	assert.ok(tools.includes("write"));
	assert.ok(!tools.includes("edit"), "synthesizer has write but not edit");
});

test("model and thinking level pass through to the child", () => {
	const runner = makeRunner();
	const args = runner.buildChildArgs(
		{ persona: "egm-design", task: "x" },
		{ model: "anthropic/claude-sonnet-4", thinkingLevel: "high" },
		"/tmp/p.md",
	);
	assert.equal(args[args.indexOf("--model") + 1], "anthropic/claude-sonnet-4");
	assert.equal(args[args.indexOf("--thinking") + 1], "high");
	const bare = runner.buildChildArgs({ persona: "egm-design", task: "x" }, {}, "/tmp/p.md");
	assert.ok(!bare.includes("--model"));
	assert.ok(!bare.includes("--thinking"));
});

test("child system prompt embeds persona body, plugin root, and read-only note", () => {
	const runner = makeRunner();
	const reviewerPrompt = runner.buildChildSystemPrompt({ persona: "egm-design", task: "x" });
	assert.ok(reviewerPrompt.includes("Design Critic Goldfish"));
	assert.ok(reviewerPrompt.includes(`EGM plugin root: ${EGM_ROOT}`));
	assert.ok(reviewerPrompt.includes("report an incomplete review"));
	assert.ok(reviewerPrompt.includes("no write or edit tools"));

	const orchestratorPrompt = runner.buildChildSystemPrompt({ persona: "egm-synthesizer", task: "x" });
	assert.ok(orchestratorPrompt.includes("egm_subagent"));

	const generalPrompt = runner.buildChildSystemPrompt({
		persona: "general",
		task: "x",
		systemPrompt: "You are a read-only codebase explorer.",
	});
	assert.ok(generalPrompt.includes("read-only codebase explorer"));
});

test("depth guard refuses spawning at MAX_SPAWN_DEPTH and restores after", () => {
	const runner = makeRunner();
	const previous = process.env.EGM_PI_DEPTH;
	try {
		delete process.env.EGM_PI_DEPTH;
		assert.equal(runner.currentDepth(), 0);
		assert.equal(runner.depthError(), undefined);

		process.env.EGM_PI_DEPTH = String(MAX_SPAWN_DEPTH - 1);
		assert.equal(runner.depthError(), undefined);

		process.env.EGM_PI_DEPTH = String(MAX_SPAWN_DEPTH);
		const error = runner.depthError();
		assert.ok(error?.includes("egm_subagent refused"));
		assert.ok(error?.includes(String(MAX_SPAWN_DEPTH)));
	} finally {
		if (previous === undefined) delete process.env.EGM_PI_DEPTH;
		else process.env.EGM_PI_DEPTH = previous;
	}
});
