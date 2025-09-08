import * as vscode from 'vscode';

export class ContextManager {
  private _contextFiles: Set<string> = new Set();
  private readonly _storageKey = 'lollmsContextFiles';

  constructor(private readonly context: vscode.ExtensionContext) {
    // Load saved context files from workspace state
    const saved = this.context.workspaceState.get<string[]>(this._storageKey, []);
    saved.forEach(file => this._contextFiles.add(file));
  }

  public getContextFiles(): string[] {
    return Array.from(this._contextFiles);
  }

  public isInContext(uri: vscode.Uri): boolean {
    return this._contextFiles.has(uri.fsPath);
  }

  public async addFileToContext(uri: vscode.Uri) {
    if (!this._contextFiles.has(uri.fsPath)) {
      this._contextFiles.add(uri.fsPath);
      await this.saveContextFiles();
      vscode.window.showInformationMessage(`Added ${uri.fsPath} to AI context.`);
    } else {
      vscode.window.showInformationMessage(`File ${uri.fsPath} is already in AI context.`);
    }
  }

  public async removeFileFromContext(uri: vscode.Uri) {
    if (this._contextFiles.delete(uri.fsPath)) {
      await this.saveContextFiles();
      vscode.window.showInformationMessage(`Removed ${uri.fsPath} from AI context.`);
    } else {
      vscode.window.showInformationMessage(`File ${uri.fsPath} was not in AI context.`);
    }
  }

  private async saveContextFiles() {
    await this.context.workspaceState.update(this._storageKey, this.getContextFiles());
  }
}
