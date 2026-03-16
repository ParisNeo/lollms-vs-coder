import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
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

export interface GitSearchOptions {
    message?: string;
    author?: string;
    file?: string;
    diffFilter?: string; // A, D, M, etc.
    content?: string;    // -S (pickaxe)
    count?: number;
}

export class GitIntegration {
  private lollmsAPI: LollmsAPI;

  constructor(lollmsAPI: LollmsAPI) {
    this.lollmsAPI = lollmsAPI;
  }

  public async isGitRepo(folder: vscode.WorkspaceFolder): Promise<boolean> {
    if (!folder) return false;
    try {
      await execAsync('git --no-pager rev-parse --is-inside-work-tree', { cwd: folder.uri.fsPath, timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  public async getCurrentBranch(folder: vscode.WorkspaceFolder): Promise<string> {
      try {
          const { stdout } = await execAsync('git --no-pager branch --show-current', { cwd: folder.uri.fsPath, timeout: 10000 });
          return stdout.trim();
      } catch (e) {
          return '';
      }
  }

  public async getCurrentHash(folder: vscode.WorkspaceFolder): Promise<string> {
    try {
        const { stdout } = await execAsync('git --no-pager rev-parse HEAD', { cwd: folder.uri.fsPath, timeout: 10000 });
        return stdout.trim();
    } catch (e) {
        return '';
    }
  }

  public async getBranches(folder: vscode.WorkspaceFolder): Promise<string[]> {
      try {
          const { stdout } = await execAsync('git --no-pager branch --format="%(refname:short)"', { cwd: folder.uri.fsPath, timeout: 15000 });
          return stdout.split('\n').map(b => b.trim()).filter(b => b.length > 0);
      } catch {
          return[];
      }
  }
  
  public async hasUnstagedChanges(folder: vscode.WorkspaceFolder): Promise<boolean> {
      try {
          const { stdout } = await execAsync('git --no-pager status --porcelain', { cwd: folder.uri.fsPath, timeout: 10000 });
          return stdout.trim().length > 0;
      } catch (e) {
          return false;
      }
  }

  public async getStagedFiles(folder: vscode.WorkspaceFolder): Promise<string[]> {
      try {
          const { stdout } = await execAsync('git --no-pager diff --name-only --cached', { cwd: folder.uri.fsPath, timeout: 15000 });
          return stdout.split('\n').filter(l => l.trim().length > 0);
      } catch { return[]; }
  }

  public async getGitStatus(folder: vscode.WorkspaceFolder): Promise<{ staged: string[], unstaged: string[], untracked: string[] }> {
      if (!folder) return { staged: [], unstaged: [], untracked: [] };
      const staged = await this.getStagedFiles(folder);
      let unstaged: string[] = [];
      try {
          // Added 5s timeout to prevent dashboard freeze
          const { stdout } = await execAsync('git --no-pager diff --name-only', { cwd: folder.uri.fsPath, timeout: 5000 });
          unstaged = stdout.split('\n').filter(l => l.trim().length > 0);
      } catch {}
      let untracked: string[] = [];
      try {
          const { stdout } = await execAsync('git --no-pager ls-files --others --exclude-standard', { cwd: folder.uri.fsPath, timeout: 5000 });
          untracked = stdout.split('\n').filter(l => l.trim().length > 0);
      } catch {}
      return { staged, unstaged, untracked };
  }

  public async stageFile(folder: vscode.WorkspaceFolder, path: string) {
      await execAsync(`git add "${path}"`, { cwd: folder.uri.fsPath });
  }

  public async unstageFile(folder: vscode.WorkspaceFolder, path: string) {
      await execAsync(`git restore --staged "${path}"`, { cwd: folder.uri.fsPath });
  }

  public async discardChanges(folder: vscode.WorkspaceFolder, path: string) {
      await execAsync(`git restore "${path}"`, { cwd: folder.uri.fsPath });
  }

  public async getStashList(folder: vscode.WorkspaceFolder): Promise<string[]> {
      try {
          const { stdout } = await execAsync('git --no-pager stash list', { cwd: folder.uri.fsPath, timeout: 15000 });
          return stdout.split('\n').filter(l => l.trim().length > 0);
      } catch { return[]; }
  }

  public async applyStash(folder: vscode.WorkspaceFolder, index: number) {
      await execAsync(`git stash apply ${index}`, { cwd: folder.uri.fsPath });
  }

  public async dropStash(folder: vscode.WorkspaceFolder, index: number) {
      await execAsync(`git stash drop ${index}`, { cwd: folder.uri.fsPath });
  }

  public async stageFiles(folder: vscode.WorkspaceFolder, files: string[]): Promise<void> {
      if (!folder) return;
      
      try {
          await execAsync('git reset', { cwd: folder.uri.fsPath });
      } catch (e) { 
          console.error("Git reset failed:", e);
      }

      if (files.length === 0) return;

      const chunkSize = 20;
      for (let i = 0; i < files.length; i += chunkSize) {
          const chunk = files.slice(i, i + chunkSize);
          const fileArgs = chunk.map(f => `"${f}"`).join(' ');
          await execAsync(`git add ${fileArgs}`, { cwd: folder.uri.fsPath });
      }
  }
  
  public async getUnstagedFiles(folder: vscode.WorkspaceFolder): Promise<string[]> {
      try {
          const { stdout: modified } = await execAsync('git --no-pager diff --name-only', { cwd: folder.uri.fsPath, timeout: 15000 });
          const { stdout: untracked } = await execAsync('git --no-pager ls-files --others --exclude-standard', { cwd: folder.uri.fsPath, timeout: 15000 });
          
          const files = new Set([
              ...modified.split('\n').filter(l => l.trim().length > 0),
              ...untracked.split('\n').filter(l => l.trim().length > 0)
          ]);
          return Array.from(files).sort();
      } catch { return []; }
  }

  public async stash(folder: vscode.WorkspaceFolder, message?: string): Promise<void> {
      const msgArg = message ? ` push -m "${message}"` : '';
      await execAsync(`git stash${msgArg}`, { cwd: folder.uri.fsPath });
  }

  public async stashPop(folder: vscode.WorkspaceFolder): Promise<void> {
      await execAsync(`git stash pop`, { cwd: folder.uri.fsPath });
  }

  public async createAndCheckoutBranch(folder: vscode.WorkspaceFolder, branchName: string, startPoint?: string): Promise<void> {
      try {
          // Quote the branch name to handle spaces or special characters safely
          const safeBranchName = `"${branchName}"`;
          const start = startPoint ? ` "${startPoint}"` : '';
          try {
              await execAsync(`git --no-pager rev-parse --verify ${safeBranchName}`, { cwd: folder.uri.fsPath, timeout: 10000 });
              await execAsync(`git checkout ${safeBranchName}`, { cwd: folder.uri.fsPath });
          } catch {
              await execAsync(`git checkout -b ${safeBranchName}${start}`, { cwd: folder.uri.fsPath });
          }
      } catch (e: any) {
          throw new Error(`Failed to create/checkout branch: ${e.message}`);
      }
  }

public async checkout(folder: vscode.WorkspaceFolder, ref: string): Promise<void> {
    if (!folder) return;

    try {
        const safeRef = `"${ref.replace(/"/g, '\\"')}"`;

        try {
            await execAsync(`git checkout ${safeRef}`, { cwd: folder.uri.fsPath });
        } catch {
            await execAsync(`git fetch`, { cwd: folder.uri.fsPath, timeout: 30000 });
            await execAsync(`git checkout ${safeRef}`, { cwd: folder.uri.fsPath });
        }

    } catch (e: any) {
        throw new Error(`Checkout failed: ${e.message}`);
    }
}

  public async detachSubmodule(folder: vscode.WorkspaceFolder, subPath: string): Promise<void> {
      if (!folder) return;
      const fullPath = path.join(folder.uri.fsPath, subPath);
      const tempPath = path.join(folder.uri.fsPath, `${subPath}_temp`);

      try {
          // 1. Move the current submodule contents to a temp folder outside Git's tracking
          await fs.promises.rename(fullPath, tempPath);
          
          // 2. Remove the submodule from Git index and configuration
          await execAsync(`git rm -f "${subPath}"`, { cwd: folder.uri.fsPath });
          
          // 3. Remove .git/modules entries (The internal git link)
          const gitModulesDir = path.join(folder.uri.fsPath, '.git', 'modules', subPath);
          try { await fs.promises.rm(gitModulesDir, { recursive: true, force: true }); } catch {}

          // 4. Move content back into the repo as plain files
          await fs.promises.rename(tempPath, fullPath);

          // 5. Explicitly remove the .git file that was inside the submodule folder
          const subGitFile = path.join(fullPath, '.git');
          try { await fs.promises.unlink(subGitFile); } catch {}
          
          vscode.window.showInformationMessage(`Successfully detached ${subPath}. It is now part of your main repository.`);
      } catch (e: any) {
          throw new Error(`Detachment failed: ${e.message}`);
      }
  }

  public async mergeBranch(folder: vscode.WorkspaceFolder, sourceBranch: string): Promise<string> {
      try {
          const currentBranch = await this.getCurrentBranch(folder);
          if (currentBranch === sourceBranch) {
              throw new Error(`Cannot merge branch into itself (You are already on \${currentBranch}).`);
          }

          // Ensure we have the latest info from the source before merging
          await execAsync(`git fetch origin`, { cwd: folder.uri.fsPath, timeout: 30000 }).catch(() => {}); 
          
          const { stdout } = await execAsync(`git merge "\${sourceBranch}"`, { cwd: folder.uri.fsPath });
          
          // Force VS Code to refresh its internal git state
          await vscode.commands.executeCommand('git.refresh');
          
          return stdout;
      } catch (e: any) {
          if (e.stdout && e.stdout.includes("CONFLICT")) {
              throw new Error(`Merge Conflict: Please resolve manually in the editor.`);
          }
          throw new Error(`Merge failed: \${e.message}`);
      }
  }

  public async deleteBranch(folder: vscode.WorkspaceFolder, branchName: string): Promise<void> {
      try {
          await execAsync(`git branch -d "${branchName}"`, { cwd: folder.uri.fsPath });
      } catch (e: any) {
          try {
            await execAsync(`git branch -D "${branchName}"`, { cwd: folder.uri.fsPath });
          } catch (e2) {
            console.error("Failed to delete temp branch", e2);
          }
      }
  }

  public async getSubmodules(folder: vscode.WorkspaceFolder): Promise<{path: string, hash: string}[]> {
      if (!folder) return[];
      try {
          const { stdout } = await execAsync('git --no-pager submodule status', { cwd: folder.uri.fsPath, timeout: 15000 });
          return stdout.split('\n')
              .filter(line => line.trim().length > 0)
              .map(line => {
                  const parts = line.trim().split(/\s+/);
                  // Git submodule status prefixes hashes with -, +, or U if out of sync/uninitialized
                  const hash = parts[0].replace(/^[+-U]/, ''); 
                  const path = parts[1];
                  return { hash, path };
              });
      } catch (e) {
          return[];
      }
  }

  public async addSubmodule(folder: vscode.WorkspaceFolder, url: string, path: string): Promise<void> {
      if (!folder) return;
      try {
          await execAsync(`git submodule add "${url}" "${path}"`, { cwd: folder.uri.fsPath });
      } catch (e: any) {
          throw new Error(`Failed to add submodule: ${e.message}`);
      }
  }

  public async removeSubmodule(folder: vscode.WorkspaceFolder, path: string): Promise<void> {
      if (!folder) return;
      try {
          await execAsync(`git rm "${path}"`, { cwd: folder.uri.fsPath });
      } catch (e: any) {
          throw new Error(`Failed to remove submodule: ${e.message}`);
      }
  }

  public async updateSubmodules(folder: vscode.WorkspaceFolder): Promise<void> {
      try {
          await execAsync('git submodule update --init --recursive', { cwd: folder.uri.fsPath, timeout: 60000 });
      } catch (e: any) {
          throw new Error(`Failed to update submodules: ${e.message}`);
      }
  }

  public async checkoutPrevious(folder: vscode.WorkspaceFolder): Promise<void> {
      if (!folder) return;
      try {
          // 'git checkout -' switches to the previously checked out branch/commit
          await execAsync(`git checkout -`, { cwd: folder.uri.fsPath });
      } catch (e: any) {
          throw new Error(`Failed to checkout previous branch: ${e.message}`);
      }
  }

  public async getCompareDiff(folder: vscode.WorkspaceFolder, hash1: string, hash2: string): Promise<string> {
      if (!folder) return "";
      try {
          // Use _getDiff to benefit from maxBuffer and fallback handling for huge diffs
          return await this._getDiff(`${hash1} ${hash2}`, folder);
      } catch (e: any) {
          throw new Error(`Failed to get compare diff: ${e.message}`);
      }
  }

  public async revertCommit(folder: vscode.WorkspaceFolder, hash: string): Promise<void> {
      try {
          await execAsync(`git revert --no-edit ${hash}`, { cwd: folder.uri.fsPath });
      } catch (e: any) {
          throw new Error(`Revert failed (Conflicts may need manual resolution): ${e.message}`);
      }
  }

  private async _getDiff(args: string, folder: vscode.WorkspaceFolder): Promise<string> {
    if (!folder) return '';
    try {
        // Use a shorter timeout and kill the process if it hangs to prevent extension host lockup
        const { stdout } = await execAsync(`git --no-pager diff ${args}`, { 
            cwd: folder.uri.fsPath,
            maxBuffer: MAX_BUFFER_SIZE,
            timeout: 10000,
            killSignal: 'SIGKILL'
        });
      return stdout || '';
    } catch (error: any) {
      console.error(`Git diff error for args '${args}':`, error);
      if (error.message && error.message.includes('maxBuffer')) {
          try {
              const { stdout } = await execAsync(`git --no-pager diff ${args} --name-only`, { cwd: folder.uri.fsPath, timeout: 15000 });
              return `Diff too large to display. Modified files:\n${stdout}`;
          } catch(e) {
              return '';
          }
      }
      return '';
    }
  }

  private async _getUntrackedFiles(folder: vscode.WorkspaceFolder): Promise<string[]> {
    if (!folder) return[];
    try {
        const { stdout } = await execAsync('git --no-pager ls-files --others --exclude-standard', { cwd: folder.uri.fsPath, timeout: 15000 });
        return stdout.split('\n').filter(line => line.trim().length > 0);
    } catch (e) {
        return [];
    }
  }

  private parseCommitMessage(rawResponse: string): string {
    const stripped = stripThinkingTags(rawResponse).trim();
    const codeBlockMatch = stripped.match(/```(?:[^\n]*)\s+([\s\S]+?)\s*```/);
    if (codeBlockMatch && codeBlockMatch[1]) {
        return codeBlockMatch[1].trim();
    }

    let lines = stripped.split('\n').map(l => l.trim());
    const conversationalStartRegex = /^(here is|here's|sure|certainly|i have|generated|commit message|below is|please find|output:|```)/i;
    const conventionalRegex = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([\w-]+\))?:/i;

    let startIndex = -1;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        
        if (conventionalRegex.test(line)) {
            startIndex = i;
            break;
        }
        
        if (!conversationalStartRegex.test(line)) {
            if (startIndex === -1) startIndex = i;
        }
    }

    if (startIndex !== -1) {
        let content = lines.slice(startIndex).join('\n').trim();
        content = content.replace(/```$/, '').trim();
        return content.replace(/^['"]|['"]$/g, '');
    }

    return stripped.replace(/```/g, '').replace(/^['"]|['"]$/g, '').trim();
  }
  
  public async generateCommitMessage(folder: vscode.WorkspaceFolder): Promise<string> {
    let diff = await this._getDiff('--cached', folder); 
    let diffSource = "staged";
    
    if (!diff || diff.trim().length === 0) {
      diff = await this._getDiff('', folder); 
      diffSource = "unstaged";
    }

    if (!diff || diff.trim().length === 0) {
        const untracked = await this._getUntrackedFiles(folder);
        if (untracked.length > 0) {
            diffSource = "untracked";
            diff = `Untracked files (newly created):\n${untracked.join('\n')}\n\n`;
            
            let fileContentContext = "";
            for (const file of untracked.slice(0, 5)) {
                try {
                    const fileUri = vscode.Uri.joinPath(folder.uri, file);
                    const stat = await vscode.workspace.fs.stat(fileUri);
                    if (stat.size < 5000) {
                        const content = await vscode.workspace.fs.readFile(fileUri);
                        fileContentContext += `\n--- Content of ${file} ---\n${Buffer.from(content).toString('utf8')}\n`;
                    }
                } catch(e) {}
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
        location: vscode.ProgressLocation.SourceControl,
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
          await vscode.workspace.fs.stat(changelogPath);
          const document = await vscode.workspace.openTextDocument(changelogPath);
          const text = document.getText();
          const lines = commitMessage.split('\n');
          const subject = lines.length > 0 ? lines[0].trim() : commitMessage.trim();
          const newEntry = `- ${subject}`;
          const unreleasedRegex = /^##\s+\[Unreleased\]/m;
          const match = unreleasedRegex.exec(text);
          const edit = new vscode.WorkspaceEdit();

          if (match) {
              const pos = document.positionAt(match.index + match.length);
              edit.insert(changelogPath, pos, `\n${newEntry}`);
          } else {
              const now = new Date();
              const dateTimeStr = now.toISOString().replace('T', ' ').substring(0, 16); 
              const headerTitle = `## [${dateTimeStr}]`;
              const firstVersionHeader = /^##\s+/m.exec(text);
              if (firstVersionHeader) {
                  const pos = document.positionAt(firstVersionHeader.index);
                  edit.insert(changelogPath, pos, `${headerTitle}\n\n${newEntry}\n\n`);
              } else {
                  const titleMatch = /^#\s+/m.exec(text);
                  if (titleMatch) {
                      const pos = document.positionAt(titleMatch.index + titleMatch.length + text.split('\n')[document.positionAt(titleMatch.index).line].length);
                      edit.insert(changelogPath, pos, `\n\n${headerTitle}\n\n${newEntry}`);
                  } else {
                      edit.insert(changelogPath, new vscode.Position(0, 0), `# Changelog\n\n${headerTitle}\n\n${newEntry}\n\n`);
                  }
              }
          }

          await vscode.workspace.applyEdit(edit);
          await document.save();
          vscode.window.showInformationMessage('CHANGELOG.md updated with new entry.');

      } catch (error) {
          console.log('Skipping CHANGELOG update: file not found or error.', error);
      }
  }

  public async commitWithMessage(message: string, folder: vscode.WorkspaceFolder): Promise<string> {
    if (!folder) return "";

    const staged = await this.getStagedFiles(folder);
    
    if (staged.length === 0) {
        const unstaged = await this.getUnstagedFiles(folder);
        if (unstaged.length === 0) {
            vscode.window.showInformationMessage("Nothing to commit (clean working directory).");
            return;
        }

        const items: vscode.QuickPickItem[] = unstaged.map(f => ({ label: f, picked: true, description: 'Unstaged' }));
        const selected = await vscode.window.showQuickPick(items, {
            canPickMany: true,
            placeHolder: "No staged changes. Select files to stage and commit:",
            title: "Stage Files for Commit"
        });

        if (!selected || selected.length === 0) {
            vscode.window.showInformationMessage("Commit cancelled (no files selected).");
            return;
        }

        try {
            if (selected.length === unstaged.length) {
                 await execAsync(`git add .`, { cwd: folder.uri.fsPath });
            } else {
                 const filesToStage = selected.map(i => `"${i.label}"`).join(' ');
                 await execAsync(`git add ${filesToStage}`, { cwd: folder.uri.fsPath });
            }
        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to stage files: ${e.message}`);
            return;
        }
    }

    try {
      await execAsync(`git commit -m "${message.replace(/"/g, '\\"')}"`, { cwd: folder.uri.fsPath });
      const { stdout: hash } = await execAsync(`git rev-parse HEAD`, { cwd: folder.uri.fsPath });
      const shortHash = hash.trim();
      vscode.window.showInformationMessage(`Committed successfully: ${shortHash.substring(0, 7)}`);
      return shortHash;
    } catch (error: any) {
      vscode.window.showErrorMessage('Git commit failed: ' + (error as Error).message);
      return "";
    }
  }

  public async stageAllAndCommit(message: string, folder: vscode.WorkspaceFolder): Promise<void> {
    if (!folder) return;
    try {
      await execAsync('git add .', { cwd: folder.uri.fsPath });
      await execAsync(`git commit -m "${message.replace(/"/g, '\\"')}"`, { cwd: folder.uri.fsPath });
      vscode.window.showInformationMessage('Staged and committed changes.');
    } catch (error) {
      if ((error as any).stdout && (error as any).stdout.includes('nothing to commit')) {
          vscode.window.showInformationMessage('Nothing to commit.');
          return;
      }
      vscode.window.showErrorMessage('Git commit failed: ' + (error as Error).message);
    }
  }

  /**
   * Fetches a formatted graph string showing all branches and merges.
   * Includes hash, relative date, author, and subject. Supports pagination via skip.
   */
  public async getGitGraph(folder: vscode.WorkspaceFolder, count: number = 30, skip: number = 0): Promise<string> {
    try {
        // Reduced timeout to 7 seconds. 
        // We also use --max-count to prevent git from traversing the entire history if the graph is too complex.
        const { stdout } = await execAsync(
            `git --no-pager log --graph --all --pretty=format:"%h|%ar|%an|%d|%s" --color=never -n ${count} --skip=${skip} --max-count=${count + skip}`,
            { cwd: folder.uri.fsPath, timeout: 7000 }
        );
        return stdout;
    } catch { 
        return "Timeline generation timed out. Your repository might have a very complex merge history."; 
    }
  }

  public async getCommitHistory(folder: vscode.WorkspaceFolder, count: number = 50): Promise<GitCommit[]> {
    if (!folder) return[];
    try {
        const { stdout } = await execAsync(
            `git --no-pager log --all --pretty=format:"%H|%s|%an|%ar" -n ${count}`, 
            { cwd: folder.uri.fsPath, timeout: 15000 }
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

  public async searchCommits(folder: vscode.WorkspaceFolder, options: GitSearchOptions): Promise<GitCommit[]> {
    if (!folder) return[];

    let cmd = `git --no-pager log --pretty=format:"%H|%s|%an|%ad" --date=short`;
    
    if (options.count) cmd += ` -n ${options.count}`;
    else cmd += ` -n 50`;
    
    if (options.message) cmd += ` --grep="${options.message.replace(/"/g, '\\"')}"`;
    if (options.author) cmd += ` --author="${options.author.replace(/"/g, '\\"')}"`;
    if (options.diffFilter) cmd += ` --diff-filter=${options.diffFilter}`;
    if (options.content) cmd += ` -S"${options.content.replace(/"/g, '\\"')}"`;
    
    if (options.file || options.diffFilter) {
         cmd += ` --full-history`; 
    }

    if (options.file) {
        cmd += ` -- "${options.file.replace(/"/g, '\\"')}"`;
    }

    try {
        const { stdout } = await execAsync(cmd, { cwd: folder.uri.fsPath, timeout: 20000 });
        
        return stdout.split('\n').filter(line => line.trim()).map(line => {
            const parts = line.split('|');
            return {
                hash: parts[0],
                message: parts[1] || '',
                author: parts[2] || '',
                date: parts[3] || ''
            };
        });
    } catch (error) {
        console.error("Git Search Failed:", error);
        return [];
    }
  }

  public async getChangedFiles(folder: vscode.WorkspaceFolder, hash: string): Promise<string[]> {
    if (!folder) return[];
    try {
        const { stdout } = await execAsync(`git --no-pager show --pretty="" --name-only ${hash}`, { 
            cwd: folder.uri.fsPath,
            maxBuffer: MAX_BUFFER_SIZE,
            timeout: 15000
        });
        return stdout.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    } catch (e) {
        console.error(`Failed to get changed files for commit ${hash}:`, e);
        return [];
    }
  }

  public async getFileAtCommit(folder: vscode.WorkspaceFolder, hash: string, filePath: string): Promise<string> {
      try {
          // git show hash:path/to/file
          const { stdout } = await execAsync(`git --no-pager show ${hash}:"${filePath}"`, { 
              cwd: folder.uri.fsPath,
              maxBuffer: MAX_BUFFER_SIZE,
              timeout: 15000
          });
          return stdout;
      } catch (e) {
          return ""; // File might not exist at that commit
      }
  }
}
