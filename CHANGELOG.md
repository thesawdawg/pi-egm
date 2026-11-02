# Changelog

## [Unreleased]

### Fixed

- `egm_subagent` reports a child that returns no report, or is cut off at the
  output token limit, as failed instead of completed.
- Child `pi` processes no longer load a user-level `SYSTEM.md`.
- `EGM artifact directory` now reaches writing subagents, which run without
  context files.
- `egm-bootstrap-orchestrator` chains can reach their scouts (depth limit 3).
- One `egm_subagent` result is limited to 100 KB of reports; oversized reports
  are saved to a temp file instead of being lost.
- System-prompt guidance now carries the harness rules from the Claude and
  Codex docs it tells the model to skip, and explains how to reach hidden skills.
- Long reports no longer contain corrupted characters from split UTF-8 in child
  output or truncation.
- Guidance now keeps a copy of `goldfish_review_report.md` before a later review
  round or stage overwrites it.
- Model setup failures in children now explain how to fix them.

### Added

- Per-child timeouts: 30 minutes for read-only personas, 120 for orchestrators.
  `EGM_PI_TIMEOUT_MINUTES` overrides the read-only limit.
- `EGM_PI_CHILD_EXTENSIONS` loads named extensions into children, for models
  from extension-registered providers.

## [0.1.0]

### Added

- Vendored [Elephant-Goldfish Model](https://github.com/google/elephant-goldfish-model)
  content (`egm/`: 7 skills, 9 personas, resources, docs), pinned to an
  upstream commit in `egm/UPSTREAM.json`, with `scripts/sync-egm.mjs` to re-sync.
- `egm_subagent` extension tool: spawns EGM personas as fresh-context child
  `pi` processes (no session, context files, skills, extensions, or
  project-local config) with host-enforced per-persona tool allowlists,
  1-8 concurrent tasks, and a delegation-depth guard (max depth 2).
- `PersonaRegistry` and `SubagentRunner` in `extensions/egm/`.
- `before_agent_start` guidance that teaches the model how EGM skill
  instructions map onto pi (`egm_subagent`, `/skill:egm-*`, plugin-root paths,
  artifact directory).
