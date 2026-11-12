# Security policy

[Tiếng Việt](docs/SECURITY.md) | English

## Reporting a vulnerability

Please do not open a public issue that contains exploit details. Use GitHub private vulnerability reporting instead: open the repository's **Security** tab and choose **Report a vulnerability**.

## What this project is, and is not

This repository documents and supports local messaging and task delegation between AI coding agents (Claude Code, Codex, Gemini, and DeepSeek via Codewhale). Messages and delegated tasks between agents can be acted on automatically if the receiving agent runs without approval prompts, and the sender identity of the Gemini side is self-declared and not verified. Read the trust model, the attack surface, the dangerous flags (`--dangerously-skip-permissions`, `--auto`), API key protection, and the restricted-actions rules before use: [docs/en/SECURITY.md](docs/en/SECURITY.md) ([Vietnamese](docs/SECURITY.md)).

Only a single Windows machine has been tested. Other environments are not tested.
