# Local agent commands for Agent Review

## Purpose

Let a reviewer send an existing Agent Review thread to a fresh local coding-agent CLI process and read its response in the same thread. The first integration supports locally authenticated Claude Code and Codex CLI through configurable commands. It does not attach to an already running agent session.

## Configuration

Contribute `agentReview.agentCommands` as a VS Code `machine` setting. Its value is a map from display name to command string, with default profiles `{"Claude": "claude -p", "Codex": "codex exec -"}`. The setting is machine-local and cannot be overridden by workspace or folder settings; a repository must not choose a command to execute. A profile is available in the picker even if its CLI is not installed; selecting it then produces a clear installation/configuration error. Users may add other agentic CLIs that accept a prompt on stdin and print a final response on stdout.

Each command is parsed into an executable and argument vector, respecting quoted arguments. The extension does not invoke a shell; pipelines, redirection, variable expansion, and leading environment assignments are unsupported. Empty commands and malformed quoting produce a configuration error before a process starts. A bare executable name resolves on the extension host's `PATH` after relative and empty PATH entries are removed, so a repository cannot substitute a command via `.` in PATH. An explicitly configured absolute executable path is also allowed; a relative path containing directory separators is rejected. The active profile is chosen from a Quick Pick on each request; no per-repository command is stored.

## Review flow

An open, persisted thread rendered on a valid document line gets a **Send to Agent** action in its thread toolbar. The action is unavailable for an empty draft, resolved thread, or outdated thread whose line is no longer present. On activation, the extension checks VS Code workspace trust and the selected profile, then starts a new CLI process with the repository root as its working directory. The prompt is sent on stdin and includes the repository-relative file path, diff side, line range, original anchor text, first review comment, and all replies in order. The prompt asks the agent to address the latest human feedback and print a concise answer. The extension never sends credentials or VS Code settings in the prompt.

The process inherits the extension host's environment, except for the sanitized `PATH`, and the user's local CLI authentication. Its stdout is the final answer; stderr is retained for diagnostics. On a successful exit with nonempty stdout, the extension reacquires the existing locked review store and checks that the thread is still open and its last comment ID is unchanged since the prompt was built. Only then does it add an `agent` reply and refresh the UI. If the thread was resolved, deleted, or received another reply while the agent ran, the response is shown in an output channel with an explanation and the thread is left untouched. The comment gains an optional agent display name so Claude and Codex replies can be identified, while old version-1 review files remain readable. The original author role remains `agent`.

The operation runs asynchronously, with at most one active request per thread. Other threads may be sent independently. The UI indicates that a request is running and offers cancellation. The launched process and its child processes are terminated on cancellation, timeout, or extension deactivation. The deadline is ten minutes; stdout and stderr each have a one-megabyte cap. A failed exit, timeout, empty stdout, missing thread, or storage failure does not create an agent reply; the user sees an actionable error and can retry. The extension does not silently mark a thread resolved.

## Boundaries

The first action responds to a human review thread. Starting an agent to produce new review findings is a separate workflow. The agent may edit files if its configured CLI permissions allow it, so this feature updates the original extension design's no-agent-execution boundary. The extension never adds permission-bypass flags automatically. Execution requires an explicit user action in a trusted workspace. Commands from project files are ignored.

## Verification

Unit tests cover command parsing, rejected shell syntax, prompt construction, configuration validation, nonzero exit, timeout, cancellation, output limits, and agent-name persistence. Integration tests use fake local CLI processes to verify stdin, repository working directory, stdout-to-reply behavior, concurrent thread handling, and no reply on failure. Compile and the full test suite must pass. A VS Code Development Host smoke test verifies Quick Pick selection, running state, the resulting inline reply, and cancellation.

## Source notes

- Crit's `agent_cmd` is global-only, runs a new process per request, sends a comment prompt on stdin, and writes stdout as a reply: <https://github.com/tomasz-tomczyk/crit/blob/ccf3fecb6faa9fc42f3473ce04bd592dbb618395/internal/server/server.go#L3225-L3365>.
- Crit ignores project-level `agent_cmd`: <https://github.com/tomasz-tomczyk/crit/blob/ccf3fecb6faa9fc42f3473ce04bd592dbb618395/internal/config/config.go#L359-L374>.
- VS Code `machine` settings are available only in user or remote settings: <https://code.visualstudio.com/api/references/contribution-points#contributes.configuration>.
- Claude Code `-p` accepts stdin and writes a response; Codex `exec` accepts `-` for stdin according to the installed CLI help.
