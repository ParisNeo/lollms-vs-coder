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
    signature?: string; // New field for function/method signatures
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

    /**
     * Builds a graph. 
     * @param focusPath If provided, only builds a subgraph around this file to prevent UI freezing on large projects.
     */
    async buildGraph(focusPath?: string) {
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

            const libraryNodeMap = new Map<string, string>();

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

                        // Improved Regex to capture signature (parameters and return types)
                        const fnMatch = line.match(/(?:async\s+)?function\s+([a-zA-Z0-9_]+)\s*\(([^)]*)\)(?:\s*:\s*([^\{]+))?/);
                        const pyMatch = line.match(/^\s*def\s+([a-zA-Z0-9_]+)\s*\(([^)]*)\)(?:\s*->\s*([^:]+))?\s*:/);

                        if ((fnMatch || pyMatch) && !currentClass) {
                            const name = fnMatch ? fnMatch[1] : pyMatch![1];
                            const args = fnMatch ? fnMatch[2] : pyMatch![2];
                            const ret = fnMatch ? (fnMatch[3] || 'any') : (pyMatch![3] || 'None');
                            
                            const fnNodeId = `fn_${nodeId++}`;
                            nodes.push({
                                id: fnNodeId,
                                label: name,
                                type: 'function',
                                filePath: relativePath,
                                startLine: index,
                                signature: `${name}(${args.trim()}) -> ${ret.trim()}`
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
                                    // Capture full Python method signature
                                    methodMatch = line.match(/^\s+def\s+([a-zA-Z0-9_]+)\s*\(([^)]*)\)(?:\s*->\s*([^:]+))?\s*:/);
                                    if (methodMatch) {
                                        const sig = `${methodMatch[1]}(${methodMatch[2].trim()}) -> ${methodMatch[3]?.trim() || 'None'}`;
                                        currentClass.methods?.push(sig);
                                    }
                                } else {
                                    // Capture TS/JS method signature
                                    methodMatch = line.match(/(?:public|private|protected|static|async|\s)*\s+([a-zA-Z0-9_]+)\s*\(([^)]*)\)(?:\s*:\s*([^\{]+))?/);
                                    if (methodMatch && !['if', 'for', 'while', 'switch', 'catch', 'constructor'].includes(methodMatch[1])) {
                                        const sig = `${methodMatch[1]}(${methodMatch[2].trim()}) : ${methodMatch[3]?.trim() || 'any'}`;
                                        currentClass.methods?.push(sig);
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
                            // Local File Import
                            const targetId = fileNodeMap.get(targetPath);
                            if (targetId && targetId !== fileNodeId) {
                                edges.push({ id: `edge_${edgeId++}`, source: fileNodeId, target: targetId, label: 'imports' });
                            }
                        } else if (!importStr.startsWith('.')) {
                            // External Library Detection
                            // We treat non-relative imports that don't resolve to local files as libraries
                            const libName = importStr.split('/')[0]; // Get base package name
                            let libId = libraryNodeMap.get(libName);
                            
                            if (!libId) {
                                libId = `lib_${nodeId++}`;
                                nodes.push({
                                    id: libId,
                                    label: libName,
                                    type: 'library'
                                });
                                libraryNodeMap.set(libName, libId);
                            }
                            
                            edges.push({
                                id: `edge_${edgeId++}`,
                                source: fileNodeId,
                                target: libId,
                                label: 'imports'
                            });
                        }
                    }
                } catch (readError) {
                    console.warn(`Error processing file ${file.fsPath}:`, readError);
                }
            }

            // --- PASS 3: Function Calls & References (Links) ---
            const allSymbols = nodes.filter(n => n.type === 'function' || n.type === 'class');
            
            for (let i = 0; i < files.length; i++) {
                if (signal.aborted) return;
                const file = files[i];
                const normalizedPath = vscode.workspace.asRelativePath(file).replace(/\\/g, '/');
                const fileNodeId = fileNodeMap.get(normalizedPath);
                if (!fileNodeId) continue;

                try {
                    const doc = await vscode.workspace.openTextDocument(file);
                    const text = doc.getText();
                    
                    // For every known symbol in the project, check if this file calls it
                    for (const symbol of allSymbols) {
                        // Avoid self-references or linking a file to its own children via 'calls'
                        if (symbol.filePath === normalizedPath) continue;

                        // Use a word-boundary regex to find the function/class name in the text
                        const callRegex = new RegExp(`\\b${symbol.label}\\s*\\(`, 'g');
                        if (callRegex.test(text)) {
                            edges.push({
                                id: `call_${edgeId++}`,
                                source: fileNodeId,
                                target: symbol.id,
                                label: 'calls'
                            });
                        }
                    }
                } catch {}
            }

            // --- PASS 4: Inheritance Parsing ---
            // TS/JS: class Child extends Parent
            // Python: class Child(Parent)
            const jsInheritance = /class\s+([a-zA-Z0-9_]+)\s+extends\s+([a-zA-Z0-9_.]+)/g;
            const pyInheritance = /class\s+([a-zA-Z0-9_]+)\s*\(\s*([a-zA-Z0-9_.]+)\s*\)/g;

            for (let i = 0; i < files.length; i++) {
                if (signal.aborted) return;
                if (i % 50 === 0) await new Promise(resolve => setTimeout(resolve, 0));
                
                try {
                    const file = files[i];
                    const ext = path.extname(file.fsPath).toLowerCase();
                    const doc = await vscode.workspace.openTextDocument(file);
                    const text = this.stripCommentsAndStrings(doc.getText());

                    let match;
                    const regex = (ext === '.py') ? pyInheritance : jsInheritance;
                    
                    // Reset regex state
                    regex.lastIndex = 0;

                    while ((match = regex.exec(text)) !== null) {
                        const className = match[1];
                        const parentName = match[2]; // Python captures Parent in group 2
                        
                        if (parentName && parentName !== 'object') {
                            const childId = classNodeMap.get(className);
                            // Try to find parent by name, might need more complex resolution in future
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

            // --- PASS 5: Filter Isolated Nodes ---
            // Remove nodes that have no edges connecting them to anything else
            const activeNodeIds = new Set<string>();
            edges.forEach(e => {
                activeNodeIds.add(e.source);
                activeNodeIds.add(e.target);
            });

            // --- PERFORMANCE CAP ---
            // If the graph is still huge, we prioritize local files over external libraries
            let finalNodes = nodes.filter(n => activeNodeIds.has(n.id));
            let finalEdges = edges;

            if (focusPath) {
                const normalizedFocus = focusPath.replace(/\\/g, '/');
                const focusId = fileNodeMap.get(normalizedFocus);
                if (focusId) {
                    const neighborIds = new Set<string>([focusId]);
                    edges.forEach(e => {
                        if (e.source === focusId) neighborIds.add(e.target);
                        if (e.target === focusId) neighborIds.add(e.source);
                    });
                    finalNodes = finalNodes.filter(n => neighborIds.has(n.id));
                    finalEdges = edges.filter(e => neighborIds.has(e.source) && neighborIds.has(e.target));
                }
            }

            // Hard cap at 1000 nodes for stability
            if (finalNodes.length > 1000) {
                finalNodes = finalNodes.slice(0, 1000);
                const nodeIdSet = new Set(finalNodes.map(n => n.id));
                finalEdges = finalEdges.filter(e => nodeIdSet.has(e.source) && nodeIdSet.has(e.target));
            }

            this.graph = { nodes: finalNodes, edges: finalEdges };
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
            // Handle: from package import module
            const fromImportRegex = /^from\s+([\w\.]+)\s+import/gm;
            let match;
            while ((match = fromImportRegex.exec(text)) !== null) {
                imports.push(match[1].replace(/\./g, '/'));
            }

            // Handle: import os, sys, json
            // Captures the whole line "import os, sys" then splits
            const importRegex = /^import\s+([^\n]+)/gm;
            while ((match = importRegex.exec(text)) !== null) {
                const modules = match[1].split(',');
                modules.forEach(m => {
                    // Remove aliases like "import pandas as pd" -> "pandas"
                    const cleanName = m.trim().split(/\s+as\s+/)[0];
                    if (cleanName) imports.push(cleanName.replace(/\./g, '/'));
                });
            }
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
        // Apply global init for better dark mode rendering
        const header = "%%{init: {'theme': 'dark', 'themeVariables': { 'lineColor': '#569cd6' }}}%%\n";
        
        let diagram = "";
        switch (type) {
            case 'class_diagram':
                diagram = this.generateClassDiagramMermaid();
                break;
            case 'call_graph':
                diagram = this.generateCallGraphMermaid();
                break;
            case 'import_graph':
                diagram = this.generateImportGraphMermaid();
                break;
            case 'function_signatures':
                diagram = this.generateFunctionSignaturesMermaid();
                break;
            default:
                diagram = 'graph TD;\n  Empty["No graph selected"]';
        }
        return header + diagram;
    }

    private sanitizeMermaidMember(member: string): string {
        // Strip out brackets and quotes that break the Mermaid class diagram parser
        return member.replace(/[\{\}\[\]\<\>\"\'\;]/g, '').trim();
    }

    private generateFunctionSignaturesMermaid(): string {
        let out = 'classDiagram\n  direction LR\n';
        const files = this.graph.nodes.filter(n => n.type === 'file');
        
        files.forEach(f => {
            const childrenEdges = this.graph.edges.filter(e => e.source === f.id && e.label === 'contains');
            if (childrenEdges.length === 0) return;

            const safeFileId = this.sanitizeMermaidId(f.id);
            
            // 1. Handle stand-alone functions in the file
            const standaloneFunctions = childrenEdges
                .map(edge => this.graph.nodes.find(n => n.id === edge.target))
                .filter(n => n && n.type === 'function');

            if (standaloneFunctions.length > 0) {
                out += `  class ${safeFileId}["${f.label}"] {\n    <<file>>\n`;
                standaloneFunctions.forEach(fn => {
                    let sig = fn!.signature ? fn!.signature : `${fn!.label}()`;
                    sig = sig.replace(/[{}";]/g, '').replace(/->/g, ':').replace(/\s+/g, ' ');
                    out += `    ${sig}\n`;
                });
                out += `  }\n`;
            } else {
                out += `  class ${safeFileId}["${f.label}"]\n  ${safeFileId} : <<file>>\n`;
            }

            // 2. Handle classes in the file
            childrenEdges.forEach(edge => {
                const child = this.graph.nodes.find(n => n.id === edge.target);
                if (child && child.type === 'class') {
                    const safeClassId = this.sanitizeMermaidId(child.id);
                    const methods = child.methods || [];
                    
                    if (methods.length > 0) {
                        out += `  class ${safeClassId}["${child.label}"] {\n`;
                        methods.forEach(m => {
                            const safeMethod = m.replace(/[{}";]/g, '').replace(/->/g, ':').replace(/\s+/g, ' ');
                            out += `    ${safeMethod}\n`;
                        });
                        out += `  }\n`;
                    } else {
                        out += `  class ${safeClassId}["${child.label}"]\n`;
                    }
                    out += `  ${safeFileId} *-- ${safeClassId}\n`;
                }
            });
        });
        return out;
    }

    private generateClassDiagramMermaid(): string {
        let out = 'classDiagram\n';
        const classes = this.graph.nodes.filter(n => n.type === 'class');
        
        classes.forEach(c => {
            const safeId = this.sanitizeMermaidId(c.id);
            const hasAttrs = c.attributes && c.attributes.length > 0;
            const hasMethods = c.methods && c.methods.length > 0;
            
            if (hasAttrs || hasMethods) {
                out += `class ${safeId}["${c.label}"] {\n`;
                if (c.attributes) {
                    c.attributes.slice(0, 15).forEach(a => out += `  +${a.replace(/[{}]/g, '')}\n`);
                }
                if (c.methods) {
                    c.methods.slice(0, 15).forEach(m => out += `  +${m.replace(/[{}]/g, '')}()\n`);
                }
                out += `}\n`;
            } else {
                out += `class ${safeId}["${c.label}"]\n`;
            }
        });
        
        this.graph.edges.filter(e => e.label === 'inherits').forEach(e => {
            const src = this.graph.nodes.find(n => n.id === e.source);
            const trg = this.graph.nodes.find(n => n.id === e.target);
            if (src && trg) {
                out += `${this.sanitizeMermaidId(trg.id)} <|-- ${this.sanitizeMermaidId(src.id)}\n`;
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
                    const safeId = this.sanitizeMermaidId(nodeId);
                    
                    if (node.type === 'library') {
                        out += `${safeId}{{"Library: ${safeLabel}"}}\n`; // Hexagon for libs
                        out += `style ${safeId} fill:#f96,stroke:#333,stroke-width:2px\n`;
                    } else {
                        out += `${safeId}(["${safeLabel}"])\n`; // Rounded for files
                    }
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
        // Ensure IDs are valid CSS-like identifiers
        return id.replace(/[^a-zA-Z0-9_]/g, '_');
    }

    private sanitizeMermaidLabel(label: string): string {
        // Class names in Mermaid cannot have spaces, dots, or most symbols.
        // We replace all non-alphanumeric characters with underscores.
        let safe = label
            .replace(/<.*?>/g, '') // Remove generics
            .replace(/["\n\r\t(){}]/g, '') // Remove brackets and quotes
            .replace(/[^a-zA-Z0-9_]/g, '_'); // Flatten spaces/dots to underscores
            
        // Identifiers cannot start with a digit
        if (/^\d/.test(safe)) {
            safe = '_' + safe;
        }
        return safe;
    }

    private fail(message: string) {
        this.buildState = 'error';
        this.lastError = message;
        this.contextSetter?.('codeGraph.error', true);
    }
}
