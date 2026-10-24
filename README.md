# Nit-In-The-Loop

Review local Git changes with line comments inside VS Code. Open a diff, share a thread with a coding agent through the bundled CLI, and resolve it when the work is done.

![NITL diff with an inline thread and the Comments panel](docs/screenshots/agent-review-native.png)

## What you can do

- **Review the working tree.** See staged, unstaged, untracked, deleted, and renamed files against `HEAD` in VS Code's native diff editor.
- **Inspect Git history.** The Git Blame view lists recent commits of the current branch, its upstream, and the remote default branch. Commits that the default branch does not have come first. It marks branch tips and `HEAD`, and colors commits by branch. Expand a commit to see its changed files and open a diff. You can comment on a line or a range of lines in a diff hunk. A hunk holds the changed lines and up to three unchanged lines around them, as in a pull request diff. If you comment on a line outside every hunk, NITL adds the comment to the commit body with a reference to the file and line. Choose **Open Commit Comments** on a commit to read and add commit body comments. Choose **Show Git Blame** on a changed file to inspect its committed lines.
- **Comment on exact lines.** Start a thread on either side of the diff, reply inline, and resolve or reopen it. Threads also appear in the Comments panel.
- **Exchange comments with an agent.** The bundled CLI lets any agent that can run a command list files and threads, add comments, reply, and change thread status. CLI updates appear in VS Code automatically.
- **Keep reviews local.** Threads are stored in `agent-review/review.json` under the repository's Git directory, outside the source tree. [`schema/review.schema.json`](schema/review.schema.json) describes the file format, and VS Code uses it to check the file when you open it. NITL upgrades a file in the older version 1 format when it reads the file, and saves it in version 2 on the next change. The extension and CLI need no account or API key.

[Light theme](docs/screenshots/agent-review-light.png) · [Open thread](docs/screenshots/agent-review-open-status.png) · [Resolved status](docs/screenshots/agent-review-resolved-status.png)

## Get started

1. **Install the tools:** [VS Code](https://code.visualstudio.com/) 1.96 or newer, Git, and Node.js/npm.
2. **Start NITL:** Run `npm ci && npm run compile` in this repository, open it in VS Code, then press **F5**. A new Extension Development Host window opens.
3. **Leave a comment:** In that window, open a Git repository with a changed text file. Click **NITL** in the Activity Bar, select a file, then use **Add Comment** on a line in the diff.

Reply or resolve the thread inline. Your comments are restored when you reload the window.

## Work with an agent

NITL sends your review comments to a coding agent and posts its answers in the threads. Set the agent command in your user settings first. If it is not set, NITL shows an error and keeps your comment queued.

```json
"agentReview.agentCommand": "claude -p --permission-mode acceptEdits"
```

NITL runs this command without a shell in the repository root. It sends the review prompt on stdin, or in place of a `{prompt}` argument. The prompt holds each thread's location, code, and conversation. The agent's printed answer becomes its reply. NITL never adds permission flags, so the command decides whether the agent can edit files. The setting is read only from user settings, never from a workspace, and NITL runs the agent only in a trusted workspace.

- **Send to Agent** saves your comment and sends its thread to the agent at once.
- **Add to Queue** saves your comment without sending it. Choose **Send Queued Comments to Agent** in the NITL view title to send every queued thread in one agent run.
- **One session per thread.** With `claude`, NITL starts each run with `--session-id` and later resumes that session with `--resume`, so a thread keeps talking to the same session. If the session is gone, NITL starts a new one. Other agents start fresh on each run and read the whole thread from the prompt.

A run stops after 10 minutes or 1 MB of output, and you can cancel it from its notification. If the run fails, no reply is posted and the comments stay queued. The **NITL Agent** output channel shows the agent's error output.

The CLI shares the extension's review store. From this source checkout, use `npm run cli --`:

```sh
npm run cli -- files --repo /path/to/repo
npm run cli -- threads --repo /path/to/repo
npm run cli -- add --repo /path/to/repo --file src/example.ts --side new --line 4 --body "Please handle this error case."
npm run cli -- reply --repo /path/to/repo --thread THREAD_ID --body "Handled."
npm run cli -- resolve --repo /path/to/repo --thread THREAD_ID
npm run cli -- reopen --repo /path/to/repo --thread THREAD_ID
```

To comment on a commit, add `--commit REV`. With `--file`, `--side`, and `--line`, the lines must be in one diff hunk of the commit. Without `--file`, the comment goes on the commit body. `threads --commit REV` lists only that commit's threads.

```sh
npm run cli -- add --repo /path/to/repo --commit 5f3b2c4 --file src/example.ts --side new --line 4 --body "Why this change?"
npm run cli -- add --repo /path/to/repo --commit 5f3b2c4 --body "The commit message does not match the change."
npm run cli -- threads --repo /path/to/repo --commit 5f3b2c4
```

`files` and `threads` return JSON. `threads` lists open threads by default; add `--all` to include resolved threads. For a range comment, add `--end-line NUMBER` to `add`. The CLI validates paths, diff sides, and line ranges before writing a comment.

For an installed VSIX, choose **Copy NITL CLI Command** from the NITL view title or the Command Palette. It copies a `node <extension>/dist/cli.js files --repo <repository>` command that uses the installed extension, so the source checkout is unnecessary. Replace `files` with another command above and supply its options. The extension refreshes when the CLI changes the review store.

An agent that works in its own terminal session can also use this CLI to read threads and reply.

## Review behavior

Diff documents are read-only. Edit the real file in a regular editor; NITL refreshes after saves and checks for external Git changes while its view is visible. Use **Refresh Reviews** when needed.

New files have an empty `HEAD` side; deleted files have an empty working-tree side. Renames read their old path from `HEAD`. Binary files appear in the list but cannot receive line comments. When a thread's original text changes, it is marked **Outdated line**. If its line no longer exists, the thread appears under the file in Changed Files instead of being placed on an unrelated line.

If a writer is forcibly stopped and later writes time out, check for `review.json.lock.reclaim` beside the review file. Remove that guard only after confirming no NITL process is writing.

## Development

```sh
npm ci
npm run compile
npm test
```

The launch configuration in `.vscode/launch.json` starts the Extension Development Host.
