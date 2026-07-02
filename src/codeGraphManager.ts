import * as vscode from 'vscode';
import * as path from 'path';
import { Worker } from 'worker_threads';

/**
 * ==========================================
 * 🧊 LOLLMS SOURCE CODE ONTOLOGY & WORKER ENGINE
 * ==========================================
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
    signature?: string;
    linesCount?: number;
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

// --- INLINE WORKER SOURCE CODE ---
// This code executes entirely inside a separate Node.js worker thread.
// It parses file contents and extracts imports/methods, returning the results.
const WORKER_PARSE_SCRIPT = `
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');

function stripCommentsAndStrings(code) {
    return code.replace(/\\/\\*[\\s\\S]*?\\*\\/|([^\\\\:]|^)\\/\\/.*$/gm, '$1') 
               .replace(/#.*/g, '') 
               .replace(/"(?:[^"\\\\\\n]|\\\\.)*"|'(?:[^'\\\\\\n]|\\\\.)*'/g, ''); 
}

function extractImports(text, ext) {
    const imports = [];
    if (['ts', 'js', 'tsx', 'jsx'].includes(ext)) {
        let match;
        const esImportRegex = /(?:import|export)\\s+(?:type\\s+)?(?:[\\w\\s{},*]+from\\s+)?['"]([^'"]+)['"]/g;
        while ((match = esImportRegex.exec(text)) !== null) {
            imports.push(match[1]);
        }
        const dynamicImportRegex = /import\\s*\\(\\s*['"]([^'"]+)['"]\\s*\\)/g;
        while ((match = dynamicImportRegex.exec(text)) !== null) {
            imports.push(match[1]);
        }
        const requireRegex = /require\\s*\\(\\s*['"]([^'"]+)['"]\\s*\\)/g;
        while ((match = requireRegex.exec(text)) !== null) {
            imports.push(match[1]);
        }
    } else if (ext === 'py') {
        const fromImportRegex = /^from\\s+([\\w\\.]+)\\s+import/gm;
        let match;
        while ((match = fromImportRegex.exec(text)) !== null) {
            imports.push(match[1].replace(/\\./g, '/'));
        }
        const importRegex = /^import\\s+([^\\n]+)/gm;
        while ((match = importRegex.exec(text)) !== null) {
            const modules = match[1].split(',');
            modules.forEach(m => {
                const cleanName = m.trim().split(/\\s+as\\s+/)[0];
                if (cleanName) imports.push(cleanName.replace(/\\./g, '/'));
            });
        }
    }
    return imports;
}

const { absolutePath, ext, normalizedPath } = workerData;
let text = '';
try {
    text = fs.readFileSync(absolutePath, 'utf8');
} catch (err) {
    text = '';
}
const cleanText = stripCommentsAndStrings(text);
const lines = cleanText.split('\\n');

const localNodes = [];
const localEdges = [];

let nextNodeIdNum = 1;
let nextEdgeIdNum = 1;

let currentClass = null;
let currentClassIndent = 0;

lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const indent = line.search(/\\S/);

    const fnMatch = line.match(/(?:async\\s+)?function\\s+([a-zA-Z0-9_]+)\\s*\\(([^)]*)\\)(?:\\s*:\\s*([^\\{]+))?/);
    const pyMatch = line.match(/^\\s*def\\s+([a-zA-Z0-9_]+)\\s*\\(([^)]*)\\)(?:\\s*->\\s*([^:]+))?\\s*:/);

    if ((fnMatch || pyMatch) && !currentClass) {
        const name = fnMatch ? fnMatch[1] : pyMatch[1];
        const args = fnMatch ? fnMatch[2] : pyMatch[2];
        const ret = fnMatch ? (fnMatch[3] || 'any') : (pyMatch[3] || 'None');

        localNodes.push({
            id: \`fn_\${nextNodeIdNum++}\`,
            label: name,
            type: 'function',
            filePath: normalizedPath,
            startLine: index,
            signature: \`\${name}(\${args.trim()}) -> \${ret.trim()}\`,
            params: args.trim(),
            returnType: ret.trim()
        });
    }

    const classMatch = line.match(/class\\s+([a-zA-Z0-9_]+)/);
    if (classMatch) {
        const className = classMatch[1];
        const classNodeId = \`class_\${nextNodeIdNum++}\`;

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
        localNodes.push(currentClass);
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
                methodMatch = line.match(/^\\s+def\\s+([a-zA-Z0-9_]+)\\s*\\(([^)]*)\\)(?:\\s*->\\s*([^:]+))?\\s*:/);
                if (methodMatch) {
                    const methodName = methodMatch[1];
                    const methodNodeId = \`method_\${nextNodeIdNum++}\`;
                    localNodes.push({
                        id: methodNodeId,
                        label: methodName,
                        type: 'method',
                        filePath: normalizedPath,
                        startLine: index,
                        signature: \`\${methodName}(\${methodMatch[2].trim()}) -> \${methodMatch[3]?.trim() || 'None'}\`,
                        params: methodMatch[2].trim(),
                        returnType: methodMatch[3]?.trim() || 'None'
                    });
                    localEdges.push({ source: currentClass.id, target: methodNodeId, label: 'contains' });
                }
            } else {
                methodMatch = line.match(/(?:public|private|protected|static|async|\\s)*\\s+([a-zA-Z0-9_]+)\\s*\\(([^)]*)\\)(?:\\s*:\\s*([^\\{]+))?/);
                if (methodMatch && !['if', 'for', 'while', 'switch', 'catch', 'constructor'].includes(methodMatch[1])) {
                    const methodName = methodMatch[1];
                    const methodNodeId = \`method_\${nextNodeIdNum++}\`;
                    localNodes.push({
                        id: methodNodeId,
                        label: methodName,
                        type: 'method',
                        filePath: normalizedPath,
                        startLine: index,
                        signature: \`\${methodName}(\&{methodMatch[2].trim()}) : \${methodMatch[3]?.trim() || 'any'}\`,
                        params: methodMatch[2].trim(),
                        returnType: methodMatch[3]?.trim() || 'any'
                    });
                    localEdges.push({ source: currentClass.id, target: methodNodeId, label: 'contains' });
                }
            }

            let attrMatch;
            if (ext === 'py') {
                attrMatch = line.match(/self\\.([a-zA-Z0-9_]+)\\s*=/);
            } else {
                attrMatch = line.match(/(?:public|private|protected|\\s)*\\s*([a-zA-Z0-9_]+)\\s*(?::\\s*[a-zA-Z0-9_<>\\[\\]]+)?\\s*=/);
            }

            if (attrMatch) {
                currentClass.attributes.push(attrMatch[1]);
            }
        }
    }
});

const imports = extractImports(cleanText, ext);

parentPort.postMessage({
    nodes: localNodes,
    edges: localEdges,
    imports,
    linesCount: lines.length
});
`;

export class CodeGraphManager {
    private workspaceRoot?: vscode.Uri;
    private graph: GraphData = { nodes: [], edges: [] };
    private buildState: BuildState = 'idle';
    private lastError?: string;
    private contextSetter?: ContextSetter;
    private abortController?: AbortController;

    private activeBuildPromise: Promise<void> | null = null;
    private activeIncrementalPromises = new Map<string, Promise<void>>();

    // High-performance caching layers for incremental compiles
    private parsedFilesCache = new Map<string, {
        nodes: GraphNode[];
        edges: GraphEdge[];
        imports: string[];
        linesCount: number;
    }>();

    private fileIdsMap = new Map<string, string>(); // filePath -> File node ID

    constructor() {}

    private runParserInWorker(absolutePath: string, ext: string, normalizedPath: string): Promise<any> {
        return new Promise((resolve, reject) => {
            const worker = new Worker(WORKER_PARSE_SCRIPT, {
                eval: true,
                workerData: { absolutePath, ext, normalizedPath }
            });

            worker.on('message', (result) => {
                worker.terminate();
                resolve(result);
            });

            worker.on('error', (err) => {
                worker.terminate();
                reject(err);
            });

            worker.on('exit', (code) => {
                if (code !== 0) {
                    reject(new Error(`Worker stopped with exit code ${code}`));
                }
            });
        });
    }

    public setWorkspaceRoot(root: vscode.Uri) {
        this.workspaceRoot = root;
    }

    public setContextSetter(setter: ContextSetter) {
        this.contextSetter = setter;
    }

    public getGraphData(): GraphData {
        return this.graph;
    }

    public getBuildState(): BuildState {
        return this.buildState;
    }

    public getLastError(): string | undefined {
        return this.lastError;
    }

    public cancel() {
        if (this.abortController) {
            this.abortController.abort();
        }
        this.buildState = 'idle';
        if (this.contextSetter) {
            this.contextSetter('buildState', 'idle');
        }
    }

    public reset() {
        this.graph = { nodes: [], edges: [] };
        this.parsedFilesCache.clear();
        this.fileIdsMap.clear();
        this.buildState = 'idle';
        if (this.contextSetter) {
            this.contextSetter('buildState', 'idle');
        }
    }

    /**
     * Rebuilds the graph, using thread pools for parallel file reads and parsing.
     */
    public buildGraph(focusPath?: string, progress?: (progress: { percentage: number; status: string }) => void): Promise<void> {
        if (this.activeBuildPromise) {
            return this.activeBuildPromise;
        }

        this.activeBuildPromise = (async () => {
            if (!this.workspaceRoot) {
                this.buildState = 'error';
                this.lastError = "No workspace root configured.";
                return;
            }

            this.buildState = 'building';
            if (this.contextSetter) {
                this.contextSetter('buildState', 'building');
            }

            this.abortController = new AbortController();
            const signal = this.abortController.signal;

            try {
                if (progress) progress({ percentage: 10, status: "Scouting codebase structure..." });

                // Find all source files
                const patterns = ['**/*.ts', '**/*.js', '**/*.tsx', '**/*.jsx', '**/*.py'];
                const excludePattern = '**/{node_modules,venv,.venv,env,.env,.git,dist,build,out,bin,obj,.vscode,.idea,.lollms,__pycache__,target,*.egg-info,vendor}/**';
                
                let files: vscode.Uri[] = [];
                for (const pattern of patterns) {
                    if (signal.aborted) return;
                    const matches = await vscode.workspace.findFiles(
                        new vscode.RelativePattern(this.workspaceRoot, pattern),
                        excludePattern,
                        500
                    );
                    files = [...files, ...matches];
                }

                const MAX_FILES = 400;
                if (files.length > MAX_FILES) {
                    files = files.slice(0, MAX_FILES);
                }

                const total = files.length;
                let processed = 0;

                // Process in parallel thread pools
                const poolLimit = 8;
                const activeWorkers: Promise<void>[] = [];

                for (let i = 0; i < files.length; i++) {
                    if (signal.aborted) return;

                    const fileUri = files[i];
                    const relPath = path.relative(this.workspaceRoot.fsPath, fileUri.fsPath).replace(/\\/g, '/');

                    const task = (async () => {
                        try {
                            const ext = path.extname(relPath).substring(1);

                            // Offload file reading & parsing to background worker thread
                            const parsed = await this.runParserInWorker(fileUri.fsPath, ext, relPath);

                            this.parsedFilesCache.set(relPath, parsed);
                        } catch (e) {
                            console.error(`Failed to parse ${relPath} in thread:`, e);
                        } finally {
                            processed++;
                            if (progress && processed % 5 === 0) {
                                const pct = 40 + Math.round((processed / total) * 50);
                                progress({ percentage: pct, status: `Parsing ${path.basename(relPath)} [${processed}/${total}]` });
                            }
                        }
                    })();

                    activeWorkers.push(task);
                    if (activeWorkers.length >= poolLimit) {
                        await Promise.race(activeWorkers);
                        // Filter completed promises out of the pool
                        const activeIndex = activeWorkers.indexOf(task);
                        if (activeIndex > -1) {
                            activeWorkers.splice(activeIndex, 1);
                        }
                    }
                }

                await Promise.all(activeWorkers);

                if (signal.aborted) return;

                if (progress) progress({ percentage: 90, status: "Establishing graph links..." });

                this.linkGraphStructure();

                this.buildState = 'ready';
                if (this.contextSetter) {
                    this.contextSetter('buildState', 'ready');
                }
                if (progress) progress({ percentage: 100, status: "Architecture map synchronized." });

            } catch (err: any) {
                this.buildState = 'error';
                this.lastError = err?.message || String(err);
                if (this.contextSetter) {
                    this.contextSetter('buildState', 'error');
                }
            } finally {
                this.activeBuildPromise = null;
            }
        })();

        return this.activeBuildPromise;
    }

    /**
     * Fast incremental file update. Offloads ONLY the changed file to a worker,
     * and updates its local cache entries.
     */
    public async updateFileInGraph(fileUri: vscode.Uri) {
        if (!this.workspaceRoot) return;

        const relPath = path.relative(this.workspaceRoot.fsPath, fileUri.fsPath).replace(/\\/g, '/');

        // Prevent multiple simultaneous updates on the exact same file
        if (this.activeIncrementalPromises.has(relPath)) {
            return this.activeIncrementalPromises.get(relPath);
        }

        const task = (async () => {
            try {
                const stat = await vscode.workspace.fs.stat(fileUri).catch(() => null);
                if (!stat || stat.type === vscode.FileType.Directory) {
                    this.removeFileFromGraph(fileUri);
                    return;
                }

                const ext = path.extname(relPath).substring(1);

                // Incremental Parse: Run background worker for ONLY this single changed file
                const parsed = await this.runParserInWorker(fileUri.fsPath, ext, relPath);
                this.parsedFilesCache.set(relPath, parsed);

                // If the graph was already fully compiled, update only the modified file surgically
                if (this.buildState === 'ready') {
                    this.linkFileInGraph(relPath);
                }

            } catch (e) {
                console.error(`Failed incremental parse for ${relPath}:`, e);
            } finally {
                this.activeIncrementalPromises.delete(relPath);
            }
        })();

        this.activeIncrementalPromises.set(relPath, task);
        return task;
    }

    public removeFileFromGraph(fileUri: vscode.Uri) {
        if (!this.workspaceRoot) return;
        const relPath = path.relative(this.workspaceRoot.fsPath, fileUri.fsPath).replace(/\\/g, '/');

        this.parsedFilesCache.delete(relPath);
        this.fileIdsMap.delete(relPath);

        if (this.buildState === 'ready') {
            const fileNodeId = `file_${relPath.replace(/[^a-zA-Z0-9_]/g, '_')}`;
            this.graph.nodes = this.graph.nodes.filter(n => n.filePath !== relPath && n.id !== fileNodeId);
            this.graph.edges = this.graph.edges.filter(e => {
                const srcNode = this.graph.nodes.find(n => n.id === e.source);
                const trgNode = this.graph.nodes.find(n => n.id === e.target);
                return srcNode && trgNode; // Sweep away orphaned edges
            });
        }
    }

    /**
     * Surgically updates a single file inside the fully compiled active graph,
     * preserving all other unchanged nodes and edge configurations.
     */
    private linkFileInGraph(relPath: string) {
        if (this.buildState !== 'ready') return;

        const fileNodeId = `file_${relPath.replace(/[^a-zA-Z0-9_]/g, '_')}`;

        // 1. Evict old file node, symbol nodes, and contains relations
        this.graph.nodes = this.graph.nodes.filter(n => n.filePath !== relPath && n.id !== fileNodeId);

        const activeNodeIds = new Set(this.graph.nodes.map(n => n.id));
        this.graph.edges = this.graph.edges.filter(e => {
            return activeNodeIds.has(e.source) && activeNodeIds.has(e.target);
        });

        const cache = this.parsedFilesCache.get(relPath);
        if (!cache) return;

        // 2. Add New File Node with Stable ID
        this.graph.nodes.push({
            id: fileNodeId,
            label: path.basename(relPath),
            type: 'file',
            filePath: relPath,
            startLine: 0,
            linesCount: cache.linesCount
        });

        const classNameToId = new Map<string, string>();
        this.graph.nodes.forEach(n => {
            if (n.type === 'class') {
                classNameToId.set(n.label, n.id);
            }
        });

        // 3. Re-inject symbol nodes and contains links
        cache.nodes.forEach(n => {
            const sysId = `sym_${relPath.replace(/[^a-zA-Z0-9_]/g, '_')}_${n.label}`;
            this.graph.nodes.push({
                ...n,
                id: sysId,
                filePath: relPath
            });

            if (n.type === 'class') {
                classNameToId.set(n.label, sysId);
            }

            this.graph.edges.push({
                id: `edge_contains_${fileNodeId}_${sysId}`,
                source: fileNodeId,
                target: sysId,
                label: 'contains'
            });
        });

        // Re-inject internal symbol hierachies (Class contains Method)
        cache.edges.forEach(e => {
            const srcSymbol = cache.nodes.find(n => n.id === e.source);
            const trgSymbol = cache.nodes.find(n => n.id === e.target);
            if (srcSymbol && trgSymbol) {
                const srcMapped = `sym_${relPath.replace(/[^a-zA-Z0-9_]/g, '_')}_${srcSymbol.label}`;
                const trgMapped = `sym_${relPath.replace(/[^a-zA-Z0-9_]/g, '_')}_${trgSymbol.label}`;
                this.graph.edges.push({
                    id: `edge_${e.label}_${srcMapped}_${trgMapped}`,
                    source: srcMapped,
                    target: trgMapped,
                    label: e.label
                });
            }
        });

        // 4. Map File Nodes and Re-link imports surgically
        const fileNodeIds = new Map<string, string>();
        this.graph.nodes.forEach(n => {
            if (n.type === 'file' && n.filePath) {
                fileNodeIds.set(n.filePath, n.id);
            }
        });

        cache.imports.forEach(imp => {
            const targetPath = this.resolveImportPath(imp, relPath, fileNodeIds);
            if (targetPath) {
                const targetFileId = fileNodeIds.get(targetPath);
                if (targetFileId && targetFileId !== fileNodeId) {
                    this.graph.edges.push({
                        id: `edge_imports_${fileNodeId}_${targetFileId}`,
                        source: fileNodeId,
                        target: targetFileId,
                        label: 'imports'
                    });
                }
            } else if (!imp.startsWith('.')) {
                const libName = imp.split('/')[0];
                const libId = `lib_${libName.replace(/[^a-zA-Z0-9_]/g, '_')}`;
                if (!this.graph.nodes.some(n => n.id === libId)) {
                    this.graph.nodes.push({
                        id: libId,
                        label: libName,
                        type: 'library'
                    });
                }
                this.graph.edges.push({
                    id: `edge_imports_${fileNodeId}_${libId}`,
                    source: fileNodeId,
                    target: libId,
                    label: 'imports'
                });
            }
        });

        // 5. Re-link inheritances surgically
        const jsInheritance = /class\s+([a-zA-Z0-9_]+)\s+extends\s+([a-zA-Z0-9_.]+)/g;
        const pyInheritance = /class\s+([a-zA-Z0-9_]+)\s*\(\s*([a-zA-Z0-9_.]+)\s*\)/g;

        const ext = path.extname(relPath).toLowerCase();
        const text = cache.nodes.map(n => n.label).join(' ');
        const regex = (ext === '.py') ? pyInheritance : jsInheritance;
        regex.lastIndex = 0;

        let match;
        while ((match = regex.exec(text)) !== null) {
            const className = match[1];
            const parentName = match[2];

            if (parentName && parentName !== 'object') {
                const childId = classNameToId.get(className);
                const parentId = classNameToId.get(parentName);

                if (childId && parentId) {
                    this.graph.edges.push({
                        id: `edge_inherits_${childId}_${parentId}`,
                        source: childId,
                        target: parentId,
                        label: 'inherits'
                    });
                }
            }
        }
    }

    /**
     * Resolves local symbols, imports, calls, and inheritances.
     */
    private linkGraphStructure() {
        const nodes: GraphNode[] = [];
        const edges: GraphEdge[] = [];

        const fileNodeIds = new Map<string, string>(); // filePath -> File node ID
        const classNameToId = new Map<string, string>(); // className -> Class node ID
        const libraryNodesMap = new Map<string, string>(); // libName -> Library node ID

        // 1. First Pass: Instantiate nodes with stable IDs (Files and nested Symbols)
        for (const [relPath, cache] of this.parsedFilesCache.entries()) {
            const fileNodeId = `file_${relPath.replace(/[^a-zA-Z0-9_]/g, '_')}`;
            fileNodeIds.set(relPath, fileNodeId);

            nodes.push({
                id: fileNodeId,
                label: path.basename(relPath),
                type: 'file',
                filePath: relPath,
                startLine: 0,
                linesCount: cache.linesCount
            });

            cache.nodes.forEach(n => {
                const sysId = `sym_${relPath.replace(/[^a-zA-Z0-9_]/g, '_')}_${n.label}`;

                nodes.push({
                    ...n,
                    id: sysId,
                    filePath: relPath
                });

                if (n.type === 'class') {
                    classNameToId.set(n.label, sysId);
                }

                // File contains symbol
                edges.push({
                    id: `edge_contains_${fileNodeId}_${sysId}`,
                    source: fileNodeId,
                    target: sysId,
                    label: 'contains'
                });
            });

            // Map internal container relations (Class contains Method)
            cache.edges.forEach(e => {
                const srcSymbol = cache.nodes.find(n => n.id === e.source);
                const trgSymbol = cache.nodes.find(n => n.id === e.target);
                if (srcSymbol && trgSymbol) {
                    const srcMapped = `sym_${relPath.replace(/[^a-zA-Z0-9_]/g, '_')}_${srcSymbol.label}`;
                    const trgMapped = `sym_${relPath.replace(/[^a-zA-Z0-9_]/g, '_')}_${trgSymbol.label}`;
                    edges.push({
                        id: `edge_${e.label}_${srcMapped}_${trgMapped}`,
                        source: srcMapped,
                        target: trgMapped,
                        label: e.label
                    });
                }
            });
        }

        // 2. Second Pass: Link dependencies and Invocations (Imports, Calls)
        for (const [relPath, cache] of this.parsedFilesCache.entries()) {
            const fileNodeId = fileNodeIds.get(relPath);
            if (!fileNodeId) continue;

            // Link Imports
            cache.imports.forEach(imp => {
                const targetPath = this.resolveImportPath(imp, relPath, fileNodeIds);
                if (targetPath) {
                    const targetFileId = fileNodeIds.get(targetPath);
                    if (targetFileId && targetFileId !== fileNodeId) {
                        edges.push({
                            id: `edge_imports_${fileNodeId}_${targetFileId}`,
                            source: fileNodeId,
                            target: targetFileId,
                            label: 'imports'
                        });
                    }
                } else if (!imp.startsWith('.')) {
                    const libName = imp.split('/')[0];
                    const libId = `lib_${libName.replace(/[^a-zA-Z0-9_]/g, '_')}`;
                    if (!libraryNodesMap.has(libName)) {
                        nodes.push({
                            id: libId,
                            label: libName,
                            type: 'library'
                        });
                        libraryNodesMap.set(libName, libId);
                    }
                    edges.push({
                        id: `edge_imports_${fileNodeId}_${libId}`,
                        source: fileNodeId,
                        target: libId,
                        label: 'imports'
                    });
                }
            });
        }

        // 3. Establish Inheritance
        const jsInheritance = /class\s+([a-zA-Z0-9_]+)\s+extends\s+([a-zA-Z0-9_.]+)/g;
        const pyInheritance = /class\s+([a-zA-Z0-9_]+)\s*\(\s*([a-zA-Z0-9_.]+)\s*\)/g;

        for (const [relPath, cache] of this.parsedFilesCache.entries()) {
            const ext = path.extname(relPath).toLowerCase();
            const text = cache.nodes.map(n => n.label).join(' ');
            const regex = (ext === '.py') ? pyInheritance : jsInheritance;
            regex.lastIndex = 0;

            let match;
            while ((match = regex.exec(text)) !== null) {
                const className = match[1];
                const parentName = match[2];

                if (parentName && parentName !== 'object') {
                    const childId = classNameToId.get(className);
                    const parentId = classNameToId.get(parentName);

                    if (childId && parentId) {
                        edges.push({
                            id: `edge_inherits_${childId}_${parentId}`,
                            source: childId,
                            target: parentId,
                            label: 'inherits'
                        });
                    }
                }
            }
        }

        this.graph = { nodes, edges };
    }

    private resolveImportPath(importPath: string, sourcePath: string, fileNodeIds: Map<string, string>): string | undefined {
        const currentDir = path.posix.dirname(sourcePath);
        let candidatePath = importPath;
        if (importPath.startsWith('.')) {
            candidatePath = path.posix.join(currentDir, importPath);
        }
        const extensions = ['', '.ts', '.js', '.tsx', '.jsx', '.py'];
        for (const ext of extensions) {
            const tryPath = candidatePath + ext;
            if (fileNodeIds.has(tryPath)) return tryPath;
        }
        return undefined;
    }

    public generateCytoscapeJson(): string {
        const activeNodeIds = new Set(this.graph.nodes.map(n => n.id));
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

    public executeSparql(query: string, customNodes?: any[], customEdges?: any[]): string {
        // Simple SPARQL emulator
        const nodes = customNodes || this.graph.nodes;
        const edges = customEdges || this.graph.edges;

        const selectMatch = query.match(/SELECT\s+([\?\w\s]+)\s+WHERE\s*\{([\s\S]+?)\}/i);
        if (!selectMatch) return "SPARQL-lite Error: Invalid query format.";

        const whereClause = selectMatch[2].trim();
        let results = "### 🔍 SPARQL-lite Query Results\n\n| Match |\n| --- |\n";

        if (whereClause.includes('s:Class')) {
            const classes = nodes.filter(n => n.type === 'class');
            classes.forEach(c => {
                results += `| **${c.label}** (\`${c.id}\`) |\n`;
            });
        } else if (whereClause.includes('s:imports')) {
            edges.filter(e => e.label === 'imports').forEach(e => {
                const src = nodes.find(n => n.id === e.source)?.label || e.source;
                const trg = nodes.find(n => n.id === e.target)?.label || e.target;
                results += `| **${src}** s:imports **${trg}** |\n`;
            });
        } else {
            results += "| (No matching subgraphs found) |\n";
        }

        return results;
    }

    public generateMermaid(type: string): string {
        const header = "%%{init: {'theme': 'dark', 'themeVariables': { 'lineColor': '#569cd6' }}}%%\n";
        let out = "graph TD\n";
        
        if (type === 'class_diagram' || type === 'inheritance_diagram') {
            out = "classDiagram\n";
            this.graph.nodes.filter(n => n.type === 'class').forEach(c => {
                out += `class ${c.id}["${c.label}"]\n`;
            });
            this.graph.edges.filter(e => e.label === 'inherits').forEach(e => {
                out += `${e.target} <|-- ${e.source}\n`;
            });
        } else {
            this.graph.nodes.slice(0, 30).forEach(n => {
                out += `${n.id}["${n.label}"]\n`;
            });
            this.graph.edges.slice(0, 40).forEach(e => {
                out += `${e.source} --> ${e.target}\n`;
            });
        }
        return header + out;
    }

    public generateTextSummary(): string {
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

    public getArchitectureAnalysis(target: string, queryType: 'outline' | 'dependencies' | 'usages'): string {
        const normalizedTarget = target.replace(/\\/g, '/');
        const targetNodes = this.graph.nodes.filter(n => 
            n.label === target || 
            (n.filePath && (n.filePath === normalizedTarget || n.filePath.endsWith('/' + normalizedTarget))) ||
            n.id === target
        );

        if (targetNodes.length === 0) return `Target '${target}' not found.`;

        let result = `Architecture Analysis for '${target}':\n\n`;

        targetNodes.forEach(tNode => {
            result += `###[${tNode.type.toUpperCase()}] ${tNode.label} ${tNode.filePath ? `(in ${tNode.filePath})` : ''}\n`;
            
            if (queryType === 'outline') {
                const children = this.graph.edges.filter(e => e.source === tNode.id && e.label === 'contains').map(e => this.graph.nodes.find(n => n.id === e.target));
                result += `Contains:\n`;
                children.forEach(c => {
                    if (c) {
                        result += `- [${c.type}] ${c.signature || c.label}\n`;
                    }
                });
            } else if (queryType === 'dependencies') {
                const outgoing = this.graph.edges.filter(e => e.source === tNode.id && e.label !== 'contains');
                result += `Dependencies:\n`;
                outgoing.forEach(e => {
                    const dest = this.graph.nodes.find(n => n.id === e.target);
                    if (dest) {
                        result += `-[${e.label}] -> [${dest.type}] ${dest.label}\n`;
                    }
                });
            } else if (queryType === 'usages') {
                const incoming = this.graph.edges.filter(e => e.target === tNode.id && e.label !== 'contains');
                result += `Usages:\n`;
                incoming.forEach(e => {
                    const src = this.graph.nodes.find(n => n.id === e.source);
                    if (src) {
                        result += `- [${e.label}] <- [${src.type}] ${src.label}\n`;
                    }
                });
            }
        });

        return result;
    }
}
