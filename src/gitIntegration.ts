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

  // Returns true if current workspace has a git repository
  public async isGitRepo(): Promise<boolean> {
    try {
      await execAsync('git rev-parse --is-inside-work-tree', { cwd: vscode.workspace.rootPath });
      return true;
    } catch {
      return false;
    }
  }

  // Get staged git diff for commit message
  public async getGitStagedDiff(): Promise<string> {
    try {
      const { stdout } = await execAsync('git diff --cached', { cwd: vscode.workspace.rootPath });
      return stdout || '';
    } catch (error) {
      vscode.window.showErrorMessage('Failed to get staged git diff.');
      return '';
    }
  }

  // Generate AI commit message based on staged diff
  public async generateCommitMessage(): Promise<string> {
    const diff = await this.getGitStagedDiff();
    if (!diff) {
      return 'No staged changes detected.';
    }

    const prompt: ChatMessage[] =  [
      { role: 'system', content: 'You are an AI assistant that writes concise, clear, and conventional git commit messages based on git diffs.' },
      { role: 'user', content: `Generate a concise git commit message based on the following diff:\n${diff}` }
    ];

    try {
      const message = await this.lollmsAPI.sendChat(prompt);
      return message.trim();
    } catch (error) {
      vscode.window.showErrorMessage('Error generating commit message: ' + (error as Error).message);
      return '';
    }
  }

  // Commit changes with the generated message
  public async commitWithMessage(message: string): Promise<void> {
    try {
      await execAsync(`git commit -m "${message.replace(/"/g, '\\"')}"`, { cwd: vscode.workspace.rootPath });
      vscode.window.showInformationMessage('Committed changes with AI-generated message.');
    } catch (error) {
      vscode.window.showErrorMessage('Git commit failed: ' + (error as Error).message);
    }
  }
}
