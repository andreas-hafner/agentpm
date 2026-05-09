# Architecture

AgentPM is a Git-native CLI for discovering and managing AI skills and agent assets from repositories, local folders, and static registry indexes.

## Runtime flow

1. `apps/cli` parses commands and flags with Commander.
2. `packages/core` resolves the action, source, scope, and confirmation policy.
3. Specialized packages handle config, database, git or local source access, adapter detection, file linking, and output formatting.
4. The database tracks sources, indexed catalog entries, cache state, and installs.
5. Native target directories are populated with symlinks or directory junctions back to either local source paths or sparse Git releases in the cache.

## Package responsibilities

- `packages/shared`: domain types and common helpers.
- `packages/config`: AgentPM home resolution and YAML config or manifest IO.
- `packages/db`: SQLite persistence and migrations.
- `packages/git`: shallow sparse Git release materialization and revision checks.
- `packages/registry`: static registry index loading and normalization.
- `packages/adapters`: repository layout detection and install mapping.
- `packages/fs`: file walking, diffing, and safe link management.
- `packages/ui`: interactive Ink prompts.
- `packages/core`: orchestration and business rules.

## Data model

- `sources`: configured source locators plus metadata and indexing state.
- `catalog_entries`: searchable installable items from repository scans or registry indexes.
- `cache_repos`: cached Git source roots and revision metadata.
- `installs`: active installs, selected items, target paths, tracked revisions, and layout signatures.

