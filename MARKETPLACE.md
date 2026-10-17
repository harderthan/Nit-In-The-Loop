# Nit-In-The-Loop

Review local Git changes with line comments inside VS Code. Open a diff, share a thread with a coding agent through the bundled CLI, and resolve it when the work is done.

## What you can do

- **Review the working tree.** See staged, unstaged, untracked, deleted, and renamed files against `HEAD` in VS Code's native diff editor.
- **Comment on exact lines.** Start a thread on either side of the diff, reply inline, and resolve or reopen it. Threads also appear in the Comments panel.
- **Exchange comments with an agent.** The bundled CLI lets any agent that can run a command list files and threads, add comments, reply, and change thread status. CLI updates appear in VS Code automatically.
- **Keep reviews local.** Threads are stored in `agent-review/review.json` under the repository's Git directory, outside the source tree. The extension and CLI need no account or API key.

## Get started

1. **Install the tools:** [VS Code](https://code.visualstudio.com/) 1.96 or newer, Git, and Node.js/npm.
2. **Start NITL:** Install NITL from the VS Code Extensions view, then open a Git repository with a changed file.
3. **Leave a comment:** Click **NITL** in the Activity Bar, select a changed text file, then use **Add Comment** on a line in the diff.

Reply or resolve the thread inline. Your comments are restored when you reload the window.

## Work with an agent

The CLI shares the extension's review store. Choose **Copy NITL CLI Command** from the NITL view title to get the command for your installation. Replace `files` with any command below:

```sh
node <extension>/dist/cli.js files --repo /path/to/repo
node <extension>/dist/cli.js threads --repo /path/to/repo
node <extension>/dist/cli.js add --repo /path/to/repo --file src/example.ts --side new --line 4 --body "Please handle this error case."
node <extension>/dist/cli.js reply --repo /path/to/repo --thread THREAD_ID --body "Handled."
node <extension>/dist/cli.js resolve --repo /path/to/repo --thread THREAD_ID
node <extension>/dist/cli.js reopen --repo /path/to/repo --thread THREAD_ID
```

`files` and `threads` return JSON. `threads` lists open threads by default; add `--all` to include resolved threads. For a range comment, add `--end-line NUMBER` to `add`. The CLI validates paths, diff sides, and line ranges before writing a comment.

The extension refreshes when the CLI changes the review store.

The current release exchanges comments through this CLI. It does not launch Claude, Codex, or another agent from the VS Code UI.

## Review behavior

Diff documents are read-only. Edit the real file in a regular editor; NITL refreshes after saves and checks for external Git changes while its view is visible. Use **Refresh Reviews** when needed.

New files have an empty `HEAD` side; deleted files have an empty working-tree side. Renames read their old path from `HEAD`. Binary files appear in the list but cannot receive line comments. When a thread's original text changes, it is marked **Outdated line**. If its line no longer exists, the thread appears under the file in Changed Files instead of being placed on an unrelated line.

If a writer is forcibly stopped and later writes time out, check for `review.json.lock.reclaim` beside the review file. Remove that guard only after confirming no NITL process is writing.
