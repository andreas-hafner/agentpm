# Registry Guide

AgentPM MVP registries are static YAML or JSON indexes that list installable entries.

## Supported format

```yaml
version: 1
entries:
  - name: audio-mastering
    description: Codex skill collection for mastering workflows
    repo: https://github.com/example/audio-skills.git
    ref: main
    path: .codex/skills/audio-mastering
    adapterHint: codex
    tags:
      - audio
      - mastering
```

## Behavior

- Add a registry index with `agentpm source add <path-or-url-to-index>`.
- Registry search is limited to configured sources.
- Installing a registry entry resolves the underlying repo and path, then follows the normal adapter and cache flow.

