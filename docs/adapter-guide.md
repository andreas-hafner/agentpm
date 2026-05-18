# Adapter Guide

AgentPM adapters translate repository layouts into installable native targets.

## Built-in adapters

- `codex`: detects `.codex/skills/*` and `.codex.cloud/skills/*`, then installs back into the detected native root.
- `claude`: detects `.claude/agents/*` and installs back into `.claude/agents`.
- `generic`: detects `skills/*`, `.agents/skills/*`, and `subagents/*`; plain `skills/*` sources install into `.agents/skills/*`, while already-native `.agents/skills/*` and `subagents/*` roots are preserved.

In `agentpm.yaml`, use `target` to select one of these native layouts:

```yaml
skills:
  - name: audio-mastering
    source: internal
    target: codex
    items:
      - audio-mastering
```

`target` is a selector, not a transformer. A Codex target requires a Codex-compatible detected entry; AgentPM does not rewrite a Claude agent into a Codex skill.

## Adapter contract

Each adapter implements:

- `detect()`
- `scoreCompatibility()`
- `install()`
- `update()`
- `remove()`
- `validate()`

## Detection behavior

- Adapters scan known layout roots and look for marker files such as `SKILL.md`, `README.md`, `AGENT.md`, or `CLAUDE.md`.
- Plain `skills/*` repositories are supported even when an upstream install script would normally copy them elsewhere.
- Install scripts such as `install.sh`, `install.ps1`, or `scripts/install.sh` are reported as warnings and are not executed automatically.
- Compatibility is scored from the number of matching roots and the confidence that the adapter can preserve native layout.
- `agentpm inspect <source> --skill <selector> --target <target>` reports whether a repository can satisfy a detailed project skill request before sync.
