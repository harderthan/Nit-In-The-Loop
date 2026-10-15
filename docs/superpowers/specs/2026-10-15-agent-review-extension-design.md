# Agent Review VS Code extension design

## Purpose

Review local Git changes in VS Code at a precise line or line range. A human can comment on an agent's changes; an agent can also leave review comments, reply, and resolve threads. The first release is local-first and works with any agent able to run a CLI command.

## Review experience

The Activity Bar has an **Agent Review** view listing changed files and their open-thread counts. Selecting a file opens VS Code's native side-by-side diff against `HEAD`. A reviewer uses the gutter comment control or a command on a selected range to create a thread. Replies appear inline and in VS Code's Comments panel. Threads can be resolved and reopened. A stale anchor is indicated when the stored line text no longer matches.

The initial diff scope is `HEAD` versus the current working tree, including staged, unstaged, and untracked text files. Deleted files are shown as an empty working-tree side. Renames use the old path for the base snapshot and the new path for the working tree. Binary files appear in the file list but cannot receive line comments. The view refreshes after Git changes and on command.

## Data and agent exchange

Each repository/worktree has a local review JSON file under its Git directory. It is not committed with source files. Each thread has a stable ID, repository-relative path, `old` or `new` side, 1-based inclusive line range, base commit SHA, anchor text, stale flag, status, and ordered comments. Each comment has an author (`human` or `agent`), body, ID, and timestamp. Review JSON is versioned and written atomically.

A bundled CLI reads the same store. It lists changed files and threads as JSON, adds line comments after validating path, side, and line range, replies to threads, and resolves or reopens threads. The extension watches the store and restores all threads on activation. Any agent can use the CLI; no account, API key, or specific agent SDK is required.

## Boundaries and errors

The extension does not execute agent code. All Git paths and CLI inputs are validated against the repository. The CLI rejects comments on files outside the diff, missing sides, and invalid line numbers. Git failures, corrupt review data, and storage failures are shown with actionable messages. Existing review data is preserved if parsing fails. Anchor drift does not silently move a thread to a different line.

## Verification

Automated tests cover the review model, JSON round trips, input validation, Git change discovery, and CLI behavior. `npm run compile`, `npm test`, and a VS Code Extension Development Host smoke test verify the actual UI flow: open a diff, create a line thread, reply, resolve, reload, and restore.

## Source influences

- `crit`: line/side anchors, JSON persistence, human-to-agent review loop.
- `diffity`: author roles, thread replies/status, drift detection, agent-authored comments.
- VS Code CommentController and `vscode.diff`: native editor experience.
