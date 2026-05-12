# Registry

## Responsibility
Loads and parses registry index files (JSON/YAML) and API-backed registry sources (skills.sh).

## Key Files
- `packages/registry/src/index.ts`

## Entry Points
- `loadRegistryIndex(locator)` — dispatched from `packages/core` during `reindexSource`

## Dependencies
- js-yaml
- @agentpm/fs (pathExists, readTextFile)
- @agentpm/shared (AgentPmError, types, isHttpUrl, isSkillsShLocator)

## Notes
- Supports static registry files (local .json/.yaml files or HTTP URLs serving them).
- **skills.sh API**: When locator matches `isSkillsShLocator`, delegates to `loadSkillsShIndex`. Paginates `GET /api/v1/skills`. Requires `SKILLS_SH_API_KEY` env var.
- **SkillsHub API** (`skillshub.wtf`): When locator matches `isSkillsHubLocator`, delegates to `loadSkillsHubIndex`. Paginates `GET /api/v1/skills/search?page=N&limit=50`. No auth required. Limited to 20 pages (1000 entries) to avoid rate limiting, with 500ms delay between pages.
- HTTP requests use `node:https` (not `fetch()`) to avoid a libuv handle cleanup assert on Windows (Node.js v25.x).
- The `readRegistryLocator` function fetches remote registry content via `httpsGet`.
