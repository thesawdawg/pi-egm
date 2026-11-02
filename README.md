# pi-egm

[Elephant-Goldfish Model](https://github.com/google/elephant-goldfish-model)
(EGM) for [pi](https://pi.dev): draft specs, run multi-persona Goldfish design
reviews, resolve findings, and check implementation drift.

EGM reviews depend on *fresh-context* subagents. Pi has no built-in subagent
tool, so this package ships one: `egm_subagent` runs each delegated task as a
separate `pi` child process with no conversation history, no project context
files, and a host-enforced per-persona tool allowlist.

The upstream EGM content (skills, reviewer personas, resources, docs) is
vendored verbatim under `egm/` and pinned to a commit in `egm/UPSTREAM.json`.

## Install

```bash
# From a local checkout
pi install ./pi-egm

# Or try it for a single run without installing
pi -e ./pi-egm
```

## Use

EGM skills are `disable-model-invocation`, so invoke them explicitly:

```text
/skill:egm-brainstorm
/skill:egm-draft
/skill:egm-review
/skill:egm-review-loop
/skill:egm-resolve
/skill:egm-drift-report
/skill:egm-bootstrap
```

When a skill says "spawn a subagent", the model calls `egm_subagent` with a
persona name from `egm/agents/*.md` frontmatter:

| Persona | Role | Child tools |
| --- | --- | --- |
| `egm-zoom-out`, `egm-comprehension`, `egm-design`, `egm-codebase-details`, `egm-structural`, `egm-style`, `egm-implementation-readiness` | Goldfish reviewers | `read,grep,find,ls` |
| `egm-synthesizer` | Aggregates reviewer findings, writes the report | `read,grep,find,ls,write,egm_subagent` |
| `egm-bootstrap-orchestrator` | Coordinates bootstrap workers | `read,grep,find,ls,write,edit,egm_subagent` |
| `general` | Generic read-only agent; supply a `systemPrompt` per task (e.g. the `goldfish-explorer` scout) | `read,grep,find,ls` |

Key mechanics:

- **Isolation**: children run with `-nc -ns -np --no-themes -ne -na
  --no-session` — no conversation history, no AGENTS.md, no skills, no
  discovered extensions, no project-local config. Only the two orchestrator
  personas get this extension loaded (`-e`) so they can nest `egm_subagent`.
- **Depth**: `EGM_PI_DEPTH` tracks delegation depth; `egm_subagent` refuses to
  spawn at depth 2 (Elephant → orchestrator → reviewers).
- **Paths**: skill text references like `agents/`, `resources/`, `docs/`
  resolve against the vendored plugin root (`egm/`), told to both the parent
  (via system-prompt guidance) and each child (via an appended system prompt).
- **Artifacts**: written to the working directory unless the user sets
  `EGM artifact directory: <path>` in the prompt or AGENTS.md.

## Develop

```bash
npm install --ignore-scripts
npm run typecheck   # tsc --noEmit
npm test            # node:test unit tests (no network, no model calls)
npm run sync        # re-vendor egm/ from upstream (optional ref: npm run sync -- v1.2.3)
```

`egm/` is a verbatim upstream copy plus `UPSTREAM.json` — never hand-edit it;
change upstream or re-sync instead.

## License

Apache-2.0. `egm/` is vendored unmodified from Google's EGM repo (see NOTICE).
This package is not an official Google product.
