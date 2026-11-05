# Solverino — Parallel PR Agents

A VS Code extension that shows every open/assigned Issue and Pull Request of your current repository, gives each one its own chat, and runs an AI coding agent in a dedicated **git worktree** per chat — with a live progress overview and one-click PR actions.

## Features

- **Overview tree view** (Activity Bar → Solverino): assigned Issues and open PRs with live status badges — idle / working / needs review / PR opened / error. Auto-refreshes on a configurable interval. Lists up to 1000 open items per category.
- **Per-Issue/PR chat panels**: full chat UX with streaming agent output, message history persisted across reloads.
- **Worktree isolation**: each chat maps 1:1 to its own `git worktree` (`solverino-<repo>-issue-42`) and branch (`issue-42`). Agents work in parallel without stepping on each other.
- **Agent engine**: runs any CLI agent (default: GitHub Copilot CLI, `copilot -p "<prompt>"`) with `cwd` set to the chat's worktree. Session resume on follow-up turns.
- **Concurrency cap + queue**: at most N agents run at once (default 4); the rest wait in a queue.
- **Approval gate**: nothing is committed or pushed automatically. **Commit**, **Push & Create PR**, and **Cleanup worktree** are explicit user actions, each with an informed confirmation: commit shows the file list (and warns about likely secrets), push shows the branch, target base, and commit count, cleanup warns about uncommitted files and locally-only commits.
- **One-click PR workflow**: review → commit → push → `gh pr create`, straight from the chat panel.
- **Error reporting**: when an agent run fails, report the error log as a GitHub issue with one click — auto-assigned to the GitHub Copilot coding agent (configurable) so it can pick the failure up.

## Install in VS Code

**Option 1 — Extension Marketplace** (once published): open the Extensions view (`Ctrl+Shift+X` / `Cmd+Shift+X`), search for **Solverino**, and click **Install**.

**Option 2 — From a VSIX** (e.g. a [release](https://github.com/emanuel-wyss/solverino/releases) artifact):

1. Download the `solverino-<version>.vsix` file.
2. In VS Code, open the Extensions view (`Ctrl+Shift+X` / `Cmd+Shift+X`).
3. Click the `⋯` menu at the top of the view → **Install from VSIX…** and select the downloaded file.
4. Reload VS Code when prompted.

   Or from the terminal: `code --install-extension solverino-<version>.vsix`

**Option 3 — Run from source** (development):

```bash
git clone https://github.com/emanuel-wyss/solverino
cd solverino
npm install
```

Open the folder in VS Code and press `F5` to launch an **Extension Development Host** with Solverino loaded.

## Requirements

- Git
- [GitHub CLI](https://cli.github.com) (`gh`), authenticated via `gh auth login`
- An agent CLI on PATH (default: [GitHub Copilot CLI](https://cli.github.com), `copilot`)

## Getting started

1. Open a repository folder in VS Code.
2. Click the Solverino icon in the Activity Bar.
3. Click the chat icon on an issue or PR — Solverino creates the worktree and opens the chat.
4. Send a message (or hit ▶ Start Agent) — the agent works inside the worktree.
5. When it finishes, review the diff, then **Commit** and **Push & Create PR**.

## Commands

| Command | Description |
|---|---|
| `Solverino: Refresh Issues & PRs` | Re-fetch issues/PRs from GitHub |
| `Solverino: Start Chat` | Create worktree + open chat for an item |
| `Solverino: Start Agent` / `Stop Agent` | Run/stop the agent for a chat |
| `Solverino: Commit Changes in Worktree` | Stage and commit all changes |
| `Solverino: Push & Create Pull Request` | Push branch and open a PR via `gh` |
| `Solverino: Cleanup Worktree` | Remove worktree + branch |
| `Solverino: Report Error as GitHub Issue` | Create a GitHub issue from a chat's error log, assigned to Copilot |
| `Solverino: Open Worktree in New Window` | Open the worktree folder in a new VS Code window |

## Settings

| Setting | Default | Description |
|---|---|---|
| `solverino.maxConcurrentAgents` | `4` | Parallel agent processes; excess chats are queued |
| `solverino.worktreeParentFolder` | *(sibling of repo)* | Parent folder for worktrees |
| `solverino.agentCommand` | `copilot` | Agent executable, invoked as `<command> -p <prompt>` |
| `solverino.agentResumeArgs` | `--continue` | Args appended on follow-up turns for session resume |
| `solverino.envSetupCommand` | *(empty)* | Shell command run once per fresh worktree (e.g. `npm install`) |
| `solverino.pollIntervalSeconds` | `60` | Overview refresh interval; `0` disables polling |
| `solverino.showAllOpenIssues` | `false` | Show all open issues, not only assigned ones |
| `solverino.errorIssueAssignee` | `copilot` | Assignee for issues created from agent error logs |
| `solverino.autoCreateErrorIssue` | `false` | Auto-create an error issue whenever an agent run fails, instead of reporting manually |

## Development

```bash
npm install
npm run compile     # esbuild bundle to out/extension.js
npm run typecheck   # tsc --noEmit
npm test            # mocha unit tests (worktree service, branch naming, queue, agent runner)
```

Press F5 to launch an Extension Development Host with Solverino loaded.

Build a local `.vsix` with `npm run vsix` and install it via Extensions → ⋯ → **Install from VSIX…**.

Every push to `main` automatically builds and publishes a `.vsix` to the repo's GitHub Releases (see `.github/workflows/release.yml`).

## Notes & limitations

- VS Code has no public API to drive built-in Copilot chat sessions, so Solverino runs its own agent processes and renders them in its own chat UI. A Copilot Chat participant (`@solverino`) plus Language Model Tools is planned for v2.
- One repository per window (multi-repo support is a v2 goal).
- No autonomous push/merge: every destructive action requires an explicit click.
- The agent CLI runs with your shell and credentials. The prompt instructs it not to commit or push, but this cannot be technically enforced — review the branch's remote state before pushing, and prefer read-only credentials for agent runs.

## License

MIT

Town boundary © OpenStreetMap contributors (ODbL)
