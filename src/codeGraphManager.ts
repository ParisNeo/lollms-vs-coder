import * as vscode from 'vscode';
import * as path from 'path';

export type GraphNode = {
    id: string;
    label: string;
    type: string;
    filePath?: string;
    startLine?: number;
    docstring?: string;
    methods?: string[];
    attributes?: string[];
};

export type GraphEdge = {
    id: string;
    source: string;
    target: string;
    label: string;
};

export type GraphData = {
    nodes: GraphNode[];
    edges: GraphEdge[];
};

export type BuildState = 'idle' | 'building' | 'ready' | 'error';

export type ContextSetter = (key: string, value: any) => void;

export class CodeGraphManager {

    private workspaceRoot?: vscode.Uri;
    private graph: GraphData = { nodes: [], edges: [] };
    private buildState: BuildState = 'idle';
    private lastError?: string;
    private contextSetter?: ContextSetter;
    private abortController?: AbortController;

    constructor(workspaceRoot?: vscode.Uri) {
        if (workspaceRoot) {
            this.workspaceRoot = workspaceRoot;
        }
    }

    /* =========================
       CONTEXT / WORKSPACE
       ========================= */

    setWorkspaceRoot(uri: vscode.Uri) {
        this.workspaceRoot = uri;
        this.reset();
    }

    setContextSetter(provider: ContextSetter) {
        this.contextSetter = provider;
    }

    /* =========================
       BUILD PIPELINE
       ========================= */

    cancel() {
        if (this.buildState === 'building' && this.abortController) {
            this.abortController.abort();
            this.buildState = 'idle';
            this.contextSetter?.('codeGraph.building', false);
            this.contextSetter?.('codeGraph.ready', false);
        }
    }

    async buildGraph() {
        // Cancel any existing operation
        this.cancel();

        if (!this.workspaceRoot) {
            this.fail('Workspace root not defined');
            return;
        }

        this.buildState = 'building';
        this.lastError = undefined;
        this.abortController = new AbortController();
        const signal = this.abortController.signal;

        this.contextSetter?.('codeGraph.building', true);
        this.contextSetter?.('codeGraph.ready', false);
        this.contextSetter?.('codeGraph.error', false);

        try {
            if (signal.aborted) return;

            // Aggressive exclusion pattern to improve performance on large repos
            // Excludes standard build/dependency folders
            const excludePattern = '**/{node_modules,venv,.venv,.git,dist,build,out,bin,obj,.vscode,.idea,.lollms,__pycache__,target,*.egg-info,vendor}/**';

            // Find code files only
            const files = await vscode.workspace.findFiles(
                new vscode.RelativePattern(this.workspaceRoot, '**/*.{ts,js,jsx,tsx,py,cpp,h,hpp,c,java,cs,go,rs,php,rb}'),
                excludePattern,
                undefined, // maxResults
                // Note: VS Code findFiles accepts a CancellationToken which we could use, 
                // but we also need manual checks in the loop below.
            );

            if (signal.aborted) return;

            const nodes: GraphNode[] = [];
            const edges: GraphEdge[] = [];
            
            const fileNodeMap = new Map<string, string>();
            const classNodeMap = new Map<string, string>();

            let nodeId = 0;
            let edgeId = 0;

            // --- PASS 1: Create Nodes for Files ---
            for (const file of files) {
                if (signal.aborted) return;

                const relativePath = vscode.workspace.asRelativePath(file);
                const normalizedPath = relativePath.replace(/\\/g, '/');

                const fileNodeId = `file_${nodeId++}`;
                nodes.push({
                    id: fileNodeId,
                    label: path.basename(relativePath),
                    type: 'file',
                    filePath: relativePath,
                    startLine: 0
                });
                
                fileNodeMap.set(normalizedPath, fileNodeId);
            }

            // --- PASS 2: Parse Content ---
            // Process files in chunks to avoid blocking the event loop for too long
            for (let i = 0; i < files.length; i++) {
                if (signal.aborted) return;

                // Yield every 20 files to keep UI responsive
                if (i % 20 === 0) {
                    await new Promise(resolve => setTimeout(resolve, 0));
                }

                const file = files[i];
                const relativePath = vscode.workspace.asRelativePath(file);
                const normalizedPath = relativePath.replace(/\\/g, '/');
                const fileNodeId = fileNodeMap.get(normalizedPath);
                
                if (!fileNodeId) continue;

                try {
                    const doc = await vscode.workspace.openTextDocument(file);
                    const text = doc.getText();
                    
                    // Skip very large files (> 500KB) to prevent freezes during parsing
                    if (text.length > 500000) continue;

                    const cleanText = this.stripCommentsAndStrings(text); 
                    const lines = cleanText.split('\n');
                    const ext = path.extname(file.fsPath).toLowerCase().replace('.', '');

                    let currentClass: GraphNode | null = null;
                    let currentClassIndent = 0;

                    lines.forEach((line, index) => {
                        const trimmed = line.trim();
                        if (!trimmed) return;
                        const indent = line.search(/\S/);

                        const fnMatch = line.match(/function\s+([a-zA-Z0-9_]+)/);
                        if (fnMatch && !currentClass) {
                            const fnNodeId = `fn_${nodeId++}`;
                            nodes.push({
                                id: fnNodeId,
                                label: fnMatch[1],
                                type: 'function',
                                filePath: relativePath,
                                startLine: index
                            });
                            edges.push({ id: `edge_${edgeId++}`, source: fileNodeId, target: fnNodeId, label: 'contains' });
                        }

                        const classMatch = line.match(/class\s+([a-zA-Z0-9_]+)/);
                        if (classMatch) {
                            const className = classMatch[1];
                            const classNodeId = `class_${nodeId++}`;
                            
                            currentClass = {
                                id: classNodeId,
                                label: className,
                                type: 'class',
                                filePath: relativePath,
                                startLine: index,
                                methods: [],
                                attributes: []
                            };
                            currentClassIndent = indent;
                            
                            nodes.push(currentClass);
                            classNodeMap.set(className, classNodeId);
                            edges.push({ id: `edge_${edgeId++}`, source: fileNodeId, target: classNodeId, label: 'contains' });
                            return;
                        }

                        if (currentClass) {
                            if (ext === 'py') {
                                if (indent <= currentClassIndent && !trimmed.startsWith('def') && !trimmed.startsWith('class') && !trimmed.startsWith('@')) {
                                    if (!trimmed.startsWith('#') && trimmed.length > 0) {
                                        currentClass = null; 
                                    }
                                }
                            } else {
                                if (line.match(/^}/) && indent === currentClassIndent) {
                                    currentClass = null;
                                }
                            }

                            if (currentClass) {
                                let methodMatch;
                                if (ext === 'py') {
                                    methodMatch = line.match(/^\s+def\s+([a-zA-Z0-9_]+)/);
                                } else {
                                    methodMatch = line.match(/(?:public|private|protected|static|\s)*\s+([a-zA-Z0-9_]+)\s*\(/);
                                    if (methodMatch && ['if', 'for', 'while', 'switch', 'catch', 'constructor'].includes(methodMatch[1])) {
                                        methodMatch = null;
                                    }
                                }

                                if (methodMatch) {
                                    const methodName = methodMatch[1];
                                    if (!methodName.startsWith('__')) {
                                        currentClass.methods?.push(methodName);
                                    }
                                }

                                let attrMatch;
                                if (ext === 'py') {
                                    attrMatch = line.match(/self\.([a-zA-Z0-9_]+)\s*=/);
                                } else {
                                    attrMatch = line.match(/(?:public|private|protected|\s)*\s*([a-zA-Z0-9_]+)\s*(?::\s*[a-zA-Z0-9_<>\[\]]+)?\s*=/);
                                }

                                if (attrMatch) {
                                    currentClass.attributes?.push(attrMatch[1]);
                                }
                            }
                        }
                    });

                    const rawImports = this.extractImports(cleanText, ext);
                    for (const importStr of rawImports) {
                        const targetPath = this.resolveImport(importStr, normalizedPath, fileNodeMap);
                        if (targetPath) {
                            const targetId = fileNodeMap.get(targetPath);
                            if (targetId && targetId !== fileNodeId) {
                                edges.push({
                                    id: `edge_${edgeId++}`,
                                    source: fileNodeId,
                                    target: targetId,
                                    label: 'imports'
                                });
                            }
                        }
                    }
                } catch (readError) {
                    console.warn(`Error processing file ${file.fsPath}:`, readError);
                }
            }

            // --- PASS 3: Inheritance (Optional, lighter check) ---
            const inheritancePattern = /class\s+([a-zA-Z0-9_]+)(?:\s*(?:extends|\()\s*([a-zA-Z0-9_.]+))?/g;
            for (let i = 0; i < files.length; i++) {
                if (signal.aborted) return;

                // Yield again
                if (i % 50 === 0) {
                    await new Promise(resolve => setTimeout(resolve, 0));
                }
                
                try {
                    const file = files[i];
                    const doc = await vscode.workspace.openTextDocument(file);
                    
                    if (doc.getText().length > 500000) continue;

                    const text = this.stripCommentsAndStrings(doc.getText());
                    let match;
                    while ((match = inheritancePattern.exec(text)) !== null) {
                        const className = match[1];
                        const parentName = match[2];
                        if (parentName) {
                            const childId = classNodeMap.get(className);
                            const parentId = classNodeMap.get(parentName);
                            if (childId && parentId) {
                                edges.push({
                                    id: `edge_${edgeId++}`,
                                    source: childId,
                                    target: parentId,
                                    label: 'inherits'
                                });
                            }
                        }
                    }
                } catch {}
            }

            this.graph = { nodes, edges };
            this.buildState = 'ready';
            this.contextSetter?.('codeGraph.ready', true);

        } catch (err: any) {
            if (signal.aborted) {
                console.log('Graph generation cancelled.');
                this.buildState = 'idle';
            } else {
                this.fail(err?.message ?? String(err));
            }
        } finally {
            if (signal.aborted) {
                this.buildState = 'idle';
            }
            this.contextSetter?.('codeGraph.building', false);
        }
    }

    private stripCommentsAndStrings(code: string): string {
        return code.replace(/\/\*[\s\S]*?\*\/|([^\\:]|^)\/\/.*$/gm, '$1') 
                   .replace(/#.*/g, '') 
                   .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, ''); 
    }

    private extractImports(text: string, ext: string): string[] {
        const imports: string[] = [];
        if (['ts', 'js', 'tsx', 'jsx'].includes(ext)) {
            let match;
            const esImportRegex = /import\s+(?:[\w\s{},*]+from\s+)?['"]([^'"]+)['"]/g;
            while ((match = esImportRegex.exec(text)) !== null) imports.push(match[1]);
            const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
            while ((match = requireRegex.exec(text)) !== null) imports.push(match[1]);
        } else if (ext === 'py') {
            const fromImportRegex = /^from\s+([\w\.]+)\s+import/gm;
            let match;
            while ((match = fromImportRegex.exec(text)) !== null) imports.push(match[1].replace(/\./g, '/'));
            const importRegex = /^import\s+([\w\.]+)/gm;
            while ((match = importRegex.exec(text)) !== null) imports.push(match[1].replace(/\./g, '/'));
        }
        return imports;
    }

    private resolveImport(importPath: string, sourceFilePath: string, fileMap: Map<string, string>): string | undefined {
        const currentDir = path.posix.dirname(sourceFilePath);
        let candidatePath = importPath;
        if (importPath.startsWith('.')) {
            candidatePath = path.posix.join(currentDir, importPath);
        }
        const extensions = ['', '.ts', '.js', '.tsx', '.jsx', '.py', '.cpp', '.h', '.hpp', '.c', '.java', '.cs'];
        for (const ext of extensions) {
            const tryPath = candidatePath + ext;
            if (fileMap.has(tryPath)) return tryPath;
        }
        for (const ext of extensions) {
            const tryPath = path.posix.join(candidatePath, 'index' + ext);
            if (fileMap.has(tryPath)) return tryPath;
        }
        return undefined;
    }

    getGraphData(): GraphData { return this.graph; }
    getBuildState(): BuildState { return this.buildState; }
    getLastError(): string | undefined { return this.lastError; }
    reset() {
        this.graph = { nodes: [], edges: [] };
        this.buildState = 'idle';
        this.lastError = undefined;
        this.contextSetter?.('codeGraph.ready', false);
        this.contextSetter?.('codeGraph.error', false);
    }

    /* =========================
       MERMAID EXPORT
       ========================= */

    generateMermaid(type: string): string {
        switch (type) {
            case 'class_diagram':
                return this.generateClassDiagramMermaid();
            case 'call_graph':
                return this.generateCallGraphMermaid();
            case 'import_graph':
                return this.generateImportGraphMermaid();
            default:
                return 'graph TD;';
        }
    }

    private generateClassDiagramMermaid(): string {
        let out = 'classDiagram\n';
        const classes = this.graph.nodes.filter(n => n.type === 'class');
        
        classes.forEach(c => {
            const safeLabel = this.sanitizeMermaidLabel(c.label);
            out += `class ${safeLabel} {\n`;
            if (c.attributes) {
                c.attributes.slice(0, 20).forEach(a => out += `  +${a}\n`);
            }
            if (c.methods) {
                c.methods.slice(0, 20).forEach(m => out += `  +${m}()\n`);
            }
            out += `}\n`;
        });
        
        this.graph.edges.filter(e => e.label === 'inherits').forEach(e => {
            const src = this.graph.nodes.find(n => n.id === e.source);
            const trg = this.graph.nodes.find(n => n.id === e.target);
            if (src && trg) {
                out += `${this.sanitizeMermaidLabel(trg.label)} <|-- ${this.sanitizeMermaidLabel(src.label)}\n`;
            }
        });
        return out;
    }

    private generateCallGraphMermaid(): string {
        let out = 'graph TD\n';
        let hasEdges = false;
        
        const definedNodes = new Set<string>();

        const defineNode = (nodeId: string) => {
            if (!definedNodes.has(nodeId)) {
                const node = this.graph.nodes.find(n => n.id === nodeId);
                if (node) {
                    const safeLabel = this.sanitizeMermaidLabel(node.label);
                    
                    // Different shapes for different types
                    if (node.type === 'file') {
                        out += `${this.sanitizeMermaidId(nodeId)}(["${safeLabel}"])\n`; // Rounded
                    } else if (node.type === 'class') {
                        out += `${this.sanitizeMermaidId(nodeId)}[["${safeLabel}"]]\n`; // Subroutine shape (double rect)
                    } else {
                        out += `${this.sanitizeMermaidId(nodeId)}["${safeLabel}"]\n`; // Rect
                    }
                    
                    definedNodes.add(nodeId);
                }
            }
        };

        for (const edge of this.graph.edges) {
            // INCLUDE 'contains' relationship in the Call Graph visualization
            // This ensures we see File -> Class/Function structure even if no explicit calls are detected
            if (edge.label === 'calls' || edge.label === 'contains') {
                const srcId = edge.source;
                const trgId = edge.target;
                
                defineNode(srcId);
                defineNode(trgId);

                const safeSrc = this.sanitizeMermaidId(srcId);
                const safeTrg = this.sanitizeMermaidId(trgId);
                
                if (edge.label === 'contains') {
                    // Use a different arrow style for containment
                    out += `${safeSrc} -.-> ${safeTrg}\n`;
                } else {
                    out += `${safeSrc} --> ${safeTrg}\n`;
                }
                hasEdges = true;
            }
        }
        
        if (!hasEdges) out += 'subgraph Empty\nDirection["No structure detected"]\nend';
        return out;
    }

    private generateImportGraphMermaid(): string {
        let out = 'graph TD\n';
        let hasEdges = false;
        const definedNodes = new Set<string>();

        const defineNode = (nodeId: string) => {
            if (!definedNodes.has(nodeId)) {
                const node = this.graph.nodes.find(n => n.id === nodeId);
                if (node) {
                    const safeLabel = this.sanitizeMermaidLabel(node.label);
                    out += `${this.sanitizeMermaidId(nodeId)}(["${safeLabel}"])\n`;
                    definedNodes.add(nodeId);
                }
            }
        };

        for (const edge of this.graph.edges) {
            if (edge.label === 'imports') {
                defineNode(edge.source);
                defineNode(edge.target);

                const srcId = this.sanitizeMermaidId(edge.source);
                const trgId = this.sanitizeMermaidId(edge.target);

                out += `${srcId} --> ${trgId}\n`;
                hasEdges = true;
            }
        }
        
        if (!hasEdges) out += 'subgraph Empty\nDirection["No imports detected"]\nend';
        return out;
    }

    private sanitizeMermaidId(id: string): string {
        return id.replace(/[^a-zA-Z0-9_]/g, '_');
    }

    private sanitizeMermaidLabel(label: string): string {
        return label.replace(/["\n\r]/g, '');
    }

    private fail(message: string) {
        this.buildState = 'error';
        this.lastError = message;
        this.contextSetter?.('codeGraph.error', true);
    }
}
