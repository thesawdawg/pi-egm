/**
 * EGM extension entry point.
 *
 * Registers the `egm_subagent` delegation tool backed by the vendored EGM
 * personas, and appends a short "EGM on pi" section to the system prompt so
 * the model knows how EGM skill instructions map onto pi.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { PersonaRegistry } from "./personas.ts";
import {
	MAX_PARALLEL_TASKS,
	type SubagentResult,
	SubagentRunner,
	type SubagentTask,
} from "./runner.ts";

const EXTENSION_PATH = fileURLToPath(import.meta.url);
const PACKAGE_ROOT = path.resolve(path.dirname(EXTENSION_PATH), "../..");
const EGM_ROOT = path.join(PACKAGE_ROOT, "egm");
const AGENTS_DIR = path.join(EGM_ROOT, "agents");

const TaskItem = Type.Object({
	persona: Type.String({
		description:
			'Persona name from the EGM agents/*.md frontmatter (e.g. "egm-design", "egm-synthesizer"), or "general" for a generic read-only agent',
	}),
	task: Type.String({ description: "Task prompt passed verbatim to the subagent" }),
	systemPrompt: Type.Optional(
		Type.String({
			description:
				"Extra system-prompt text for this subagent, e.g. a runtime scout definition such as goldfish-explorer (use with persona \"general\")",
		}),
	),
});

const EgmSubagentParams = Type.Object({
	tasks: Type.Array(TaskItem, {
		minItems: 1,
		maxItems: MAX_PARALLEL_TASKS,
		description: "Subagent tasks to run concurrently (at most 4 children run in parallel)",
	}),
});

interface EgmSubagentDetails {
	results: SubagentResult[];
}

/**
 * Builds the EGM-on-pi guidance appended to the system prompt once per turn.
 * Kept constant within a session so prompt caching is unaffected.
 *
 * @param egmRoot - Absolute path of the vendored EGM plugin root.
 * @returns The guidance markdown section.
 */
export function buildEgmGuidance(egmRoot: string): string {
	return [
		"## Elephant-Goldfish Model (EGM)",
		"",
		`- EGM plugin root: ${egmRoot}. Relative paths in EGM skill text (\`agents/\`, \`resources/\`, \`docs/\`) resolve against this directory.`,
		"- EGM skills are explicit-only: invoke them as `/skill:egm-<name>` (e.g. `/skill:egm-review`).",
		'- When EGM skill text says "spawn a subagent", use the `egm_subagent` tool with the persona name from `agents/*.md` frontmatter (e.g. `egm-zoom-out`). `egm-synthesizer` and `egm-bootstrap-orchestrator` may nest `egm_subagent` calls; maximum delegation depth is 2.',
		'- For ad-hoc read-only scouts such as `goldfish-explorer`, call `egm_subagent` with persona `general` and pass the scout\'s system prompt via `systemPrompt`.',
		'- The Codex/Claude lines in EGM skills ("first read docs/codex.md", `${CLAUDE_PLUGIN_ROOT}/docs/claude.md`) do not apply on pi; ignore them.',
		"- Artifact directory: the working directory, unless the user sets `EGM artifact directory: <path>` in the prompt or AGENTS.md.",
	].join("\n");
}

/**
 * Formats one task result as a markdown section for the tool response.
 *
 * @param result - The task outcome.
 * @returns A headed section with status and (possibly truncated) output.
 */
function formatResultSection(result: SubagentResult): string {
	const status = result.status === "completed" ? "completed" : `failed (${result.status})`;
	const output = result.output || result.errorMessage || result.stderr.trim() || "(no output)";
	return `### [${result.persona}] ${status}\n\n${output}`;
}

/**
 * EGM extension factory: wires the persona registry, subagent runner,
 * egm_subagent tool, and system-prompt guidance into pi.
 *
 * @param pi - The pi extension API for this load.
 */
export default function egmExtension(pi: ExtensionAPI): void {
	const registry = PersonaRegistry.load(AGENTS_DIR);
	const runner = new SubagentRunner(registry, EGM_ROOT, EXTENSION_PATH);
	const guidance = buildEgmGuidance(EGM_ROOT);

	pi.registerTool({
		name: "egm_subagent",
		label: "EGM Subagent",
		description: [
			"Spawn one or more EGM Goldfish subagents, each in a fresh pi process with an isolated context",
			"(no conversation history, no project context files, host-enforced tool allowlist).",
			'Personas come from the EGM plugin\'s agents/*.md frontmatter names plus "general"',
			"(a generic read-only agent; supply its persona via the per-task systemPrompt, e.g. the",
			"goldfish-explorer scout). egm-synthesizer and egm-bootstrap-orchestrator can nest",
			"egm_subagent calls themselves; maximum delegation depth is 2.",
		].join(" "),
		promptSnippet: "egm_subagent — spawn EGM Goldfish subagents in fresh-context child pi processes",
		promptGuidelines: [
			'When EGM skill text says "spawn a subagent" and names a persona, call egm_subagent with that persona name and pass the task prompt verbatim.',
			'For runtime scout personas such as goldfish-explorer, use persona "general" and pass the scout system prompt via systemPrompt.',
			'egm_subagent refuses to spawn beyond delegation depth 2; a reviewer that fails or cannot run is "not run", never a zero-finding review.',
		],
		parameters: EgmSubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<EgmSubagentDetails>> {
			// 0.84.2 has no isError on AgentToolResult; throwing marks the tool
			// result as an error while preserving the message as its content.
			const depthError = runner.depthError();
			if (depthError) throw new Error(depthError);

			const tasks: SubagentTask[] = params.tasks;
			const validationError = runner.validateTasks(tasks);
			if (validationError) throw new Error(validationError);

			const settled: SubagentResult[] = [];
			const results = await runner.runTasks(
				tasks,
				ctx.cwd,
				{
					model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
					thinkingLevel: ctx.thinkingLevel,
				},
				signal,
				(result, done, total) => {
					settled.push(result);
					onUpdate?.({
						content: [{ type: "text", text: `${done}/${total} done` }],
						details: { results: [...settled] },
					});
				},
			);

			const successCount = results.filter((r) => r.status === "completed").length;
			const text = `${successCount}/${results.length} subagent task(s) completed\n\n${results
				.map(formatResultSection)
				.join("\n\n---\n\n")}`;
			if (successCount === 0) throw new Error(text);
			return {
				content: [{ type: "text", text }],
				details: { results },
			};
		},

		renderCall(args, theme) {
			const personas = args.tasks.map((t) => t.persona);
			const preview = personas.slice(0, 4).join(", ") + (personas.length > 4 ? `, +${personas.length - 4} more` : "");
			return new Text(
				theme.fg("toolTitle", theme.bold("egm_subagent ")) +
					theme.fg("accent", `${args.tasks.length} task(s)`) +
					theme.fg("dim", ` [${preview}]`),
				0,
				0,
			);
		},

		renderResult(result, _options, theme) {
			const details = result.details as EgmSubagentDetails | undefined;
			if (!details) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "(no output)", 0, 0);
			}
			const lines = details.results.map((r) => {
				const icon = r.status === "completed" ? theme.fg("success", "✓") : theme.fg("error", "✗");
				const preview = r.output.split("\n").slice(0, 3).join("\n");
				return `${icon} ${theme.fg("accent", r.persona)}\n${theme.fg("toolOutput", preview || "(no output)")}`;
			});
			return new Text(lines.join("\n\n"), 0, 0);
		},
	});

	// 0.84.2 has no systemPromptOptions.sections; replace the assembled prompt
	// with itself plus our constant section (chained safely with other extensions).
	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n${guidance}`,
	}));
}
