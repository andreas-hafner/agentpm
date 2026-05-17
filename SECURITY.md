# Security Policy

## Scope

AgentPM works with local paths, Git repositories, private SSH remotes, registry indexes, and generated local links. Security-sensitive changes usually affect:

- Git and SSH credential handling
- registry authentication and token lookup
- local filesystem writes, links, and cache cleanup
- parsing or indexing untrusted repository content

## Reporting

Do not open public issues for credential leaks, token handling bugs, unsafe filesystem behavior, or private repository access problems.

Report them privately to the repository owner through the existing direct channel you already use for this project. If that is unavailable, do not disclose exploit details publicly until a private contact path is established.

## Expectations For Contributors

- Never commit credentials, tokens, SSH keys, or private registry secrets.
- Keep security fixes narrowly scoped and include regression tests where possible.
- Call out trust-boundary changes in the PR description.
- Prefer explicit failure over silent mutation for risky filesystem or remote operations.
