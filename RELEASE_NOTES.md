# Release Notes

Solverino release notes. Add every user-facing change to the **Unreleased** section as it lands; when cutting a release, move it under a new version heading and update the `version` field in `package.json` in the same commit.

## v0.2.2

*Shipped via PRs #5 and #6.*

### UX & UI (PR #5)

- PR items show draft state, CI check results (colored icons for failing/running checks) and review decisions; issue items show their labels.
- Markdown tooltips with author, relative last-activity time, labels and a body excerpt.
- Dirty-worktree indicator: uncommitted file count shown next to the branch name.
- Welcome/empty state with **Refresh** and **Toggle Show All Open Issues** actions instead of a blank tree.
- Progress notification while a worktree is being created.
- Status bar item with PR / review-request / issue counts; click it to jump to any item.
- New commands: `Solverino: Go to Issue/PR…` (fuzzy quick pick with action menu) and `Solverino: Toggle Show All Open Issues`.
- Tree sections show item counts and icons.

### Flows, analytics & worktree hygiene (PR #6)

- **Solverino: Create Draft PR** (issues): ensures the worktree, commits uncommitted changes, pushes the branch and opens a draft PR titled `#<number>: <title>` with a `Closes #<number>` body.
- **Orphaned Worktrees** tree section listing worktrees whose issue/PR is no longer open, with their own cleanup action.
- **Cleanup Worktree** now warns that removing the worktree of a still-open PR does not close the PR.
- **Solverino: My Week (Merged & Closed)**: quick pick of the PRs you merged and issues you closed in the last 7 days.

## v0.2.1

- **Open in Codespace**: opens `https://codespaces.new/<repo>/tree/<branch>` for the item's branch — the PR head branch (works for fork PRs) or the existing worktree branch after confirming it exists on GitHub, with an option to push a local-only branch. Falls back to the default branch when no worktree exists yet.
- **Open Copilot Agent**: ensures the worktree, opens/focuses its VS Code window and opens GitHub Copilot Chat as an agent-mode editor tab in it.

## v0.2.0

- Focused on worktree management for Issues & PRs: tree view with your PRs, PRs requesting your review and your assigned issues.
- One-click **Open Worktree** (`solverino-<repo>-<kind>-<number>`) with a clear highlight for items that already have a worktree.
- PR worktrees fetch `pull/<n>/head` and check out the PR's actual branch.
- **Cleanup Worktree** with an explicit confirmation warning about uncommitted files and locally-only commits.

## v0.1.0

- Initial release: parallel PR/issue agent chats with git worktrees.

---

## Maintaining this file

When cutting a release:

1. Move the **Unreleased** entries under a new `## <version>` heading matching `package.json`.
2. Bump `version` in `package.json`.
3. Commit both in the same change, then tag/build the release as usual (`npm run vsix`).
4. Copy the version's section into the GitHub release body (or link this file).
