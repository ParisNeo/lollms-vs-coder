import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import { LollmsAPI, ChatMessage } from './lollmsAPI';
import { getProcessedSystemPrompt, stripThinkingTags } from './utils';

const execAsync = promisify(exec);
const MAX_DIFF_LENGTH = 8000; // Set a reasonable character limit for the diff
const MAX_BUFFER_SIZE = 20 * 1024 * 1024; // 20MB buffer for git operations

export interface GitCommit {
    hash: string;
    message: string;
    author: string;
    date: string;
}

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
      const { stdout } = await execAsync(`git diff ${args}`, { 
        cwd: folder.uri.fsPath,
        maxBuffer: MAX_BUFFER_SIZE
      });
      return stdout || '';
    } catch (error: any) {
      console.error(`Git diff error for args '${args}':`, error);
      // Fallback for maxBuffer error
      if (error.message && error.message.includes('maxBuffer')) {
          try {
              // Try getting just list of files if diff is too big
              const { stdout } = await execAsync(`git diff ${args} --name-only`, { cwd: folder.uri.fsPath });
              return `Diff too large to display. Modified files:\n${stdout}`;
          } catch(e) {
              return '';
          }
      }
      return '';
    }
  }

  private async _getUntrackedFiles(folder: vscode.WorkspaceFolder): Promise<string[]> {
    if (!folder) return [];
    try {
        const { stdout } = await execAsync('git ls-files --others --exclude-standard', { cwd: folder.uri.fsPath });
        return stdout.split('\n').filter(line => line.trim().length > 0);
    } catch (e) {
        return [];
    }
  }

  private parseCommitMessage(rawResponse: string): string {
    const stripped = stripThinkingTags(rawResponse).trim();

    // 1. Try to extract from code block (Preferred)
    // Relaxed regex: matches ``` ... ``` with any leading/trailing whitespace inside, allows language:path syntax
    const codeBlockMatch = stripped.match(/```(?:[^\n]*)\s+([\s\S]+?)\s*```/);
    if (codeBlockMatch && codeBlockMatch[1]) {
        return codeBlockMatch[1].trim();
    }

    // 2. Fallback: Heuristic extraction
    let lines = stripped.split('\n').map(l => l.trim());
    
    // Filter out known conversational lines at the start AND markdown fences
    // Added "here's" and "```" to the regex
    const conversationalStartRegex = /^(here is|here's|sure|certainly|i have|generated|commit message|below is|please find|output:|```)/i;
    
    // Conventional commit usually starts with "feat:", "fix:", etc.
    const conventionalRegex = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([\w-]+\))?:/i;

    let startIndex = -1;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        
        // If we see a conventional commit start, we trust it immediately
        if (conventionalRegex.test(line)) {
            startIndex = i;
            break;
        }
        
        // If it's not conversational (and not a code fence), mark as candidate start
        if (!conversationalStartRegex.test(line)) {
            if (startIndex === -1) startIndex = i;
        }
    }

    if (startIndex !== -1) {
        let content = lines.slice(startIndex).join('\n').trim();
        // Remove trailing ``` if present (in case the start fence was filtered but end remains)
        content = content.replace(/```$/, '').trim();
        return content.replace(/^['"]|['"]$/g, '');
    }

    // If all else fails, return stripped text but clean quotes and all fences
    return stripped.replace(/```/g, '').replace(/^['"]|['"]$/g, '').trim();
  }
  
  public async generateCommitMessage(folder: vscode.WorkspaceFolder): Promise<string> {
    let diff = await this._getDiff('--cached', folder); // Staged changes
    let diffSource = "staged";
    
    if (!diff || diff.trim().length === 0) {
      diff = await this._getDiff('', folder); // Unstaged changes
      diffSource = "unstaged";
    }

    // If still no diff, check for untracked files
    if (!diff || diff.trim().length === 0) {
        const untracked = await this._getUntrackedFiles(folder);
        if (untracked.length > 0) {
            diffSource = "untracked";
            diff = `Untracked files (newly created):\n${untracked.join('\n')}\n\n`;
            
            // Attempt to read content of small untracked files to give context
            let fileContentContext = "";
            for (const file of untracked.slice(0, 5)) { // Limit to 5 files
                try {
                    const fileUri = vscode.Uri.joinPath(folder.uri, file);
                    const stat = await vscode.workspace.fs.stat(fileUri);
                    if (stat.size < 5000) { // Read only if small (<5KB)
                        const content = await vscode.workspace.fs.readFile(fileUri);
                        fileContentContext += `\n--- Content of ${file} ---\n${Buffer.from(content).toString('utf8')}\n`;
                    }
                } catch(e) {
                    // Ignore read errors
                }
            }
            if (fileContentContext) {
                diff += fileContentContext;
            }
        }
    }

    if (!diff || diff.trim().length === 0) {
      vscode.window.showInformationMessage('No staged, unstaged, or untracked changes detected.');
      return '';
    }

    let userPromptContent: string;

    if (diff.length > MAX_DIFF_LENGTH && !diff.startsWith("Diff too large")) {
        const diffArgs = diffSource === 'staged' ? '--cached' : '';
        
        if (diffSource === 'untracked') {
             userPromptContent = `Generate a commit message for the creation of the following untracked files:\n\n${diff.substring(0, MAX_DIFF_LENGTH)}...`;
        } else {
            // Standard big diff logic
            const fileNames = (await this._getDiff(`${diffArgs} --name-only`, folder)).trim().split('\n');
            let summary = `The following files were changed:\n- ${fileNames.join('\n- ')}\n\n`;
        
            summary += "**Here are snippets of the changes:**\n";
            for (const file of fileNames.slice(0, 5)) { 
                const fileDiff = await this._getDiff(`${diffArgs} -- "${file}"`, folder);
                summary += `--- Diff for ${file} ---\n\`\`\`diff\n${fileDiff.substring(0, 300)}...\n\`\`\`\n`;
            }
            userPromptContent = `Generate a commit message for the following summarized changes:\n\n${summary}`;
        }
    } else {
      if (diffSource === 'untracked') {
          userPromptContent = `Generate a commit message for the following new (untracked) files:\n\n${diff}`;
      } else {
          userPromptContent = `Generate a commit message for the following diff of ${diffSource} changes:\n\`\`\`diff\n${diff}\n\`\`\``;
      }
    }

    const systemPromptContent = await getProcessedSystemPrompt('commit');

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

      const cleanMessage = this.parseCommitMessage(rawMessage);

      if (!cleanMessage) {
        vscode.window.showWarningMessage('Lollms returned an empty commit message.');
        return '';
      }
      
      const config = vscode.workspace.getConfiguration('lollmsVsCoder');
      const autoUpdateChangelog = config.get<boolean>('autoUpdateChangelog');

      if (autoUpdateChangelog && cleanMessage) {
          await this.updateChangelog(folder, cleanMessage);
      }

      return cleanMessage;
      
    } catch (error) {
      vscode.window.showErrorMessage('Error generating commit message: ' + (error as Error).message);
      return '';
    }
  }

  private async updateChangelog(folder: vscode.WorkspaceFolder, commitMessage: string) {
      const changelogPath = vscode.Uri.joinPath(folder.uri, 'CHANGELOG.md');
      try {
          // Check if file exists
          await vscode.workspace.fs.stat(changelogPath);
          
          const document = await vscode.workspace.openTextDocument(changelogPath);
          const text = document.getText();
          
          // Fix: Correctly extract the first line (subject)
          const lines = commitMessage.split('\n');
          const subject = lines.length > 0 ? lines[0].trim() : commitMessage.trim();
          
          const newEntry = `- ${subject}`;

          // Heuristic: Try to find "## [Unreleased]" section
          const unreleasedRegex = /^##\s+\[Unreleased\]/m;
          const match = unreleasedRegex.exec(text);
          
          const edit = new vscode.WorkspaceEdit();

          if (match) {
              // Insert after the header
              const pos = document.positionAt(match.index + match.length);
              edit.insert(changelogPath, pos, `\n${newEntry}`);
          } else {
              // Fallback to Date/Time if Unreleased not found
              const now = new Date();
              const dateTimeStr = now.toISOString().replace('T', ' ').substring(0, 16); // YYYY-MM-DD HH:mm
              const headerTitle = `## [${dateTimeStr}]`;

              // Try to find the first heading level 2 (e.g. ## [1.0.0])
              const firstVersionHeader = /^##\s+/m.exec(text);
              if (firstVersionHeader) {
                  // Insert before the first version header
                  const pos = document.positionAt(firstVersionHeader.index);
                  edit.insert(changelogPath, pos, `${headerTitle}\n\n${newEntry}\n\n`);
              } else {
                  // No structure found, just append to top after title if exists, or very top
                  const titleMatch = /^#\s+/m.exec(text);
                  if (titleMatch) {
                      const pos = document.positionAt(titleMatch.index + titleMatch.length + text.split('\n')[document.positionAt(titleMatch.index).line].length);
                      edit.insert(changelogPath, pos, `\n\n${headerTitle}\n\n${newEntry}`);
                  } else {
                      // Insert at the very beginning
                      edit.insert(changelogPath, new vscode.Position(0, 0), `# Changelog\n\n${headerTitle}\n\n${newEntry}\n\n`);
                  }
              }
          }

          await vscode.workspace.applyEdit(edit);
          await document.save();
          vscode.window.showInformationMessage('CHANGELOG.md updated with new entry.');

      } catch (error) {
          // File likely doesn't exist or other error, silently ignore or log
          console.log('Skipping CHANGELOG update: file not found or error.', error);
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

  public async stageAllAndCommit(message: string, folder: vscode.WorkspaceFolder): Promise<void> {
    if (!folder) return;
    try {
      await execAsync('git add .', { cwd: folder.uri.fsPath });
      await execAsync(`git commit -m "${message.replace(/"/g, '\\"')}"`, { cwd: folder.uri.fsPath });
      vscode.window.showInformationMessage('Staged and committed changes.');
    } catch (error) {
      // Check if "nothing to commit"
      if ((error as any).stdout && (error as any).stdout.includes('nothing to commit')) {
          vscode.window.showInformationMessage('Nothing to commit.');
          return;
      }
      vscode.window.showErrorMessage('Git commit failed: ' + (error as Error).message);
    }
  }

  public async getCommitHistory(folder: vscode.WorkspaceFolder, count: number = 50): Promise<GitCommit[]> {
    if (!folder) return [];
    try {
        const { stdout } = await execAsync(
            `git log --pretty=format:"%H|%s|%an|%ad" --date=short -n ${count}`, 
            { cwd: folder.uri.fsPath }
        );
        
        return stdout.split('\n').filter(line => line.trim()).map(line => {
            const [hash, message, author, date] = line.split('|');
            return { hash, message, author, date };
        });
    } catch (error) {
        console.error("Failed to fetch commit history:", error);
        return [];
    }
  }

  public async getCommitDiff(folder: vscode.WorkspaceFolder, commitHash: string): Promise<string> {
      if (!folder || !commitHash) return '';
      try {
          const { stdout } = await execAsync(`git show ${commitHash}`, { 
              cwd: folder.uri.fsPath,
              maxBuffer: MAX_BUFFER_SIZE
          });
          return stdout;
      } catch (error) {
          console.error(`Failed to fetch diff for commit ${commitHash}:`, error);
          throw error;
      }
  }
}
