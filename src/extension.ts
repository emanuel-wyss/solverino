import * as vscode from "vscode";
import { Controller } from "./controller";

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel("Solverino");
  context.subscriptions.push(outputChannel);

  let activated = false;

  const tryActivate = (): void => {
    if (activated || !vscode.workspace.workspaceFolders?.length) {
      return;
    }
    try {
      const controller = new Controller(context);
      activated = true;
      context.subscriptions.push(controller);
      controller.activate();
      context.subscriptions.push(
        vscode.window.registerTreeDataProvider(
          "solverino.overview",
          controller.overviewProvider
        )
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      outputChannel.appendLine(`[error] ${message}`);
      void vscode.window.showErrorMessage(`Solverino: ${message}`);
    }
  };

  if (vscode.workspace.workspaceFolders?.length) {
    tryActivate();
  } else {
    outputChannel.appendLine(
      "[info] No workspace folder open yet; Solverino will activate when one is opened."
    );
    context.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(tryActivate)
    );
  }
}

export function deactivate(): void {
  // Controller.dispose (via context.subscriptions) stops all running and
  // queued agent processes on extension deactivation.
}
