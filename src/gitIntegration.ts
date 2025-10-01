import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import { LollmsAPI, ChatMessage } from './lollmsAPI';
import { getProcessedSystemPrompt, stripThinkingTags } from './utils';

const execAsync = promisify(exec);
const MAX_DIFF_LENGTH = 8000; // Set a reasonable character limit for the diff

export class GitIntegration {
  private lollmsAPI: LollmsAPI;

  constructor(lollmsAPI: LollmsAPI) {
    this.lollmsAPI = lollmsAPI;
  }

  public async isGitRepo(folder: vscode.WorkspaceFolder): Promise<boolean> {
    if (!folder) return false;
    try {
      await execAsync('git rev-parse --is-inside-work-tree', { cwd: folder.uri.fsPath });
      return true;
    } catch {
      return false;
    }
  }

  private async _getDiff(args: string, folder: vscode.WorkspaceFolder): Promise<string> {
    if (!folder) return '';
    try {
      const { stdout } = await execAsync(`git diff ${args}`, { cwd: folder.uri.fsPath });
      return stdout || '';
    } catch (error) {
      // Errors are expected if there are no changes, so we can often ignore them.
      return '';
    }
  }
  
  public async generateCommitMessage(folder: vscode.WorkspaceFolder): Promise<string> {
    let diff = await this._getDiff('--cached', folder); // Staged changes
    let diffSource = "staged";
    
    if (!diff) {
      diff = await this._getDiff('', folder); // Unstaged changes
      diffSource = "unstaged";
    }

    if (!diff) {
      vscode.window.showInformationMessage('No staged or unstaged changes detected.');
      return '';
    }

    let userPromptContent: string;

    if (diff.length > MAX_DIFF_LENGTH) {
        const diffArgs = diffSource === 'staged' ? '--cached' : '';
        const fileNames = (await this._getDiff(`${diffArgs} --name-only`, folder)).trim().split('\n');
        let summary = `The following files were changed:\n- ${fileNames.join('\n- ')}\n\n`;
      
        summary += "**Here are snippets of the changes:**\n";
        for (const file of fileNames.slice(0, 5)) { // Limit to 5 snippets for brevity
            const fileDiff = await this._getDiff(`${diffArgs} -- "${file}"`, folder);
            summary += `--- Diff for ${file} ---\n\`\`\`diff\n${fileDiff.substring(0, 300)}...\n\`\`\`\n`;
        }
        userPromptContent = `Generate a commit message for the following summarized changes:\n\n${summary}`;
    } else {
      userPromptContent = `Generate a commit message for the following diff of ${diffSource} changes:\n\`\`\`diff\n${diff}\n\`\`\``;
    }

    const systemPromptContent = getProcessedSystemPrompt('commit');

    const prompt: ChatMessage[] =  [
      { role: 'system', content: systemPromptContent },
      { role: 'user', content: userPromptContent }
    ];

    try {
      const rawMessage = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Lollms: Generating commit message...",
        cancellable: false
      }, async () => {
        return await this.lollmsAPI.sendChat(prompt);
      });

      const cleanMessage = stripThinkingTags(rawMessage);
      return cleanMessage.trim();
      
    } catch (error) {
      vscode.window.showErrorMessage('Error generating commit message: ' + (error as Error).message);
      return '';
    }
  }

  public async commitWithMessage(message: string, folder: vscode.WorkspaceFolder): Promise<void> {
    if (!folder) return;
    try {
      await execAsync(`git commit -m "${message.replace(/"/g, '\\"')}"`, { cwd: folder.uri.fsPath });
      vscode.window.showInformationMessage('Committed changes with AI-generated message.');
    } catch (error) {
      vscode.window.showErrorMessage('Git commit failed: ' + (error as Error).message);
    }
  }
}