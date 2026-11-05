import * as vscode from "vscode";
import { Controller } from "./controller";

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel("Solverino");
  context.subscriptions.push(outputChannel);

  let controller: Controller;
  try {
    controller = new Controller(context);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    outputChannel.appendLine(`[error] ${message}`);
    void vscode.window.showErrorMessage(`Solverino: ${message}`);
    return;
  }
  context.subscriptions.push(controller);
  controller.activate();

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider(
      "solverino.overview",
      controller.overviewProvider
    )
  );
}

export function deactivate(): void {
  // Controller.dispose (via context.subscriptions) stops all running and
  // queued agent processes on extension deactivation.
}
