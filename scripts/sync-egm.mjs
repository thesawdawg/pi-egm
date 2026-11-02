/**
 * Syncs the vendored EGM upstream content into egm/.
 *
 * Usage: node scripts/sync-egm.mjs [ref]   (ref defaults to "main"; accepts a
 * branch, tag, or commit SHA)
 *
 * Fetches the ref shallowly, replaces egm/ with the upstream paths listed in
 * COPY_PATHS, and records the resolved commit in egm/UPSTREAM.json. The egm/
 * tree is a verbatim upstream copy plus UPSTREAM.json; never hand-edit it.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY = "https://github.com/google/elephant-goldfish-model";
const DEFAULT_REF = "main";

/** Upstream paths copied verbatim into egm/. The list mirrors the portable
 * plugin bundle documented in upstream docs/harnesses.md. */
const COPY_PATHS = ["skills", "agents", "resources", "docs", "LICENSE", "README.md", "plugin.json"];

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const egmDir = path.join(packageRoot, "egm");
const ref = process.argv[2] ?? DEFAULT_REF;

/**
 * Runs git with the given arguments inside dir, returning trimmed stdout.
 *
 * @param {string} dir - Repository working directory.
 * @param {string[]} args - git subcommand and arguments.
 * @returns {string} Trimmed stdout of the git invocation.
 */
function git(dir, args) {
	return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "egm-sync-"));
try {
	// init+fetch (rather than clone --branch) so any ref form works: branch,
	// tag, or full commit SHA.
	execFileSync("git", ["init", "-q", tmpDir]);
	git(tmpDir, ["remote", "add", "origin", REPOSITORY]);
	execFileSync("git", ["-C", tmpDir, "fetch", "--depth", "1", "origin", ref], { stdio: "inherit" });
	git(tmpDir, ["checkout", "-q", "FETCH_HEAD"]);
	const commit = git(tmpDir, ["rev-parse", "HEAD"]);

	fs.rmSync(egmDir, { recursive: true, force: true });
	fs.mkdirSync(egmDir, { recursive: true });
	for (const relPath of COPY_PATHS) {
		const src = path.join(tmpDir, relPath);
		if (!fs.existsSync(src)) {
			console.error(`warning: upstream path missing, skipped: ${relPath}`);
			continue;
		}
		fs.cpSync(src, path.join(egmDir, relPath), { recursive: true });
	}

	const upstream = { repository: REPOSITORY, ref, commit, syncedAt: new Date().toISOString() };
	fs.writeFileSync(path.join(egmDir, "UPSTREAM.json"), `${JSON.stringify(upstream, null, 2)}\n`);
	console.log(`Synced egm/ from ${REPOSITORY} @ ${commit} (ref: ${ref})`);
} finally {
	fs.rmSync(tmpDir, { recursive: true, force: true });
}
