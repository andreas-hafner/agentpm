# AgentPM Next Steps: Detailed Project Skills MVP

## Summary

AgentPM's next publishable MVP should focus on detailed project-level
`skills` entries in the committed `agentpm.yaml` file.

The goal is not to build a full npm-style dependency solver yet. The goal is to
make a project declare the direct skills it needs, where those skills come from,
which coding-agent runtime should receive them, and how they should be pinned or
resolved during `agentpm sync`.

`skills` remains the canonical project contract:

- string entries stay available for the simple case
- object entries provide source binding, version pinning, private-source usage,
  adapter targets, and reproducible sync
- `.agentpmrc` remains a local-only override or compatibility fallback
- lockfiles, transitive dependencies, semver ranges, and integrity metadata are
  deferred until after this direct workflow is reliable

## Project Config Contract

Keep `agentpm.yaml` centered on `sources` and `skills`:

```yaml
sources:
  - id: internal
    locator: git@github.com:company/private-skills.git
  - id: public
    locator: github:agentpm/public-skills
  - id: local
    locator: local:../skills

skills:
  - nextjs-architecture

  - name: audio-mastering
    source: internal
    ref: v1.2.0
    target: codex
    scope: project
    items:
      - audio-mastering
```

String skills are shorthand:

```yaml
skills:
  - audio-mastering
```

This means: resolve `audio-mastering` from configured sources in deterministic
order using the default target and scope.

Object skills are the detailed MVP contract:

- `name`: stable project skill name
- `source`: optional source id, locator, or alias
- `ref`: branch, tag, or commit-ish pin
- `revision`: exact resolved commit when known
- `target`: `codex`, `claude`, `generic`, or a future adapter id
- `scope`: `project` or `workspace`
- `items`: optional native skill paths or names when package name differs from
  folder name
- `workspaceRoot`: optional explicit workspace target root

This keeps the first MVP direct-only:

- no transitive skill dependencies
- no semver solver
- no lockfile requirement
- no conflict resolver beyond clear duplicate, missing-source, missing-skill,
  and unsupported-target diagnostics
- `agentpm sync` installs exactly the direct skills declared in `agentpm.yaml`

## Source And Registry Support

The MVP should make private-first project setup work without committing skill
code or secrets.

Supported source classes:

- public GitHub repositories
- private GitHub, GitLab, and SSH Git repositories
- local folders
- static YAML or JSON registries
- enterprise/private registry URLs
- existing shorthands such as `github:`, `local:`, and `registry:`

Private-source behavior:

- private Git uses the user's existing SSH key or Git credential helper
- private HTTP registries use environment tokens only
- credentials are never written to `agentpm.yaml`, `.agentpmrc`, generated
  metadata, cache records, logs, or future lockfiles
- generated skill folders, cache contents, symlinks, and runtime artifacts stay
  local and uncommitted
- `agentpm sync`, `agentpm inspect`, and `agentpm doctor` report inaccessible
  private sources with actionable messages

Registry entries should remain compatible with today's simple format while
supporting enough metadata for direct detailed skills:

- `name`
- `repo`
- `ref`
- `path`
- `adapterHint`
- `tags`

Future registry metadata can add target matrices, dependency metadata,
integrity, and compatibility constraints after the direct-skill MVP is stable.

## CLI And Runtime Behavior

`agentpm sync` should:

- read `agentpm.yaml`
- resolve configured sources in file order
- resolve each string or object `skills` entry
- honor `source`, `ref`, `revision`, `target`, `scope`, `items`, and
  `workspaceRoot`
- install or refresh local generated targets
- avoid committing generated targets by updating local Git exclude state when
  possible
- fail clearly for missing sources, missing skills, inaccessible private repos,
  unsupported targets, and malformed project config

`agentpm resolve` should:

- show active global, project, and temporary skill layers
- resolve project skills from `agentpm.yaml`
- avoid mutating the repository
- provide stable JSON output for automation

`agentpm inspect` should:

- report detected layouts
- report adapter compatibility
- report install-script risks
- detect plain `skills/`, `.agents/skills`, `.codex/skills`,
  `.codex.cloud/skills`, `.claude/agents`, and `subagents`
- make it clear whether a source can satisfy a detailed skill entry

`agentpm doctor` should check:

- malformed string or object skill entries
- unreachable sources
- unsupported targets
- missing installed targets
- stale or broken local generated targets
- generated skill artifacts that accidentally became Git-tracked
- registry entries that point to missing paths or unsupported adapters

The CLI should stay thin. Resolution, install, validation, and diagnostic logic
should live in `packages/core` and the specialized packages.

## Implementation Priorities

1. Tighten detailed `skills` parsing and validation.
2. Make target handling explicit for Codex, Claude, generic, and future adapters.
3. Make `sync` deterministic for direct project skills.
4. Improve diagnostics for private Git, private registries, and malformed
   project config.
5. Extend inspect and doctor so users can trust a source before installing from
   it.
6. Extend the smoke test to cover a detailed `skills` object with a pinned ref
   and a registry-backed source.
7. Keep `agentpm.lock.yaml`, transitive dependencies, semver ranges, and
   integrity metadata as the next phase after this MVP.

## Test Plan

Add or update tests for:

- parsing string and object `skills` entries
- `source`, `ref`, `revision`, `target`, `scope`, `items`, and `workspaceRoot`
  handling
- sync from local folders, public Git, private-style SSH fixtures, and
  registry-backed sources
- Codex, Claude, generic `.agents`, plain `skills/`, `.codex.cloud/skills`, and
  `subagents` layouts
- clear failures for missing source, missing skill, unsupported target, bad
  registry entry, inaccessible private source, and malformed config
- `resolve --json` stability for direct project skills
- `doctor` detection of broken generated targets and accidentally tracked
  generated skill folders
- smoke coverage for one detailed `skills` object with a pinned ref and one
  registry source

Release validation for this phase should include:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm smoke
```

## Assumptions

- `skills` stays canonical for the first publishable MVP.
- Detailed `skills` objects provide enough npm-like reproducibility without a
  separate `dependencies` field.
- `agentpm.yaml` may reveal skill names or private source aliases, but it must
  never contain credentials.
- Only `agentpm.yaml` is required for this MVP workflow.
- `.agentpmrc` remains local-only and should not be required for team
  reproducibility.
- Lockfiles, transitive dependency resolution, semver ranges, package integrity,
  MCP config installation, hosted sync, cloud execution, GUI work, and
  marketplace monetization are out of scope for this phase.
