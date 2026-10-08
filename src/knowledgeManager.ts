import * as vscode from 'vscode';
import * as path from 'path';
import { Logger } from './logger';

export interface KnowledgeIndexEntry {
    title: string;
    normalizedPath: string;
    accessCount: number;
    depth: number;
    children: KnowledgeIndexEntry[];
}

export class KnowledgeManager {
    public static readonly ROOT_FILENAME = 'KNOWLEDGE.md';
    public static readonly SUBDIR_NAME = 'knowledge';

    constructor(private context: vscode.ExtensionContext) {}

    public getKnowledgeRootUri(workspaceFolder?: vscode.WorkspaceFolder): vscode.Uri | null {
        const folder = workspaceFolder || vscode.workspace.workspaceFolders?.[0];
        if (!folder) return null;
        return vscode.Uri.joinPath(folder.uri, '.lollms');
    }

    public async getRootKnowledgeUri(workspaceFolder?: vscode.WorkspaceFolder): Promise<vscode.Uri | null> {
        const root = this.getKnowledgeRootUri(workspaceFolder);
        if (!root) return null;
        return vscode.Uri.joinPath(root, KnowledgeManager.ROOT_FILENAME);
    }

    public normalizeSectionName(name: string): string {
        return name
            .trim()
            .replace(/\[\d+\]/g, '')
            .trim()
            .replace(/[^\w\s\-.]/g, '')
            .replace(/\s+/g, '_');
    }

    public async getSectionUri(sectionPath: string, workspaceFolder?: vscode.WorkspaceFolder): Promise<vscode.Uri | null> {
        const root = this.getKnowledgeRootUri(workspaceFolder);
        if (!root) return null;

        const cleanPath = sectionPath.trim().replace(/^\.?\/+/, '').replace(/\/+$/, '');
        if (!cleanPath || cleanPath === KnowledgeManager.ROOT_FILENAME) {
            return vscode.Uri.joinPath(root, KnowledgeManager.ROOT_FILENAME);
        }

        const segments = cleanPath.split(/[\/\\]+/).map(s => this.normalizeSectionName(s));
        return vscode.Uri.joinPath(root, KnowledgeManager.SUBDIR_NAME, ...segments, KnowledgeManager.ROOT_FILENAME);
    }

    public async readRootKnowledge(workspaceFolder?: vscode.WorkspaceFolder): Promise<string> {
        const fileUri = await this.getRootKnowledgeUri(workspaceFolder);
        if (!fileUri) return "";
        try {
            const bytes = await vscode.workspace.fs.readFile(fileUri);
            return Buffer.from(bytes).toString('utf8');
        } catch {
            return "";
        }
    }

    public async readSectionKnowledge(sectionPath: string, workspaceFolder?: vscode.WorkspaceFolder): Promise<string> {
        const fileUri = await this.getSectionUri(sectionPath, workspaceFolder);
        if (!fileUri) return "";
        try {
            const bytes = await vscode.workspace.fs.readFile(fileUri);
            return Buffer.from(bytes).toString('utf8');
        } catch {
            return "";
        }
    }

    public parseIndexEntries(markdown: string): { abstract: string, entries: KnowledgeIndexEntry[] } {
        const lines = markdown.split(/\r?\n/);
        let inAbstract = false;
        let inIndex = false;
        const abstractLines: string[] = [];
        const flatEntries: { level: number; title: string; count: number }[] = [];

        for (const line of lines) {
            const trimmed = line.trim();
            if (/^##\s+Abstract\b/i.test(trimmed)) {
                inAbstract = true;
                inIndex = false;
                continue;
            }
            if (/^##\s+Index\b/i.test(trimmed)) {
                inAbstract = false;
                inIndex = true;
                continue;
            }
            if (/^##?\s+/i.test(trimmed) && inIndex) {
                inIndex = false;
            }

            if (inAbstract) {
                abstractLines.push(line);
            } else if (inIndex) {
                const headerMatch = trimmed.match(/^(#{3,6})\s+(.+)$/);
                if (headerMatch) {
                    const level = headerMatch[1].length;
                    const fullText = headerMatch[2].trim();
                    const countMatch = fullText.match(/\[(\d+)\]\s*$/);
                    const count = countMatch ? parseInt(countMatch[1], 10) : 0;
                    const title = fullText.replace(/\[\d+\]\s*$/, '').trim();

                    flatEntries.push({ level, title, count });
                }
            }
        }

        const entries: KnowledgeIndexEntry[] = [];
        const stack: { level: number; entry: KnowledgeIndexEntry; pathPrefix: string }[] = [];

        for (const item of flatEntries) {
            const normalized = this.normalizeSectionName(item.title);

            while (stack.length > 0 && stack[stack.length - 1].level >= item.level) {
                stack.pop();
            }

            const parent = stack.length > 0 ? stack[stack.length - 1] : null;
            const fullPath = parent ? `${parent.pathPrefix}/${normalized}` : normalized;

            const entry: KnowledgeIndexEntry = {
                title: item.title,
                normalizedPath: fullPath,
                accessCount: item.count,
                depth: item.level - 2,
                children: []
            };

            if (parent) {
                parent.entry.children.push(entry);
            } else {
                entries.push(entry);
            }

            stack.push({ level: item.level, entry, pathPrefix: fullPath });
        }

        return {
            abstract: abstractLines.join('\n').trim(),
            entries
        };
    }

    public flattenEntries(entries: KnowledgeIndexEntry[]): KnowledgeIndexEntry[] {
        const result: KnowledgeIndexEntry[] = [];
        const walk = (list: KnowledgeIndexEntry[]) => {
            for (const item of list) {
                result.push(item);
                if (item.children.length > 0) {
                    walk(item.children);
                }
            }
        };
        walk(entries);
        return result;
    }

    public async incrementAccessCount(sectionPath: string, workspaceFolder?: vscode.WorkspaceFolder): Promise<number> {
        const rootUri = await this.getRootKnowledgeUri(workspaceFolder);
        if (!rootUri) return 0;

        let content = await this.readRootKnowledge(workspaceFolder);
        if (!content) return 0;

        const cleanTarget = sectionPath.trim().replace(/^\.?\/+/, '').replace(/\/+$/, '');
        const targetNormalized = cleanTarget.split(/[\/\\]+/).map(s => this.normalizeSectionName(s)).join('/');
        const targetLeaf = this.normalizeSectionName(targetNormalized.split('/').pop() || targetNormalized);

        let newScore = 1;
        let modified = false;

        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            const headerMatch = line.match(/^(#{3,6})\s+(.+)$/);
            if (!headerMatch) continue;

            const fullText = headerMatch[2].trim();
            const cleanTitle = fullText.replace(/\[\d+\]\s*$/, '').trim();
            const normTitle = this.normalizeSectionName(cleanTitle);

            if (normTitle === targetLeaf || normTitle === targetNormalized) {
                const countMatch = fullText.match(/\[(\d+)\]\s*$/);
                const currentCount = countMatch ? parseInt(countMatch[1], 10) : 0;
                newScore = currentCount + 1;
                lines[i] = `${headerMatch[1]} ${cleanTitle} [${newScore}]`;
                modified = true;
                break;
            }
        }

        if (modified) {
            await vscode.workspace.fs.writeFile(rootUri, Buffer.from(lines.join('\n'), 'utf8'));
        }

        return newScore;
    }

    public async updateKnowledge(
        sectionPath: string,
        newContent: string,
        workspaceFolder?: vscode.WorkspaceFolder
    ): Promise<{ success: boolean; uri?: vscode.Uri; error?: string }> {
        const cleanPath = sectionPath.trim().replace(/^\.?\/+/, '').replace(/\/+$/, '');
        const isRoot = !cleanPath || cleanPath === KnowledgeManager.ROOT_FILENAME;

        const targetUri = await this.getSectionUri(cleanPath, workspaceFolder);
        if (!targetUri) return { success: false, error: 'Cannot resolve knowledge directory.' };

        try {
            const dirUri = vscode.Uri.joinPath(targetUri, '..');
            await vscode.workspace.fs.createDirectory(dirUri);
            await vscode.workspace.fs.writeFile(targetUri, Buffer.from(newContent.trim() + '\n', 'utf8'));

            if (!isRoot) {
                await this.ensureEntryInRootIndex(cleanPath, workspaceFolder);
            }

            Logger.info(`Updated KNOWLEDGE.md at: ${targetUri.fsPath}`);
            return { success: true, uri: targetUri };
        } catch (err: any) {
            Logger.error(`Failed to update knowledge at ${cleanPath}: ${err.message}`);
            return { success: false, error: err.message };
        }
    }

    private async ensureEntryInRootIndex(sectionPath: string, workspaceFolder?: vscode.WorkspaceFolder): Promise<void> {
        const rootUri = await this.getRootKnowledgeUri(workspaceFolder);
        if (!rootUri) return;

        let content = await this.readRootKnowledge(workspaceFolder);
        if (!content) return;

        const segments = sectionPath.split(/[\/\\]+/).map(s => this.normalizeSectionName(s));
        const leaf = segments[segments.length - 1];

        const { entries } = this.parseIndexEntries(content);
        const flat = this.flattenEntries(entries);
        const exists = flat.some(e => e.normalizedPath === segments.join('/') || this.normalizeSectionName(e.title) === leaf);

        if (!exists) {
            const level = Math.min(6, 3 + (segments.length - 1));
            const hashes = '#'.repeat(level);
            const displayTitle = leaf.replace(/_/g, ' ');
            const newIndexLine = `${hashes} ${displayTitle} [1]`;

            if (content.includes('## Index')) {
                content = content.replace(/(##\s+Index[^\n]*\n)/i, `$1${newIndexLine}\n`);
            } else {
                content = `${content.trim()}\n\n## Index\n${newIndexLine}\n`;
            }

            await vscode.workspace.fs.writeFile(rootUri, Buffer.from(content, 'utf8'));
        }
    }

    /**
     * Conducts a deep architectural scrutiny of the codebase and compiles the full KNOWLEDGE.md tree.
     */
    public async scrutinizeAndBuildFullTree(
        lollmsAPI?: any,
        codeGraphManager?: any,
        contextManager?: any,
        signal?: AbortSignal,
        onProgress?: (status: string, pct: number) => void
    ): Promise<{ success: boolean; sectionsCount: number; rootUri?: vscode.Uri; error?: string }> {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) return { success: false, sectionsCount: 0, error: 'No workspace folder open.' };

        try {
            if (onProgress) onProgress("Scrutinizing codebase structure & symbols...", 15);

            if (codeGraphManager && (codeGraphManager.getBuildState() !== 'ready' || codeGraphManager.getGraphData().nodes.length === 0)) {
                await codeGraphManager.buildGraph(undefined, (p: any) => {
                    if (onProgress) onProgress(`Indexing symbols: ${p.status}`, Math.round(15 + p.percentage * 0.35));
                });
            }

            const graphData = codeGraphManager?.getGraphData() || { nodes: [], edges: [] };
            const projectName = folder.name || 'Workspace';

            const rootDir = vscode.Uri.joinPath(folder.uri, '.lollms');
            await vscode.workspace.fs.createDirectory(rootDir);
            const knowledgeBaseDir = vscode.Uri.joinPath(rootDir, KnowledgeManager.SUBDIR_NAME);
            await vscode.workspace.fs.createDirectory(knowledgeBaseDir);

            if (onProgress) onProgress("Clustering files into architectural modules...", 55);

            // Cluster nodes by directory path into clean section names
            const fileNodes = graphData.nodes.filter((n: any) => n.type === 'file');
            const clusters = new Map<string, { files: string[]; classes: any[]; functions: any[] }>();

            const getCleanSection = (filePath?: string): string => {
                if (!filePath) return 'Core_Services';
                const parts = filePath.replace(/\\/g, '/').split('/').filter(p => Boolean(p) && p !== '.' && p !== '..');
                if (parts.length <= 1) return 'Architecture_Overview';
                const dir = parts[0] === 'src' && parts.length > 2 ? parts[1] : parts[0];
                return this.normalizeSectionName(dir.charAt(0).toUpperCase() + dir.slice(1));
            };

            for (const fn of fileNodes) {
                const sec = getCleanSection(fn.filePath);
                if (!clusters.has(sec)) {
                    clusters.set(sec, { files: [], classes: [], functions: [] });
                }
                clusters.get(sec)!.files.push(fn.filePath || fn.label);
            }

            // Distribute symbols to clusters
            graphData.nodes.forEach((n: any) => {
                if (n.type === 'class' || n.type === 'function' || n.type === 'method') {
                    const sec = getCleanSection(n.filePath);
                    if (!clusters.has(sec)) {
                        clusters.set(sec, { files: [], classes: [], functions: [] });
                    }
                    if (n.type === 'class') clusters.get(sec)!.classes.push(n);
                    else clusters.get(sec)!.functions.push(n);
                }
            });

            if (!clusters.has('Architecture_Overview')) {
                clusters.set('Architecture_Overview', { files: ['README.md', 'package.json'], classes: [], functions: [] });
            }

            if (onProgress) onProgress("Synthesizing section knowledge files...", 75);

            let createdSectionsCount = 0;
            const indexLines: string[] = [];

            for (const [secName, data] of clusters.entries()) {
                if (signal?.aborted) throw new Error("Scrutiny cancelled by user.");

                const isMainOverview = secName === 'Architecture_Overview';
                const accessCount = isMainOverview ? 2 : 0;
                indexLines.push(`### ${secName} [${accessCount}]`);

                // Generate Section KNOWLEDGE.md
                let secMd = `## ${secName.replace(/_/g, ' ')}\n\n`;
                secMd += `### Role & Responsibilities\n`;
                secMd += `Handles ${secName.toLowerCase().replace(/_/g, ' ')} modules and associated domain logic.\n\n`;

                secMd += `### Files In Section\n`;
                secMd += (data.files.slice(0, 15).map(f => `- \`${f}\``).join('\n') || '- None') + '\n\n';

                if (data.classes.length > 0) {
                    secMd += `### Key Classes & Entities\n`;
                    data.classes.slice(0, 8).forEach(c => {
                        secMd += `- **\`${c.label}\`**${c.docstring ? `: ${c.docstring}` : ''}\n`;
                    });
                    secMd += '\n';
                }

                if (data.functions.length > 0) {
                    secMd += `### Key Function & Method Signatures\n`;
                    secMd += '```typescript\n';
                    data.functions.slice(0, 12).forEach(f => {
                        secMd += `${f.signature || f.label + '()'}\n`;
                    });
                    secMd += '```\n\n';
                }

                // Call and import relationships
                const sectionEdges = graphData.edges.filter((e: any) => 
                    data.files.some(f => e.source.includes(f) || e.target.includes(f))
                );
                const imports = sectionEdges.filter((e: any) => e.label === 'imports').slice(0, 10);
                if (imports.length > 0) {
                    secMd += `### Primary Dependencies\n`;
                    imports.forEach((imp: any) => {
                        const trg = graphData.nodes.find((n: any) => n.id === imp.target)?.label || imp.target;
                        secMd += `- Imports: \`${trg}\`\n`;
                    });
                    secMd += '\n';
                }

                await this.updateKnowledge(secName, secMd, folder);
                createdSectionsCount++;
            }

            if (onProgress) onProgress("Formulating Root KNOWLEDGE.md and Abstract...", 90);

            // Generate Root KNOWLEDGE.md
            const rootKnowledgeUri = await this.getRootKnowledgeUri(folder);
            if (!rootKnowledgeUri) throw new Error("Could not create root knowledge URI.");

            let abstractText = `This project (${projectName}) consists of ${fileNodes.length} discovered source files across ${clusters.size} core architectural modules. The codebase follows clean component boundaries, modular service decoupling, and strict type safety standards.`;
            
            // Try to extract doctrine from existing root knowledge if available
            const existingRoot = await this.readRootKnowledge(folder);
            if (existingRoot) {
                const parsed = this.parseIndexEntries(existingRoot);
                if (parsed.abstract.trim()) {
                    abstractText = parsed.abstract.trim();
                }
            }

            let rootMd = `# ${projectName}\n\n`;
            rootMd += `## Abstract\n\n${abstractText}\n\n`;
            rootMd += `## Index\n`;
            rootMd += indexLines.join('\n') + '\n';

            await vscode.workspace.fs.writeFile(rootKnowledgeUri, Buffer.from(rootMd, 'utf8'));

            if (onProgress) onProgress("Complete! Knowledge tree ready.", 100);

            return {
                success: true,
                sectionsCount: createdSectionsCount,
                rootUri: rootKnowledgeUri
            };
        } catch (err: any) {
            Logger.error("Scrutinize & Build Knowledge Tree failed:", err);
            return { success: false, sectionsCount: 0, error: err.message };
        }
    }

    public async resetKnowledge(workspaceFolder?: vscode.WorkspaceFolder): Promise<void> {
        const root = this.getKnowledgeRootUri(workspaceFolder);
        if (!root) return;

        try {
            const rootKnowledgeUri = vscode.Uri.joinPath(root, KnowledgeManager.ROOT_FILENAME);
            await vscode.workspace.fs.delete(rootKnowledgeUri, { useTrash: true }).then(undefined, () => {});

            const knowledgeDirUri = vscode.Uri.joinPath(root, KnowledgeManager.SUBDIR_NAME);
            await vscode.workspace.fs.delete(knowledgeDirUri, { recursive: true, useTrash: true }).then(undefined, () => {});

            const structUri = vscode.Uri.joinPath(root, 'structure.md');
            await vscode.workspace.fs.delete(structUri, { useTrash: true }).then(undefined, () => {});

            const folder = workspaceFolder || vscode.workspace.workspaceFolders?.[0];
            const projectName = folder?.name || 'Workspace';

            const initialKnowledge = `# ${projectName}

## Abstract
Knowledge base reset. Architectural findings and component contracts will be documented as the assistant works and learns.

## Index
### Architecture_Overview [1]
### Core_Services [0]
`;
            await vscode.workspace.fs.writeFile(rootKnowledgeUri, Buffer.from(initialKnowledge, 'utf8'));
            await vscode.workspace.fs.writeFile(structUri, Buffer.from(initialKnowledge, 'utf8'));

            Logger.info("Knowledge Base reset successfully.");
        } catch (err: any) {
            Logger.error("Failed to reset knowledge base:", err);
        }
    }

    public async renderContextKnowledge(
        workspaceFolder?: vscode.WorkspaceFolder,
        additionalUncollapsedPaths: string[] = []
    ): Promise<string> {
        const rootContent = await this.readRootKnowledge(workspaceFolder);
        if (!rootContent.trim()) {
            return "";
        }

        const { abstract, entries } = this.parseIndexEntries(rootContent);
        const flat = this.flattenEntries(entries);

        const scored = flat.filter(e => e.accessCount > 0);
        scored.sort((a, b) => b.accessCount - a.accessCount);

        const uncollapseTargetCount = Math.max(1, Math.ceil(scored.length * 0.3));
        const topScored = scored.slice(0, uncollapseTargetCount);

        const uncollapsedPaths = new Set<string>();
        topScored.forEach(e => uncollapsedPaths.add(e.normalizedPath));
        additionalUncollapsedPaths.forEach(p => {
            const clean = p.trim().replace(/^\.?\/+/, '').replace(/\/+$/, '');
            const norm = clean.split(/[\/\\]+/).map(s => this.normalizeSectionName(s)).join('/');
            uncollapsedPaths.add(norm);
        });

        const uncollapsedContents: { path: string; title: string; content: string }[] = [];

        for (const itemPath of uncollapsedPaths) {
            const text = await this.readSectionKnowledge(itemPath, workspaceFolder);
            if (text.trim()) {
                const title = itemPath.split('/').pop()?.replace(/_/g, ' ') || itemPath;
                uncollapsedContents.push({
                    path: itemPath,
                    title,
                    content: text.trim()
                });
            }
        }

        let output = `## 🏛️ CODE KNOWLEDGE (KNOWLEDGE.md)\n\n`;
        output += `${rootContent.trim()}\n\n`;

        if (uncollapsedContents.length > 0) {
            output += `### 📖 UNCOLLAPSED KNOWLEDGE SECTIONS (Top 30% Active)\n`;
            for (const section of uncollapsedContents) {
                output += `\n#### 📌 Section: \`${section.path}\` (${section.title})\n`;
                output += `\`\`\`markdown\n${section.content}\n\`\`\`\n`;
            }
        }

        return output.trim();
    }
}