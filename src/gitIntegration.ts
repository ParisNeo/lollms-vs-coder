import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import { LollmsAPI, ChatMessage } from './lollmsAPI';

const execAsync = promisify(exec);

export class GitIntegration {
  private lollmsAPI: LollmsAPI;

  constructor(lollmsAPI: LollmsAPI) {
    this.lollmsAPI = lollmsAPI;
  }

  public async isGitRepo(): Promise<boolean> {
    const workspaceRoot = vscode.workspace.rootPath;
    if (!workspaceRoot) return false;
    try {
      await execAsync('git rev-parse --is-inside-work-tree', { cwd: workspaceRoot });
      return true;
    } catch {
      return false;
    }
  }

  public async getGitStagedDiff(): Promise<string> {
    const workspaceRoot = vscode.workspace.rootPath;
    if (!workspaceRoot) return '';
    try {
      const { stdout } = await execAsync('git diff --cached', { cwd: workspaceRoot });
      return stdout || '';
    } catch (error) {
      vscode.window.showErrorMessage('Failed to get staged git diff.');
      return '';
    }
  }

  public async generateCommitMessage(): Promise<string> {
    const diff = await this.getGitStagedDiff();
    if (!diff) {
      vscode.window.showInformationMessage('No staged changes detected.');
      return '';
    }

    const prompt: ChatMessage[] =  [
      { role: 'system', content: 'You are an AI assistant that writes concise, clear, and conventional git commit messages based on git diffs.' },
      { role: 'user', content: `Generate a concise git commit message based on the following diff:\n${diff}` }
    ];

    try {
      const message = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Lollms: Generating commit message...",
        cancellable: false
      }, async () => {
        return await this.lollmsAPI.sendChat(prompt);
      });
      return message.trim();
    } catch (error) {
      vscode.window.showErrorMessage('Error generating commit message: ' + (error as Error).message);
      return '';
    }
  }

  public async commitWithMessage(message: string): Promise<void> {
    const workspaceRoot = vscode.workspace.rootPath;
    if (!workspaceRoot) return;
    try {
      await execAsync(`git commit -m "${message.replace(/"/g, '\\"')}"`, { cwd: workspaceRoot });
      vscode.window.showInformationMessage('Committed changes with AI-generated message.');
    } catch (error) {
      vscode.window.showErrorMessage('Git commit failed: ' + (error as Error).message);
    }
  }
}