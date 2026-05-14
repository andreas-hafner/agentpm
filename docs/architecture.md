# Architecture

AgentPM is a Git-native CLI for discovering and managing AI skills and agent assets from repositories, local folders, and static registry indexes.

## Runtime flow

1. `apps/cli` parses commands and flags with Commander.
2. `packages/core` resolves the action, source, scope, and confirmation policy.
3. Specialized packages handle config, database, git or local source access, adapter detection, file linking, and output formatting.
4. The database tracks sources, indexed catalog entries, cache state, and installs.
5. Project config is declared in committed `agentpm.yaml`; optional `.agentpmrc` files are local-only overrides or compatibility fallbacks.
6. Native target directories are populated with symlinks or directory junctions for install/sync flows, while `agentpm resolve` builds a runtime context graph without writing project runtime folders.

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

## Project-aware runtime resolution

`agentpm.yaml` declares source order, default scope, and required project skills:

```yaml
sources:
  - skills.sh
  - git@github.com:me/private-skills.git
  - local:~/skills
  - id: company-registry
    locator: registry:https://registry.example.com/agentpm/index.yaml
scope: project
skills:
  - audio-mastering
  - nextjs-architecture
  - name: internal-review
    source: company-registry
    items:
      - internal-review
```

`agentpm sync` uses that order deterministically and writes generated target paths to `.git/info/exclude` when the project is a Git repository. This keeps committed project state focused on `agentpm.yaml`.

`agentpm resolve` returns the active runtime context layers:

- global installs already tracked in AgentPM
- project skills from `agentpm.yaml`
- temporary skills passed with `--temp`

The resolver may index configured sources into AgentPM state, but it does not create native project skill folders or symlinks.

Supported source shorthands include `skills.sh`, `skillshub.wtf`, `github:owner/repo`, `local:<path>`, and `registry:<url-or-path>`. Full Git URLs, SSH locators, local paths, and registry index files remain supported. Private Git sources use the local Git credential setup. Private HTTP registries can be accessed with `AGENTPM_REGISTRY_TOKEN` or a host-specific environment variable such as `AGENTPM_REGISTRY_TOKEN_REGISTRY_EXAMPLE_COM`.
