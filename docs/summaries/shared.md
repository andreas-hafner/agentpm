# Shared

## Responsibility
Shared types, pure utility functions, and cross-package constants. No runtime dependencies on other AgentPM packages.

## Key Files
- `packages/shared/src/index.ts`

## Entry Points
- Used by all packages via `@agentpm/shared` import

## Dependencies
- Node.js built-ins only (crypto, path)

## Notes
- `classifyLocator` determines source kind from a locator string. `isSkillsShLocator` recognizes skills.sh URLs, and `isSkillsHubLocator` recognizes skillshub.wtf URLs — both classified as `'registry'`.
- `SourceKind` is `'git' | 'local' | 'registry'`. API-backed registries (skills.sh, skillshub.wtf) are loaded via dynamic paginators in `@agentpm/registry`.
