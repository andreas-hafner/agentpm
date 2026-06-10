<h1 align="center">AgentPM</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@travelhawk/agentpm"><img src="https://img.shields.io/npm/v/@travelhawk/agentpm?color=cb3837&label=npm" alt="npm version" /></a>
  <a href="https://github.com/travelhawk/agentpm/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-0f766e.svg" alt="MIT License" /></a>
  <a href="https://github.com/travelhawk/agentpm/actions/workflows/ci.yml"><img src="https://github.com/travelhawk/agentpm/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
</p>

<br>

<p margin-top: "50px" align="center">
  <strong>Git-native skill management for AI coding agents.</strong><br />
  Discover, install, update, sync, and publish skills from Git repositories, local folders, private indexes, and the public skills.sh bridge.
</p>

<br>

<p align="center">
  <img src="./docs/assets/agentpm-demo.gif" alt="AgentPM add and push demo" width="900" />
</p>

## Install

```bash
npm install -g @travelhawk/agentpm
agentpm --help
```

For development from this repository checkout:

```bash
git clone https://github.com/travelhawk/agentpm.git
cd agentpm
pnpm install
pnpm build
pnpm run link:global
```

AgentPM works in two modes:

1. <strong>Skill Package Manager</strong> with update function for local installs
2. A committed <strong>`agentpm.yaml`</strong> turns a repo into a shared contract for reproducible skill sync where generated skill folders, caches and credentials stay local.

## Features

- 🚀 **One global CLI**: install with `npm install -g @travelhawk/agentpm`, then run `agentpm` from any repo.
- 🧭 **Project contracts**: commit `agentpm.yaml` with shorthand or detailed `skills` entries for reproducible team sync.
- 🔒 **Private-first sources**: use public GitHub, private Git/SSH, local folders, static registries, and private HTTP registry indexes.
- 🔎 **Public discovery bridge**: run `agentpm skills search`, `install`, `list`, `update`, and `remove` through the official `npx skills`.
- 🧩 **Native runtime layouts**: target `codex`, `claude`, and `generic` directories without converting source repositories.
- 📦 **Repository inspection**: detect `.codex/skills`, `.codex.cloud/skills`, `.claude/skills`, `.claude/agents`, `.agents/skills`, plain `skills`, and `subagents`.
- 🔁 **Canonical cross-device sync**: `agentpm push` publishes a tidy `skills/<name>` form, `agentpm pull` materializes it into every coding agent via one symlinked library, and `agentpm adopt` brings existing skills under management.
- ♻️ **Fresh indexes**: rebuild local source indexes on `source add`, `agentpm refresh`, or `agentpm update --refresh`.
- 🛠️ **One-command installs**: run `agentpm install --from <repo-or-source>` when you already know where the skill lives.
- 🧪 **Diagnostics and cleanup**: use `agentpm doctor --fix` and `agentpm cache clean --dry-run` for conservative maintenance.
- 📤 **Git push flows**: publish selected local skills back into a target Git repository while preserving native paths.

## Getting started

Install the published CLI:

```bash
npm install -g @travelhawk/agentpm
agentpm --help
```

Use the repository checkout only when developing AgentPM itself:

```bash
pnpm install
pnpm build
pnpm --filter @travelhawk/agentpm exec agentpm --help
```

If you want the development checkout on your global `PATH`, run:

```bash
pnpm run link:global
agentpm --help
```

This creates a live symlink to the local CLI. Rebuild after source changes with `pnpm build`.

## Project Config

Create and commit `agentpm.yaml` when you want a repository-level skill contract:

A `agentpm.yaml` file looks like this:

```yaml
sources:
  - id: internal
    locator: git@github.com:company/private-skills.git
  - id: public
    locator: github:agentpm/public-skills
  - id: registry
    locator: registry:https://registry.example.com/agentpm/index.yaml

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

String entries are shorthand. Object entries bind a project skill to a configured source, optional Git ref or resolved revision, runtime target, install scope, and one or more native skill items. `target` selects a matching native layout; it does not transform one agent format into another. Accepted MVP targets are `codex`, `claude`, and `generic`.

When `agentpm.yaml` already exists, bridge installs from `agentpm skills install` are saved the same way: AgentPM persists the resolved source it can sync later, and can also keep optional provenance metadata from the public bridge.

```yaml
skills:
  - name: typescript-advanced-types
    source: public-types
    items:
      - typescript-advanced-types
    scope: project
    provider: skills.sh
    selector: wshobson/agents@typescript-advanced-types
```

Private Git sources use your existing SSH key or Git credential helper. Git locators may be bare `owner/repo` shorthands, `github:owner/repo`, HTTPS URLs, or SSH URLs. Private HTTP registries use environment tokens such as `AGENTPM_REGISTRY_TOKEN` or `AGENTPM_REGISTRY_TOKEN_REGISTRY_EXAMPLE_COM`. Do not commit credentials to `agentpm.yaml`.

`skills.sh` is available as a public bridge through `agentpm skills search` and `agentpm skills install`, powered by `npx skills`. If a bridge install lands in a repo with `agentpm.yaml`, AgentPM writes the resolved source locator into the manifest, so later `agentpm sync` works without needing `skills.sh` again.

If `agentpm.yaml` is absent, `agentpm install --project` and `agentpm install --workspace` install locally without creating one. Run `agentpm init` to snapshot current local installs into `agentpm.yaml`. Once `agentpm.yaml` exists, future project or workspace installs update that repo contract automatically.

## Smoke test

Run the local smoke test before publishing or handing the CLI to another machine:

```bash
pnpm smoke
```

The smoke test builds the workspace, runs the packaged `agentpm` bin with an isolated `AGENTPM_HOME`, inspects a Codex fixture repository, syncs a temporary project from a detailed registry-backed `agentpm.yaml`, verifies runtime resolution, checks local Git exclude handling, and runs `agentpm doctor`.

## Example commands

```bash
agentpm source add ./examples/repos/codex-sample
agentpm source skills github:company/private-skills
agentpm skills search typescript
agentpm skills install wshobson/agents@typescript-advanced-types --project
agentpm skills install typescript
agentpm skills list
agentpm skills update --yes
agentpm skills remove typescript-advanced-types
agentpm inspect ./examples/repos/codex-sample --skill audio-mastering --target codex
agentpm search audio --refresh
agentpm install --from github:company/private-skills --skill audio-mastering --project --add-source
agentpm install audio-mastering --project --target codex
agentpm resolve --temp release-helper
agentpm sync
agentpm refresh
agentpm update --refresh
agentpm diff
agentpm cache clean --dry-run
agentpm doctor --fix
agentpm target add production git@github.com:my-org/my-skills.git --default
agentpm push skill-a --to git@github.com:my-org/my-skills.git
agentpm push --all --to git@github.com:my-org/my-skills.git
agentpm push --all --preserve-layout
agentpm pull --from git@github.com:my-org/my-skills.git
agentpm pull my-skill --target codex,claude
agentpm adopt my-claude-skill --target codex,generic
```

## Canonical skills: push, pull, and adopt

AgentPM keeps a **canonical skill library** at `~/.agentpm/skills/` (under `AGENTPM_HOME`).
It is the single source of truth on each machine: every agent's native skill directory is a
symlink back to the library, so a skill is stored once and an update propagates to all agents.

This enables a cross-device workflow:

```bash
# On device A: publish your skills in canonical form to a Git repo.
agentpm target add my-skills git@github.com:me/skills.git --default
agentpm push --all

# On device B: pull them into all your coding agents.
agentpm pull
```

### `agentpm push` — publish in canonical form

`agentpm push` is a skill push command, not a raw repository mirror.

- AgentPM detects pushable local entries from native layouts such as `.agents/skills`, `.codex/skills`, `.codex.cloud/skills`, `.claude/skills`, `.claude/agents`, plain `skills/`, and `subagents/`.
- If you omit the name or path in a TTY session, AgentPM shows an interactive selector. Use Space to toggle, `a` to select all, `n` to select none, and Enter to confirm.
- If multiple push targets exist and none is marked `default`, `agentpm push` lets TTY users choose one and save it as the default in global AgentPM config. Non-interactive runs should pass `--to <target>` or set a default with `agentpm target default <id>`.
- **By default, pushed entries are normalized to a canonical `skills/<name>` folder** in the destination repository, regardless of their source layout. This keeps shared repos tidy and lets the same repo be pulled into any agent. Pass `--preserve-layout` to keep native target-relative paths (`.codex/skills/...`, `.claude/...`) instead.
- The target repository can be empty. AgentPM reuses a cached checkout for repeat pushes, copies the selected entries into place, commits, and pushes `HEAD`.

### `agentpm pull` — install canonical skills into your agents

`agentpm pull [skills...] --from <target>` fetches the canonical `skills/*` from a target
repository, stores them in the library, and symlinks them into your coding agents.

- AgentPM auto-detects which agents are present (`.codex`, `.claude`, `.agents`) and shows a multi-select defaulting to all detected. Pass `--target codex,claude,generic` to choose explicitly, or `--yes` to skip the prompt and install to all detected.
- Skills install globally (into your home agent dirs) by default; pass `--project` to install into the current repository instead.
- If a target agent already has an unmanaged skill of the same name, AgentPM asks before replacing it (and skips it in non-interactive `--yes` runs) so it never clobbers existing work — one collision does not abort the rest of the fan-out.
- To later publish edits back with `agentpm push`, run `push` from the scope you pulled into (your home directory for a global pull).

### `agentpm adopt` — manage an existing skill

`agentpm adopt <skillOrPath>` brings a skill that already lives in one agent (for example a
Claude skill under `.claude/skills/...`) under AgentPM management. It moves the content into
the library, replaces the original with a managed symlink, and fans the skill out to your
other agents (auto-detected, with the same `--target`/`--yes` options as `pull`). After
adopting, `agentpm push` can publish it to your canonical repository.

## Docs

- [Getting Started](https://github.com/travelhawk/agentpm/blob/main/docs/getting-started.md)
- [Architecture](https://github.com/travelhawk/agentpm/blob/main/docs/architecture.md)
- [Adapter Guide](https://github.com/travelhawk/agentpm/blob/main/docs/adapter-guide.md)
- [Registry Guide](https://github.com/travelhawk/agentpm/blob/main/docs/registry-guide.md)
- [Concept](https://github.com/travelhawk/agentpm/blob/main/docs/concept.md)
- [Plan](https://github.com/travelhawk/agentpm/blob/main/docs/plan.md)
- [Changelog](https://github.com/travelhawk/agentpm/blob/main/CHANGELOG.md)
- [Contributing](https://github.com/travelhawk/agentpm/blob/main/CONTRIBUTING.md)
- [Security Policy](https://github.com/travelhawk/agentpm/blob/main/SECURITY.md)

## License

AgentPM is licensed under the MIT License. See [LICENSE](https://github.com/travelhawk/agentpm/blob/main/LICENSE).
