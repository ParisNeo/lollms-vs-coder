import * as vscode from 'vscode';
import * as path from 'path';
import { ContextStateProvider } from './commands/contextStateProvider';
import { Logger } from './logger';

export interface CodeGraphNode {
    id: string;
    label: string;
    type: 'file' | 'class' | 'interface' | 'function' | 'property' | 'variable';
    filePath: string;
    startLine: number;
    docstring?: string;
    command?: vscode.Command;
}

export interface CodeGraphEdge {
    id: string;
    source: string;
    target: string;
    label: 'contains' | 'calls' | 'imports' | 'inherits';
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
            case vscode.SymbolKind.Struct:
                return 'class';
            case vscode.SymbolKind.Interface:
                return 'interface';
            case vscode.SymbolKind.Function:
            case vscode.SymbolKind.Method:
            case vscode.SymbolKind.Constructor:
                return 'function';
            case vscode.SymbolKind.Property:
            case vscode.SymbolKind.Field:
            case vscode.SymbolKind.Variable:
            case vscode.SymbolKind.EnumMember:
            case vscode.SymbolKind.Enum: 
                return kind === vscode.SymbolKind.Enum ? 'class' : 'property';
            default:
                return null;
        }
    }
    
    private processSymbols(
        relativePath: string, 
        symbols: vscode.DocumentSymbol[], 
        parentId: string, 
        nodes: CodeGraphNode[], 
        edges: CodeGraphEdge[], 
        fileUri: vscode.Uri
    ) {
        for (const symbol of symbols) {
            const nodeType = this.symbolKindToNodeType(symbol.kind);
            
            if (nodeType) {
                const nodeId = `${parentId}:${symbol.name}`;
                
                if (!nodes.some(n => n.id === nodeId)) {
                    nodes.push({
                        id: nodeId,
                        label: symbol.name,
                        type: nodeType,
                        filePath: relativePath,
                        startLine: symbol.range.start.line,
                        docstring: symbol.detail || undefined,
                        command: { command: 'vscode.open', title: 'Go to Definition', arguments: [fileUri, { selection: symbol.selectionRange }] }
                    });

                    edges.push({
                        id: `${parentId}->${nodeId}`,
                        source: parentId,
                        target: nodeId,
                        label: 'contains'
                    });
                }

                if (symbol.children && symbol.children.length > 0) {
                    this.processSymbols(relativePath, symbol.children, nodeId, nodes, edges, fileUri);
                }
            } else {
                if (symbol.kind === vscode.SymbolKind.Module || symbol.kind === vscode.SymbolKind.Namespace || symbol.kind === vscode.SymbolKind.Package) {
                     const nodeId = `${parentId}:${symbol.name}`;
                     nodes.push({
                        id: nodeId, label: symbol.name, type: 'file',
                        filePath: relativePath, startLine: symbol.range.start.line,
                        command: { command: 'vscode.open', title: 'Go to Definition', arguments: [fileUri, { selection: symbol.selectionRange }] }
                     });
                     edges.push({ id: `${parentId}->${nodeId}`, source: parentId, target: nodeId, label: 'contains' });
                     if (symbol.children) this.processSymbols(relativePath, symbol.children, nodeId, nodes, edges, fileUri);
                } else if (symbol.children && symbol.children.length > 0) {
                    this.processSymbols(relativePath, symbol.children, parentId, nodes, edges, fileUri);
                }
            }
        }
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
            this.graphData = { nodes: [], edges: [] };
            this.buildState = 'idle';
        }
    }

    public generateMermaid(type: 'import_graph' | 'class_diagram' | 'call_graph' | 'inheritance_graph'): string {
        if (this.graphData.nodes.length === 0) return "graph TD\nNode[Graph is empty]";

        let mermaid = "";
        const nodes = new Set<string>();
        const edges: string[] = [];
        
        const sanitizeId = (id: string) => id.replace(/[^a-zA-Z0-9]/g, '_');
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
            if (edges.length === 0) {
                this.graphData.nodes.filter(n => n.type === 'file').forEach(n => {
                    nodes.add(`${sanitizeId(n.id)}["${escapeLabel(n.label)}"]`);
                });
            }
        } else if (type === 'class_diagram') {
            mermaid = "classDiagram\n";
            let hasClasses = false;
            this.graphData.nodes.filter(n => n.type === 'class' || n.type === 'interface').forEach(n => {
                hasClasses = true;
                const className = sanitizeId(n.label);
                
                if (n.type === 'interface') {
                    mermaid += `class ${className} {\n    <<interface>>\n`;
                } else {
                    mermaid += `class ${className} {\n`;
                }
                
                const childrenEdges = this.graphData.edges.filter(e => e.source === n.id && e.label === 'contains');
                childrenEdges.forEach(ce => {
                    const childNode = this.graphData.nodes.find(cn => cn.id === ce.target);
                    if (childNode) {
                        if (childNode.type === 'function') {
                            mermaid += `    +${escapeLabel(childNode.label)}()\n`;
                        } else if (childNode.type === 'property' || childNode.type === 'variable') {
                            mermaid += `    +${escapeLabel(childNode.label)}\n`;
                        }
                    }
                });
                mermaid += `}\n`;
                
                const inheritEdges = this.graphData.edges.filter(e => e.source === n.id && e.label === 'inherits');
                inheritEdges.forEach(ie => {
                    const parentNode = this.graphData.nodes.find(pn => pn.id === ie.target);
                    if (parentNode) {
                        mermaid += `${sanitizeId(parentNode.label)} <|-- ${className}\n`;
                    }
                });
            });
            if (!hasClasses) return "graph TD\nEmpty[No classes found]";
            return mermaid;
        } else if (type === 'inheritance_graph') {
            mermaid = "graph TD\n";
            const inheritEdges = this.graphData.edges.filter(e => e.label === 'inherits');
            
            inheritEdges.forEach(e => {
                const source = sanitizeId(e.source);
                const target = sanitizeId(e.target);
                const sourceNode = this.graphData.nodes.find(n => n.id === e.source);
                const targetNode = this.graphData.nodes.find(n => n.id === e.target);
                
                if (sourceNode && targetNode) {
                    nodes.add(`${source}["${escapeLabel(sourceNode.label)}"]`);
                    nodes.add(`${target}["${escapeLabel(targetNode.label)}"]`);
                    edges.push(`${target} --> ${source}`); // Parent points to child in TD, or Child -> Parent. UML is Child -> Parent.
                }
            });
            if (edges.length === 0) return "graph TD\nEmpty[No inheritance relationships found]";
        } else { // call_graph
            mermaid = "graph TD\n";
            this.graphData.nodes.forEach(n => {
                if (n.type !== 'property' && n.type !== 'variable') {
                    nodes.add(`${sanitizeId(n.id)}["${escapeLabel(n.label)}"]`);
                }
            });
            this.graphData.edges.forEach(e => {
                if (e.label === 'calls' || e.label === 'contains') {
                    const sourceNode = this.graphData.nodes.find(n => n.id === e.source);
                    const targetNode = this.graphData.nodes.find(n => n.id === e.target);
                    if (sourceNode?.type === 'property' || targetNode?.type === 'property') return;

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
            progress.report({ message: "Scanning files..." });
            
            // Regex for inheritance: 
            // TS/JS: class Child extends Parent
            // Python: class Child(Parent):
            const tsInheritanceRegex = /class\s+([a-zA-Z0-9_]+)(?:\s*<[^>]*>)?\s+extends\s+([a-zA-Z0-9_]+)/g;
            const pyInheritanceRegex = /class\s+([a-zA-Z0-9_]+)\s*\(\s*([a-zA-Z0-9_]+)\s*\):/g;
            const importRegex = /^(?:import|export)(?:[^{}]*|\{[^}]*\})\s*from\s*['"]([^'"]+)['"];?|import\s*['"]([^'"]+)['"];?|require\s*\(\s*['"]([^'"]+)['"]\s*\)/gm;

            for (const relativePath of allVisibleFiles) {
                if (token.isCancellationRequested) return;
                
                const fileUri = vscode.Uri.joinPath(rootUri, relativePath);
                
                // Add File Node
                newGraph.nodes.push({
                    id: relativePath, label: path.basename(relativePath), type: 'file', filePath: relativePath, startLine: 0,
                    docstring: relativePath,
                    command: { command: 'vscode.open', title: 'Open File', arguments: [fileUri] }
                });

                try {
                    const contentBytes = await vscode.workspace.fs.readFile(fileUri);
                    const content = Buffer.from(contentBytes).toString('utf8');

                    // 1. Process Symbols
                    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                        'vscode.executeDocumentSymbolProvider', fileUri
                    );
                    if (symbols) {
                        this.processSymbols(relativePath, symbols, relativePath, newGraph.nodes, newGraph.edges, fileUri);
                    }

                    // 2. Process Inheritance (Regex)
                    let match;
                    const ext = path.extname(relativePath).toLowerCase();
                    const regex = (ext === '.py') ? pyInheritanceRegex : tsInheritanceRegex;
                    
                    // Reset regex state
                    regex.lastIndex = 0;
                    
                    while ((match = regex.exec(content)) !== null) {
                        const className = match[1];
                        const parentName = match[2];
                        
                        // Find nodes for these classes in the current file first
                        // Note: Parent might be imported, so finding it is harder without full resolution.
                        // We will try to find a class node with matching name in the graph.
                        // Ideally we restrict to this file or imported files, but for now we search globally to link them.
                        
                        // We need the ID. The class node ID format is "filepath:ClassName"
                        const classNode = newGraph.nodes.find(n => n.label === className && (n.type === 'class' || n.type === 'interface') && n.filePath === relativePath);
                        
                        if (classNode) {
                            // Find parent node. It might not be scanned yet if it's in a later file.
                            // We will do a second pass or just store the relationship strings and link later.
                            // For simplicity in this pass, we store the edge with a placeholder ID if we can't find it,
                            // or better, postpone linking.
                            // Actually, let's just push a potential edge and filter invalid ones later or use a label matching heuristic.
                            
                            // Strategy: Add a temporary edge request
                            newGraph.edges.push({
                                id: `REQ_INHERIT:${classNode.id}:${parentName}`,
                                source: classNode.id,
                                target: `POTENTIAL:${parentName}`, // Placeholder
                                label: 'inherits'
                            });
                        }
                    }

                    // 3. Process Imports (Regex)
                    importRegex.lastIndex = 0;
                    while ((match = importRegex.exec(content)) !== null) {
                        const importPath = match[1] || match[2] || match[3];
                        if (!importPath || !importPath.startsWith('.')) continue;

                        const sourceDir = path.dirname(relativePath);
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
                                id: `${relativePath}->import->${resolvedPath}`,
                                source: relativePath,
                                target: resolvedPath,
                                label: 'imports'
                            });
                        }
                    }

                } catch (e) { 
                    Logger.debug(`Error processing file ${relativePath}`, e); 
                }
            }

            // --- PASS 2: Resolve Inheritance and References ---
            
            // 2a. Fix Inheritance Edges
            // We have edges with target `POTENTIAL:ParentName`. We try to find a class node with label `ParentName`.
            const inheritRequests = newGraph.edges.filter(e => e.target.startsWith('POTENTIAL:'));
            const finalEdges = newGraph.edges.filter(e => !e.target.startsWith('POTENTIAL:'));
            
            for (const req of inheritRequests) {
                const parentName = req.target.replace('POTENTIAL:', '');
                // Try to find a class with this name. 
                // Priority: Same file > Imported files > Global
                // Simplified: Global search for class with that name
                const parentNode = newGraph.nodes.find(n => n.label === parentName && (n.type === 'class' || n.type === 'interface'));
                
                if (parentNode) {
                    finalEdges.push({
                        id: `${req.source}->inherits->${parentNode.id}`,
                        source: req.source,
                        target: parentNode.id,
                        label: 'inherits'
                    });
                }
            }
            newGraph.edges = finalEdges;

            // 2b. References (Limit 50)
            const symbolNodes = newGraph.nodes.filter(n => n.type === 'function' || n.type === 'class');
            const limit = 50; 
            
            if (symbolNodes.length > 0) {
                progress.report({ message: "Resolving references (limit 50)..." });
                for (let i = 0; i < Math.min(symbolNodes.length, limit); i++) {
                    const symbolNode = symbolNodes[i];
                    if (token.isCancellationRequested) return;
                    
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
                    } catch (e) { }
                }
            }
        });
        
        this.graphData = newGraph;
        this.buildState = 'built';
        await this.saveGraph();
    }
}
