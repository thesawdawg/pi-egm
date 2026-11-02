/**
 * Subagent runner for the EGM extension.
 *
 * Spawns each delegated task as a fresh `pi` child process (isolated context,
 * no session, no project config or context files) with a host-enforced tool
 * allowlist per persona, then collects the child's final assistant message
 * from its JSON event stream.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { type PersonaRegistry, policyForPersona } from "./personas.ts";

export { BOOTSTRAP_MAX_SPAWN_DEPTH, MAX_SPAWN_DEPTH } from "./personas.ts";

/** Maximum tasks accepted in one egm_subagent call. */
export const MAX_PARALLEL_TASKS = 8;

/** Maximum child pi processes running at once. */
export const MAX_CONCURRENCY = 4;

/** Per-task cap on the final output returned to the parent. */
export const PER_TASK_OUTPUT_CAP = 50 * 1024;

/**
 * Cap on all task output in one tool result. Direct dispatch would otherwise
 * put eight full reports in the Elephant's context, which EGM exists to protect.
 */
export const TOTAL_OUTPUT_CAP = 100 * 1024;

/** Env var carrying the current delegation depth into child processes. */
const DEPTH_ENV_VAR = "EGM_PI_DEPTH";

/** Default wall-clock limit for a read-only child. */
export const DEFAULT_TASK_TIMEOUT_MINUTES = 30;

/**
 * Nesting children wait on their own children, so their limit must outlast
 * several full reviewer runs; otherwise a healthy Synthesizer dies first.
 */
export const NESTING_TIMEOUT_MULTIPLIER = 4;

/** Env var telling a child which persona it is running, for its own spawn limit. */
const PERSONA_ENV_VAR = "EGM_PI_PERSONA";

/** Env var listing comma-separated extensions to load into every child. */
const CHILD_EXTENSIONS_ENV_VAR = "EGM_PI_CHILD_EXTENSIONS";

/** Env var overriding DEFAULT_TASK_TIMEOUT_MINUTES (slow local models need more). */
const TIMEOUT_ENV_VAR = "EGM_PI_TIMEOUT_MINUTES";

/** Env var carrying the resolved artifact directory to nested children. */
const ARTIFACT_DIR_ENV_VAR = "EGM_PI_ARTIFACT_DIR";

/**
 * Replaces pi's default prompt so a user-level SYSTEM.md cannot reach a
 * Goldfish: pi only consults that file when --system-prompt is absent.
 */
export const CHILD_BASE_SYSTEM_PROMPT =
	"You are a delegated EGM subagent running non-interactively with a fresh context. " +
	"Use your tools to do the task, then give your complete result in your final message; nobody can answer questions.";

/** One delegated task, as accepted by the egm_subagent tool. */
export interface SubagentTask {
	/** Persona name from the registry, or "general". */
	persona: string;
	/** Task prompt passed to the child verbatim. */
	task: string;
	/** Optional extra system-prompt text (e.g. a goldfish-explorer scout definition). */
	systemPrompt?: string;
}

/** Model settings inherited from the parent session. */
export interface DispatchDefaults {
	/** "provider/id" model string, or undefined to use pi's default. */
	model?: string;
	/** Thinking level, or undefined to use pi's default. */
	thinkingLevel?: ThinkingLevel;
	/** Absolute artifact directory, or undefined to use the working directory. */
	artifactDir?: string;
}

/** Aggregated usage reported by a child's assistant messages. */
export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

/** Outcome of one delegated task. */
export interface SubagentResult {
	persona: string;
	task: string;
	/** "completed" means the child delivered a full report; anything else is a failure. */
	status: "completed" | "failed" | "aborted" | "timed_out";
	exitCode: number;
	/** Final assistant text, capped by taskOutputCap(); a truncation note names the full copy. */
	output: string;
	stderr: string;
	stopReason?: string;
	errorMessage?: string;
	usage: UsageStats;
}

/** Called after each task settles: the finished result and completion counts. */
export type ProgressCallback = (result: SubagentResult, done: number, total: number) => void;

function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

/**
 * Resolves how to invoke pi: prefer rerunning the current script with the same
 * runtime (covers global installs and standalone binaries), then the process
 * itself when it is a dedicated binary, and finally a `pi` on PATH.
 *
 * @param args - CLI arguments for the child invocation.
 * @returns The command and full argument list to spawn.
 */
function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

/**
 * Returns the last assistant text from a message list, or "" if none.
 *
 * @param messages - Child messages collected from JSON events.
 * @returns The final assistant text content.
 */
function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

/**
 * Output budget for each task in a call of the given size.
 *
 * @param taskCount - Number of tasks in the call.
 * @returns The per-task cap in bytes.
 */
export function taskOutputCap(taskCount: number): number {
	return Math.min(PER_TASK_OUTPUT_CAP, Math.floor(TOTAL_OUTPUT_CAP / Math.max(1, taskCount)));
}

/**
 * Truncates output to a byte cap without splitting a multi-byte UTF-8
 * character. The full text is saved to a private temp file so an oversized
 * report stays readable instead of losing findings.
 *
 * @param output - Raw text to cap.
 * @param cap - Maximum bytes to keep inline.
 * @param persona - Persona name, used to name the saved file.
 * @returns The text, unchanged or truncated with a note naming the saved copy.
 */
export function capOutput(output: string, cap: number, persona: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= cap) return output;
	let truncated = output.slice(0, cap);
	while (Buffer.byteLength(truncated, "utf8") > cap) {
		truncated = truncated.slice(0, -1);
	}
	// The loop can stop on half a surrogate pair, which encodes as U+FFFD.
	const lastCodeUnit = truncated.charCodeAt(truncated.length - 1);
	if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) truncated = truncated.slice(0, -1);
	let location = "The full report could not be saved.";
	try {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-egm-output-"));
		const filePath = path.join(directory, `${persona.replace(/[^\w.-]+/g, "_")}.md`);
		fs.writeFileSync(filePath, output, { encoding: "utf-8", mode: 0o600 });
		location = `Read the full report at ${filePath}.`;
	} catch {
		// The inline text is still useful; the note above reports the lost copy.
	}
	const omitted = byteLength - Buffer.byteLength(truncated, "utf8");
	return `${truncated}\n\n[Output truncated: ${omitted} bytes omitted. ${location}]`;
}

/**
 * Maps items through fn with at most `concurrency` in flight, preserving order.
 *
 * @param items - Items to process.
 * @param concurrency - Maximum concurrent calls.
 * @param fn - Async mapper invoked once per item.
 * @returns Results in input order.
 */
async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

/**
 * Finds the `EGM artifact directory: <path>` setting in prompt or context text.
 * The last match wins because pi loads the most specific context file last.
 *
 * @param text - Text to search.
 * @returns The configured path, or undefined when absent.
 */
export function parseArtifactDirectory(text: string | undefined): string | undefined {
	if (!text) return undefined;
	const matches = [...text.matchAll(/^[ \t]*EGM artifact directory:[ \t]*(\S.*?)[ \t]*$/gm)];
	const value = matches.at(-1)?.[1];
	return value && !value.startsWith("<") ? value : undefined;
}

/**
 * Parses the comma-separated child extension list.
 *
 * @param value - Raw EGM_PI_CHILD_EXTENSIONS value.
 * @returns Extension paths or builtin:<name> entries; empty when unset.
 */
export function parseChildExtensions(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

/**
 * Explains a child's model-setup failure, which the parent cannot detect up
 * front because the parent itself has the extension or key the child lacks.
 *
 * @param detail - The child's error text.
 * @returns How to fix it, or undefined for unrelated failures.
 */
export function explainModelFailure(detail: string): string | undefined {
	if (!/Model ".*" not found|No API key found/.test(detail)) return undefined;
	return (
		"Subagents start without extensions and do not inherit --api-key. Set EGM_PI_CHILD_EXTENSIONS to the " +
		"extension that registers this provider, or configure the key in models.json, auth.json, or an environment variable."
	);
}

/**
 * Explains why a child that exited cleanly did not deliver a usable report.
 * EGM treats a missing report as "not run", never as zero findings, and a
 * cut-off report would otherwise pass for a complete one.
 *
 * @param stopReason - The child's final stop reason.
 * @param output - The child's final assistant text.
 * @returns The failure message, or undefined when the report is usable.
 */
export function findReportProblem(stopReason: string | undefined, output: string): string | undefined {
	if (stopReason === "length") return "Report cut off at the model's output token limit; findings are incomplete.";
	if (!output.trim()) return "Child finished without returning a report.";
	return undefined;
}

/**
 * Runs EGM subagent tasks as child pi processes.
 */
export class SubagentRunner {
	private readonly registry: PersonaRegistry;
	private readonly egmRoot: string;
	private readonly extensionPath: string;

	/**
	 * @param registry - Loaded persona registry.
	 * @param egmRoot - Absolute path of the vendored EGM plugin root (egm/).
	 * @param extensionPath - Absolute path of this extension's index.ts, passed
	 *   to nesting children via `-e`.
	 */
	constructor(registry: PersonaRegistry, egmRoot: string, extensionPath: string) {
		this.registry = registry;
		this.egmRoot = egmRoot;
		this.extensionPath = extensionPath;
	}

	/**
	 * Current delegation depth: 0 in the Elephant, parent+1 in each child.
	 *
	 * @returns The depth read from EGM_PI_DEPTH, or 0 when unset/unparseable.
	 */
	currentDepth(): number {
		const depth = Number.parseInt(process.env[DEPTH_ENV_VAR] ?? "0", 10);
		return Number.isFinite(depth) && depth >= 0 ? depth : 0;
	}

	/**
	 * Spawn limit for this process, from the persona it is running.
	 *
	 * @returns The depth at which this process may no longer spawn.
	 */
	maxSpawnDepth(): number {
		return policyForPersona(process.env[PERSONA_ENV_VAR] ?? "").maxSpawnDepth;
	}

	/**
	 * Whether this process may still spawn subagents.
	 *
	 * @returns True when currentDepth() is below maxSpawnDepth().
	 */
	canSpawn(): boolean {
		return this.currentDepth() < this.maxSpawnDepth();
	}

	/**
	 * Error message when spawning is refused by the depth guard.
	 *
	 * @returns The refusal text, or undefined when spawning is allowed.
	 */
	depthError(): string | undefined {
		if (this.canSpawn()) return undefined;
		return (
			`egm_subagent refused: delegation depth ${this.currentDepth()} reached the maximum ` +
			`of ${this.maxSpawnDepth()} for this persona (Elephant -> synthesizer/orchestrator -> reviewers). ` +
			`Perform the remaining work inline instead of spawning.`
		);
	}

	/**
	 * Artifact directory inherited from a parent EGM process.
	 *
	 * @returns The inherited absolute path, or undefined at the root.
	 */
	inheritedArtifactDir(): string | undefined {
		return process.env[ARTIFACT_DIR_ENV_VAR] || undefined;
	}

	/**
	 * Wall-clock limit for one child of the given persona.
	 *
	 * @param persona - Persona name.
	 * @returns The limit in milliseconds.
	 */
	taskTimeoutMs(persona: string): number {
		const configured = Number.parseFloat(process.env[TIMEOUT_ENV_VAR] ?? "");
		const minutes = configured > 0 ? configured : DEFAULT_TASK_TIMEOUT_MINUTES;
		const multiplier = policyForPersona(persona).canNest ? NESTING_TIMEOUT_MULTIPLIER : 1;
		return minutes * multiplier * 60_000;
	}

	/**
	 * Validates persona names and task content without spawning.
	 *
	 * @param tasks - Tasks from the tool call.
	 * @returns An error message, or undefined when all tasks are valid.
	 */
	validateTasks(tasks: SubagentTask[]): string | undefined {
		if (tasks.length === 0) return "egm_subagent requires at least one task.";
		if (tasks.length > MAX_PARALLEL_TASKS) {
			return `Too many tasks (${tasks.length}); the maximum is ${MAX_PARALLEL_TASKS}.`;
		}
		const unknown = [...new Set(tasks.map((t) => t.persona).filter((p) => !this.registry.isValid(p)))];
		if (unknown.length > 0) {
			return (
				`Unknown persona(s): ${unknown.map((p) => `"${p}"`).join(", ")}. ` +
				`Valid personas: ${this.registry.validNames().map((p) => `"${p}"`).join(", ")}.`
			);
		}
		return undefined;
	}

	/**
	 * Builds the system-prompt text appended to a child's default prompt: the
	 * persona file body, any per-task extra prompt (runtime scout definitions),
	 * and the pi-specific path/tooling addendum.
	 *
	 * @param task - The delegated task.
	 * @param artifactDir - Absolute artifact directory, if one is configured.
	 * @returns Markdown text written to the --append-system-prompt file.
	 */
	buildChildSystemPrompt(task: SubagentTask, artifactDir?: string): string {
		const sections: string[] = [];
		const persona = this.registry.get(task.persona);
		if (persona?.body.trim()) sections.push(persona.body.trim());
		if (task.systemPrompt?.trim()) sections.push(task.systemPrompt.trim());

		const policy = policyForPersona(task.persona);
		const toolingNote = policy.canNest
			? `Spawn subagents with the \`egm_subagent\` tool using persona names (or \`general\`). ` +
				`Write files only where your instructions require it; every file path above still resolves against the EGM plugin root.`
			: "You have no write or edit tools; deliver all findings in your final message.";
		const notes = [
			"---",
			"",
			"## Pi runtime notes (EGM)",
			"",
			`- EGM plugin root: ${this.egmRoot}. Resolve relative \`agents/\`, \`resources/\`, \`docs/\`, and \`skills/\` paths in these instructions against this directory.`,
			"- If a file required by these instructions cannot be read, report an incomplete review instead of returning a verdict.",
			`- ${toolingNote}`,
		];
		if (artifactDir && policy.canNest) {
			notes.push(`- Artifact directory: ${artifactDir}. Write briefs and reports there, not to the working directory.`);
		}
		sections.push(notes.join("\n"));
		return sections.join("\n\n");
	}

	/**
	 * Builds the child pi argument list. Isolation flags give the child a fresh
	 * context: no session, no context files, no skills, no prompt templates, no
	 * themes, no discovered extensions, and no project-local config. Personas
	 * that may nest additionally get `-e <extensionPath>` so egm_subagent is
	 * registered in their allowlist.
	 *
	 * @param task - The delegated task.
	 * @param defaults - Model settings inherited from the parent.
	 * @param promptFilePath - Temp file path for --append-system-prompt.
	 * @returns The full CLI argument list for the child.
	 */
	buildChildArgs(task: SubagentTask, defaults: DispatchDefaults, promptFilePath: string): string[] {
		const args = [
			"--mode",
			"json",
			"-p",
			"--no-session",
			"-nc",
			"-ns",
			"-np",
			"--no-themes",
			"-ne",
			"-na",
		];
		if (defaults.model) args.push("--model", defaults.model);
		if (defaults.thinkingLevel) args.push("--thinking", defaults.thinkingLevel);
		args.push("--system-prompt", CHILD_BASE_SYSTEM_PROMPT);
		const policy = policyForPersona(task.persona);
		args.push("--tools", policy.tools.join(","));
		if (policy.canNest) args.push("-e", this.extensionPath);
		// -ne also removes extension-registered providers, so a user whose model
		// comes from one must be able to opt that single extension back in.
		for (const extension of parseChildExtensions(process.env[CHILD_EXTENSIONS_ENV_VAR])) {
			args.push("-e", extension);
		}
		args.push("--append-system-prompt", promptFilePath);
		args.push(`Task: ${task.task}`);
		return args;
	}

	/**
	 * Runs one task in a child pi process and collects its result.
	 *
	 * @param task - The delegated task.
	 * @param cwd - Working directory for the child.
	 * @param defaults - Model settings inherited from the parent.
	 * @param signal - Parent abort signal; kills the child when aborted.
	 * @param outputCap - Maximum output bytes returned inline.
	 * @returns The task result; never throws for child failures.
	 */
	async runTask(
		task: SubagentTask,
		cwd: string,
		defaults: DispatchDefaults,
		signal: AbortSignal | undefined,
		outputCap: number = PER_TASK_OUTPUT_CAP,
	): Promise<SubagentResult> {
		const result: SubagentResult = {
			persona: task.persona,
			task: task.task,
			status: "failed",
			exitCode: 1,
			output: "",
			stderr: "",
			usage: emptyUsage(),
		};

		const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-egm-"));
		const promptFilePath = path.join(tmpDir, `prompt-${task.persona.replace(/[^\w.-]+/g, "_")}.md`);
		let wasAborted = false;
		let timedOut = false;
		const timeoutMs = this.taskTimeoutMs(task.persona);
		try {
			await fs.promises.writeFile(promptFilePath, this.buildChildSystemPrompt(task, defaults.artifactDir), {
				encoding: "utf-8",
				mode: 0o600,
			});
			const args = this.buildChildArgs(task, defaults, promptFilePath);
			const messages: Message[] = [];

			result.exitCode = await new Promise<number>((resolve) => {
				const invocation = getPiInvocation(args);
				const proc = spawn(invocation.command, invocation.args, {
					cwd,
					shell: false,
					stdio: ["ignore", "pipe", "pipe"],
					env: {
						...process.env,
						[DEPTH_ENV_VAR]: String(this.currentDepth() + 1),
						[PERSONA_ENV_VAR]: task.persona,
						...(defaults.artifactDir ? { [ARTIFACT_DIR_ENV_VAR]: defaults.artifactDir } : {}),
					},
				});
				let buffer = "";
				// Pipe chunks can end inside a multi-byte character; decoding each
				// chunk alone would corrupt reports that use emoji severity markers.
				const stdoutDecoder = new StringDecoder("utf8");

				const processLine = (line: string) => {
					if (!line.trim()) return;
					let event: { type?: string; message?: Message };
					try {
						event = JSON.parse(line);
					} catch {
						return;
					}
					if ((event.type === "message_end" || event.type === "tool_result_end") && event.message) {
						const message = event.message;
						messages.push(message);
						if (message.role === "assistant") {
							result.usage.turns++;
							const usage = message.usage;
							if (usage) {
								result.usage.input += usage.input || 0;
								result.usage.output += usage.output || 0;
								result.usage.cacheRead += usage.cacheRead || 0;
								result.usage.cacheWrite += usage.cacheWrite || 0;
								result.usage.cost += usage.cost?.total || 0;
							}
							if (message.stopReason) result.stopReason = message.stopReason;
							if (message.errorMessage) result.errorMessage = message.errorMessage;
						}
					}
				};

				proc.stdout.on("data", (data: Buffer) => {
					buffer += stdoutDecoder.write(data);
					const lines = buffer.split("\n");
					buffer = lines.pop() || "";
					for (const line of lines) processLine(line);
				});
				proc.stderr.on("data", (data: Buffer) => {
					result.stderr += data.toString();
				});
				// `proc.killed` flips as soon as SIGTERM is sent, so check the real exit state instead.
				const terminate = () => {
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
					}, 5000).unref();
				};
				const killProc = () => {
					wasAborted = true;
					terminate();
				};
				const timeout = setTimeout(() => {
					timedOut = true;
					terminate();
				}, timeoutMs);
				const finish = (code: number) => {
					clearTimeout(timeout);
					signal?.removeEventListener("abort", killProc);
					resolve(code);
				};
				proc.on("close", (code) => {
					buffer += stdoutDecoder.end();
					if (buffer.trim()) processLine(buffer);
					finish(code ?? 1);
				});
				proc.on("error", (error) => {
					result.errorMessage = error.message;
					finish(1);
				});

				if (signal?.aborted) killProc();
				else signal?.addEventListener("abort", killProc, { once: true });
			});

			result.output = capOutput(getFinalOutput(messages), outputCap, task.persona);
			if (wasAborted) {
				result.status = "aborted";
			} else if (timedOut) {
				result.status = "timed_out";
				result.errorMessage = `Child stopped after reaching its ${timeoutMs / 60_000} minute limit.`;
			} else if (
				result.exitCode === 0 &&
				result.stopReason !== "error" &&
				result.stopReason !== "aborted"
			) {
				const problem = findReportProblem(result.stopReason, result.output);
				if (problem) result.errorMessage = problem;
				else result.status = "completed";
			}
			if (result.status === "failed") {
				const detail = result.errorMessage || result.stderr.trim();
				const hint = explainModelFailure(detail);
				if (hint) result.errorMessage = `${detail} ${hint}`;
			}
			return result;
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	}

	/**
	 * Runs all tasks concurrently (max MAX_CONCURRENCY children in flight) and
	 * reports "N/M done" progress after each finishes.
	 *
	 * @param tasks - Validated delegated tasks.
	 * @param cwd - Working directory for the children.
	 * @param defaults - Model settings inherited from the parent.
	 * @param signal - Parent abort signal.
	 * @param onProgress - Optional callback fired as each task settles.
	 * @returns One result per task, in input order.
	 */
	async runTasks(
		tasks: SubagentTask[],
		cwd: string,
		defaults: DispatchDefaults,
		signal: AbortSignal | undefined,
		onProgress?: ProgressCallback,
	): Promise<SubagentResult[]> {
		let done = 0;
		const outputCap = taskOutputCap(tasks.length);
		return mapWithConcurrencyLimit(tasks, MAX_CONCURRENCY, async (task) => {
			const result = await this.runTask(task, cwd, defaults, signal, outputCap);
			done++;
			onProgress?.(result, done, tasks.length);
			return result;
		});
	}
}
