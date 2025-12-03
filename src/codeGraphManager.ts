import * as vscode from 'vscode';
import * as path from 'path';
import { ContextStateProvider } from './commands/contextStateProvider';
import { Logger } from './logger';

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
    label: 'contains' | 'calls' | 'imports';
}

export interface CodeGraph {
    nodes: CodeGraphNode[];
    edges: CodeGraphEdge[];
}

export class CodeGraphManager {
    private graphData: CodeGraph = { nodes: [], edges: [] };
    private contextStateProvider: ContextStateProvider | undefined;
    private buildState: 'idle' | 'building' | 'built' = 'idle';
    private workspaceRoot: vscode.Uri | undefined;

    constructor() {}

    public setContextStateProvider(provider: ContextStateProvider | undefined) {
        this.contextStateProvider = provider;
    }

    public setWorkspaceRoot(uri: vscode.Uri) {
        this.workspaceRoot = uri;
        this.loadGraph();
    }

    public getGraphData(): CodeGraph {
        return this.graphData;
    }

    public getBuildState(): 'idle' | 'building' | 'built' {
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

    public async saveGraph(): Promise<void> {
        if (!this.workspaceRoot) return;
        const lollmsDir = vscode.Uri.joinPath(this.workspaceRoot, '.lollms');
        try {
            await vscode.workspace.fs.createDirectory(lollmsDir);
            const graphFile = vscode.Uri.joinPath(lollmsDir, 'code_graph.json');
            const data = Buffer.from(JSON.stringify(this.graphData, null, 2), 'utf8');
            await vscode.workspace.fs.writeFile(graphFile, data);
        } catch (e) {
            Logger.error("Failed to save code graph:", e);
        }
    }

    public async loadGraph(): Promise<void> {
        if (!this.workspaceRoot) return;
        try {
            const graphFile = vscode.Uri.joinPath(this.workspaceRoot, '.lollms', 'code_graph.json');
            const content = await vscode.workspace.fs.readFile(graphFile);
            this.graphData = JSON.parse(content.toString());
            this.buildState = 'built';
        } catch (e) {
            // File might not exist yet
            this.graphData = { nodes: [], edges: [] };
            this.buildState = 'idle';
        }
    }

    public generateMermaid(type: 'import_graph' | 'class_diagram' | 'call_graph'): string {
        if (this.graphData.nodes.length === 0) return "graph TD\nNode[Graph is empty]";

        let mermaid = "";
        const nodes = new Set<string>();
        const edges: string[] = [];
        
        // Helper to make IDs mermaid-safe
        const sanitizeId = (id: string) => id.replace(/[^a-zA-Z0-9]/g, '_');
        // Helper to escape labels - replace double quotes with single quotes to avoid syntax errors
        const escapeLabel = (label: string) => label.replace(/"/g, "'").replace(/\n/g, ' ');

        if (type === 'import_graph') {
            mermaid = "graph LR\n";
            this.graphData.edges.filter(e => e.label === 'imports').forEach(e => {
                const source = sanitizeId(e.source);
                const target = sanitizeId(e.target);
                const sourceNode = this.graphData.nodes.find(n => n.id === e.source);
                const targetNode = this.graphData.nodes.find(n => n.id === e.target);
                
                const sourceLabel = sourceNode ? escapeLabel(sourceNode.label) : e.source;
                const targetLabel = targetNode ? escapeLabel(targetNode.label) : e.target;
                
                nodes.add(`${source}["${sourceLabel}"]`);
                nodes.add(`${target}["${targetLabel}"]`);
                edges.push(`${source} --> ${target}`);
            });
            // If no edges, add disjoint file nodes
            if (edges.length === 0) {
                this.graphData.nodes.filter(n => n.type === 'file').forEach(n => {
                    nodes.add(`${sanitizeId(n.id)}["${escapeLabel(n.label)}"]`);
                });
            }
        } else if (type === 'class_diagram') {
            mermaid = "classDiagram\n";
            let hasClasses = false;
            this.graphData.nodes.filter(n => n.type === 'class').forEach(n => {
                hasClasses = true;
                const className = sanitizeId(n.label);
                mermaid += `class ${className}\n`;
                
                // Find methods
                const methodEdges = this.graphData.edges.filter(e => e.source === n.id && e.label === 'contains');
                methodEdges.forEach(me => {
                    const methodNode = this.graphData.nodes.find(mn => mn.id === me.target);
                    if (methodNode && (methodNode.type === 'function' || methodNode.type === 'function')) {
                        mermaid += `${className} : +${escapeLabel(methodNode.label)}()\n`;
                    }
                });
            });
            if (!hasClasses) return "graph TD\nEmpty[No classes found]";
            return mermaid;
        } else { // call_graph (default)
            mermaid = "graph TD\n";
            
            // Add all nodes that are relevant (files, functions, classes)
            this.graphData.nodes.forEach(n => {
                nodes.add(`${sanitizeId(n.id)}["${escapeLabel(n.label)}"]`);
            });

            // Add edges: 'calls' as solid, 'contains' as dashed
            this.graphData.edges.forEach(e => {
                if (e.label === 'calls' || e.label === 'contains') {
                    const source = sanitizeId(e.source);
                    const target = sanitizeId(e.target);
                    
                    if (e.label === 'contains') {
                        edges.push(`${source} -.-> ${target}`);
                    } else {
                        edges.push(`${source} -->|calls| ${target}`);
                    }
                }
            });
        }

        if (nodes.size === 0 && edges.length === 0 && type !== 'class_diagram') {
            return `${mermaid}Empty[No ${type} structure found]`;
        }

        nodes.forEach(n => mermaid += `    ${n}\n`);
        edges.forEach(e => mermaid += `    ${e}\n`);

        return mermaid;
    }

    public async buildGraph(): Promise<void> {
        if (!this.contextStateProvider) {
            vscode.window.showWarningMessage("Code Graph: Context provider not ready.");
            return;
        }
        
        const rootUri = this.workspaceRoot || (vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0].uri : undefined);
        if (!rootUri) {
             vscode.window.showErrorMessage("Code Graph: No workspace root found.");
             return;
        }

        const allVisibleFiles = await this.contextStateProvider.getAllVisibleFiles();
        if (allVisibleFiles.length === 0) {
             vscode.window.showInformationMessage("Code Graph: No files found in context.");
             this.graphData = { nodes: [], edges: [] };
             this.buildState = 'built';
             await this.saveGraph();
             return;
        }
        
        const newGraph: CodeGraph = { nodes: [], edges: [] };
        this.buildState = 'building';

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Building Code Graph",
            cancellable: true
        }, async (progress, token) => {
            // --- PASS 1: Find all files and symbols ---
            progress.report({ message: "Scanning files for symbols..." });
            for (const relativePath of allVisibleFiles) {
                if (token.isCancellationRequested) return;
                
                const fileUri = vscode.Uri.joinPath(rootUri, relativePath);
                
                try {
                    const stat = await vscode.workspace.fs.stat(fileUri);
                    if (stat.type === vscode.FileType.Directory) continue;
                } catch (e) { continue; }

                newGraph.nodes.push({
                    id: relativePath, label: path.basename(relativePath), type: 'file', filePath: relativePath, startLine: 0,
                    docstring: relativePath,
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
                } catch (e) { 
                    Logger.debug(`Could not get symbols for ${relativePath}`, e); 
                }
            }

            // --- PASS 1.5: Find imports ---
            progress.report({ message: "Scanning for imports..." });
            const importRegex = /^(?:import|export)(?:[^{}]*|\{[^}]*\})\s*from\s*['"]([^'"]+)['"];?|import\s*['"]([^'"]+)['"];?|require\s*\(\s*['"]([^'"]+)['"]\s*\)/gm;

            for (const sourcePath of allVisibleFiles) {
                if (token.isCancellationRequested) return;

                const fileUri = vscode.Uri.joinPath(rootUri, sourcePath);
                try {
                    const stat = await vscode.workspace.fs.stat(fileUri);
                    if (stat.type === vscode.FileType.Directory) continue;
                } catch (e) { continue; }

                try {
                    const content = (await vscode.workspace.fs.readFile(fileUri)).toString();
                    
                    let match;
                    while ((match = importRegex.exec(content)) !== null) {
                        const importPath = match[1] || match[2] || match[3];
                        if (!importPath || !importPath.startsWith('.')) continue; // Only handle relative imports

                        const sourceDir = path.dirname(sourcePath);
                        const targetPath = path.join(sourceDir, importPath);
                        const normalizedTargetPath = path.normalize(targetPath).replace(/\\/g, '/');

                        const possibleExtensions = ['', '.ts', '.js', '.tsx', '.jsx', '/index.ts', '/index.js', '.py'];
                        let resolvedPath: string | null = null;

                        for (const ext of possibleExtensions) {
                            const tempPath = normalizedTargetPath + ext;
                            if (newGraph.nodes.some(n => n.id === tempPath && n.type === 'file')) {
                                resolvedPath = tempPath;
                                break;
                            }
                        }

                        if (resolvedPath) {
                            newGraph.edges.push({
                                id: `${sourcePath}->import->${resolvedPath}`,
                                source: sourcePath,
                                target: resolvedPath,
                                label: 'imports'
                            });
                        }
                    }
                } catch (e) {
                    Logger.debug(`Could not read or parse imports for ${sourcePath}`, e);
                }
            }
            
            // --- PASS 2: Find connections (references) ---
            const symbolNodes = newGraph.nodes.filter(n => n.type === 'function' || n.type === 'class');
            const totalSymbols = symbolNodes.length;
            const limit = 50; 
            
            if (totalSymbols > 0) {
                progress.report({ message: "Resolving references (limit 50)..." });
                for (let i = 0; i < Math.min(symbolNodes.length, limit); i++) {
                    const symbolNode = symbolNodes[i];
                    if (token.isCancellationRequested) return;
                    progress.report({ message: `Finding references for ${symbolNode.label}`, increment: (1 / limit) * 100 });
                    
                    const symbolUri = vscode.Uri.joinPath(rootUri, symbolNode.filePath);
                    const symbolPosition = new vscode.Position(symbolNode.startLine, 0);

                    try {
                        const references = await vscode.commands.executeCommand<vscode.Location[]>(
                            'vscode.executeReferenceProvider', symbolUri, symbolPosition
                        );
                        if (references) {
                            for (const ref of references) {
                                const refRelativePath = vscode.workspace.asRelativePath(ref.uri, false);
                                if (refRelativePath === symbolNode.filePath && ref.range.start.line === symbolNode.startLine) continue;

                                const callingSymbolNode = newGraph.nodes.find(n => 
                                    n.filePath === refRelativePath &&
                                    (n.type === 'function' || n.type === 'class') && 
                                    n.startLine <= ref.range.start.line
                                );
                                
                                if (callingSymbolNode && callingSymbolNode.id !== symbolNode.id) {
                                    const edgeId = `${callingSymbolNode.id}->calls->${symbolNode.id}`;
                                    if (!newGraph.edges.some(e => e.id === edgeId)) {
                                        newGraph.edges.push({
                                            id: edgeId,
                                            source: callingSymbolNode.id,
                                            target: symbolNode.id,
                                            label: 'calls'
                                        });
                                    }
                                }
                            }
                        }
                    } catch (e) { 
                        Logger.debug(`Could not get references for ${symbolNode.label}`, e); 
                    }
                }
            }
        });
        
        this.graphData = newGraph;
        this.buildState = 'built';
        await this.saveGraph();
    }
}
