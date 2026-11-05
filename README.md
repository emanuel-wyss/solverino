# Solverino

A VS Code extension that lists the open Issues and Pull Requests of your current repository and gives each one a **one-click git worktree** — with a clear highlight for items that already have a worktree and a cleanup command when you are done.

## Features

- **Issues & PRs overview**: a tree view with your PRs, PRs requesting your review, and your assigned issues (refreshed automatically).
- **Open Worktree button**: one click per issue or PR creates a dedicated `git worktree` (`solverino-<repo>-issue-42`) on its own branch and opens it in VS Code — if a window for that worktree is already open, it is focused instead of opening a new instance.
  - Issue worktrees branch off `HEAD` as `issue-<number>`.
  - PR worktrees fetch the PR head (`pull/<n>/head`) and check out the PR's **actual branch** so you work on exactly the code under review.
- **Open in Codespace**: opens `https://codespaces.new/<repo>/tree/<branch>` for the item's branch — the PR head branch (from the PR's head repository, so fork PRs work) or the existing worktree branch after confirming it exists on GitHub (with an option to push a local-only branch). If no worktree exists yet, the default branch is used.
- **Open Copilot Agent**: ensures the worktree (same as **Open Worktree**), opens/focuses its VS Code window and opens GitHub Copilot Chat as an agent-mode editor tab in it.
- **Existing worktrees are highlighted**: items with a worktree show a folder icon and their branch name, so you always know what is already checked out.
- **Cleanup Worktree**: removes a worktree and its branch, with an explicit confirmation that warns about uncommitted files and locally-only commits before anything is deleted. Deleting the worktree of a still-open PR warns that the PR itself stays open.
- **Create Draft PR** *(issues)*: closes the loop from issue to PR — ensures the worktree, commits any uncommitted changes, pushes the branch and opens a draft PR titled `#<number>: <title>` with a `Closes #<number>` body, then opens it on GitHub.
- **Orphaned Worktrees section**: worktrees whose issue or PR is no longer open are listed with their own cleanup action, so stale checkouts never pile up.
- **My Week**: a quick-pick summary of the PRs you merged and issues you closed in the last 7 days, each opening on GitHub.

## Requirements

- Git
- The [GitHub CLI](https://cli.github.com) (`gh`), authenticated via `gh auth login`

## Usage

1. Open a repository folder in VS Code.
2. Click the Solverino icon in the activity bar.
3. Click the **Open Worktree** button on any issue or PR — the worktree is created (or reused) and opened in a new window.
4. When you are done, run **Cleanup Worktree** on the item to remove the worktree and branch.

## Commands

| Command | Description |
| --- | --- |
| `Solverino: Refresh Issues & PRs` | Re-fetch issues and PRs from GitHub |
| `Solverino: Open Worktree` | Create (or reuse) the worktree and open/focus its VS Code window |
| `Solverino: Cleanup Worktree` | Remove the worktree and its branch |
| `Solverino: Open on GitHub` | Open the issue/PR on github.com |
| `Solverino: Open in Codespace` | Open the item's branch as a GitHub Codespace (`https://codespaces.new/…`) |
| `Solverino: Open Copilot Agent` | Ensure the worktree, open/focus its window and open Copilot Chat in agent mode in a new editor tab |
| `Solverino: Create Draft PR` | For an issue: commit, push the branch and open a draft PR linked to the issue |
| `Solverino: Cleanup Orphaned Worktree` | Remove a worktree whose issue/PR is no longer open |
| `Solverino: My Week (Merged & Closed)` | Show the PRs merged and issues closed by you in the last 7 days |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `solverino.worktreeParentFolder` | *(sibling of repo)* | Parent folder for worktrees |
| `solverino.pollIntervalSeconds` | `60` | Refresh interval for Issues/PRs; `0` disables polling |
| `solverino.showAllOpenIssues` | `false` | Show all open issues, not only the ones assigned to you |

## Releases

User-facing changes are tracked in [RELEASE_NOTES.md](RELEASE_NOTES.md). Add entries to its **Unreleased** section as changes land; each release gets its own section there and in the GitHub release.

## Development

```bash
npm install
npm run compile      # esbuild bundle to out/
npm run typecheck    # tsc --noEmit
npm test             # mocha unit tests (worktree service, branch naming, queue)
npm run vsix         # package a .vsix for local installation
```

Press `F5` to launch the Extension Development Host with Solverino loaded.
