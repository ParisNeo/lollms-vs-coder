import * as vscode from 'vscode';
import * as path from 'path';

/**
 * ==========================================
 * 🧊 LOLLMS SOURCE CODE ONTOLOGY
 * ==========================================
 * Classes (Types):
 * - s:File : Represents a source file.
 * - s:Class : Represents an object-oriented class or interface.
 * - s:Function : Represents a global function.
 * - s:Method : Represents an object-oriented method inside a class.
 * - s:Library : Represents an external imported package.
 * 
 * Properties (Relationships):
 * - s:type : Declares the class/type of a resource.
 * - s:name : The human-readable identifier of the resource.
 * - s:path : The relative file path of the resource.
 * - s:contains : Indicates a file or class contains a nested symbol/method.
 * - s:imports : Declares that a file imports another file or library.
 * - s:calls : Indicates a function or method calls another symbol.
 * - s:inherits : Declares that a class inherits from another class.
 */

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
    linesCount?: number; // New field
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

    // Preserved index state for progressive and incremental background builds
    private nextNodeIdNum: number = 0;
    private nextEdgeIdNum: number = 0;
    private fileNodeMap = new Map<string, string>();
    private classNodeMap = new Map<string, string>();
    private libraryNodeMap = new Map<string, string>();
    private fileContents = new Map<string, { text: string, linesCount: number }>();

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
     * @param onProgress Optional callback for real-time progress metrics.
     */
    async buildGraph(focusPath?: string, onProgress?: (p: { percentage: number, status: string }) => void) {
        // Cancel any existing operation
        this.cancel();

        // JIT Resolution: If root is not set, try to grab it from current VS Code state
        if (!this.workspaceRoot) {
            const folders = vscode.workspace.workspaceFolders;
            if (folders && folders.length > 0) {
                this.workspaceRoot = folders[0].uri;
            } else {
                this.fail('Workspace root not defined. Please open a project folder.');
                return;
            }
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

            // Ultra-aggressive exclusion pattern to guarantee we never touch build/dependency directories
            const excludePattern = '**/{node_modules,venv,.venv,env,.env,.git,dist,build,out,bin,obj,.vscode,.idea,.lollms,__pycache__,target,*.egg-info,vendor,temp_scripts,web_cache,snapshots}/**';

            // Find code files only
            const files = await vscode.workspace.findFiles(
                new vscode.RelativePattern(this.workspaceRoot, '**/*.{ts,js,jsx,tsx,py,cpp,h,hpp,c,java,cs,go,rs,php,rb}'),
                excludePattern,
                undefined
            );

            if (signal.aborted) return;

            // Cap the maximum number of files to process to prevent locking up in extremely large codebases
            const MAX_FILES_LIMIT = 400;
            let filesToProcess = files;
            if (files.length > MAX_FILES_LIMIT) {
                console.warn(`[Lollms Graph] Codebase exceeds maximum file limit (${files.length} > ${MAX_FILES_LIMIT}). Truncating to keep the extension host fully responsive.`);
                filesToProcess = files.slice(0, MAX_FILES_LIMIT);
            }

            const nodes: GraphNode[] = [];
            const edges: GraphEdge[] = [];

            this.fileNodeMap.clear();
            this.classNodeMap.clear();
            this.libraryNodeMap.clear();
            this.fileContents.clear();

            this.nextNodeIdNum = 0;
            this.nextEdgeIdNum = 0;

            // --- PASS 1: Batched Asynchronous Reading & Pre-flight Size Checks ---
            const BATCH_SIZE = 25;
            for (let i = 0; i < filesToProcess.length; i += BATCH_SIZE) {
                if (signal.aborted) return;

                // Yield back to the main thread to keep UI completely responsive
                await new Promise(resolve => setTimeout(resolve, 1));

                const batch = filesToProcess.slice(i, i + BATCH_SIZE);

                if (onProgress) {
                    const pct = Math.round((i / filesToProcess.length) * 40); // Allocate up to 40% of bar to Pass 1
                    const currentFileSample = batch[0] ? path.basename(batch[0].fsPath) : 'codebase';
                    onProgress({ percentage: pct, status: `Pass 1: Reading ${currentFileSample}...` });
                }

                await Promise.all(batch.map(async (file) => {
                    const relativePath = vscode.workspace.asRelativePath(file);
                    const normalizedPath = relativePath.replace(/\\/g, '/');

                    try {
                        // Pre-flight file size check: skip reading if size exceeds 200KB to save memory and CPU
                        const stats = await vscode.workspace.fs.stat(file);
                        if (stats.size > 200000) {
                            return;
                        }

                        const fileBytes = await vscode.workspace.fs.readFile(file);
                        const text = Buffer.from(fileBytes).toString('utf8');
                        const linesCount = text.split('\n').length;

                        this.fileContents.set(normalizedPath, { text, linesCount });

                        const fileNodeId = `file_${this.nextNodeIdNum++}`;
                        nodes.push({
                            id: fileNodeId,
                            label: path.basename(relativePath),
                            type: 'file',
                            filePath: relativePath,
                            startLine: 0,
                            linesCount: linesCount
                        });

                        this.fileNodeMap.set(normalizedPath, fileNodeId);
                    } catch (readError) {
                        console.warn(`Error reading file ${file.fsPath}:`, readError);
                    }
                }));
            }

            if (onProgress) {
                onProgress({ percentage: 40, status: 'Pass 1 complete. Extracting file-level nodes...' });
            }

            // --- PASS 2: Parse Content ---
            let filesParsed = 0;
            for (const [normalizedPath, data] of this.fileContents.entries()) {
                if (signal.aborted) return;

                filesParsed++;
                // Yield back more frequently to keep the main thread fully responsive
                if (filesParsed % 3 === 0) {
                    await new Promise(resolve => setTimeout(resolve, 1));
                }

                if (onProgress && filesParsed % 10 === 0) {
                    const pct = 40 + Math.round((filesParsed / this.fileContents.size) * 30); // 40% to 70%
                    onProgress({ percentage: pct, status: `Pass 2: Extracting classes/functions from ${path.basename(normalizedPath)}...` });
                }

                const fileNodeId = this.fileNodeMap.get(normalizedPath);
                if (!fileNodeId) continue;

                // Track nodes and edges generated ONLY from this file to populate cache
                const localNodes: GraphNode[] = [];
                const localEdges: GraphEdge[] = [];

                try {
                    const text = data.text;
                    const cleanText = this.stripCommentsAndStrings(text); 
                    const lines = cleanText.split('\n');
                    const ext = path.extname(normalizedPath).toLowerCase().replace('.', '');

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

                            const fnNodeId = `fn_${this.nextNodeIdNum++}`;
                            nodes.push({
                                id: fnNodeId,
                                label: name,
                                type: 'function',
                                filePath: normalizedPath,
                                startLine: index,
                                signature: `${name}(${args.trim()}) -> ${ret.trim()}`,
                                params: args.trim(),
                                returnType: ret.trim()
                            });
                            edges.push({ id: `edge_${this.nextEdgeIdNum++}`, source: fileNodeId, target: fnNodeId, label: 'contains' });
                        }

                        const classMatch = line.match(/class\s+([a-zA-Z0-9_]+)/);
                        if (classMatch) {
                            const className = classMatch[1];
                            const classNodeId = `class_${this.nextNodeIdNum++}`;

                            currentClass = {
                                id: classNodeId,
                                label: className,
                                type: 'class',
                                filePath: normalizedPath,
                                startLine: index,
                                methods: [],
                                attributes: []
                            };
                            currentClassIndent = indent;

                            nodes.push(currentClass);
                            this.classNodeMap.set(className, classNodeId);
                            edges.push({ id: `edge_${this.nextEdgeIdNum++}`, source: fileNodeId, target: classNodeId, label: 'contains' });
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
                                        const methodName = methodMatch[1];
                                        const methodNodeId = `method_${this.nextNodeIdNum++}`;
                                        nodes.push({
                                            id: methodNodeId,
                                            label: methodName,
                                            type: 'method',
                                            filePath: normalizedPath,
                                            startLine: index,
                                            signature: `${methodName}(${methodMatch[2].trim()}) -> ${methodMatch[3]?.trim() || 'None'}`,
                                            params: methodMatch[2].trim(),
                                            returnType: methodMatch[3]?.trim() || 'None'
                                        });
                                        edges.push({ id: `edge_${this.nextEdgeIdNum++}`, source: currentClass.id, target: methodNodeId, label: 'contains' });
                                    }
                                } else {
                                    // Capture TS/JS method signature
                                    methodMatch = line.match(/(?:public|private|protected|static|async|\s)*\s+([a-zA-Z0-9_]+)\s*\(([^)]*)\)(?:\s*:\s*([^\{]+))?/);
                                    if (methodMatch && !['if', 'for', 'while', 'switch', 'catch', 'constructor'].includes(methodMatch[1])) {
                                        const methodName = methodMatch[1];
                                        const methodNodeId = `method_${this.nextNodeIdNum++}`;
                                        nodes.push({
                                            id: methodNodeId,
                                            label: methodName,
                                            type: 'method',
                                            filePath: normalizedPath,
                                            startLine: index,
                                            signature: `${methodName}(${methodMatch[2].trim()}) : ${methodMatch[3]?.trim() || 'any'}`,
                                            params: methodMatch[2].trim(),
                                            returnType: methodMatch[3]?.trim() || 'any'
                                        });
                                        edges.push({ id: `edge_${this.nextEdgeIdNum++}`, source: currentClass.id, target: methodNodeId, label: 'contains' });
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
                        const targetPath = this.resolveImport(importStr, normalizedPath, this.fileNodeMap);

                        if (targetPath) {
                            // Local File Import
                            const targetId = this.fileNodeMap.get(targetPath);
                            if (targetId && targetId !== fileNodeId) {
                                edges.push({ id: `edge_${this.nextEdgeIdNum++}`, source: fileNodeId, target: targetId, label: 'imports' });
                            }
                        } else if (!importStr.startsWith('.')) {
                            // External Library Detection
                            const libName = importStr.split('/')[0];
                            let libId = this.libraryNodeMap.get(libName);

                            if (!libId) {
                                libId = `lib_${this.nextNodeIdNum++}`;
                                nodes.push({
                                    id: libId,
                                    label: libName,
                                    type: 'library'
                                });
                                this.libraryNodeMap.set(libName, libId);
                            }

                            edges.push({
                                id: `edge_${this.nextEdgeIdNum++}`,
                                source: fileNodeId,
                                target: libId,
                                label: 'imports'
                            });
                        }
                    }
                } catch (parseError) {
                    console.warn(`Error parsing file ${normalizedPath}:`, parseError);
                }
            }

            if (onProgress) {
                onProgress({ percentage: 70, status: 'Pass 2 complete. Analyzing calls & references...' });
            }

            // --- PASS 3: Function Calls & References (Links) ---
            const allSymbols = nodes.filter(n => n.type === 'function' || n.type === 'method' || n.type === 'class');

            // Pre-compile the regexes for all symbols once to avoid rebuilding them inside nested loops
            const symbolRegexes = new Map<string, {
                bound: RegExp;
                call: RegExp;
                instantiation: RegExp;
            }>();

            allSymbols.forEach(symbol => {
                const escapedLabel = symbol.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                symbolRegexes.set(symbol.id, {
                    bound: new RegExp(`\\b${escapedLabel}\\b`),
                    call: new RegExp(`\\b${escapedLabel}\\s*\\(`, 'g'),
                    instantiation: new RegExp(`\\bnew\\s+${escapedLabel}\\b|:\\s*${escapedLabel}\\b|\\b${escapedLabel}\\.`, 'g')
                });
            });

            let filesLinked = 0;
            for (const [normalizedPath, data] of this.fileContents.entries()) {
                if (signal.aborted) return;

                filesLinked++;
                // Yield back on EVERY file to ensure the event loop stays responsive, keeping VS Code responsive
                await new Promise(resolve => setTimeout(resolve, 0));

                if (onProgress && filesLinked % 5 === 0) {
                    const pct = 70 + Math.round((filesLinked / this.fileContents.size) * 20); // 70% to 90%
                    onProgress({ percentage: pct, status: `Pass 3: Linking references in ${path.basename(normalizedPath)}...` });
                }

                const fileNodeId = this.fileNodeMap.get(normalizedPath);
                if (!fileNodeId) continue;

                const text = data.text;
                const lines = text.split('\n');

                // Gather and sort all symbols defined in this file by line number
                const fileSymbols = nodes
                    .filter(n => n.filePath === normalizedPath && (n.type === 'function' || n.type === 'method' || n.type === 'class'))
                    .sort((a, b) => (a.startLine || 0) - (b.startLine || 0));

                for (let index = 0; index < lines.length; index++) {
                    const line = lines[index];

                    // Yield occasionally within large files
                    if (index % 100 === 0) {
                        await new Promise(resolve => setTimeout(resolve, 0));
                    }

                    // Identify the active caller context (enclosing symbol range)
                    let currentCallerId = fileNodeId;
                    for (let sIdx = fileSymbols.length - 1; sIdx >= 0; sIdx--) {
                        const sym = fileSymbols[sIdx];
                        if (sym.startLine !== undefined && index >= sym.startLine) {
                            currentCallerId = sym.id;
                            break;
                        }
                    }

                    const callerNode = nodes.find(n => n.id === currentCallerId);
                    const isAtDefinitionLine = callerNode && index === callerNode.startLine;

                    // Check for relationships to any known symbol in the project (Upgraded Ontology)
                    for (const symbol of allSymbols) {
                        if (symbol.id === currentCallerId) continue;

                        // CRITICAL PERFORMANCE BOOST: Quick substring check to bypass RegExp compilation entirely
                        if (!line.includes(symbol.label)) continue;

                        const regexes = symbolRegexes.get(symbol.id);
                        if (!regexes) continue;

                        // Helper to safely add unique relationship edges
                        const addEdgeOnce = (src: string, trg: string, relLabel: string) => {
                            const edgeExists = edges.some(e => e.source === src && e.target === trg && e.label === relLabel);
                            if (!edgeExists) {
                                edges.push({
                                    id: `edge_${this.nextEdgeIdNum++}`,
                                    source: src,
                                    target: trg,
                                    label: relLabel
                                });
                            }
                        };

                        // 1. Check Signature for Input / Output Parameter Types (At definition line)
                        if (isAtDefinitionLine) {
                            if (callerNode.params && regexes.bound.test(callerNode.params)) {
                                  addEdgeOnce(currentCallerId, symbol.id, 'inputParam');
                                continue;
                            }
                            if (callerNode.returnType && regexes.bound.test(callerNode.returnType)) {
                                  addEdgeOnce(currentCallerId, symbol.id, 'outputParam');
                                continue;
                            }
                        }

                        // 2. Check Line Content for Internal Calls & Local Variable Instantiation
                        if (regexes.call.test(line)) {
                            addEdgeOnce(currentCallerId, symbol.id, 'calls');
                        } else if (regexes.instantiation.test(line)) {
                            addEdgeOnce(currentCallerId, symbol.id, 'localVariable');
                        }
                    }
                }
            }

            if (onProgress) {
                onProgress({ percentage: 90, status: 'Analyzing class inheritance...' });
            }

            // --- PASS 4: Inheritance Parsing ---
            const jsInheritance = /class\s+([a-zA-Z0-9_]+)\s+extends\s+([a-zA-Z0-9_.]+)/g;
            const pyInheritance = /class\s+([a-zA-Z0-9_]+)\s*\(\s*([a-zA-Z0-9_.]+)\s*\)/g;

            for (const [normalizedPath, data] of this.fileContents.entries()) {
                if (signal.aborted) return;

                const ext = path.extname(normalizedPath).toLowerCase();
                const text = this.stripCommentsAndStrings(data.text);

                let match;
                const regex = (ext === '.py') ? pyInheritance : jsInheritance;
                regex.lastIndex = 0;

                while ((match = regex.exec(text)) !== null) {
                    const className = match[1];
                    const parentName = match[2];

                    if (parentName && parentName !== 'object') {
                        const childId = this.classNodeMap.get(className);
                        const parentId = this.classNodeMap.get(parentName); 

                        if (childId && parentId) {
                            edges.push({
                                id: `edge_${this.nextEdgeIdNum++}`,
                                source: childId,
                                target: parentId,
                                label: 'inherits'
                            });
                        }
                    }
                }
            }

            if (onProgress) {
                onProgress({ percentage: 95, status: 'Finalizing architectural layout...' });
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
                const focusId = this.fileNodeMap.get(normalizedFocus);
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
            // Enhanced Regex: Handles standard imports, 'import type', and 'export ... from'
            const esImportRegex = /(?:import|export)\s+(?:type\s+)?(?:[\w\s{},*]+from\s+)?['"]([^'"]+)['"]/g;
            while ((match = esImportRegex.exec(text)) !== null) {
                imports.push(match[1]);
            }
            // Dynamic imports: import('./path')
            const dynamicImportRegex = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
            while ((match = dynamicImportRegex.exec(text)) !== null) {
                imports.push(match[1]);
            }
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

    /**
     * Serializes the current active graph into a high-density, machine-readable Cytoscape JSON structure.
     * This is optimized for LLM comprehension and enables high-scale interactive rendering in the chat panel.
     */
    generateCytoscapeJson(): string {
        const activeNodeIds = new Set(this.graph.nodes.map(n => n.id));

        // Enforce strict integrity: only serialize edges that connect fully-possessed nodes
        const validatedEdges = this.graph.edges.filter(e => 
            activeNodeIds.has(e.source) && activeNodeIds.has(e.target)
        );

        const elements = {
            nodes: this.graph.nodes.map(n => ({
                data: {
                    id: n.id,
                    label: n.label,
                    type: n.type,
                    filePath: n.filePath || '',
                    startLine: n.startLine || 0,
                    linesCount: n.linesCount || 0,
                    signature: n.signature || ''
                }
            })),
            edges: validatedEdges.map(e => ({
                data: {
                    id: e.id,
                    source: e.source,
                    target: e.target,
                    label: e.label
                }
            }))
        };
        return JSON.stringify(elements, null, 2);
    }
    public removeFileFromGraph(fileUri: vscode.Uri) {
        if (!this.workspaceRoot) return;
        const relativePath = vscode.workspace.asRelativePath(fileUri);
        const normalizedPath = relativePath.replace(/\\/g, '/');

        // Find all nodes belonging to this file
        const nodesToRemove = this.graph.nodes.filter(n => n.filePath === normalizedPath);
        const nodeIdsToRemove = new Set(nodesToRemove.map(n => n.id));

        const fileNodeId = this.fileNodeMap.get(normalizedPath);
        if (fileNodeId) {
            nodeIdsToRemove.add(fileNodeId);
        }

        if (nodeIdsToRemove.size === 0) return;

        // Remove nodes
        this.graph.nodes = this.graph.nodes.filter(n => !nodeIdsToRemove.has(n.id));

        // Remove edges connected to those nodes
        this.graph.edges = this.graph.edges.filter(e => !nodeIdsToRemove.has(e.source) && !nodeIdsToRemove.has(e.target));

        // Clean up state maps
        this.fileNodeMap.delete(normalizedPath);
        this.fileContents.delete(normalizedPath);

        // Remove class entries
        nodesToRemove.forEach(n => {
            if (n.type === 'class') {
                this.classNodeMap.delete(n.label);
            }
        });
    }

    public async updateFileInGraph(fileUri: vscode.Uri) {
        if (!this.workspaceRoot) return;
        const relativePath = vscode.workspace.asRelativePath(fileUri);
        const normalizedPath = relativePath.replace(/\\/g, '/');

        // 1. Remove old nodes and edges
        this.removeFileFromGraph(fileUri);

        try {
            // Pre-flight file size check: skip reading if size exceeds 200KB
            const stats = await vscode.workspace.fs.stat(fileUri);
            if (stats.size > 200000) return;

            const fileBytes = await vscode.workspace.fs.readFile(fileUri);
            const text = Buffer.from(fileBytes).toString('utf8');
            const linesCount = text.split('\n').length;

            this.fileContents.set(normalizedPath, { text, linesCount });

            // Create File Node
            const fileNodeId = `file_${this.nextNodeIdNum++}`;
            this.fileNodeMap.set(normalizedPath, fileNodeId);

            const fileNode: GraphNode = {
                id: fileNodeId,
                label: path.basename(relativePath),
                type: 'file',
                filePath: normalizedPath,
                startLine: 0,
                linesCount: linesCount
            };
            this.graph.nodes.push(fileNode);

            // Parse content
            const cleanText = this.stripCommentsAndStrings(text);
            const lines = cleanText.split('\n');
            const ext = path.extname(normalizedPath).toLowerCase().replace('.', '');

            let currentClass: GraphNode | null = null;
            let currentClassIndent = 0;

            lines.forEach((line, index) => {
                const trimmed = line.trim();
                if (!trimmed) return;
                const indent = line.search(/\S/);

                const fnMatch = line.match(/(?:async\s+)?function\s+([a-zA-Z0-9_]+)\s*\(([^)]*)\)(?:\s*:\s*([^\{]+))?/);
                const pyMatch = line.match(/^\s*def\s+([a-zA-Z0-9_]+)\s*\(([^)]*)\)(?:\s*->\s*([^:]+))?\s*:/);

                if ((fnMatch || pyMatch) && !currentClass) {
                    const name = fnMatch ? fnMatch[1] : pyMatch![1];
                    const args = fnMatch ? fnMatch[2] : pyMatch![2];
                    const ret = fnMatch ? (fnMatch[3] || 'any') : (pyMatch![3] || 'None');

                    const fnNodeId = `fn_${this.nextNodeIdNum++}`;
                    const fnNode: GraphNode = {
                        id: fnNodeId,
                        label: name,
                        type: 'function',
                        filePath: normalizedPath,
                        startLine: index,
                        signature: `${name}(${args.trim()}) -> ${ret.trim()}`,
                        params: args.trim(),
                        returnType: ret.trim()
                    };
                    this.graph.nodes.push(fnNode);
                    this.graph.edges.push({ id: `edge_${this.nextEdgeIdNum++}`, source: fileNodeId, target: fnNodeId, label: 'contains' });
                }

                const classMatch = line.match(/class\s+([a-zA-Z0-9_]+)/);
                if (classMatch) {
                    const className = classMatch[1];
                    const classNodeId = `class_${this.nextNodeIdNum++}`;

                    currentClass = {
                        id: classNodeId,
                        label: className,
                        type: 'class',
                        filePath: normalizedPath,
                        startLine: index,
                        methods: [],
                        attributes: []
                    };
                    currentClassIndent = indent;

                    this.graph.nodes.push(currentClass);
                    this.classNodeMap.set(className, classNodeId);
                    this.graph.edges.push({ id: `edge_${this.nextEdgeIdNum++}`, source: fileNodeId, target: classNodeId, label: 'contains' });
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
                            methodMatch = line.match(/^\s+def\s+([a-zA-Z0-9_]+)\s*\(([^)]*)\)(?:\s*->\s*([^:]+))?\s*:/);
                            if (methodMatch) {
                                const methodName = methodMatch[1];
                                const methodNodeId = `method_${this.nextNodeIdNum++}`;
                                this.graph.nodes.push({
                                    id: methodNodeId,
                                    label: methodName,
                                    type: 'method',
                                    filePath: normalizedPath,
                                    startLine: index,
                                    signature: `${methodName}(${methodMatch[2].trim()}) -> ${methodMatch[3]?.trim() || 'None'}`,
                                    params: methodMatch[2].trim(),
                                    returnType: methodMatch[3]?.trim() || 'None'
                                });
                                this.graph.edges.push({ id: `edge_${this.nextEdgeIdNum++}`, source: currentClass.id, target: methodNodeId, label: 'contains' });
                            }
                        } else {
                            methodMatch = line.match(/(?:public|private|protected|static|async|\s)*\s+([a-zA-Z0-9_]+)\s*\(([^)]*)\)(?:\s*:\s*([^\{]+))?/);
                            if (methodMatch && !['if', 'for', 'while', 'switch', 'catch', 'constructor'].includes(methodMatch[1])) {
                                const methodName = methodMatch[1];
                                const methodNodeId = `method_${this.nextNodeIdNum++}`;
                                this.graph.nodes.push({
                                    id: methodNodeId,
                                    label: methodName,
                                    type: 'method',
                                    filePath: normalizedPath,
                                    startLine: index,
                                    signature: `${methodName}(${methodMatch[2].trim()}) : ${methodMatch[3]?.trim() || 'any'}`,
                                    params: methodMatch[2].trim(),
                                    returnType: methodMatch[3]?.trim() || 'any'
                                });
                                this.graph.edges.push({ id: `edge_${this.nextEdgeIdNum++}`, source: currentClass.id, target: methodNodeId, label: 'contains' });
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

            // Import resolution
            const rawImports = this.extractImports(cleanText, ext);
            for (const importStr of rawImports) {
                const targetPath = this.resolveImport(importStr, normalizedPath, this.fileNodeMap);

                if (targetPath) {
                    const targetId = this.fileNodeMap.get(targetPath);
                    if (targetId && targetId !== fileNodeId) {
                        this.graph.edges.push({ id: `edge_${this.nextEdgeIdNum++}`, source: fileNodeId, target: targetId, label: 'imports' });
                    }
                } else if (!importStr.startsWith('.')) {
                    const libName = importStr.split('/')[0];
                    let libId = this.libraryNodeMap.get(libName);

                    if (!libId) {
                        libId = `lib_${this.nextNodeIdNum++}`;
                        this.graph.nodes.push({
                            id: libId,
                            label: libName,
                            type: 'library'
                        });
                        this.libraryNodeMap.set(libName, libId);
                    }

                    this.graph.edges.push({
                        id: `edge_${this.nextEdgeIdNum++}`,
                        source: fileNodeId,
                        target: libId,
                        label: 'imports'
                    });
                }
            }

            // Linking pass for just the updated file (and linking others to it)
            const allSymbols = this.graph.nodes.filter(n => n.type === 'function' || n.type === 'method' || n.type === 'class');
            const fileSymbols = this.graph.nodes
                .filter(n => n.filePath === normalizedPath && (n.type === 'function' || n.type === 'method' || n.type === 'class'))
                .sort((a, b) => (a.startLine || 0) - (b.startLine || 0));

            const symbolRegexes = new Map<string, { bound: RegExp; call: RegExp; instantiation: RegExp }>();
            allSymbols.forEach(symbol => {
                const escapedLabel = symbol.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                symbolRegexes.set(symbol.id, {
                    bound: new RegExp(`\\b${escapedLabel}\\b`),
                    call: new RegExp(`\\b${escapedLabel}\\s*\\(`, 'g'),
                    instantiation: new RegExp(`\\bnew\\s+${escapedLabel}\\b|:\\s*${escapedLabel}\\b|\\b${escapedLabel}\\.`, 'g')
                });
            });

            const addEdgeOnce = (src: string, trg: string, relLabel: string) => {
                const edgeExists = this.graph.edges.some(e => e.source === src && e.target === trg && e.label === relLabel);
                if (!edgeExists) {
                    this.graph.edges.push({
                        id: `edge_${this.nextEdgeIdNum++}`,
                        source: src,
                        target: trg,
                        label: relLabel
                    });
                }
            };

            // Part A: Link this file's lines to other project symbols
            for (let index = 0; index < lines.length; index++) {
                const line = lines[index];
                let currentCallerId = fileNodeId;
                for (let sIdx = fileSymbols.length - 1; sIdx >= 0; sIdx--) {
                    const sym = fileSymbols[sIdx];
                    if (sym.startLine !== undefined && index >= sym.startLine) {
                        currentCallerId = sym.id;
                        break;
                    }
                }

                const callerNode = this.graph.nodes.find(n => n.id === currentCallerId);
                const isAtDefinitionLine = callerNode && index === callerNode.startLine;

                for (const symbol of allSymbols) {
                    if (symbol.id === currentCallerId) continue;
                    if (!line.includes(symbol.label)) continue;

                    const regexes = symbolRegexes.get(symbol.id);
                    if (!regexes) continue;

                    if (isAtDefinitionLine) {
                        if (callerNode.params && regexes.bound.test(callerNode.params)) {
                            addEdgeOnce(currentCallerId, symbol.id, 'inputParam');
                            continue;
                        }
                        if (callerNode.returnType && regexes.bound.test(callerNode.returnType)) {
                            addEdgeOnce(currentCallerId, symbol.id, 'outputParam');
                            continue;
                        }
                    }

                    if (regexes.call.test(line)) {
                        addEdgeOnce(currentCallerId, symbol.id, 'calls');
                    } else if (regexes.instantiation.test(line)) {
                        addEdgeOnce(currentCallerId, symbol.id, 'localVariable');
                    }
                }
            }

            // Part B: Link other files' lines to this file's newly defined symbols
            if (fileSymbols.length > 0) {
                for (const [otherPath, otherData] of this.fileContents.entries()) {
                    if (otherPath === normalizedPath) continue;
                    const otherLines = otherData.text.split('\n');
                    const otherFileNodeId = this.fileNodeMap.get(otherPath);
                    if (!otherFileNodeId) continue;

                    const otherSymbols = this.graph.nodes
                        .filter(n => n.filePath === otherPath && (n.type === 'function' || n.type === 'method' || n.type === 'class'))
                        .sort((a, b) => (a.startLine || 0) - (b.startLine || 0));

                    for (let index = 0; index < otherLines.length; index++) {
                        const line = otherLines[index];
                        let currentCallerId = otherFileNodeId;
                        for (let sIdx = otherSymbols.length - 1; sIdx >= 0; sIdx--) {
                            const sym = otherSymbols[sIdx];
                            if (sym.startLine !== undefined && index >= sym.startLine) {
                                currentCallerId = sym.id;
                                break;
                            }
                        }

                        const callerNode = this.graph.nodes.find(n => n.id === currentCallerId);
                        const isAtDefinitionLine = callerNode && index === callerNode.startLine;

                        for (const symbol of fileSymbols) {
                            if (!line.includes(symbol.label)) continue;

                            const regexes = symbolRegexes.get(symbol.id);
                            if (!regexes) continue;

                            if (isAtDefinitionLine) {
                                if (callerNode.params && regexes.bound.test(callerNode.params)) {
                                    addEdgeOnce(currentCallerId, symbol.id, 'inputParam');
                                    continue;
                                }
                                if (callerNode.returnType && regexes.bound.test(callerNode.returnType)) {
                                    addEdgeOnce(currentCallerId, symbol.id, 'outputParam');
                                    continue;
                                }
                            }

                            if (regexes.call.test(line)) {
                                addEdgeOnce(currentCallerId, symbol.id, 'calls');
                            } else if (regexes.instantiation.test(line)) {
                                addEdgeOnce(currentCallerId, symbol.id, 'localVariable');
                            }
                        }
                    }
                }
            }

            // Handle Inheritance
            const jsInheritance = /class\s+([a-zA-Z0-9_]+)\s+extends\s+([a-zA-Z0-9_.]+)/g;
            const pyInheritance = /class\s+([a-zA-Z0-9_]+)\s*\(\s*([a-zA-Z0-9_.]+)\s*\)/g;
            const regex = (ext === 'py') ? pyInheritance : jsInheritance;
            regex.lastIndex = 0;

            let match;
            while ((match = regex.exec(cleanText)) !== null) {
                const className = match[1];
                const parentName = match[2];

                if (parentName && parentName !== 'object') {
                    const childId = this.classNodeMap.get(className);
                    const parentId = this.classNodeMap.get(parentName);

                    if (childId && parentId) {
                        addEdgeOnce(childId, parentId, 'inherits');
                    }
                }
            }

            this.contextSetter?.('codeGraph.ready', true);
        } catch (err: any) {
            console.warn(`[Incremental Graph Update] Error updating ${normalizedPath}:`, err);
        }
    }

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

    getArchitectureAnalysis(target: string, queryType: 'outline' | 'dependencies' | 'usages'): string {
        if (this.buildState !== 'ready') return "Graph not built. Please run update_code_graph first.";
        
        const normalizedTarget = target.replace(/\\/g, '/');
        const targetNodes = this.graph.nodes.filter(n => 
            n.label === target || 
            (n.filePath && (n.filePath === normalizedTarget || n.filePath.endsWith('/' + normalizedTarget))) ||
            n.id === target
        );

        if (targetNodes.length === 0) return `Target '${target}' not found in the architecture graph.`;

        let result = `Architecture Analysis for '${target}':\n\n`;

        targetNodes.forEach(tNode => {
            result += `###[${tNode.type.toUpperCase()}] ${tNode.label} ${tNode.filePath ? `(in ${tNode.filePath})` : ''}\n`;
            
            if (queryType === 'outline') {
                if (tNode.type === 'file' || tNode.type === 'class') {
                    const children = this.graph.edges.filter(e => e.source === tNode.id && e.label === 'contains').map(e => this.graph.nodes.find(n => n.id === e.target));
                    result += `Contains:\n`;
                    let hasItems = false;
                    children.forEach(c => {
                        if (c) {
                            result += `- [${c.type}] ${c.signature || c.label}\n`;
                            hasItems = true;
                        }
                    });
                    if (!hasItems) result += `- (Empty)\n`;
                } else {
                    result += `Outline not applicable for type ${tNode.type}. Use 'usages' or 'dependencies'.\n`;
                }
            } else if (queryType === 'dependencies') {
                const outgoing = this.graph.edges.filter(e => e.source === tNode.id && e.label !== 'contains');
                result += `Dependencies (What this uses/calls/imports):\n`;
                let hasItems = false;
                outgoing.forEach(e => {
                    const dest = this.graph.nodes.find(n => n.id === e.target);
                    if (dest) {
                        result += `-[${e.label}] -> [${dest.type}] ${dest.label} ${dest.filePath ? `(${dest.filePath})` : ''}\n`;
                        hasItems = true;
                    }
                });
                if (!hasItems) result += `- (None found)\n`;
            } else if (queryType === 'usages') {
                const incoming = this.graph.edges.filter(e => e.target === tNode.id && e.label !== 'contains');
                result += `Usages (What uses/calls/imports this):\n`;
                let hasItems = false;
                incoming.forEach(e => {
                    const src = this.graph.nodes.find(n => n.id === e.source);
                    if (src) {
                        result += `- [${e.label}] <- [${src.type}] ${src.label} ${src.filePath ? `(${src.filePath})` : ''}\n`;
                        hasItems = true;
                    }
                });
                if (!hasItems) result += `- (None found)\n`;
            }
            result += `\n`;
        });

        return result.trim();
    }

    /**
     * Executes a SPARQL-lite query over the built code graph.
     * Enforces the LoLLMs Source Code Ontology:
     * - Classes: s:File, s:Class, s:Function, s:Method, s:Library
     * - Properties: s:contains, s:imports, s:calls, s:inherits, s:type, s:name, s:path
     */
    public executeSparql(query: string): string {
        if (this.buildState !== 'ready') {
            return "Error: Code graph is not built yet. Please run update_code_graph first.";
        }

        // Clean query comments and whitespace
        const cleanQuery = query.replace(/#.*/g, '').trim();
        const selectMatch = cleanQuery.match(/SELECT\s+([\?\w\s]+)\s+WHERE\s*\{([\s\S]+?)\}/i);
        const constructMatch = cleanQuery.match(/CONSTRUCT\s*\{([\s\S]+?)\}\s*WHERE\s*\{([\s\S]+?)\}/i);

        if (!selectMatch && !constructMatch) {
            return "SPARQL-lite Error: Invalid query format. Expected SELECT ?var WHERE { ... } or CONSTRUCT { ... } WHERE { ... }";
        }

        const isConstruct = !selectMatch;
        const whereClause = selectMatch ? selectMatch[2].trim() : constructMatch![2].trim();
        const constructTemplate = isConstruct ? constructMatch![1].trim() : "";

        // Parse WHERE Triple Patterns
        const triples: { s: string, p: string, o: string }[] = [];
        const lines = whereClause.split(/\s*\.\s*(?=(?:[^"']*["'][^"']*["'])*[^"']*$)/); // Split by dot outside quotes
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const parts = trimmed.split(/\s+/);
            if (parts.length >= 3) {
                triples.push({
                    s: parts[0],
                    p: parts[1],
                    o: parts.slice(2).join(' ') // Handles spaces inside quoted literals
                });
            }
        }

        if (triples.length === 0) {
            return "SPARQL-lite Error: No triple patterns found in WHERE clause.";
        }

        // Collect all variables
        const variables = new Set<string>();
        for (const t of triples) {
            if (t.s.startsWith('?')) variables.add(t.s);
            if (t.p.startsWith('?')) variables.add(t.p);
            if (t.o.startsWith('?')) variables.add(t.o);
        }

        // Generate knowledge triples/facts from internal graph
        const facts: { s: string, p: string, o: string }[] = [];
        for (const node of this.graph.nodes) {
            const typeUri = `s:${node.type.charAt(0).toUpperCase() + node.type.slice(1)}`;
            facts.push({ s: node.id, p: 's:type', o: typeUri });
            facts.push({ s: node.id, p: 's:name', o: `"${node.label}"` });
            if (node.filePath) {
                facts.push({ s: node.id, p: 's:path', o: `"${node.filePath}"` });
            }
        }

        for (const edge of this.graph.edges) {
            const relUri = `s:${edge.label}`;
            facts.push({ s: edge.source, p: relUri, o: edge.target });
        }

        const varList = Array.from(variables);
        const results: Record<string, string>[] = [];

        const matchValue = (factVal: string, queryVal: string): boolean => {
            if (!factVal || !queryVal) return false;
            const cleanFact = factVal.replace(/^s:/i, '').toLowerCase().replace(/['"]/g, '').trim();
            const cleanQuery = queryVal.replace(/^s:/i, '').toLowerCase().replace(/['"]/g, '').trim();
            return cleanFact === cleanQuery;
        };

        // Backtracking Search Graph Matcher
        const solve = (varIdx: number, bindings: Record<string, string>) => {
            if (varIdx === varList.length) {
                let valid = true;
                for (const t of triples) {
                    const sVal = t.s.startsWith('?') ? bindings[t.s] : t.s;
                    const pVal = t.p.startsWith('?') ? bindings[t.p] : t.p;
                    const oVal = t.o.startsWith('?') ? bindings[t.o] : t.o;

                    const match = facts.some(f => {
                        return matchValue(f.s, sVal) && matchValue(f.p, pVal) && matchValue(f.o, oVal);
                    });

                    if (!match) {
                        valid = false;
                        break;
                    }
                }
                if (valid) {
                    const isDup = results.some(r => {
                        return varList.every(v => r[v] === bindings[v]);
                    });
                    if (!isDup) {
                        results.push({ ...bindings });
                    }
                }
                return;
            }

            const currentVar = varList[varIdx];
            const domain = new Set<string>();
            for (const t of triples) {
                if (t.s === currentVar) {
                    facts.forEach(f => domain.add(f.s));
                }
                if (t.p === currentVar) {
                    facts.forEach(f => domain.add(f.p));
                }
                if (t.o === currentVar) {
                    facts.forEach(f => domain.add(f.o));
                }
            }

            for (const val of domain) {
                bindings[currentVar] = val;
                solve(varIdx + 1, bindings);
                delete bindings[currentVar];
            }
        };

        solve(0, {});

        if (results.length === 0) {
            return "SPARQL-lite Result: No matching subgraphs found.";
        }

        const idToLabel = new Map<string, string>();
        this.graph.nodes.forEach(n => idToLabel.set(n.id, n.label));

        if (!isConstruct) {
            const selectVars = selectMatch![1].trim().split(/\s+/).map(v => v.trim());
            // Format into a Markdown table
            let out = `### 🔍 SPARQL-lite Query Results\n\n`;
            out += `| ${selectVars.join(' | ')} |\n`;
            out += `| ${selectVars.map(() => '---').join(' | ')} |\n`;

            results.forEach(row => {
                const line = selectVars.map(v => {
                    const rawVal = row[v] || "";
                    if (idToLabel.has(rawVal)) {
                        return `**${idToLabel.get(rawVal)}** (\`${rawVal}\`)`;
                    }
                    return rawVal.replace(/^"|"$/g, '');
                }).join(' | ');
                out += `| ${line} |\n`;
            });

            return out;
        } else {
            // CONSTRUCT MODE
            const templateTriples: { s: string, p: string, o: string }[] = [];
            const templateLines = constructTemplate.split(/\s*\.\s*(?=(?:[^"']*["'][^"']*["'])*[^"']*$)/);
            for (const line of templateLines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                const parts = trimmed.split(/\s+/);
                if (parts.length >= 3) {
                    templateTriples.push({
                        s: parts[0],
                        p: parts[1],
                        o: parts.slice(2).join(' ')
                    });
                }
            }

            let out = `### 🧱 Constructed Subgraph Triples (RDF)\n\n`;
            out += `| Subject | Predicate | Object |\n`;
            out += `| --- | --- | --- |\n`;

            const constructedTriplesSet = new Set<string>();

            results.forEach(row => {
                templateTriples.forEach(t => {
                    const sVal = t.s.startsWith('?') ? row[t.s] : t.s;
                    const pVal = t.p.startsWith('?') ? row[t.p] : t.p;
                    const oVal = t.o.startsWith('?') ? row[t.o] : t.o;

                    if (sVal && pVal && oVal) {
                        const cleanS = sVal.replace(/^s:/i, '');
                        const cleanP = pVal.replace(/^s:/i, '');
                        const cleanO = oVal.replace(/^s:/i, '');

                        const tripleKey = `${cleanS}|${cleanP}|${cleanO}`;
                        if (!constructedTriplesSet.has(tripleKey)) {
                            constructedTriplesSet.add(tripleKey);

                            const sLabel = idToLabel.get(cleanS) || cleanS;
                            const oLabel = idToLabel.get(cleanO) || cleanO;

                            out += `| **${sLabel}** (\`${cleanS}\`) | \`s:${cleanP}\` | **${oLabel}** (\`${cleanO}\`) |\n`;
                        }
                    }
                });
            });

            return out;
        }
    }

    generateTextSummary(): string {
        if (this.buildState !== 'ready') return "Graph not built. Run 'update_code_graph' to generate.";

        let out = "# 🗺️ ARCHITECTURAL MAP\n";
        const files = this.graph.nodes.filter(n => n.type === 'file');

        files.forEach(f => {
            const namespacedPath = f.filePath || "unknown";
            out += `## FILE: ${namespacedPath}\n`;
            
            const contains = this.graph.edges.filter(e => e.source === f.id && e.label === 'contains').map(e => this.graph.nodes.find(n => n.id === e.target));
            const imports = this.graph.edges.filter(e => e.source === f.id && e.label === 'imports').map(e => this.graph.nodes.find(n => n.id === e.target));
            
            const classes = contains.filter(n => n?.type === 'class').map(n => n?.label);
            const funcs = contains.filter(n => n?.type === 'function').map(n => n?.label);
            const imps = imports.map(n => n?.label);
            
            if (classes.length) out += `  Classes: ${classes.join(', ')}\n`;
            if (funcs.length) out += `  Functions: ${funcs.join(', ')}\n`;
            if (imps.length) out += `  Imports: ${imps.join(', ')}\n`;
        });
        return out;
    }

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
            case 'module_dependency_graph':
                diagram = this.generateModuleDependencyGraphMermaid();
                break;
            case 'external_library_graph':
                diagram = this.generateExternalLibraryGraphMermaid();
                break;
            case 'hotspot_complexity_graph':
                diagram = this.generateHotspotComplexityGraphMermaid();
                break;
            default:
                diagram = 'graph TD;\n  Empty["No graph selected"]';
        }
        return header + diagram;
    }

    private generateHotspotComplexityGraphMermaid(): string {
        let out = 'graph TD\n';
        let hasEdges = false;
        const definedNodes = new Set<string>();

        const defineNode = (nodeId: string) => {
            if (!definedNodes.has(nodeId)) {
                const node = this.graph.nodes.find(n => n.id === nodeId);
                if (node) {
                    const safeLabel = this.sanitizeMermaidLabel(node.label);
                    const lines = node.linesCount || 50;
                    out += `${this.sanitizeMermaidId(nodeId)}["${safeLabel} (${lines} LOC)"]\n`;
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
        if (!hasEdges) out += 'subgraph Empty\nDirection["No structure detected"]\nend';
        return out;
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
                        out += `style ${safeId} fill:#d19a66,stroke:#333,stroke-width:2px\n`;
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

    private generateModuleDependencyGraphMermaid(): string {
        let out = 'graph TD\n';
        const folderEdges = new Set<string>();
        const folderNames = new Set<string>();

        this.graph.edges.forEach(e => {
            if (e.label === 'imports') {
                const srcNode = this.graph.nodes.find(n => n.id === e.source);
                const trgNode = this.graph.nodes.find(n => n.id === e.target);
                if (srcNode && trgNode && srcNode.filePath && trgNode.filePath) {
                    const srcFolder = path.dirname(srcNode.filePath).replace(/\\/g, '/');
                    const trgFolder = path.dirname(trgNode.filePath).replace(/\\/g, '/');
                    if (srcFolder !== trgFolder) {
                        const edgeKey = `"${srcFolder}" --> "${trgFolder}"`;
                        if (!folderEdges.has(edgeKey)) {
                            folderEdges.add(edgeKey);
                            folderNames.add(srcFolder);
                            folderNames.add(trgFolder);
                        }
                    }
                }
            }
        });

        folderNames.forEach(folder => {
            const safeId = folder.replace(/[^a-zA-Z0-9_]/g, '_');
            out += `  ${safeId}["📁 ${folder}"]\n`;
        });

        folderEdges.forEach(edge => {
            const parts = edge.match(/"([^"]+)" --> "([^"]+)"/);
            if (parts) {
                const srcId = parts[1].replace(/[^a-zA-Z0-9_]/g, '_');
                const trgId = parts[2].replace(/[^a-zA-Z0-9_]/g, '_');
                out += `  ${srcId} --> ${trgId}\n`;
            }
        });

        if (folderEdges.size === 0) {
            out += '  NoFolderDeps["No cross-folder dependencies found"]\n';
        }

        return out;
    }

    private generateExternalLibraryGraphMermaid(): string {
        let out = 'graph TD\n';
        const libNodes = this.graph.nodes.filter(n => n.type === 'library');
        const libEdges = this.graph.edges.filter(e => {
            const trg = this.graph.nodes.find(n => n.id === e.target);
            return trg && trg.type === 'library';
        });

        libNodes.forEach(lib => {
            const safeId = lib.id.replace(/[^a-zA-Z0-9_]/g, '_');
            out += `  ${safeId}{{"📦 ${lib.label}"}}\n`;
            out += `  style ${safeId} fill:#d19a66,stroke:#333,stroke-width:2px\n`;
        });

        libEdges.forEach(e => {
            const srcNode = this.graph.nodes.find(n => n.id === e.source);
            if (srcNode) {
                const safeSrcId = srcNode.id.replace(/[^a-zA-Z0-9_]/g, '_');
                const safeTrgId = e.target.replace(/[^a-zA-Z0-9_]/g, '_');
                
                out += `  ${safeSrcId}["📄 ${srcNode.label}"]\n`;
                out += `  ${safeSrcId} --> ${safeTrgId}\n`;
            }
        });

        if (libEdges.length === 0) {
            out += '  NoExternalLibs["No external library imports found"]\n';
        }

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
