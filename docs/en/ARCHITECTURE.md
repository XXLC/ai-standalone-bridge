# System Architecture and Orchestration Model

[Tiếng Việt](../ARCHITECTURE.md) | English

This document details the components, directional message flows, sender identification mechanisms, technical limitations of each communication channel, and work orchestration rules between the coordinating agent Claude Code and the execution sessions: Codex, Gemini (Opus and Argon sessions via Antigravity), and DeepSeek (via the Codewhale CLI).

Verification scope note: Every item labeled `[VERIFIED]` was measured on a single Windows 11 machine (Claude Code `2.1.312`, Codex CLI `0.165.0`, Antigravity CLI `agy` `1.4.10`, Codewhale CLI `0.10.2`, Node `24.15`). Other operating systems (macOS, Linux) and other machines are entirely `[NOT TESTED]`.

---

## 1. Components and Roles

1. **Claude Code (Anthropic)**: Runs as an extension in VS Code or in Antigravity IDE (`2.1.312`). Acts as the central orchestrating, checking, and evaluating agent, and directly performs tasks that require conversational context with the user, code integration, independent verification, and restricted operations.
2. **Codex (OpenAI)**: Consists of the CLI installed via `npm` (`@openai/codex` `0.165.0`) and the IDE extension. Receives tasks from Claude or Gemini via the daemon queue, or is invoked non-interactively using `codex exec`.
3. **Gemini (Google, via Antigravity)**: Operates inside Antigravity IDE or through the `agy` command-line tool (`1.4.10`, capable of running both Opus and Argon sessions depending on the selected model). Google discontinued serving AI Pro and Ultra tiers through Gemini CLI (`gemini`) as of `2026-06-18` (returning `IneligibleTierError`), making `agy` the only command-line path to invoke Gemini.
4. **DeepSeek (via Codewhale CLI)**: The `codewhale` command-line tool (`0.10.2`, formerly named `deepseek-tui`), installed via `npm` (located at `%APPDATA%\npm\codewhale.cmd` on Windows). Its default provider is `deepseek`, with default model `deepseek-flash` (DeepSeek V4.1 Flash) and `deepseek-v4-pro` also available, offering a 1M-token context window and up to 384K output tokens. Receives one-shot non-interactive work via `codewhale exec` (or via the wrapper script `src/deepseek-exec.mjs`); it has no channel for messaging an already-open session. `[VERIFIED]`
5. **Claude-Codex Bridge (`KeeVeeG/codex-claude-desktop-bridge`)**: External project (MIT license, requires Node >= 20) providing plugins for Claude Code and Codex to send asynchronous messages by exact session ID; according to the bridge's description, sender identity is verified by process (we have not independently verified this mechanism). Release `v0.4.0` only accepts the `claude-desktop`, `cli`, and `sdk-cli` entrypoints and therefore ignores VS Code extension sessions (`claude-vscode`). The `main` branch from merge commit `3ac8488` (PR #5, merged on `2026-10-29`) onward is required to recognize `claude-vscode`. This repo does not copy the bridge's code; it reuses functions in `<bridge directory>/lib/claude-desktop.mjs` and `<bridge directory>/lib/codex-daemon.mjs`.
6. **Codex Daemon (`codex app-server daemon`)**: Background process managing connections and the `codex queue` for Codex sessions. The bridge does not start this daemon automatically; the user must run `codex app-server daemon start` (using `@openai/codex` installed via `npm`, because the `codex.exe` bundled with the IDE extension lacks a complete local package and fails with `this CLI has no complete local package`). `[VERIFIED]`
7. **MCP Server `gemini-bridge` (`src/gemini-bridge-mcp.mjs`)**: MCP server communicating over `stdio`, running on Node with no external dependencies. It provides four tools to Gemini (`list_claude_sessions`, `send_to_claude`, `list_codex_chats`, `send_to_codex`) by directly calling `resolveClaudeSession`, `sendToClaude`, `discoverClaudeSessions` (in `lib/claude-desktop.mjs`) and `openDaemon`, `listTerminalThreads`, `queueToTerminalThread` (in `lib/codex-daemon.mjs`). The server validates string and integer types against `inputSchema` and limits each message to 16,000 characters (for Codex, counted after envelope wrapping). `[VERIFIED: npm test passes on Windows with Node 24.15 (see README, Running tests section); live send test runs only when SESSION_ID and BRIDGE_LIB_DIR are manually set]`
8. **Fallback Script (`src/gemini-send-to-claude.mjs`) and DeepSeek Wrapper Script (`src/deepseek-exec.mjs`)**:
   - `src/gemini-send-to-claude.mjs`: Command-line utility to send a single message directly to a Claude session when MCP is not used.
   - `src/deepseek-exec.mjs`: Command-line wrapper around `codewhale exec` (accepts working directory `--cwd`, prompt file `--prompt-file` or `--prompt`, flags `--auto`, `--sandbox`, `--model`, `--timeout`; classifies results into `ok`, `quota_or_balance` for `402`/`429`, or `other_error`; refuses command-line API keys and redacts key patterns if they appear in output). `[VERIFIED: npm test passes with a fake codewhale on PATH]`
9. **Instruction Templates (`templates/`) and Secret-Redaction Hook (`extras/redact-secrets/`)**:
   - The template files define the orchestration rule block enclosed between the HTML comment markers `dieu-phoi-agent:bat-dau` and `dieu-phoi-agent:ket-thuc`, placed in `<HOME>/.claude/CLAUDE.md`, `<HOME>/.codex/AGENTS.md`, and `<HOME>/.gemini/GEMINI.md`.
   - An optional `PostToolUse` hook for Claude Code scans and replaces secrets in tool output with `<REDACTED:kind>`. `[VERIFIED: 12/12 tests with PowerShell, Bash, Read, Grep]`; `[NOT TESTED]` with WebFetch, Agent, Glob, and MCP tools.

---

## 2. Directional Communication Flows

### 2.1. Direction Claude -> Codex (`[VERIFIED]`)

Claude has two ways to assign work to Codex:
1. Send a message to an existing Codex session via the bridge's `send_to_codex` tool with the required parameter `transport: "terminal"` (if left at `auto`, the daemon rejects conversations inside the extension because it reports `notLoaded`). The message goes through `codex queue`.
2. Invoke a non-interactive Codex process via the command:
   `codex exec -C <directory> -s read-only|workspace-write --skip-git-repo-check -` (passing the prompt via `stdin`).

```mermaid
sequenceDiagram
    participant Claude as Claude Code
    participant Plugin as Bridge Plugin (Claude)
    participant Daemon as Codex Daemon (codex queue)
    participant Codex as Codex Session

    Claude->>Plugin: send_to_codex(transport: "terminal", ...)
    Plugin->>Daemon: queueToTerminalThread (via codex queue)
    Daemon-->>Plugin: Enqueued (acknowledged: false)
    Plugin-->>Claude: Return send result
    Daemon->>Codex: Deliver message from codex queue
```

### 2.2. Direction Codex -> Claude (`[VERIFIED]`)

Codex uses the `send_to_claude` tool from the bridge plugin. According to the bridge's description, it verifies the sending Codex process, wraps the message in a `cross-session-message` tag, and delivers it to the exact Claude Code session ID.

```mermaid
sequenceDiagram
    participant Codex as Codex
    participant Plugin as Bridge Plugin (Codex)
    participant Lib as lib/claude-desktop.mjs
    participant Claude as Claude Code Session

    Codex->>Plugin: send_to_claude(session_id, message)
    Plugin->>Lib: resolveClaudeSession + sendToClaude
    Lib->>Claude: Deliver envelope-wrapped message
    Lib-->>Plugin: Send complete (acknowledged: false)
    Plugin-->>Codex: Return send result
```

### 2.3. Direction Gemini -> Claude (`[VERIFIED]`)

Gemini (running in Antigravity IDE or invoked from `agy`) uses the `list_claude_sessions` and `send_to_claude` tools of the `gemini-bridge` MCP server (or calls the fallback CLI script `src/gemini-send-to-claude.mjs`).

```mermaid
sequenceDiagram
    participant Gemini as Gemini (IDE / agy)
    participant MCP as MCP gemini-bridge (stdio)
    participant Lib as lib/claude-desktop.mjs
    participant Claude as Claude Code Session

    Gemini->>MCP: list_claude_sessions()
    MCP->>Lib: discoverClaudeSessions()
    Lib-->>MCP: Session list (including claude-vscode)
    MCP-->>Gemini: Return session list
    Gemini->>MCP: send_to_claude(session_id, message)
    Note over MCP: Validate inputSchema,<= 16,000 chars, attach AGENT_NAME
    MCP->>Lib: resolveClaudeSession + sendToClaude
    Lib->>Claude: Deliver message (sender label: unverified)
    Lib-->>MCP: Send complete (acknowledged: false)
    MCP-->>Gemini: Return send result
```

### 2.4. Direction Gemini -> Codex (`[VERIFIED]`, timing of when Codex reads is unknown)

Gemini calls `list_codex_chats` and `send_to_codex` on the `gemini-bridge` MCP server. The MCP server reuses `openDaemon`, `listTerminalThreads`, and `queueToTerminalThread` in `lib/codex-daemon.mjs` to push the message into `codex queue`.

```mermaid
sequenceDiagram
    participant Gemini as Gemini (IDE / agy)
    participant MCP as MCP gemini-bridge (stdio)
    participant Lib as lib/codex-daemon.mjs
    participant Daemon as Codex Daemon (codex queue)
    participant Codex as Codex Session

    Gemini->>MCP: list_codex_chats()
    MCP->>Lib: openDaemon + listTerminalThreads
    Lib-->>MCP: Chat list
    MCP-->>Gemini: Return chat list
    Gemini->>MCP: send_to_codex(thread_id, message)
    Note over MCP: Validate inputSchema, attach AGENT_NAME, wrap envelope <= 16,000 chars
    MCP->>Lib: queueToTerminalThread
    Lib->>Daemon: Enqueue message into codex queue
    Daemon-->>MCP: Enqueue complete (acknowledged: false)
    MCP-->>Gemini: Return send result
    Daemon->>Codex: Codex reads from queue (latency not measured)
```

### 2.5. Direction Claude -> Gemini and Codex -> Gemini (`[VERIFIED]`)

Because an open Gemini conversation in the IDE has no push inbox, both Claude and Codex invoke Gemini by spawning a new non-interactive session via the `agy` CLI:
`agy --model <m> --print-timeout <t> [--dangerously-skip-permissions] -p "<prompt>"`

```mermaid
sequenceDiagram
    participant Caller as Claude Code / Codex
    participant Agy as Antigravity CLI (agy -p)
    participant Gemini as New Gemini Session
    participant MCP as MCP gemini-bridge

    Caller->>Agy: agy --model <m> --print-timeout <t> -p "<prompt>"
    Agy->>Gemini: Start new session with prompt
    opt When prompt requests reporting back via MCP
        Gemini->>MCP: send_to_claude / send_to_codex
    end
    Gemini-->>Agy: Print output to stdout
    Agy-->>Caller: Return standard output (stdout)
```

### 2.6. Direction Delegating Tasks to DeepSeek via Codewhale (`[VERIFIED]` command invocation; live `402`/`429` `[NOT TESTED]`)

DeepSeek (Codewhale) has no push inbox for an already-open session and is not connected to the MCP bridge. Task delegation is one-way per invocation via `codewhale exec` (or through the wrapper script `src/deepseek-exec.mjs`):
1. Change into the working directory before invoking (`cd <directory>`), because `codewhale exec` does not have a working-directory flag.
2. Invoke `codewhale exec [--auto] [--sandbox workspace-write] [--model <model>] [--max-turns <N>] [--json | --output-format stream-json] [--continue | --resume <id>] -- "<prompt>"` with `CODEWHALE_NO_UPDATE_CHECK=1`.
3. Without `--auto`, `codewhale exec` only returns a single text response without tools. With `--auto`, Codewhale enables tools and auto-approves them (Full Access, with no OS-level sandbox on Windows); `--sandbox workspace-write` can be added to retain the policy sandbox.
4. The prompt is a positional command-line argument (not read from `stdin`); all flags must precede the prompt, and `--` must be used if the prompt starts with a dash (`-`). When a prompt is long or multi-line, write it to a file and instruct `codewhale exec` to read that file (or use `node <repo directory>/src/deepseek-exec.mjs --cwd <directory> --prompt-file <file>`).

```mermaid
sequenceDiagram
    participant Caller as Claude Code / Calling Agent
    participant Wrapper as src/deepseek-exec.mjs (or shell cd)
    participant CW as Codewhale CLI (codewhale exec)
    participant API as DeepSeek API (api.deepseek.com)

    Caller->>Wrapper: --cwd <directory> --prompt-file <file> [--auto] [--sandbox workspace-write]
    Wrapper->>CW: Run in <directory>: codewhale exec ... -- "<prompt>"
    CW->>API: Send request (key resolved from Codewhale secret store / env)
    API-->>CW: Response (or 402/429 error on balance / rate limit)
    CW-->>Wrapper: Return stdout / stderr and exit code
    Wrapper-->>Caller: Classification JSON (ok | quota_or_balance | other_error)
```

---

## 3. Sender Identity and Message Envelope

### 3.1. Identity Verification
- **Claude and Codex**: According to `KeeVeeG/codex-claude-desktop-bridge`, the bridge verifies sender identity based on the executing process. We have not independently verified this verification mechanism (`[NOT TESTED]`).
- **Gemini**: Sender identity is **self-declared** via the `AGENT_NAME` environment variable configured when registering the MCP server (`Gemini (agy)` for the CLI or `Gemini (Antigravity IDE)` for the IDE). In `src/gemini-bridge-mcp.mjs`, the model cannot self-declare an identity at tool-call time, and any spoofed `from` parameter passed in is rejected. However, because the bridge cannot verify Gemini's process, the receiving side (Claude or Codex) always sees the sender status labeled as **unverified**.
- **DeepSeek (Codewhale)**: Only returns output directly via `stdout` to the parent process that invoked `codewhale exec`; it does not send asynchronous messages into other agents' sessions.

### 3.2. Message Envelope and Trust Boundary
- Messages sent to Claude pass through the bridge's `sendToClaude` and are wrapped in a `cross-session-message` tag carrying the sender name (from Gemini, this is `AGENT_NAME` with an "unverified" label).
- Messages sent by `gemini-bridge` to Codex are wrapped in an envelope generated by this repo: the first line states that the source is a self-declared, unverified agent; the message body sits between two boundary lines `<<<TIN-<code>` and `TIN-<code>>>>` with a fresh random code generated per send (so model-generated content cannot forge the closing delimiter); the final line, placed AFTER the closing delimiter line, states that this is **collaborative context**, **not** user or system instructions. The 16,000-character limit is counted **after** envelope wrapping. The random boundary only makes forging the envelope structure harder; it does not replace the receiving agent treating the content as context.
- Whether the receiving agent treats the content as context rather than instructions still depends on how that agent itself processes input and on the rules in its instruction file (`templates/`).
- The receiving side must not autonomously perform destructive operations, delete data, run `git push`, or modify permission configurations merely because a message body or another agent's output asks it to. Verified in practice (`[VERIFIED]`): Codex stops on its own and refuses to perform actions that require direct user confirmation in the Codex session (such as pushing, modifying Claude's permission settings, or SSH write operations to another machine) even when instructed via a message from Claude.
- **Attack surface warning**: If the receiving agent is running in a mode that automatically bypasses permission approvals, message content or output from another agent can lead to automatic command execution. This is a real attack surface that must be controlled through tool permissions and prompt scoping.

---

## 4. Technical Limitations of Each Channel

1. **No read receipt (`acknowledged: false`)**: Every message direction across the bridge and MCP only confirms successful delivery or queueing; there is no signal indicating that the recipient has read or finished processing the message.
2. **Gemini and DeepSeek have no push inbox for an open session**: Messages cannot be pushed into a Gemini conversation already open in Antigravity IDE or into an open Codewhale session. Gemini only receives work when invoked as a new session via `agy -p` (or when that Gemini session actively calls an MCP tool itself); DeepSeek only receives one-shot tasks via `codewhale exec`.
3. **Limitations of `send_to_codex` and the queue**:
   - Mode `transport: "auto"` rejects Codex conversations open in the IDE extension because the daemon reports `notLoaded`; passing `transport: "terminal"` is required to route messages through `codex queue`. `[VERIFIED]`
   - How and with what latency an IDE extension Codex session reads messages from `codex queue` has not been specifically measured (`[NOT TESTED]` for latency).
4. **Limitations of `agy -p` in non-interactive mode (`[VERIFIED]`)**:
   - **Ignores permission configuration**: `agy -p` ignores the `permissions.allow` list (issue `google-antigravity/antigravity-cli#548`). Passing `--settings` with `command(...)` rules (with and without `*` wildcards) was tested and rejected in both cases. Consequently, if `toolPermission` is not configured and Gemini needs to read files or call tools in `-p` mode, adding the `--dangerously-skip-permissions` flag is required (this flag approves **every** tool for that run). Only use this flag when the user has approved it and the prompt scope is strictly confined to the project directory; pure Q&A tasks do not need this flag.
   - **Command-line length limit**: Prompts passed via the command-line argument of `agy -p` that exceed roughly 32,000 characters silently return 0 bytes. Keep prompts under roughly 25,000 characters and always verify that output is non-empty. Additionally, multi-line prompts passed through `Start-Process -ArgumentList` in PowerShell get split into broken arguments; pass them via a file or `stdin` instead.
5. **Limitations of `codewhale exec` (DeepSeek) (`[VERIFIED]`)**:
   - **No working-directory flag and no `stdin` prompt**: You must `cd` into the target directory before invoking it. The prompt is a command-line argument; all flags must precede the prompt, and `--` must be passed if the prompt begins with a dash (`-`). For long or multi-line prompts, write the prompt to a file and instruct it to read that file (or invoke via `src/deepseek-exec.mjs --prompt-file <file>`).
   - **Tool flag and Windows sandbox**: By default, `codewhale exec "<prompt>"` runs without tools. Adding `--auto` enables tools with auto-approval (Full Access, with no OS-level sandbox on Windows); add `--sandbox workspace-write` to keep the policy sandbox.
6. **Instruction file loading limits**: Antigravity cumulatively loads both `AGENTS.md` and `GEMINI.md` from the file's directory up to the workspace root and truncates each file at 24,000 bytes, whereas Codex reads only `AGENTS.md`.

---

## 5. Work Orchestration Model

### 5.1. Role Assignment and Delegation Principles
- **Claude Code** is the coordinator, checker, and evaluator: it decomposes tasks, delegates suitable parts to the four execution sessions, retains work requiring direct conversational context with the user, integrates results, performs independent verification, and handles sensitive operations:
  - **Codex (`codex exec`)**: writing or modifying code, refactoring, running and fixing tests, reviewing diffs in a repo.
  - **Gemini Opus session (`agy`)**: hard reasoning, design, multi-step analysis, editing documentation and files outside the repo, deep review.
  - **Gemini Argon session (`agy`)**: broad lookup, reading long context, synthesis, drafting documentation, second opinions, cross-checking.
  - **DeepSeek (`codewhale exec`)**: 1M-token context window (up to 384K output), low cost; well suited for analyzing or summarizing large context, generating large volumes of code or documentation, second opinions, and cross-checking.
- **Delegation without privilege escalation**: Restricted tasks include: writing to production environments or shared clusters, reading production databases, running `kubectl` or `ssh` with write effects, handling credentials, irreversible deletion, `push`, sending data externally, or modifying agent permission configurations (Claude's `settings.json`, Codex configuration, Gemini's `mcp_config.json`, Codewhale's configuration/secret store). All of these require asking the user first or having the user run them directly. If an agent is blocked by permissions from performing an action, it must never delegate that action to another agent to bypass the rule.
- **Memory security**: Allowing Codex, Gemini, and DeepSeek to read Claude's `memory` directory means that data is sent to OpenAI, Google, and DeepSeek (`https://api.deepseek.com`) servers; therefore, secrets (passwords, tokens, API keys) must never be stored in `memory`.

### 5.2. Three Coordination Patterns
1. **Parallel split**: Separate independent items for the execution sessions (Codex, Gemini Opus, Gemini Argon, DeepSeek) and Claude to execute concurrently.
2. **Cross-check**: Assign one session to read and verify the output (source code, documentation, analysis) just completed by another session.
3. **Sequential pipeline**: Gemini or DeepSeek performs initial lookup or exploration, then Codex or Claude implements the code, and a remaining session performs the review step.

### 5.3. Model Selection
Default model selection by task type (adjustable based on actual needs):
- **Gemini (`agy`)**:
  - `claude-opus-5-5-high` or `gemini-4-argon-high`: Used for multi-step, design, or high-difficulty analysis tasks.
  - `gemini-4-argon-medium`: Used for medium-complexity tasks.
  - `gemini-3.8-flash-medium`: Used for lookup and summarization tasks.
  - Empirical note (`[VERIFIED, small sample]`): Do not use Gemini `low` variants for tasks requiring precision (miscounted by one character in one test run). In addition, Gemini inserted characters from outside the target language into its response twice, so the coordinator must proofread outputs before using or forwarding them.
- **Codex**: Keep the model configured as default.
- **DeepSeek (`codewhale`)**:
  - Default `deepseek-flash` (DeepSeek V4.1 Flash, 1M-token context, up to 384K output tokens) for fast turnaround and low cost.
  - Switch to `--model deepseek-v4-pro` when deeper reasoning is needed, or use them as mutual fallback models (`deepseek-flash` <-> `deepseek-v4-pro`).

### 5.4. Per-Task Delegation Workflow
Each time work is delegated to Codex, Gemini, or DeepSeek, the prompt must follow this workflow:
1. Assign only **one clear task** per invocation.
2. State completely: objective, working directory, list of files allowed to be modified, prohibited actions, and output report format.
3. Upon receiving a completion report, Claude must read the files itself and verify the actual results rather than blindly trusting the delegated session's report.

---

## 6. Quota and Balance Exhaustion Handling Rules

- **Difference between quota windows and monetary balance**:
  - Claude Code, Codex, and Gemini enforce time-windowed quotas (such as 5-hour or weekly windows).
  - DeepSeek bills directly against the account's monetary balance (with no 5-hour or weekly window). The DeepSeek API supports OpenAI-compatible endpoints at `https://api.deepseek.com` and Anthropic-compatible endpoints at `https://api.deepseek.com/anthropic`; the balance can be queried via `GET https://api.deepseek.com/user/balance` with `Authorization: Bearer <key>` (`[VERIFIED]`: returns JSON with `is_available` and a `balance_infos` array containing `currency`, `total_balance`, `granted_balance`, `topped_up_balance`).
- **Detection signals**:
  - For Codex and Gemini: based on an initial estimated set of keywords and error codes: `quota`, `usage limit`, `rate limit`, `resource exhausted`, `credits`, and HTTP status codes `429` or `402`.
  - For DeepSeek (Codewhale): treated as out of balance or rate-limited when encountering HTTP `402` (`Insufficient Balance`) or `429` (inferred from API documentation, `[NOT TESTED]` against a live zero-balance error).
- **Failover order and handoff rules**:
  1. If a limit error is specific to a single model within the same tool, try switching to the equivalent fallback model first (`deepseek-flash` <-> `deepseek-v4-pro` in Codewhale; equivalent model in `agy`).
  2. When the entire tool hits quota or balance exhaustion, Claude transfers the unfinished portion intact to a remaining execution session matched to the task's strengths: code/test/review tasks prioritize `Codex <-> Gemini (Opus/Argon) <-> DeepSeek`; long-context/summarization/documentation/cross-check tasks prioritize `Gemini <-> DeepSeek <-> Codex`.
  3. If all execution sessions are out of quota or balance, Claude performs the work itself and clearly informs the user. Quota exhaustion does not alter security boundaries: restricted tasks are still never delegated automatically.
- **Verification status**: The quota failover workflow between Codex and Gemini is reported by the maintainer as having been used in practice across two working days (`[REPORTED]`, with no logs retained in this repo); the `402`/`429` classification branch in `src/deepseek-exec.mjs` is verified using a fake `codewhale` script (`[VERIFIED]`), while live DeepSeek zero-balance exhaustion remains `[NOT TESTED]`.

---

## 7. Why an MCP Architecture Was Chosen Over a File-Based Inbox

To connect Gemini to the existing communication network between Claude and Codex, this repo uses the `gemini-bridge` MCP server over `stdio` instead of designing a custom intermediate file-based inbox for two technical reasons:
- **Direct reuse of the bridge library**: It directly calls the tested session-routing, envelope-wrapping, and daemon-queueing functions in `lib/claude-desktop.mjs` and `lib/codex-daemon.mjs`, avoiding the need to maintain two parallel messaging protocols or run an extra directory-polling process.
- **Identity and input enforcement at the chokepoint**: The MCP server reads the `AGENT_NAME` environment variable from the IDE/`agy` launch configuration and rejects any model-supplied `from` parameter, while enforcing `inputSchema` type validation and the 16,000-character size limit before passing messages into the bridge.
