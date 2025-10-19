import * as vscode from 'vscode';
import { ContextStateProvider } from './commands/contextStateProvider';
import * as path from 'path';

export interface CodeGraphNode {
    id: string; // e.g., 'file_path:ClassName.methodName'
    label: string;
    type: 'file' | 'class' | 'function' | 'method' | 'enum';
    filePath: string;
    startLine: number;
    children: CodeGraphNode[];
}

export class CodeGraphManager {
    private graphData: CodeGraphNode[] = [];
    private contextStateProvider: ContextStateProvider | undefined;
    private buildState: 'idle' | 'built' = 'idle';

    constructor() {}

    public setContextStateProvider(provider: ContextStateProvider | undefined) {
        this.contextStateProvider = provider;
    }

    public getGraphData(): CodeGraphNode[] {
        return this.graphData;
    }

    public getBuildState(): 'idle' | 'built' {
        return this.buildState;
    }

    public async buildGraph(): Promise<void> {
        if (!this.contextStateProvider) {
            vscode.window.showWarningMessage("Cannot build code graph: Context provider is not available.");
            return;
        }

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            vscode.window.showWarningMessage("Please open a workspace folder to build a code graph.");
            return;
        }
        const workspaceRoot = workspaceFolders[0].uri;

        this.graphData = [];
        const includedFiles = await this.contextStateProvider.getAllVisibleFiles();

        if (includedFiles.length === 0) {
            this.buildState = 'built'; // Mark as built, even if empty
            vscode.window.showInformationMessage("Code graph build finished: No visible files to analyze.");
            return;
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Building Code Graph...",
            cancellable: true
        }, async (progress, token) => {
            let processedFiles = 0;
            for (const relativePath of includedFiles) {
                if (token.isCancellationRequested) break;
                
                processedFiles++;
                progress.report({ message: `Parsing ${relativePath}`, increment: (1 / includedFiles.length) * 100 });

                try {
                    const fileUri = vscode.Uri.joinPath(workspaceRoot, relativePath);
                    const document = await vscode.workspace.openTextDocument(fileUri);
                    const fileNode = this.parseDocument(document);
                    if (fileNode.children.length > 0) {
                        this.graphData.push(fileNode);
                    }
                } catch (error) {
                    console.warn(`Could not parse file ${relativePath}:`, error);
                }
            }
        });

        this.buildState = 'built';
    }

    private parseDocument(document: vscode.TextDocument): CodeGraphNode {
        const relativePath = vscode.workspace.asRelativePath(document.uri, false);
        const fileNode: CodeGraphNode = {
            id: relativePath,
            label: path.basename(relativePath),
            type: 'file',
            filePath: relativePath,
            startLine: 0,
            children: []
        };

        const text = document.getText();
        const lang = document.languageId;
        
        // Very basic regex-based parsing. This can be improved significantly.
        let classRegex: RegExp | null = null;
        let functionRegex: RegExp | null = null;
        
        if (lang === 'typescript' || lang === 'javascript') {
            classRegex = /class\s+([A-Za-z0-9_]+)/g;
            functionRegex = /(?:function\s+([A-Za-z0-9_]+)|(?:const|let|var)\s+([A-Za-z0-9_]+)\s*=\s*(?:async)?\s*\()/g;
        } else if (lang === 'python') {
            classRegex = /class\s+([A-Za-z0-9_]+):/g;
            functionRegex = /def\s+([A-Za-z0-9_]+)\s*\(/g;
        }

        let match;
        if (classRegex) {
            while ((match = classRegex.exec(text)) !== null) {
                const className = match[1];
                const pos = document.positionAt(match.index);
                const classNode: CodeGraphNode = {
                    id: `${relativePath}:${className}`,
                    label: className,
                    type: 'class',
                    filePath: relativePath,
                    startLine: pos.line,
                    children: []
                };
                fileNode.children.push(classNode);
            }
        }
        
        if (functionRegex) {
            while ((match = functionRegex.exec(text)) !== null) {
                const funcName = match[1] || match[2];
                if (!funcName) continue;

                const pos = document.positionAt(match.index);
                const funcNode: CodeGraphNode = {
                    id: `${relativePath}:${funcName}`,
                    label: `${funcName}()`,
                    type: 'function',
                    filePath: relativePath,
                    startLine: pos.line,
                    children: []
                };
                fileNode.children.push(funcNode);
            }
        }

        return fileNode;
    }
}