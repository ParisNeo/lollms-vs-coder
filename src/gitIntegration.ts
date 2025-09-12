import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import { LollmsAPI, ChatMessage } from './lollmsAPI';

const execAsync = promisify(exec);
const MAX_DIFF_LENGTH = 8000; // Set a reasonable character limit for the diff

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

  private async _getDiff(args: string): Promise<string> {
    const workspaceRoot = vscode.workspace.rootPath;
    if (!workspaceRoot) return '';
    try {
      const { stdout } = await execAsync(`git diff ${args}`, { cwd: workspaceRoot });
      return stdout || '';
    } catch (error) {
      // Errors are expected if there are no changes, so we can often ignore them.
      return '';
    }
  }
  
  public async generateCommitMessage(): Promise<string> {
    let diff = await this._getDiff('--cached'); // Staged changes
    let diffSource = "staged";
    
    if (!diff) {
      diff = await this._getDiff(''); // Unstaged changes
      diffSource = "unstaged";
    }

    if (!diff) {
      vscode.window.showInformationMessage('No staged or unstaged changes detected.');
      return '';
    }

    let promptContent: string;

    if (diff.length > MAX_DIFF_LENGTH) {
      const fileNames = (await this._getDiff(`${diff === await this._getDiff('--cached') ? '--cached' : ''} --name-only`)).trim().split('\n');
      let summary = `Generate a concise git commit message based on the following changes. The full diff is too large, so here is a summary:\n\n**Changed Files:**\n- ${fileNames.join('\n- ')}\n\n`;
      
      // Add snippets from the first few files
      summary += "**Change Snippets:**\n";
      for (const file of fileNames.slice(0, 5)) { // Limit to 5 snippets for brevity
          const fileDiff = await this._getDiff(`${diff === await this._getDiff('--cached') ? '--cached' : ''} -- "${file}"`);
          summary += `--- Diff for ${file} ---\n\`\`\`diff\n${fileDiff.substring(0, 300)}...\n\`\`\`\n`;
      }
      promptContent = summary;
    } else {
      promptContent = `Generate a concise git commit message based on the following diff of ${diffSource} changes:\n\`\`\`diff\n${diff}\n\`\`\``;
    }

    const prompt: ChatMessage[] =  [
      { role: 'system', content: 'You are an AI assistant that writes concise, clear, and conventional git commit messages based on git diffs. Your response should be only the commit message itself, without any conversational text or markdown formatting.' },
      { role: 'user', content: promptContent }
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