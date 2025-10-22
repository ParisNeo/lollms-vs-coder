import * as vscode from 'vscode';
import * as path from 'path';
import { ContextStateProvider } from './commands/contextStateProvider';

export interface CodeGraphNode {
    id: string; // Unique ID, e.g., 'filepath:functionName'
    label: string;
    type: 'file' | 'class' | 'function';
    filePath: string;
    startLine: number;
    docstring?: string;
    command?: vscode.Command;
}

export interface CodeGraphEdge {
    id: string;
    source: string; // ID of the source node
    target: string; // ID of the target node
    label: 'contains' | 'calls';
}

export interface CodeGraph {
    nodes: CodeGraphNode[];
    edges: CodeGraphEdge[];
}

export class CodeGraphManager {
    private graphData: CodeGraph = { nodes: [], edges: [] };
    private contextStateProvider: ContextStateProvider | undefined;
    private buildState: 'idle' | 'built' = 'idle';

    constructor() {}

    public setContextStateProvider(provider: ContextStateProvider | undefined) {
        this.contextStateProvider = provider;
    }

    public getGraphData(): CodeGraph {
        return this.graphData;
    }

    public getBuildState(): 'idle' | 'built' {
        return this.buildState;
    }

    private symbolKindToNodeType(kind: vscode.SymbolKind): CodeGraphNode['type'] | null {
        switch (kind) {
            case vscode.SymbolKind.Class:
            case vscode.SymbolKind.Interface:
            case vscode.SymbolKind.Struct:
                return 'class';
            case vscode.SymbolKind.Function:
            case vscode.SymbolKind.Method:
            case vscode.SymbolKind.Constructor:
                return 'function';
            default:
                return null;
        }
    }
    
    private flattenSymbols(symbols: vscode.DocumentSymbol[]): vscode.DocumentSymbol[] {
        const flattened: vscode.DocumentSymbol[] = [];
        const queue = [...symbols];
        while (queue.length > 0) {
            const symbol = queue.shift()!;
            flattened.push(symbol);
            queue.push(...symbol.children);
        }
        return flattened;
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
        const allVisibleFiles = await this.contextStateProvider.getAllVisibleFiles();
        const newGraph: CodeGraph = { nodes: [], edges: [] };

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Building Code Graph",
            cancellable: true
        }, async (progress, token) => {
            // --- PASS 1: Find all files and symbols ---
            progress.report({ message: "Scanning files for symbols..." });
            for (const relativePath of allVisibleFiles) {
                if (token.isCancellationRequested) return;
                
                const fileUri = vscode.Uri.joinPath(workspaceRoot, relativePath);
                newGraph.nodes.push({
                    id: relativePath, label: path.basename(relativePath), type: 'file', filePath: relativePath, startLine: 0,
                    command: { command: 'vscode.open', title: 'Open File', arguments: [fileUri] }
                });

                try {
                    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                        'vscode.executeDocumentSymbolProvider', fileUri
                    );
                    if (symbols) {
                        for (const symbol of this.flattenSymbols(symbols)) {
                            const nodeType = this.symbolKindToNodeType(symbol.kind);
                            if (nodeType) {
                                const nodeId = `${relativePath}:${symbol.name}`;
                                newGraph.nodes.push({
                                    id: nodeId, label: symbol.name, type: nodeType, filePath: relativePath, startLine: symbol.range.start.line,
                                    docstring: symbol.detail || `A ${nodeType} defined in ${path.basename(relativePath)}`,
                                    command: { command: 'vscode.open', title: 'Go to Definition', arguments: [fileUri, { selection: symbol.selectionRange }] }
                                });
                                newGraph.edges.push({ id: `${relativePath}->${nodeId}`, source: relativePath, target: nodeId, label: 'contains' });
                            }
                        }
                    }
                } catch (e) { console.warn(`Could not get symbols for ${relativePath}:`, e); }
            }

            // --- PASS 2: Find connections (references) ---
            const symbolNodes = newGraph.nodes.filter(n => n.type === 'function' || n.type === 'class');
            let processedSymbols = 0;
            for (const symbolNode of symbolNodes) {
                if (token.isCancellationRequested) return;
                processedSymbols++;
                progress.report({ message: `Finding references for ${symbolNode.label}`, increment: (processedSymbols / symbolNodes.length) * 100 });
                
                const symbolUri = vscode.Uri.joinPath(workspaceRoot, symbolNode.filePath);
                const symbolPosition = new vscode.Position(symbolNode.startLine, 0);

                try {
                    const references = await vscode.commands.executeCommand<vscode.Location[]>(
                        'vscode.executeReferenceProvider', symbolUri, symbolPosition
                    );
                    if (references) {
                        for (const ref of references) {
                            const refRelativePath = vscode.workspace.asRelativePath(ref.uri, false);
                            const callingSymbolNode = newGraph.nodes.find(n => 
                                n.filePath === refRelativePath &&
                                n.type === 'function' &&
                                ref.range.start.line >= n.startLine
                            );
                            
                            if (callingSymbolNode && callingSymbolNode.id !== symbolNode.id) {
                                newGraph.edges.push({
                                    id: `${callingSymbolNode.id}->${symbolNode.id}`,
                                    source: callingSymbolNode.id,
                                    target: symbolNode.id,
                                    label: 'calls'
                                });
                            }
                        }
                    }
                } catch (e) { console.warn(`Could not get references for ${symbolNode.label}:`, e); }
            }
        });
        
        this.graphData = newGraph;
        this.buildState = 'built';
    }
}