import * as vscode from "vscode";
import { ChatMessage, ChatSession, SessionStatus } from "../types";

export type ChatPanelAction =
  | { type: "send"; text: string }
  | { type: "stop" }
  | { type: "commit" }
  | { type: "pushAndCreatePR" }
  | { type: "openWorktree" };

interface PanelState {
  status: SessionStatus;
  worktreePath?: string;
  branch?: string;
  hasWorktree: boolean;
}

export class ChatPanel {
  public static readonly viewType = "solverino.chat";

  private panel: vscode.WebviewPanel;
  private actionHandler: ((action: ChatPanelAction) => void) | undefined;
  private disposed = false;

  private constructor(
    public readonly session: ChatSession,
    column: vscode.ViewColumn
  ) {
    this.panel = vscode.window.createWebviewPanel(
      ChatPanel.viewType,
      this.titleFor(session),
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );
    this.panel.webview.onDidReceiveMessage((m: ChatPanelAction) => {
      this.actionHandler?.(m);
    });
    this.panel.onDidDispose(() => {
      this.disposed = true;
    });
  }

  static open(
    session: ChatSession,
    column: vscode.ViewColumn
  ): ChatPanel {
    return new ChatPanel(session, column);
  }

  get webview(): vscode.Webview {
    return this.panel.webview;
  }

  get onDidDispose(): vscode.Event<void> {
    return this.panel.onDidDispose;
  }

  onAction(handler: (action: ChatPanelAction) => void): void {
    this.actionHandler = handler;
  }

  reveal(): void {
    this.panel.reveal();
  }

  dispose(): void {
    this.panel.dispose();
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  private titleFor(session: ChatSession): string {
    const kind = session.kind === "issue" ? "Issue" : "PR";
    return `Solverino: ${kind} #${session.number}`;
  }

  render(state?: PanelState): void {
    this.panel.title = this.titleFor(this.session);
    const s: PanelState =
      state ?? {
        status: this.session.status,
        worktreePath: this.session.worktreePath,
        branch: this.session.branch,
        hasWorktree: Boolean(this.session.worktreePath),
      };
    this.panel.webview.html = this.html(s);
  }

  setMessages(history: ChatMessage[], state: PanelState): void {
    this.render(state);
    void this.panel.webview.postMessage({ type: "history", messages: history });
  }

  appendAgentChunk(chunk: string): void {
    void this.panel.webview.postMessage({ type: "agent-chunk", chunk });
  }

  appendSystemMessage(text: string): void {
    void this.panel.webview.postMessage({ type: "system-message", text });
  }

  closeAgentMessage(): void {
    void this.panel.webview.postMessage({ type: "agent-close" });
  }

  setStatus(state: PanelState): void {
    void this.panel.webview.postMessage({ type: "state", state });
  }

  private html(s: PanelState): string {
    const statusText: Record<SessionStatus, string> = {
      idle: "Idle",
      working: "Agent working…",
      needsReview: "Needs review",
      prOpened: "PR opened",
      error: "Error",
    };
    const nonce = Math.random().toString(36).slice(2);
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); margin: 0; display: flex; flex-direction: column; height: 100vh; }
  header { padding: 6px 12px; border-bottom: 1px solid var(--vscode-panel-border); display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  header .meta { opacity: 0.8; font-size: 0.85em; }
  #status { font-weight: bold; }
  #messages { flex: 1; overflow-y: auto; padding: 10px 12px; }
  .msg { margin: 6px 0; white-space: pre-wrap; word-wrap: break-word; }
  .msg.user { color: var(--vscode-input-foreground); background: var(--vscode-input-background); padding: 6px 8px; border-radius: 4px; }
  .msg.agent { border-left: 2px solid var(--vscode-focusBorder); padding-left: 8px; }
  .msg.system { opacity: 0.7; font-size: 0.85em; font-style: italic; }
  footer { border-top: 1px solid var(--vscode-panel-border); padding: 8px 12px; display: flex; gap: 6px; }
  textarea { flex: 1; resize: vertical; min-height: 2.2em; }
  button { white-space: nowrap; cursor: pointer; }
</style>
</head>
<body>
<header>
  <span id="status">${statusText[s.status]}</span>
  <span class="meta" id="worktree">${s.hasWorktree ? `worktree: ${escapeHtml(s.worktreePath ?? "")} (${escapeHtml(s.branch ?? "")})` : "no worktree yet"}</span>
</header>
<div id="messages"></div>
<footer>
  <textarea id="input" placeholder="Message the agent…"></textarea>
  <button id="send">Send</button>
  <button id="stop" ${s.status === "working" ? "" : "disabled"}>Stop</button>
  <button id="commit" ${s.hasWorktree && s.status !== "working" ? "" : "disabled"}>Commit</button>
  <button id="push" ${s.hasWorktree && s.status !== "working" ? "" : "disabled"}>Push &amp; Create PR</button>
  <button id="openwt" ${s.hasWorktree ? "" : "disabled"}>Open Worktree</button>
</footer>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const messages = document.getElementById('messages');
const input = document.getElementById('input');
const statusEl = document.getElementById('status');
const worktreeEl = document.getElementById('worktree');
let agentMsg = null;

function escapeHtml(t) {
  return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function addMessage(role, text) {
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  div.textContent = text;
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
  return div;
}

document.getElementById('send').addEventListener('click', () => {
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  vscode.postMessage({ type: 'send', text });
});
document.getElementById('stop').addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
document.getElementById('commit').addEventListener('click', () => vscode.postMessage({ type: 'commit' }));
document.getElementById('push').addEventListener('click', () => vscode.postMessage({ type: 'pushAndCreatePR' }));
document.getElementById('openwt').addEventListener('click', () => vscode.postMessage({ type: 'openWorktree' }));
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    document.getElementById('send').click();
  }
});

window.addEventListener('message', (e) => {
  const m = e.data;
  if (m.type === 'history') {
    messages.innerHTML = '';
    agentMsg = null;
    for (const msg of m.messages) {
      if (msg.role === 'agent') {
        addMessage('agent', msg.text);
      } else {
        addMessage(msg.role, msg.text);
      }
    }
    const last = m.messages[m.messages.length - 1];
    if (last && last.role === 'agent' && last.streaming) {
      agentMsg = messages.lastElementChild;
    }
    messages.scrollTop = messages.scrollHeight;
  } else if (m.type === 'agent-chunk') {
    if (!agentMsg || !agentMsg.classList.contains('msg') || agentMsg.dataset.closed === '1') {
      agentMsg = addMessage('agent', m.chunk);
      agentMsg.dataset.closed = '0';
    } else {
      agentMsg.textContent += m.chunk;
    }
    messages.scrollTop = messages.scrollHeight;
  } else if (m.type === 'agent-close') {
    if (agentMsg) {
      agentMsg.dataset.closed = '1';
      agentMsg = null;
    }
  } else if (m.type === 'system-message') {
    addMessage('system', m.text);
  } else if (m.type === 'state') {
    const s = m.state;
    statusEl.textContent = ${JSON.stringify(statusText)}[s.status] || s.status;
    worktreeEl.textContent = s.hasWorktree ? 'worktree: ' + s.worktreePath + ' (' + s.branch + ')' : 'no worktree yet';
    document.getElementById('stop').disabled = s.status !== 'working';
    const wtDisabled = !s.hasWorktree;
    const working = s.status === 'working';
    document.getElementById('commit').disabled = wtDisabled || working;
    document.getElementById('push').disabled = wtDisabled || working;
    document.getElementById('openwt').disabled = wtDisabled;
  }
});
</script>
</body>
</html>`;
  }
}

function escapeHtml(t: string): string {
  return t
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
