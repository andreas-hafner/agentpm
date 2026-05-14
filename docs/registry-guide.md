# Registry Guide

AgentPM registries are static YAML or JSON indexes that list installable entries. They can be local files, HTTPS URLs, or enterprise/private indexes exposed behind normal Git or HTTP access controls.

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
- Use `registry:<path-or-url-to-index>` when a source should be treated as a registry even if the locator does not end in `.yaml`, `.yml`, or `.json`.
- Registry search is limited to configured sources.
- Installing a registry entry resolves the underlying repo and path, then follows the normal adapter and cache flow.
- Private HTTP registries can use `AGENTPM_REGISTRY_TOKEN` or host-specific bearer tokens such as `AGENTPM_REGISTRY_TOKEN_REGISTRY_EXAMPLE_COM`. AgentPM reads those tokens from the environment but does not store them.
