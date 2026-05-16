# AgentPM — Universal Skill & Agent Package Manager (Concept)

This document is long-term concept material. The current publishable MVP is the
direct detailed project skills workflow described in [plan.md](./plan.md):
committed `agentpm.yaml`, direct `skills` entries, source binding, `target`
selection, ref/revision pinning, private-first sources, and no lockfile or
transitive dependency solver yet.

The sections below are retained as product background and may describe future
work beyond the current MVP.

## Vision

Build a **Git-native package manager for AI skills and agent assets**.

A developer should be able to:

- discover skills
- install skills
- update skills
- remove skills
- pin versions
- compare changes
- use public registries
- use private registries
- use local folders
- install globally or project-bound
- selectively install only what is needed

without manually cloning repositories, running install scripts, or copying files around.

**Goal:**

> **Git URL in → working skill install out**

Long-term positioning:

> **npm / Homebrew / Docker-like workflow for AI skills**

but **Git-native**, **adapter-based**, and **compatible with existing ecosystems**.

---

# Problem

Today, AI skills are fragmented:

- public registries exist
- private Git repos exist
- local skill folders exist
- repositories have inconsistent structures
- installation is often manual
- updates are manual
- version awareness is weak
- diffing changes is hard
- project-scoped skill setup is cumbersome

Typical workflow today:

1. find repo
2. clone repo
3. inspect structure
4. run install script / copy files
5. forget source
6. updates become manual

This is not scalable.

---

# Core Product Idea

AgentPM manages **repositories as installable skill sources**.

Supports:

- public registries
- private GitHub repositories
- private GitLab repositories
- local folders
- curated company registries

Examples:

```bash
agentpm search audio
agentpm add git@github.com:me/private-skills.git
agentpm install audio-mastering --project
agentpm update
agentpm diff
agentpm remove audio-mastering
```

---

# Core Principles

## 1) Compatibility First

No custom repo structure required.

**Do not enforce a standard.**

Bad:

> "Change your repo to our bundle format."

Good:

> "Bring your repo, AgentPM adapts."

Supports existing layouts:

```txt
skills/
.agents/skills/
.codex/skills/
.claude/agents/
subagents/
install.sh
custom layouts
```

Detection layer handles compatibility.

---

## 2) Native by Default

Install in the format the repository already uses.

Example:

Repo contains:

```txt
.codex/skills/
```

Default install target:

```txt
~/.codex/skills/
```

not transformed.

Reason:

- safest
- most compatible
- easiest updates
- least surprising

Optional portability adapters may expose them elsewhere.

---

## 3) Git-native

Repositories remain the source of truth.

AgentPM never owns content.

AgentPM manages:

- discovery
- installation
- update tracking
- symlinks / mapping
- metadata

---

## 4) Narrow Scope (v1)

Manage:

✅ skills
✅ subagents / workflows (if detected)

Ignore for v1:

❌ MCP config installation
❌ prompt package installation
❌ secret management

Reason:

too provider-specific / messy.

---

# Architecture

## Source Providers

Pluggable providers:

- Public registry (skills.sh-like)
- GitHub repo
- GitLab repo
- Local folder
- Company registry
- Custom registry API

Config:

```yaml
sources:
  - skills.sh
  - git@github.com:me/private-skills.git
  - company-registry.internal
  - ~/local-skills
```

---

# Discovery Engine

Scan repository.

Detect:

- skill folders
- agent folders
- subagents
- install scripts
- metadata files

Example:

```txt
Detected:
✓ Codex skills (12)
✓ Subagents (3)

Compatibility:
✓ Codex native
✓ Generic likely
? Claude unknown
```

---

# Adapter System

Adapters understand formats.

Examples:

- Codex adapter
- Generic `.agents` adapter
- Claude adapter
- Custom adapter

Responsibilities:

- detect layout
- determine compatibility
- install mapping
- validate update migrations

---

# Installation Scopes

## Global

Available everywhere.

Example:

```txt
~/.codex/skills/
```

Command:

```bash
agentpm install audio-tools --global
```

---

## Project

Only for one repo/project.

Example:

```txt
./.codex/skills/
```

Command:

```bash
agentpm install audio-tools --project
```

---

## Workspace

Shared among related projects.

Example:

```txt
~/work/acme/.skills/
```

Command:

```bash
agentpm install audio-tools --workspace
```

---

# Selective Installation

Install entire repo:

```bash
agentpm install my-skills --all
```

or only parts:

```bash
agentpm install audio video
```

or:

```bash
agentpm add audio-mastering
```

This is crucial for monolithic private repos.

Example:

Private repo contains:

- audio
- video
- coding
- marketing
- writing

User only installs:

- audio
- video

---

# Storage Model

Do **not** full-clone by default.

Use:

## sparse checkout

Only fetch relevant folders.

## shallow clone

Only latest history.

Combined:

> **shallow + sparse**

Result:

small cache footprint.

---

## Local Cache

Managed cache:

```txt
~/.agentpm/cache/
```

Contains cloned repos.

Install via symlink:

```txt
~/.codex/skills/foo -> cache/foo/.codex/skills
```

Benefits:

- easy updates
- rollback possible
- diff possible
- minimal duplication

---

# Update Model

Track:

- source repo
- installed commit SHA
- detected structure
- install target

Example:

```yaml
repo: github.com/me/private-skills
commit: a81f9d2
adapter: codex
path: .codex/skills/audio
```

Update check:

compare remote HEAD vs installed SHA.

If changed:

```txt
Update available
+ 3 skills added
~ 1 changed
- 1 removed
⚠ layout changed
```

---

## Layout Change Handling

If repository structure changes:

Re-run detection.

Cases:

### compatible migration

automatic remap possible

### breaking migration

manual review required

Never silently break installs.

---

# Lockfile

Project config:

```yaml
agentpm.yaml

sources:
  - git@github.com:me/private-skills.git

skills:
  - audio-mastering
  - loop-builder

scope: project
```

Teammate:

```bash
agentpm sync
```

Same setup.

Huge team value.

---

# CLI Commands

```bash
agentpm search <query>
agentpm sources add <repo>
agentpm sources remove <repo>

agentpm inspect <repo>

agentpm install <skill>
agentpm remove <skill>

agentpm update
agentpm diff
agentpm doctor

agentpm sync
agentpm list
```

---

# Optional UI

Desktop / web UI:

Dashboard:

```txt
Installed: 23
Updates: 2
Sources: 5
Broken: 1
```

Features:

- Add source
- Update all
- Open config
- View diff
- Enable / disable
- Scope management
- Search registry

Potential desktop shell later.

CLI first.

---

# Monetization (Optional Later)

Enterprise:

- private registry hosting
- SSO login
- access control
- audit logs
- signing / verification
- internal company marketplace
- policy enforcement

Comparable to:

- private npm registry
- private container registry

---

# MVP

Build first:

✅ add source
✅ inspect repo
✅ detect skills
✅ install global/project
✅ selective install
✅ shallow+sparse clone
✅ symlink install
✅ update detection
✅ diff
✅ remove

Ignore:

❌ enterprise
❌ MCP
❌ prompt packages
❌ desktop UI

---

# Final Positioning

> **AgentPM**
>
> A Git-native package manager for AI skills and agent assets.
>
> Compatible with existing repositories.
>
> Supports public + private registries.
>
> Global or project installs.
>
> Selective installs.
>
> Update-aware.
>
> Zero repo restructuring required.

Core promise:

> **Bring your repo. AgentPM adapts.**
