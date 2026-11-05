# Solverino — Parallel PR Agents

A VS Code extension that shows every open/assigned Issue and Pull Request of your current repository, gives each one its own chat, and runs an AI coding agent in a dedicated **git worktree** per chat — with a live progress overview and one-click PR actions.

## Features

- **Overview tree view** (Activity Bar → Solverino): assigned Issues and open PRs with live status badges — idle / working / needs review / PR opened / error. Auto-refreshes on a configurable interval. Lists up to 1000 open items per category.
- **Per-Issue/PR chat panels**: full chat UX with streaming agent output, message history persisted across reloads.
- **Worktree isolation**: each chat maps 1:1 to its own `git worktree` (`solverino-<repo>-issue-42`) and branch (`issue-42`). Agents work in parallel without stepping on each other.
- **Agent engine**: runs any CLI agent (default: GitHub Copilot CLI, `copilot -p "<prompt>"`) with `cwd` set to the chat's worktree. Session resume on follow-up turns.
- **Concurrency cap + queue**: at most N agents run at once (default 4); the rest wait in a queue.
- **Approval gate**: nothing is committed or pushed automatically. **Commit**, **Push & Create PR**, and **Cleanup worktree** are explicit user actions.
- **One-click PR workflow**: review → commit → push → `gh pr create`, straight from the chat panel.

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

## License

MIT

Town boundary © OpenStreetMap contributors (ODbL)
