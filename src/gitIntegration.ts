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

    let userPromptContent: string;

    if (diff.length > MAX_DIFF_LENGTH) {
        const diffArgs = diffSource === 'staged' ? '--cached' : '';
        const fileNames = (await this._getDiff(`${diffArgs} --name-only`)).trim().split('\n');
        let summary = `The following files were changed:\n- ${fileNames.join('\n- ')}\n\n`;
      
        summary += "**Here are snippets of the changes:**\n";
        for (const file of fileNames.slice(0, 5)) { // Limit to 5 snippets for brevity
            const fileDiff = await this._getDiff(`${diffArgs} -- "${file}"`);
            summary += `--- Diff for ${file} ---\n\`\`\`diff\n${fileDiff.substring(0, 300)}...\n\`\`\`\n`;
        }
        userPromptContent = `Generate a commit message for the following summarized changes:\n\n${summary}`;
    } else {
      userPromptContent = `Generate a commit message for the following diff of ${diffSource} changes:\n\`\`\`diff\n${diff}\n\`\`\``;
    }

    const chatPersonaPrompt = getProcessedSystemPrompt('chat');
    const systemPromptContent = `You are an expert AI assistant that writes conventional git commit messages.

**CRITICAL INSTRUCTIONS:**
1.  **COMMIT MESSAGE ONLY:** Your entire response MUST be the commit message text.
2.  **NO EXTRA TEXT:** Do not add any conversational text, explanations, apologies, or markdown formatting like \`\`\`.
3.  **CONVENTIONAL FORMAT:** Follow the conventional commit format: \`<type>(<scope>): <subject>\`.
    -   \`<type>\` can be: \`feat\`, \`fix\`, \`docs\`, \`style\`, \`refactor\`, \`test\`, \`chore\`, \`perf\`.
    -   \`<scope>\` is optional and describes the part of the codebase affected.
    -   \`<subject>\` is a short, imperative-tense description of the change.
4.  **SINGLE LINE:** Prioritize a concise single-line message. You can add a blank line followed by a more detailed body ONLY if necessary.

**FORBIDDEN ACTIONS:**
-   **DO NOT** write any code.
-   **DO NOT** explain the changes in conversational text.
-   **DO NOT** use markdown.
-   **DO NOT** add prefixes like "Commit message:".

Based on the provided git diff, generate the commit message.

User preferences: ${chatPersonaPrompt}`;

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