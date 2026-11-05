# Solverino

A VS Code extension that lists the open Issues and Pull Requests of your current repository and gives each one a **one-click git worktree** — with a clear highlight for items that already have a worktree and a cleanup command when you are done.

## Features

- **Issues & PRs overview**: a tree view with your PRs, PRs requesting your review, and your assigned issues (refreshed automatically).
- **Open Worktree button**: one click per issue or PR creates a dedicated `git worktree` (`solverino-<repo>-issue-42`) on its own branch and opens it in VS Code — if a window for that worktree is already open, it is focused instead of opening a new instance.
  - Issue worktrees branch off `HEAD` as `issue-<number>`.
  - PR worktrees fetch the PR head (`pull/<n>/head`) and check out the PR's **actual branch** so you work on exactly the code under review.
- **Existing worktrees are highlighted**: items with a worktree show a folder icon and their branch name, so you always know what is already checked out.
- **Cleanup Worktree**: removes a worktree and its branch, with an explicit confirmation that warns about uncommitted files and locally-only commits before anything is deleted.

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

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `solverino.worktreeParentFolder` | *(sibling of repo)* | Parent folder for worktrees |
| `solverino.pollIntervalSeconds` | `60` | Refresh interval for Issues/PRs; `0` disables polling |
| `solverino.showAllOpenIssues` | `false` | Show all open issues, not only the ones assigned to you |

## Development

```bash
npm install
npm run compile      # esbuild bundle to out/
npm run typecheck    # tsc --noEmit
npm test             # mocha unit tests (worktree service, branch naming, queue)
npm run vsix         # package a .vsix for local installation
```

Press `F5` to launch the Extension Development Host with Solverino loaded.
