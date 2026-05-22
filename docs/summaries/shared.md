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

- `classifyLocator` determines source kind from a locator string. `registry:<url-or-path>` is classified as `'registry'`, and `file://` locators are treated as Git sources.
- `SourceKind` is `'git' | 'local' | 'registry'`.
- Project and manifest skill specs include `target` as the preferred runtime-layout selector; `adapter` remains a compatibility alias.
- Registry entries include preferred `target` metadata plus legacy `adapterHint`.
- Shared result types cover source refresh, cache cleanup dry-runs, and doctor fix actions/results for removing unused sources or stale install records across CLI and core boundaries.
