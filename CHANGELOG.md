# Changelog

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
