/**
 * Persona registry for the EGM extension.
 *
 * Loads the vendored EGM reviewer personas from egm/agents/*.md and maps each
 * persona (plus the built-in "general" persona) to the tool allowlist the host
 * enforces on its child pi process.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

/** Name of the delegation tool this extension registers; referenced in persona tool allowlists. */
export const SUBAGENT_TOOL_NAME = "egm_subagent";

/** Persona name accepted for a generic read-only agent with no persona file. */
export const GENERAL_PERSONA = "general";

/**
 * Deepest egm_subagent call depth: Elephant (0) -> orchestrator/synthesizer
 * (1) -> reviewers/scouts (2). At this depth the tool refuses to spawn.
 */
export const MAX_SPAWN_DEPTH = 2;

/**
 * Bootstrap needs one more level than review: Elephant -> root orchestrator ->
 * worker orchestrator -> scouts. A refused scout would put placeholder text in
 * generated READMEs, so the limit must fit the skill's real shape.
 */
export const BOOTSTRAP_MAX_SPAWN_DEPTH = 3;

/** Tools every read-only Goldfish subagent gets: inspect, never modify. */
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];

/**
 * Personas allowed to spawn subagents themselves get egm_subagent and the write
 * tools their upstream instructions require (the synthesizer writes a report;
 * the bootstrap orchestrator edits READMEs). Everyone else stays read-only.
 */
const NESTING_PERSONA_TOOLS: Record<string, string[]> = {
	"egm-synthesizer": [...READ_ONLY_TOOLS, "write", SUBAGENT_TOOL_NAME],
	"egm-bootstrap-orchestrator": [...READ_ONLY_TOOLS, "write", "edit", SUBAGENT_TOOL_NAME],
};

/** A vendored EGM persona parsed from one agents/*.md file. */
export interface Persona {
	/** Persona name from frontmatter (e.g. "egm-design"); what callers pass to egm_subagent. */
	name: string;
	/** One-line persona description from frontmatter. */
	description: string;
	/** Markdown body after frontmatter; becomes the child's appended system prompt. */
	body: string;
	/** Absolute path of the source persona file. */
	filePath: string;
}

/** Host-enforced capabilities for a subagent child process. */
export interface PersonaPolicy {
	/** Value passed to the child's --tools allowlist. */
	tools: string[];
	/** Whether the child loads this extension so it can call egm_subagent itself. */
	canNest: boolean;
	/** Depth at which a process running this persona may no longer spawn. */
	maxSpawnDepth: number;
}

/**
 * Returns the tool allowlist and nesting capability for a persona name.
 * Any name not in NESTING_PERSONA_TOOLS (including "general") is read-only.
 *
 * @param name - Persona name to look up.
 * @returns The host-enforced policy for that persona.
 */
export function policyForPersona(name: string): PersonaPolicy {
	const tools = NESTING_PERSONA_TOOLS[name];
	const maxSpawnDepth = name === "egm-bootstrap-orchestrator" ? BOOTSTRAP_MAX_SPAWN_DEPTH : MAX_SPAWN_DEPTH;
	return tools
		? { tools: [...tools], canNest: true, maxSpawnDepth }
		: { tools: [...READ_ONLY_TOOLS], canNest: false, maxSpawnDepth };
}

/**
 * Registry of EGM personas loaded from the vendored agents/ directory.
 */
export class PersonaRegistry {
	private readonly personas: Map<string, Persona>;

	private constructor(personas: Persona[]) {
		this.personas = new Map(personas.map((persona) => [persona.name, persona]));
	}

	/**
	 * Loads every *.md persona file in agentsDir into a registry.
	 *
	 * @param agentsDir - Directory of vendored persona files (egm/agents).
	 * @returns A registry keyed by frontmatter persona name.
	 * @throws If a persona file lacks a frontmatter `name` or declares a duplicate.
	 */
	static load(agentsDir: string): PersonaRegistry {
		const personas: Persona[] = [];
		for (const entry of fs.readdirSync(agentsDir).sort()) {
			if (!entry.endsWith(".md")) continue;
			const filePath = path.join(agentsDir, entry);
			const { frontmatter, body } = parseFrontmatter<{ name?: string; description?: string }>(
				fs.readFileSync(filePath, "utf8"),
			);
			if (!frontmatter.name) {
				throw new Error(`EGM persona file ${filePath} has no frontmatter "name"`);
			}
			if (personas.some((p) => p.name === frontmatter.name)) {
				throw new Error(`Duplicate EGM persona name "${frontmatter.name}" in ${filePath}`);
			}
			personas.push({
				name: frontmatter.name,
				description: frontmatter.description ?? "",
				body,
				filePath,
			});
		}
		return new PersonaRegistry(personas);
	}

	/**
	 * Looks up a persona by frontmatter name.
	 *
	 * @param name - Persona name (e.g. "egm-zoom-out").
	 * @returns The persona, or undefined if the name is unknown.
	 */
	get(name: string): Persona | undefined {
		return this.personas.get(name);
	}

	/**
	 * Whether a name is a valid persona: a loaded file or the built-in "general".
	 *
	 * @param name - Persona name to check.
	 * @returns True when the name can be passed to egm_subagent.
	 */
	isValid(name: string): boolean {
		return name === GENERAL_PERSONA || this.personas.has(name);
	}

	/**
	 * All persona names accepted by egm_subagent, sorted.
	 *
	 * @returns Loaded persona names plus "general".
	 */
	validNames(): string[] {
		return [...this.personas.keys(), GENERAL_PERSONA].sort();
	}
}
