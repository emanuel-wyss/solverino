import * as vscode from "vscode";
import { Controller } from "./controller";

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel("Swarmforge");
  context.subscriptions.push(outputChannel);

  let controller: Controller;
  try {
    controller = new Controller(context);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    outputChannel.appendLine(`[error] ${message}`);
    void vscode.window.showErrorMessage(`Swarmforge: ${message}`);
    return;
  }
  controller.activate();

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider(
      "swarmforge.overview",
      controller.overviewProvider
    )
  );
}

export function deactivate(): void {
  // Agent processes are killed when their parent VS Code exits;
  // nothing else to clean up.
}
