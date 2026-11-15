import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { LollmsAPI, ChatMessage } from './lollmsAPI';
import { getProcessedSystemPrompt, stripThinkingTags } from './utils';

export const execAsync = promisify(exec);
export const MAX_DIFF_LENGTH = 8000;
export const MAX_BUFFER_SIZE = 20 * 1024 * 1024;

export interface GitCommit {
    hash: string;
    message: string;
    author: string;
    date: string;
}

export interface GitFileVersionCommit {
    hash: string;
    message: string;
    author: string;
    date: string;
    refs?: string;
}

export interface GitSearchOptions {
    message?: string;
    author?: string;
    file?: string;
    diffFilter?: string;
    content?: string;
    count?: number;
}

const IGNORED_SUBFOLDER_SCAN_DIRS = new Set([
    'node_modules', '.git', '.lollms', '.vscode', '.vscode-test',
    'venv', '.venv', 'env', '.env', '__pycache__',
    'dist', 'build', 'out', 'target', 'bin', 'obj', '.next', '.pytest_cache'
]);

export class GitIntegration {
  private lollmsAPI: LollmsAPI;
  private repoRootCache: Map<string, string> = new Map();

  constructor(lollmsAPI: LollmsAPI) {
    this.lollmsAPI = lollmsAPI;
  }

  private async verifyGitWorkTree(dirPath: string): Promise<boolean> {
      try {
          const { stdout } = await execAsync('git --no-pager rev-parse --is-inside-work-tree', { cwd: dirPath, timeout: 5000 });
          return stdout.trim() === 'true';
      } catch {
          return false;
      }
  }

  public async resolveGitCwd(folder: vscode.WorkspaceFolder): Promise<string | null> {
      if (!folder?.uri?.fsPath) return null;
      const rootFsPath = folder.uri.fsPath;

      if (await this.verifyGitWorkTree(rootFsPath)) {
          this.repoRootCache.delete(rootFsPath);
          return rootFsPath;
      }

      const cached = this.repoRootCache.get(rootFsPath);
      if (cached) {
          try {
              await fs.promises.stat(path.join(cached, '.git'));
              if (await this.verifyGitWorkTree(cached)) {
                  return cached;
              }
          } catch {}
          this.repoRootCache.delete(rootFsPath);
      }

      const scanLevel = async (parentDir: string): Promise<string[]> => {
          try {
              const entries = await fs.promises.readdir(parentDir, { withFileTypes: true });
              const subDirs = entries
                  .filter(e => e.isDirectory() && !IGNORED_SUBFOLDER_SCAN_DIRS.has(e.name.toLowerCase()) && !e.name.startsWith('.'))
                  .map(e => e.name);
              // Prioritize a subfolder matching the workspace folder name (e.g. ascii_colors/ascii_colors)
              subDirs.sort((a, b) => {
                  const aMatches = a.toLowerCase() === folder.name.toLowerCase() ? -1 : 0;
                  const bMatches = b.toLowerCase() === folder.name.toLowerCase() ? -1 : 0;
                  return aMatches - bMatches || a.localeCompare(b);
              });
              return subDirs.map(name => path.join(parentDir, name));
          } catch {
              return [];
          }
      };

      const depth1Dirs = await scanLevel(rootFsPath);
      for (const dirPath of depth1Dirs) {
          try {
              await fs.promises.stat(path.join(dirPath, '.git'));
              if (await this.verifyGitWorkTree(dirPath)) {
                  this.repoRootCache.set(rootFsPath, dirPath);
                  return dirPath;
              }
          } catch {}
      }

      for (const dirPath of depth1Dirs) {
          const depth2Dirs = await scanLevel(dirPath);
          for (const subPath of depth2Dirs) {
              try {
                  await fs.promises.stat(path.join(subPath, '.git'));
                  if (await this.verifyGitWorkTree(subPath)) {
                      this.repoRootCache.set(rootFsPath, subPath);
                      return subPath;
                  }
              } catch {}
          }
      }

      return null;
  }

  private async getCwd(folder: vscode.WorkspaceFolder): Promise<string> {
      return (await this.resolveGitCwd(folder)) || folder.uri.fsPath;
  }

  private normalizeRepoFilePath(folder: vscode.WorkspaceFolder, cwd: string, filePath: string): string {
      const norm = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
      if (cwd === folder.uri.fsPath) return norm;
      const relCwd = path.relative(folder.uri.fsPath, cwd).replace(/\\/g, '/').replace(/\/+$/, '');
      if (relCwd && norm.toLowerCase().startsWith(relCwd.toLowerCase() + '/')) {
          return norm.substring(relCwd.length + 1);
      }
      return norm;
  }

  public async isGitRepo(folder: vscode.WorkspaceFolder): Promise<boolean> {
    if (!folder) return false;
    return (await this.resolveGitCwd(folder)) !== null;
  }

  public async getCurrentBranch(folder: vscode.WorkspaceFolder): Promise<string> {
      try {
          const cwd = await this.getCwd(folder);
          const { stdout } = await execAsync('git --no-pager branch --show-current', { cwd, timeout: 10000 });
          return stdout.trim();
      } catch (e) {
          return '';
      }
  }

  public async getCurrentHash(folder: vscode.WorkspaceFolder): Promise<string> {
    try {
        const cwd = await this.getCwd(folder);
        const { stdout } = await execAsync('git --no-pager rev-parse HEAD', { cwd, timeout: 10000 });
        return stdout.trim();
    } catch (e) {
        return '';
    }
  }

  public async getBranches(folder: vscode.WorkspaceFolder): Promise<string[]> {
      try {
          const cwd = await this.getCwd(folder);
          const { stdout } = await execAsync('git --no-pager branch --format="%(refname:short)"', { cwd, timeout: 15000 });
          return stdout.split('\n').map(b => b.trim()).filter(b => b.length > 0);
      } catch {
          return [];
      }
  }

  public async getTags(folder: vscode.WorkspaceFolder): Promise<{name: string, date: string, message: string}[]> {
      try {
          const cwd = await this.getCwd(folder);
          const { stdout } = await execAsync('git --no-pager tag -l --format="%(refname:short)|%(creatordate:relative)|%(contents:subject)"', { 
              cwd, 
              timeout: 10000 
          });
          return stdout.split('\n')
              .filter(line => line.trim())
              .map(line => {
                  const [name, date, message] = line.split('|');
                  return { name, date, message };
              })
              .reverse(); // Newest first
      } catch {
          return [];
      }
  }

  public async createTag(folder: vscode.WorkspaceFolder, name: string, message?: string, ref?: string): Promise<void> {
      const cwd = await this.getCwd(folder);
      const msgArg = message ? ` -m "${message.replace(/"/g, '\\"')}"` : '';
      const flag = message ? '-a' : '';
      const refArg = ref ? ` "${ref}"` : '';
      await execAsync(`git tag ${flag} "${name}" ${msgArg}${refArg}`, { cwd });
  }

  public async deleteTag(folder: vscode.WorkspaceFolder, name: string): Promise<void> {
      const cwd = await this.getCwd(folder);
      await execAsync(`git tag -d "${name}"`, { cwd });
  }

  public async hasUnstagedChanges(folder: vscode.WorkspaceFolder): Promise<boolean> {
      try {
          const cwd = await this.getCwd(folder);
          const { stdout } = await execAsync('git --no-pager status --porcelain', { cwd, timeout: 10000 });
          return stdout.trim().length > 0;
      } catch (e) {
          return false;
      }
  }

  public async getStagedFiles(folder: vscode.WorkspaceFolder): Promise<string[]> {
      try {
          const cwd = await this.getCwd(folder);
          const { stdout } = await execAsync('git --no-pager diff --name-only --cached', { cwd, timeout: 15000 });
          return stdout.split('\n').filter(l => l.trim().length > 0);
      } catch { return []; }
  }

  public async isClean(folder: vscode.WorkspaceFolder): Promise<boolean> {
      const status = await this.getGitStatus(folder);
      return status.staged.length === 0 && status.unstaged.length === 0 && status.untracked.length === 0;
  }

  public async getGitStatus(folder: vscode.WorkspaceFolder): Promise<{ staged: string[], unstaged: string[], untracked: string[] }> {
      if (!folder) return { staged: [], unstaged: [], untracked: [] };
      const cwd = await this.getCwd(folder);
      const staged = await this.getStagedFiles(folder);
      let unstaged: string[] = [];
      try {
          const { stdout } = await execAsync('git --no-pager diff --name-only', { cwd, timeout: 5000 });
          unstaged = stdout.split('\n').filter(l => l.trim().length > 0);
      } catch {}
      let untracked: string[] = [];
      try {
          const { stdout } = await execAsync('git --no-pager ls-files --others --exclude-standard', { cwd, timeout: 5000 });
          untracked = stdout.split('\n').filter(l => l.trim().length > 0);
      } catch {}
      return { staged, unstaged, untracked };
  }

  public async stageFile(folder: vscode.WorkspaceFolder, filePath: string) {
      const cwd = await this.getCwd(folder);
      await execAsync(`git add "${this.normalizeRepoFilePath(folder, cwd, filePath)}"`, { cwd });
  }

  public async unstageFile(folder: vscode.WorkspaceFolder, filePath: string) {
      const cwd = await this.getCwd(folder);
      await execAsync(`git restore --staged "${this.normalizeRepoFilePath(folder, cwd, filePath)}"`, { cwd });
  }

  public async discardChanges(folder: vscode.WorkspaceFolder, filePath: string) {
      const cwd = await this.getCwd(folder);
      // Use restore for tracked files and clean for untracked files
      if (filePath === ".") {
          await execAsync(`git restore .`, { cwd });
          await execAsync(`git clean -fd`, { cwd });
      } else {
          await execAsync(`git restore "${this.normalizeRepoFilePath(folder, cwd, filePath)}"`, { cwd });
      }
  }

  public async getStashList(folder: vscode.WorkspaceFolder): Promise<string[]> {
      try {
          const cwd = await this.getCwd(folder);
          const { stdout } = await execAsync('git --no-pager stash list', { cwd, timeout: 15000 });
          return stdout.split('\n').filter(l => l.trim().length > 0);
      } catch { return []; }
  }

  public async applyStash(folder: vscode.WorkspaceFolder, index: number) {
      const cwd = await this.getCwd(folder);
      await execAsync(`git stash apply ${index}`, { cwd });
  }

  public async dropStash(folder: vscode.WorkspaceFolder, index: number) {
      const cwd = await this.getCwd(folder);
      await execAsync(`git stash drop ${index}`, { cwd });
  }

  public async stageFiles(folder: vscode.WorkspaceFolder, files: string[]): Promise<void> {
      if (!folder) return;
      const cwd = await this.getCwd(folder);
      try {
          await execAsync('git reset', { cwd });
      } catch (e) {
          console.error("Git reset failed:", e);
      }
      if (files.length === 0) return;
      const chunkSize = 20;
      for (let i = 0; i < files.length; i += chunkSize) {
          const chunk = files.slice(i, i + chunkSize);
          const fileArgs = chunk.map(f => `"${this.normalizeRepoFilePath(folder, cwd, f)}"`).join(' ');
          await execAsync(`git add ${fileArgs}`, { cwd });
      }
  }

  public async getUnstagedFiles(folder: vscode.WorkspaceFolder): Promise<string[]> {
      try {
          const cwd = await this.getCwd(folder);
          const { stdout: modified } = await execAsync('git --no-pager diff --name-only', { cwd, timeout: 15000 });
          const { stdout: untracked } = await execAsync('git --no-pager ls-files --others --exclude-standard', { cwd, timeout: 15000 });
          const files = new Set([
              ...modified.split('\n').filter(l => l.trim().length > 0),
              ...untracked.split('\n').filter(l => l.trim().length > 0)
          ]);
          return Array.from(files).sort();
      } catch { return []; }
  }

  public async stash(folder: vscode.WorkspaceFolder, message?: string): Promise<void> {
      const cwd = await this.getCwd(folder);
      const msgArg = message ? ` push -m "${message}"` : '';
      await execAsync(`git stash${msgArg}`, { cwd });
  }

  public async stashPop(folder: vscode.WorkspaceFolder): Promise<void> {
      const cwd = await this.getCwd(folder);
      await execAsync(`git stash pop`, { cwd });
  }

  public async createAndCheckoutBranch(folder: vscode.WorkspaceFolder, branchName: string, startPoint?: string): Promise<void> {
      try {
          const cwd = await this.getCwd(folder);
          const safeBranchName = `"${branchName}"`;
          const start = startPoint ? ` "${startPoint}"` : '';
          try {
              await execAsync(`git --no-pager rev-parse --verify ${safeBranchName}`, { cwd, timeout: 10000 });
              await execAsync(`git checkout ${safeBranchName}`, { cwd });
          } catch {
              await execAsync(`git checkout -b ${safeBranchName}${start}`, { cwd });
          }
      } catch (e: any) {
          throw new Error(`Failed to create/checkout branch: ${e.message}`);
      }
  }

  public async checkout(folder: vscode.WorkspaceFolder, ref: string): Promise<void> {
      if (!folder) return;
      try {
          const cwd = await this.getCwd(folder);
          const safeRef = `"${ref.replace(/"/g, '\\"')}"`;
          try {
              await execAsync(`git checkout ${safeRef}`, { cwd });
          } catch {
              await execAsync(`git fetch`, { cwd, timeout: 30000 });
              await execAsync(`git checkout ${safeRef}`, { cwd });
          }
      } catch (e: any) {
          throw new Error(`Checkout failed: ${e.message}`);
      }
  }

  public async detachSubmodule(folder: vscode.WorkspaceFolder, subPath: string): Promise<void> {
      if (!folder) return;
      const cwd = await this.getCwd(folder);
      const fullPath = path.join(cwd, subPath);
      const tempPath = path.join(cwd, `${subPath}_temp`);
      try {
          await fs.promises.rename(fullPath, tempPath);
          await execAsync(`git rm -f "${subPath}"`, { cwd });
          const gitModulesDir = path.join(cwd, '.git', 'modules', subPath);
          try { await fs.promises.rm(gitModulesDir, { recursive: true, force: true }); } catch {}
          await fs.promises.rename(tempPath, fullPath);
          const subGitFile = path.join(fullPath, '.git');
          try { await fs.promises.unlink(subGitFile); } catch {}
          vscode.window.showInformationMessage(`Successfully detached ${subPath}.`);
      } catch (e: any) {
          throw new Error(`Detachment failed: ${e.message}`);
      }
  }

  public async mergeBranch(folder: vscode.WorkspaceFolder, sourceBranch: string): Promise<string> {
      try {
          const cwd = await this.getCwd(folder);
          const currentBranch = await this.getCurrentBranch(folder);
          if (currentBranch === sourceBranch) {
              throw new Error(`Cannot merge branch into itself (already on ${currentBranch}).`);
          }
          const { stdout } = await execAsync(`git merge "${sourceBranch}"`, { cwd, timeout: 30000 });
          await vscode.commands.executeCommand('git.refresh').then(undefined, () => {});
          return stdout;
      } catch (e: any) {
          const combinedOutput = `${e.stdout || ''}\n${e.stderr || ''}\n${e.message || ''}`;
          if (combinedOutput.includes("CONFLICT") || combinedOutput.includes("Automatic merge failed")) {
              throw new Error(`Merge Conflict: Automatic merge failed. Conflicts have been marked in your files.`);
          }
          throw new Error(e.stderr || e.stdout || e.message || "Merge failed.");
      }
  }

  public async rebaseBranch(folder: vscode.WorkspaceFolder, upstream: string): Promise<string> {
      try {
          const cwd = await this.getCwd(folder);
          const currentBranch = await this.getCurrentBranch(folder);
          if (currentBranch === upstream) {
              throw new Error(`Cannot rebase branch onto itself.`);
          }
          // Fetch to ensure upstream is fresh
          await execAsync(`git fetch origin`, { cwd, timeout: 30000 }).catch(() => {});
          const { stdout } = await execAsync(`git rebase "${upstream}"`, { cwd });
          return stdout;
      } catch (e: any) {
          if (e.stdout && (e.stdout.includes("CONFLICT") || e.stdout.includes("error: could not apply"))) {
              throw new Error(`Rebase Conflict: Rebase is paused. Please resolve conflicts in files and use 'git rebase --continue' or 'git rebase --abort'.`);
          }
          throw new Error(`Rebase failed: ${e.message}`);
      }
  }

  public async getFileHistory(folder: vscode.WorkspaceFolder, filePath: string, count: number = 50): Promise<GitCommit[]> {
      try {
          const cwd = await this.getCwd(folder);
          const repoFilePath = this.normalizeRepoFilePath(folder, cwd, filePath);
          const { stdout } = await execAsync(
              `git --no-pager log --pretty=format:"%H|%s|%an|%ar" -n ${count} -- "${repoFilePath}"`,
              { cwd, timeout: 15000 }
          );
          return stdout.split('\n').filter(line => line.trim()).map(line => {
              const [hash, message, author, date] = line.split('|');
              return { hash, message, author, date };
          });
      } catch (error) {
          console.error(`Failed to fetch history for ${filePath}:`, error);
          return [];
      }
  }

  /**
   * Retrieves full commit history for a file across ALL local and remote branches.
   * Merges `git log --all` with `git log --follow` to capture multi-branch and renamed commits reliably.
   */
  public async getFileHistoryAllBranches(
      folder: vscode.WorkspaceFolder, 
      filePath: string, 
      count: number = 50,
      skip: number = 0,
      searchContent?: string
  ): Promise<GitFileVersionCommit[]> {
      const cwd = await this.getCwd(folder);
      const normalizedPath = this.normalizeRepoFilePath(folder, cwd, filePath);
      const commitsMap = new Map<string, GitFileVersionCommit>();

      const parsePipeOutput = (stdout: string) => {
          if (!stdout) return;
          const lines = stdout.split('\n');
          for (let i = 0; i < lines.length; i++) {
              const cleanLine = lines[i].replace(/\r$/, '').trim();
              if (!cleanLine) continue;
              const parts = cleanLine.split('|');
              if (parts.length >= 5) {
                  const hash = parts[0].trim();
                  if (!commitsMap.has(hash)) {
                      const refs = parts.length >= 6 ? parts[parts.length - 1].trim() : undefined;
                      const relDate = parts[parts.length - 2].trim();
                      const date = parts[parts.length - 3].trim();
                      const author = parts[parts.length - 4].trim();
                      const message = parts.slice(1, parts.length - 4).join('|').trim();

                      commitsMap.set(hash, {
                          hash,
                          message,
                          author,
                          date: `${date} (${relDate})`,
                          refs: refs || undefined
                      });
                  }
              }
          }
      };

      const pickaxeArg = searchContent && searchContent.trim()
          ? ` -S"${searchContent.trim().replace(/"/g, '\\"')}"`
          : '';

      // 1. Fast Primary Query: Query all branches using path-indexed log without slow rename traversal
      try {
          const res1 = await execAsync(
              `git --no-pager log --all${pickaxeArg} --pretty=format:"%H|%s|%an|%ad|%ar|%d" --date=short --max-count=${count} --skip=${skip} -- "${normalizedPath}"`,
              { cwd, maxBuffer: MAX_BUFFER_SIZE, timeout: 8000 }
          );
          parsePipeOutput(res1.stdout);
      } catch {}

      // 2. Only if NO commits were found on initial page (skip === 0), try follow-rename as bounded fallback
      if (commitsMap.size === 0 && skip === 0) {
          try {
              const res2 = await execAsync(
                  `git --no-pager log --follow --pretty=format:"%H|%s|%an|%ad|%ar|%d" --date=short --max-count=${count} -- "${normalizedPath}"`,
                  { cwd, maxBuffer: MAX_BUFFER_SIZE, timeout: 4000 }
              );
              parsePipeOutput(res2.stdout);
          } catch {}
      }

      return Array.from(commitsMap.values());
  }

  /**
   * Retrieves file content at a specific ref/commit, or from the active working tree.
   */
  public async getFileContentAtRef(folder: vscode.WorkspaceFolder, ref: string, filePath: string): Promise<string> {
      const cwd = await this.getCwd(folder);
      const normalizedPath = this.normalizeRepoFilePath(folder, cwd, filePath);

      if (ref === 'WORKING_TREE' || ref === 'HEAD_WORKING') {
          const fileUri = vscode.Uri.file(path.join(cwd, normalizedPath));
          try {
              const bytes = await vscode.workspace.fs.readFile(fileUri);
              return Buffer.from(bytes).toString('utf8');
          } catch (e: any) {
              return `(File does not exist on disk: ${e.message})`;
          }
      }

      try {
          const { stdout } = await execAsync(`git --no-pager show "${ref}:${normalizedPath}"`, {
              cwd,
              maxBuffer: MAX_BUFFER_SIZE,
              timeout: 10000
          });
          return stdout;
      } catch (e: any) {
          // File did not exist at this commit (e.g. before initial commit of this path)
          return '';
      }
  }

  /**
   * Generates a unified diff between two refs for a specific file.
   */
  public async getRepoRoot(targetFsPath: string): Promise<string | null> {
      try {
          const stat = await fs.promises.stat(targetFsPath).catch(() => null);
          const cwd = stat && stat.isDirectory() ? targetFsPath : path.dirname(targetFsPath);
          const { stdout } = await execAsync('git --no-pager rev-parse --show-toplevel', { cwd, timeout: 5000 });
          return stdout.trim() || null;
      } catch {
          return null;
      }
  }

  public async getFileDiffBetweenRefs(folder: vscode.WorkspaceFolder, refA: string, refB: string, filePath: string): Promise<string> {
      const cwd = await this.getCwd(folder);
      const normalizedPath = this.normalizeRepoFilePath(folder, cwd, filePath);
      try {
          if (refA === refB) {
              return '';
          }
          if (refB === 'WORKING_TREE') {
              const { stdout } = await execAsync(`git --no-pager diff "${refA}" -- "${normalizedPath}"`, {
                  cwd,
                  maxBuffer: MAX_BUFFER_SIZE,
                  timeout: 15000
              });
              return stdout;
          }
          if (refA === 'WORKING_TREE') {
              const { stdout } = await execAsync(`git --no-pager diff -R "${refB}" -- "${normalizedPath}"`, {
                  cwd,
                  maxBuffer: MAX_BUFFER_SIZE,
                  timeout: 15000
              });
              return stdout;
          }
          const { stdout } = await execAsync(`git --no-pager diff "${refA}" "${refB}" -- "${normalizedPath}"`, {
              cwd,
              maxBuffer: MAX_BUFFER_SIZE,
              timeout: 15000
          });
          return stdout;
      } catch {
          return '';
      }
  }

  public async renameBranch(folder: vscode.WorkspaceFolder, oldName: string, newName: string): Promise<void> {
      try {
          const cwd = await this.getCwd(folder);
          const safeOld = oldName.trim().replace(/"/g, '\\"');
          const safeNew = newName.trim().replace(/\s+/g, '-').replace(/"/g, '\\"');
          
          const current = await this.getCurrentBranch(folder);
          if (current === safeOld) {
              await execAsync(`git branch -m "${safeNew}"`, { cwd });
          } else {
              await execAsync(`git branch -m "${safeOld}" "${safeNew}"`, { cwd });
          }
      } catch (e: any) {
          throw new Error(e.message || "Failed to rename branch.");
      }
  }

  public async deleteBranch(folder: vscode.WorkspaceFolder, branchName: string): Promise<void> {
      const cwd = await this.getCwd(folder);
      try {
          await execAsync(`git branch -d "${branchName}"`, { cwd });
      } catch (e: any) {
          try {
              // Fallback to force delete if safe delete fails (e.g. unmerged changes)
              await execAsync(`git branch -D "${branchName}"`, { cwd });
          } catch (e2: any) {
              console.error("Failed to delete branch", e2);
              throw new Error(e2.message || "Failed to force delete branch.");
          }
      }
  }

  public async getSubmodules(folder: vscode.WorkspaceFolder): Promise<{path: string, hash: string}[]> {
      if (!folder) return [];
      try {
          const cwd = await this.getCwd(folder);
          const { stdout } = await execAsync('git --no-pager submodule status', { cwd, timeout: 15000 });
          return stdout.split('\n')
              .filter(line => line.trim().length > 0)
              .map(line => {
                  const parts = line.trim().split(/\s+/);
                  const hash = parts[0].replace(/^[+-U]/, '');
                  const subPath = parts[1];
                  return { hash, path: subPath };
              });
      } catch (e) {
          return [];
      }
  }

  public async addSubmodule(folder: vscode.WorkspaceFolder, url: string, subPath: string): Promise<void> {
      if (!folder) return;
      try {
          const cwd = await this.getCwd(folder);
          await execAsync(`git submodule add "${url}" "${subPath}"`, { cwd });
      } catch (e: any) {
          throw new Error(`Failed to add submodule: ${e.message}`);
      }
  }

  public async removeSubmodule(folder: vscode.WorkspaceFolder, subPath: string): Promise<void> {
      if (!folder) return;
      try {
          const cwd = await this.getCwd(folder);
          await execAsync(`git rm "${subPath}"`, { cwd });
      } catch (e: any) {
          throw new Error(`Failed to remove submodule: ${e.message}`);
      }
  }

  public async updateSubmodules(folder: vscode.WorkspaceFolder): Promise<void> {
      try {
          const cwd = await this.getCwd(folder);
          await execAsync('git submodule update --init --recursive', { cwd, timeout: 60000 });
      } catch (e: any) {
          throw new Error(`Failed to update submodules: ${e.message}`);
      }
  }

  public async checkoutPrevious(folder: vscode.WorkspaceFolder): Promise<void> {
      if (!folder) return;
      try {
          const cwd = await this.getCwd(folder);
          await execAsync(`git checkout -`, { cwd });
      } catch (e: any) {
          throw new Error(`Failed to checkout previous branch: ${e.message}`);
      }
  }

  public async getCommitDiff(folder: vscode.WorkspaceFolder, hash: string): Promise<string> {
      if (!folder) return "";
      try {
          const cwd = await this.getCwd(folder);
          // Standard git show -p provides the patch for the entire commit
          const { stdout } = await execAsync(`git --no-pager show --pretty="" -p ${hash}`, {
              cwd,
              maxBuffer: MAX_BUFFER_SIZE,
              timeout: 10000
          });
          return stdout || '';
      } catch (e: any) {
          throw new Error(`Failed to get commit diff: ${e.message}`);
      }
  }

  public async revertCommit(folder: vscode.WorkspaceFolder, hash: string): Promise<void> {
      try {
          const cwd = await this.getCwd(folder);
          await execAsync(`git revert --no-edit ${hash}`, { cwd });
      } catch (e: any) {
          throw new Error(`Revert failed: ${e.message}`);
      }
  }

  private async _getDiff(args: string, folder: vscode.WorkspaceFolder): Promise<string> {
      if (!folder) return '';
      const cwd = await this.getCwd(folder);
      try {
          const { stdout } = await execAsync(`git --no-pager diff ${args}`, {
              cwd,
              maxBuffer: MAX_BUFFER_SIZE,
              timeout: 10000,
              killSignal: 'SIGKILL'
          });
          return stdout || '';
      } catch (error: any) {
          console.error(`Git diff error for args '${args}':`, error);
          if (error.message && error.message.includes('maxBuffer')) {
              try {
                  const { stdout } = await execAsync(`git --no-pager diff ${args} --name-only`, { cwd, timeout: 15000 });
                  return `Diff too large to display. Modified files:\n${stdout}`;
              } catch (e) {
                  return '';
              }
          }
          return '';
      }
  }

  private async _getUntrackedFiles(folder: vscode.WorkspaceFolder): Promise<string[]> {
      if (!folder) return [];
      try {
          const cwd = await this.getCwd(folder);
          const { stdout } = await execAsync('git --no-pager ls-files --others --exclude-standard', { cwd, timeout: 15000 });
          return stdout.split('\n').filter(line => line.trim().length > 0);
      } catch (e) {
          return [];
      }
  }

  private parseCommitMessage(rawResponse: string): string {
      let stripped = stripThinkingTags(rawResponse).trim();

      // --- POCKET PROTECTION: COG RECOVERY FALLBACK ---
      // If stripping the thoughts leaves nothing, it means the eager thinking model
      // wrote the actual commit message INSIDE the <think> tags!
      if (stripped.length < 3 && rawResponse.trim().length > 10) {
          const rawLines = rawResponse.split('\n').map(l => l.trim());
          const conventionalRegex = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([\w-]+\))?:/i;

          const matchInThoughts = rawLines.find(line => conventionalRegex.test(line));
          if (matchInThoughts) {
              stripped = matchInThoughts;
          } else {
              // Fallback: take the last non-tag, non-empty line from the thought block
              const cleanLines = rawLines.filter(l => l.length > 0 && !l.startsWith('<') && !l.startsWith('/') && !l.startsWith('</'));
              if (cleanLines.length > 0) {
                  stripped = cleanLines[cleanLines.length - 1];
              }
          }
      }

      // 1. Try JSON parsing in case the model wraps the output in JSON due to system history
      try {
          const parsed = JSON.parse(stripped);
          if (parsed && typeof parsed === 'object') {
              const message = parsed.message || parsed.title || parsed.response || 
                              (parsed.params?.response) || (parsed.params?.message);
              if (message && typeof message === 'string') {
                  return message.trim();
              }
          }
      } catch (e) {
          // Not JSON, continue with standard parsing
      }

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
          if (conventionalRegex.test(line)) { startIndex = i; break; }
          if (!conversationalStartRegex.test(line)) { if (startIndex === -1) startIndex = i; }
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
              const cwd = await this.getCwd(folder);
              diffSource = "untracked";
              diff = `Untracked files (newly created):\n${untracked.join('\n')}\n\n`;
              let fileContentContext = "";
              for (const file of untracked.slice(0, 5)) {
                  try {
                      const fileUri = vscode.Uri.file(path.join(cwd, file));
                      const stat = await vscode.workspace.fs.stat(fileUri);
                      if (stat.size < 5000) {
                          const content = await vscode.workspace.fs.readFile(fileUri);
                          fileContentContext += `\n--- Content of ${file} ---\n${Buffer.from(content).toString('utf8')}\n`;
                      }
                  } catch (e) {}
              }
              if (fileContentContext) diff += fileContentContext;
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
      const prompt: ChatMessage[] = [
          { role: 'system', content: systemPromptContent },
          { role: 'user', content: userPromptContent }
      ];
      try {
          const config = vscode.workspace.getConfiguration('lollmsVsCoder');
          const commitModel = config.get<string>('gitCommitModelName') || undefined;

          const rawMessage = await vscode.window.withProgress({
              location: vscode.ProgressLocation.SourceControl,
              title: "Lollms: Generating commit message...",
              cancellable: false
          }, async () => {
              return await this.lollmsAPI.sendChat(prompt, null, undefined, commitModel);
          });
          const cleanMessage = this.parseCommitMessage(rawMessage);
          if (!cleanMessage) {
              vscode.window.showWarningMessage('Lollms returned an empty commit message.');
              return '';
          }
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
      const cwd = await this.getCwd(folder);
      const changelogPath = vscode.Uri.file(path.join(cwd, 'CHANGELOG.md'));
      try {
          try {
              await vscode.workspace.fs.stat(changelogPath);
          } catch {
              return; // Silently skip if file doesn't exist
          }
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
      const cwd = await this.getCwd(folder);
      const staged = await this.getStagedFiles(folder);
      if (staged.length === 0) {
          const unstaged = await this.getUnstagedFiles(folder);
          if (unstaged.length === 0) {
              vscode.window.showInformationMessage("Nothing to commit (clean working directory).");
              return "";
          }
          const items: vscode.QuickPickItem[] = unstaged.map(f => ({ label: f, picked: true, description: 'Unstaged' }));
          const selected = await vscode.window.showQuickPick(items, {
              canPickMany: true,
              placeHolder: "No staged changes. Select files to stage and commit:",
              title: "Stage Files for Commit"
          });
          if (!selected || selected.length === 0) {
              vscode.window.showInformationMessage("Commit cancelled (no files selected).");
              return "";
          }
          try {
              if (selected.length === unstaged.length) {
                  await execAsync(`git add .`, { cwd });
              } else {
                  const filesToStage = selected.map(i => `"${i.label}"`).join(' ');
                  await execAsync(`git add ${filesToStage}`, { cwd });
              }
          } catch (e: any) {
              vscode.window.showErrorMessage(`Failed to stage files: ${e.message}`);
              return "";
          }
      }
      try {
          await execAsync(`git commit -m "${message.replace(/"/g, '\\"')}"`, { cwd });
          const { stdout: hash } = await execAsync(`git rev-parse HEAD`, { cwd });
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
      const cwd = await this.getCwd(folder);
      try {
          await execAsync('git add .', { cwd });
          await execAsync(`git commit -m "${message.replace(/"/g, '\\"')}"`, { cwd });
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
   * FIX: Removed conflicting -n and --max-count flags (they are aliases — using both
   * caused git to traverse (count + skip) commits before returning, reliably timing out.
   * Now uses only --max-count with the correct value and a clean --skip for pagination.
   * Returns null on timeout/error so the caller can show a graceful fallback.
   */
  public async getGitGraph(folder: vscode.WorkspaceFolder, count: number = 30, skip: number = 0): Promise<string | null> {
      try {
          const cwd = await this.getCwd(folder);
          const { stdout } = await execAsync(
              `git --no-pager log --graph --all --pretty=format:"%H|%ar|%an|%d|%s" --color=never --max-count=${count} --skip=${skip}`,
              { cwd, timeout: 10000 }
          );
          // Return null if git gave us nothing (empty repo, no commits)
          return stdout.trim() ? stdout : null;
      } catch (e: any) {
          // Distinguish timeout from other errors for better UX
          if (e.killed || e.signal === 'SIGKILL' || (e.message && e.message.includes('timed out'))) {
              console.warn('getGitGraph timed out:', e.message);
          } else {
              console.error('getGitGraph failed:', e.message);
          }
          return null;
      }
  }

  public async getCommitHistory(folder: vscode.WorkspaceFolder, count: number = 50): Promise<GitCommit[]> {
      if (!folder) return [];
      try {
          const cwd = await this.getCwd(folder);
          const { stdout } = await execAsync(
              `git --no-pager log --all --pretty=format:"%H|%s|%an|%ar" -n ${count}`,
              { cwd, timeout: 15000 }
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
      if (!folder) return [];
      const cwd = await this.getCwd(folder);
      let cmd = `git --no-pager log --pretty=format:"%H|%s|%an|%ad" --date=short`;
      if (options.count) cmd += ` -n ${options.count}`;
      else cmd += ` -n 50`;
      if (options.message) cmd += ` --grep="${options.message.replace(/"/g, '\\"')}"`;
      if (options.author) cmd += ` --author="${options.author.replace(/"/g, '\\"')}"`;
      if (options.diffFilter) cmd += ` --diff-filter=${options.diffFilter}`;
      if (options.content) cmd += ` -S"${options.content.replace(/"/g, '\\"')}"`;
      if (options.file || options.diffFilter) cmd += ` --full-history`;
      if (options.file) cmd += ` -- "${this.normalizeRepoFilePath(folder, cwd, options.file).replace(/"/g, '\\"')}"`;
      try {
          const { stdout } = await execAsync(cmd, { cwd, timeout: 20000 });
          return stdout.split('\n').filter(line => line.trim()).map(line => {
              const parts = line.split('|');
              return { hash: parts[0], message: parts[1] || '', author: parts[2] || '', date: parts[3] || '' };
          });
      } catch (error) {
          console.error("Git Search Failed:", error);
          return [];
      }
  }

  public async getChangedFiles(folder: vscode.WorkspaceFolder, hash: string): Promise<string[]> {
      if (!folder) return [];
      try {
          const cwd = await this.getCwd(folder);
          const { stdout } = await execAsync(`git --no-pager show --pretty="" --name-only ${hash}`, {
              cwd,
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
          const cwd = await this.getCwd(folder);
          const repoFilePath = this.normalizeRepoFilePath(folder, cwd, filePath);
          const { stdout } = await execAsync(`git --no-pager show ${hash}:"${repoFilePath}"`, {
              cwd,
              maxBuffer: MAX_BUFFER_SIZE,
              timeout: 15000
          });
          return stdout;
      } catch (e) {
          return "";
      }
  }
}