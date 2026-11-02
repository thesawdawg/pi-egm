/**
 * Tests for SubagentRunner's pure helpers: child argv construction, the
 * appended system prompt, and the delegation-depth guard. Nothing here spawns
 * a child process.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PersonaRegistry } from "../extensions/egm/personas.ts";
import {
	BOOTSTRAP_MAX_SPAWN_DEPTH,
	capOutput,
	CHILD_BASE_SYSTEM_PROMPT,
	explainModelFailure,
	parseChildExtensions,
	PER_TASK_OUTPUT_CAP,
	taskOutputCap,
	TOTAL_OUTPUT_CAP,
	DEFAULT_TASK_TIMEOUT_MINUTES,
	findReportProblem,
	MAX_SPAWN_DEPTH,
	NESTING_TIMEOUT_MULTIPLIER,
	parseArtifactDirectory,
	SubagentRunner,
} from "../extensions/egm/runner.ts";

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

test("child args replace pi's default prompt so a user SYSTEM.md cannot load", () => {
	const args = makeRunner().buildChildArgs({ persona: "egm-design", task: "x" }, {}, "/tmp/p.md");
	assert.equal(args[args.indexOf("--system-prompt") + 1], CHILD_BASE_SYSTEM_PROMPT);
	// Passing --append-system-prompt is what keeps a user APPEND_SYSTEM.md out.
	assert.ok(args.includes("--append-system-prompt"));
});

test("findReportProblem rejects empty and cut-off reports", () => {
	assert.equal(findReportProblem("stop", "findings"), undefined);
	assert.match(findReportProblem("stop", "  \n") ?? "", /without returning a report/);
	assert.match(findReportProblem("length", "partial") ?? "", /cut off/);
});

test("parseArtifactDirectory reads the setting line and skips placeholders", () => {
	assert.equal(parseArtifactDirectory("intro\nEGM artifact directory: .dev/docs  \nend"), ".dev/docs");
	assert.equal(parseArtifactDirectory("EGM artifact directory: a\nEGM artifact directory: b"), "b");
	assert.equal(parseArtifactDirectory("Set `EGM artifact directory: <path>` in AGENTS.md"), undefined);
	assert.equal(parseArtifactDirectory("EGM artifact directory: <path>"), undefined);
	assert.equal(parseArtifactDirectory(undefined), undefined);
});

test("artifact directory reaches writing personas only", () => {
	const runner = makeRunner();
	const note = "Artifact directory: /abs/docs";
	assert.ok(runner.buildChildSystemPrompt({ persona: "egm-synthesizer", task: "x" }, "/abs/docs").includes(note));
	assert.ok(!runner.buildChildSystemPrompt({ persona: "egm-design", task: "x" }, "/abs/docs").includes(note));
	assert.ok(!runner.buildChildSystemPrompt({ persona: "egm-synthesizer", task: "x" }).includes("Artifact directory:"));
});

test("task timeout gives nesting personas longer and honors the env override", () => {
	const runner = makeRunner();
	const previous = process.env.EGM_PI_TIMEOUT_MINUTES;
	try {
		delete process.env.EGM_PI_TIMEOUT_MINUTES;
		const leaf = DEFAULT_TASK_TIMEOUT_MINUTES * 60_000;
		assert.equal(runner.taskTimeoutMs("egm-design"), leaf);
		assert.equal(runner.taskTimeoutMs("egm-synthesizer"), leaf * NESTING_TIMEOUT_MULTIPLIER);

		process.env.EGM_PI_TIMEOUT_MINUTES = "5";
		assert.equal(runner.taskTimeoutMs("egm-design"), 300_000);

		process.env.EGM_PI_TIMEOUT_MINUTES = "nonsense";
		assert.equal(runner.taskTimeoutMs("egm-design"), leaf);
	} finally {
		if (previous === undefined) delete process.env.EGM_PI_TIMEOUT_MINUTES;
		else process.env.EGM_PI_TIMEOUT_MINUTES = previous;
	}
});

test("bootstrap orchestrators get one more spawn level than other personas", () => {
	const runner = makeRunner();
	const saved = { depth: process.env.EGM_PI_DEPTH, persona: process.env.EGM_PI_PERSONA };
	try {
		process.env.EGM_PI_DEPTH = String(MAX_SPAWN_DEPTH);
		process.env.EGM_PI_PERSONA = "egm-synthesizer";
		assert.ok(runner.depthError(), "synthesizer stops at the standard limit");

		process.env.EGM_PI_PERSONA = "egm-bootstrap-orchestrator";
		assert.equal(runner.depthError(), undefined, "bootstrap worker can still spawn scouts");

		process.env.EGM_PI_DEPTH = String(BOOTSTRAP_MAX_SPAWN_DEPTH);
		assert.ok(runner.depthError(), "bootstrap recursion is still bounded");
	} finally {
		for (const [key, value] of [["EGM_PI_DEPTH", saved.depth], ["EGM_PI_PERSONA", saved.persona]] as const) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

test("EGM_PI_CHILD_EXTENSIONS adds explicit extensions to child args", () => {
	assert.deepEqual(parseChildExtensions(" /a/p.ts, builtin:llama.cpp ,"), ["/a/p.ts", "builtin:llama.cpp"]);
	assert.deepEqual(parseChildExtensions(undefined), []);
	const previous = process.env.EGM_PI_CHILD_EXTENSIONS;
	try {
		process.env.EGM_PI_CHILD_EXTENSIONS = "/a/p.ts";
		const args = makeRunner().buildChildArgs({ persona: "egm-design", task: "x" }, {}, "/tmp/p.md");
		assert.equal(args[args.indexOf("-e") + 1], "/a/p.ts");
		assert.ok(args.includes("-ne"), "discovery stays disabled");
	} finally {
		if (previous === undefined) delete process.env.EGM_PI_CHILD_EXTENSIONS;
		else process.env.EGM_PI_CHILD_EXTENSIONS = previous;
	}
});

test("explainModelFailure only explains model setup errors", () => {
	assert.ok(explainModelFailure('Error: Model "x/y" not found.')?.includes("EGM_PI_CHILD_EXTENSIONS"));
	assert.ok(explainModelFailure("No API key found for mock."));
	assert.equal(explainModelFailure("connection reset"), undefined);
});

test("taskOutputCap shares the total budget across tasks", () => {
	assert.equal(taskOutputCap(1), PER_TASK_OUTPUT_CAP);
	assert.equal(taskOutputCap(8), Math.floor(TOTAL_OUTPUT_CAP / 8));
	assert.ok(taskOutputCap(8) * 8 <= TOTAL_OUTPUT_CAP);
});

test("capOutput keeps short text and saves the full copy of long text", () => {
	assert.equal(capOutput("short", 100, "egm-design"), "short");
	const full = "🔴".repeat(100);
	const capped = capOutput(full, 10, "egm-design");
	assert.ok(capped.startsWith("🔴🔴"), "no split character");
	// Odd caps can land inside a surrogate pair; only encoding reveals the damage.
	for (const cap of [10, 11, 12, 13, 15]) {
		const note = capOutput(full, cap, "egm-design");
		fs.rmSync(path.dirname(note.match(/full report at (.+\.md)\./)?.[1] ?? ""), { recursive: true, force: true });
		assert.ok(!Buffer.from(note, "utf8").toString("utf8").includes("\uFFFD"), `split character at cap ${cap}`);
	}
	const savedPath = capped.match(/full report at (.+\.md)\./)?.[1];
	assert.ok(savedPath, "note names the saved file");
	try {
		assert.equal(fs.readFileSync(savedPath, "utf8"), full);
	} finally {
		fs.rmSync(path.dirname(savedPath), { recursive: true, force: true });
	}
});
