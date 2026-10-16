import * as vscode from 'vscode';
import * as path from 'path';
import { Logger } from './logger';

export interface GraphTriple {
    s: string;
    p: string;
    o: string;
}

export interface InsightEntry {
    id: string;
    topic: string;
    content: string;
    hashtags: string[];
    files: string[];
    timestamp: number;
}

export class KnowledgeManager {
    public static readonly TTL_FILENAME = 'knowledge.ttl';

    private triples: GraphTriple[] = [];
    private initialized: boolean = false;
    public lastConstructedGraph: { nodes: any[]; edges: any[] } | null = null;

    constructor(private context: vscode.ExtensionContext) {}

    public getKnowledgeDir(workspaceFolder?: vscode.WorkspaceFolder): vscode.Uri | null {
        const folder = workspaceFolder || vscode.workspace.workspaceFolders?.[0];
        if (!folder) return null;
        return vscode.Uri.joinPath(folder.uri, '.lollms');
    }

    public getKnowledgeTtlUri(workspaceFolder?: vscode.WorkspaceFolder): vscode.Uri | null {
        const dir = this.getKnowledgeDir(workspaceFolder);
        if (!dir) return null;
        return vscode.Uri.joinPath(dir, KnowledgeManager.TTL_FILENAME);
    }

    public async initializeGraph(workspaceFolder?: vscode.WorkspaceFolder): Promise<void> {
        if (this.initialized) return;
        const ttlUri = this.getKnowledgeTtlUri(workspaceFolder);
        if (!ttlUri) return;

        try {
            const bytes = await vscode.workspace.fs.readFile(ttlUri);
            const content = Buffer.from(bytes).toString('utf8');
            this.parseTurtle(content);
            Logger.info(`[KnowledgeManager] Loaded ${this.triples.length} triples from ${KnowledgeManager.TTL_FILENAME}`);
        } catch {
            this.triples = this.getBaselineOntologyTriples();
            await this.saveGraph(workspaceFolder);
            Logger.info(`[KnowledgeManager] Initialized new knowledge graph with baseline TBox ontology.`);
        }
        this.initialized = true;
    }

    public getBaselineOntologyTriples(): GraphTriple[] {
        return [
            { s: 's:SoftwareArtifact', p: 'rdf:type', o: 'owl:Class' },
            { s: 's:SoftwareArtifact', p: 'rdfs:label', o: '"Software Artifact"@en' },

            { s: 's:SourceFile', p: 'rdf:type', o: 'owl:Class' },
            { s: 's:SourceFile', p: 'rdfs:subClassOf', o: 's:SoftwareArtifact' },
            { s: 's:SourceFile', p: 'rdfs:label', o: '"Source File"@en' },

            { s: 's:BackendModule', p: 'rdf:type', o: 'owl:Class' },
            { s: 's:BackendModule', p: 'rdfs:subClassOf', o: 's:SourceFile' },
            { s: 's:BackendModule', p: 'rdfs:label', o: '"Backend Service / Module"@en' },

            { s: 's:VueComponent', p: 'rdf:type', o: 'owl:Class' },
            { s: 's:VueComponent', p: 'rdfs:subClassOf', o: 's:SourceFile' },
            { s: 's:VueComponent', p: 'rdfs:label', o: '"Vue.js Single File Component"@en' },

            { s: 's:AutomationScript', p: 'rdf:type', o: 'owl:Class' },
            { s: 's:AutomationScript', p: 'rdfs:subClassOf', o: 's:SourceFile' },
            { s: 's:AutomationScript', p: 'rdfs:label', o: '"Installation & DevOps Script"@en' },

            { s: 's:CodeEntity', p: 'rdf:type', o: 'owl:Class' },
            { s: 's:CodeEntity', p: 'rdfs:label', o: '"Code Entity"@en' },

            { s: 's:ClassDefinition', p: 'rdf:type', o: 'owl:Class' },
            { s: 's:ClassDefinition', p: 'rdfs:subClassOf', o: 's:CodeEntity' },
            { s: 's:ClassDefinition', p: 'rdfs:label', o: '"Class Definition"@en' },

            { s: 's:InterfaceDefinition', p: 'rdf:type', o: 'owl:Class' },
            { s: 's:InterfaceDefinition', p: 'rdfs:subClassOf', o: 's:CodeEntity' },
            { s: 's:InterfaceDefinition', p: 'rdfs:label', o: '"Interface Definition"@en' },

            { s: 's:FunctionDefinition', p: 'rdf:type', o: 'owl:Class' },
            { s: 's:FunctionDefinition', p: 'rdfs:subClassOf', o: 's:CodeEntity' },
            { s: 's:FunctionDefinition', p: 'rdfs:label', o: '"Function Definition"@en' },

            { s: 's:MethodDefinition', p: 'rdf:type', o: 'owl:Class' },
            { s: 's:MethodDefinition', p: 'rdfs:subClassOf', o: 's:FunctionDefinition' },
            { s: 's:MethodDefinition', p: 'rdfs:label', o: '"Method Definition"@en' },

            { s: 's:FunctionDescription', p: 'rdf:type', o: 'owl:Class' },
            { s: 's:FunctionDescription', p: 'rdfs:subClassOf', o: 's:CodeEntity' },
            { s: 's:FunctionDescription', p: 'rdfs:label', o: '"Function Description / Docstring / Doxygen Documentation"@en' },

            { s: 's:APIRoute', p: 'rdf:type', o: 'owl:Class' },
            { s: 's:APIRoute', p: 'rdfs:subClassOf', o: 's:CodeEntity' },
            { s: 's:APIRoute', p: 'rdfs:label', o: '"REST / API Route Endpoint"@en' },

            { s: 's:StateStore', p: 'rdf:type', o: 'owl:Class' },
            { s: 's:StateStore', p: 'rdfs:subClassOf', o: 's:CodeEntity' },
            { s: 's:StateStore', p: 'rdfs:label', o: '"State Store / Composable"@en' },

            { s: 's:ExternalLibrary', p: 'rdf:type', o: 'owl:Class' },
            { s: 's:ExternalLibrary', p: 'rdfs:label', o: '"External Library / Dependency"@en' },

            { s: 's:ArchitecturalInsight', p: 'rdf:type', o: 'owl:Class' },
            { s: 's:ArchitecturalInsight', p: 'rdfs:label', o: '"Architectural Insight"@en' },

            { s: 's:TopicTag', p: 'rdf:type', o: 'owl:Class' },
            { s: 's:TopicTag', p: 'rdfs:label', o: '"Topic Tag"@en' },

            { s: 's:containsEntity', p: 'rdf:type', o: 'owl:ObjectProperty' },
            { s: 's:containsEntity', p: 'rdfs:domain', o: 's:SoftwareArtifact' },
            { s: 's:containsEntity', p: 'rdfs:range', o: 's:CodeEntity' },
            { s: 's:containsEntity', p: 'rdfs:label', o: '"contains code entity"@en' },

            { s: 's:definedInFile', p: 'rdf:type', o: 'owl:ObjectProperty' },
            { s: 's:definedInFile', p: 'rdfs:domain', o: 's:CodeEntity' },
            { s: 's:definedInFile', p: 'rdfs:range', o: 's:SourceFile' },
            { s: 's:definedInFile', p: 'owl:inverseOf', o: 's:containsEntity' },
            { s: 's:definedInFile', p: 'rdfs:label', o: '"defined in source file"@en' },

            { s: 's:memberOfClass', p: 'rdf:type', o: 'owl:ObjectProperty' },
            { s: 's:memberOfClass', p: 'rdfs:domain', o: 's:MethodDefinition' },
            { s: 's:memberOfClass', p: 'rdfs:range', o: 's:ClassDefinition' },
            { s: 's:memberOfClass', p: 'rdfs:label', o: '"member method of class"@en' },

            { s: 's:importsModule', p: 'rdf:type', o: 'owl:ObjectProperty' },
            { s: 's:importsModule', p: 'rdfs:domain', o: 's:SourceFile' },
            { s: 's:importsModule', p: 'rdfs:range', o: 's:SoftwareArtifact' },
            { s: 's:importsModule', p: 'rdfs:label', o: '"imports module"@en' },

            { s: 's:invokesFunction', p: 'rdf:type', o: 'owl:ObjectProperty' },
            { s: 's:invokesFunction', p: 'rdfs:domain', o: 's:CodeEntity' },
            { s: 's:invokesFunction', p: 'rdfs:range', o: 's:FunctionDefinition' },
            { s: 's:invokesFunction', p: 'rdfs:label', o: '"invokes function or method"@en' },

            { s: 's:inheritsFrom', p: 'rdf:type', o: 'owl:ObjectProperty' },
            { s: 's:inheritsFrom', p: 'rdfs:domain', o: 's:ClassDefinition' },
            { s: 's:inheritsFrom', p: 'rdfs:range', o: 's:ClassDefinition' },
            { s: 's:inheritsFrom', p: 'rdfs:label', o: '"inherits from class"@en' },

            { s: 's:exposesEndpoint', p: 'rdf:type', o: 'owl:ObjectProperty' },
            { s: 's:exposesEndpoint', p: 'rdfs:domain', o: 's:SourceFile' },
            { s: 's:exposesEndpoint', p: 'rdfs:range', o: 's:APIRoute' },
            { s: 's:exposesEndpoint', p: 'rdfs:label', o: '"exposes API endpoint"@en' },

            { s: 's:disjointWith', p: 'rdf:type', o: 'owl:SymmetricProperty' },
            { s: 's:disjointWith', p: 'rdfs:domain', o: 's:CodeEntity' },
            { s: 's:disjointWith', p: 'rdfs:range', o: 's:CodeEntity' },
            { s: 's:disjointWith', p: 'rdfs:label', o: '"disjoint with same-name entity in different file"@en' },

            { s: 's:hasFunctionDescription', p: 'rdf:type', o: 'owl:ObjectProperty' },
            { s: 's:hasFunctionDescription', p: 'rdfs:domain', o: 's:FunctionDefinition' },
            { s: 's:hasFunctionDescription', p: 'rdfs:range', o: 's:FunctionDescription' },
            { s: 's:hasFunctionDescription', p: 'rdfs:label', o: '"has function description"@en' },

            { s: 's:describesFunction', p: 'rdf:type', o: 'owl:ObjectProperty' },
            { s: 's:describesFunction', p: 'rdfs:domain', o: 's:FunctionDescription' },
            { s: 's:describesFunction', p: 'rdfs:range', o: 's:FunctionDefinition' },
            { s: 's:describesFunction', p: 'owl:inverseOf', o: 's:hasFunctionDescription' },
            { s: 's:describesFunction', p: 'rdfs:label', o: '"describes function or method"@en' },

            { s: 's:functionDescription', p: 'rdf:type', o: 'owl:DatatypeProperty' },
            { s: 's:functionDescription', p: 'rdfs:domain', o: 's:FunctionDefinition' },
            { s: 's:functionDescription', p: 'rdfs:range', o: 'xsd:string' },
            { s: 's:functionDescription', p: 'rdfs:label', o: '"function description text"@en' },

            { s: 's:docstringFormat', p: 'rdf:type', o: 'owl:DatatypeProperty' },
            { s: 's:docstringFormat', p: 'rdfs:domain', o: 's:FunctionDescription' },
            { s: 's:docstringFormat', p: 'rdfs:range', o: 'xsd:string' },
            { s: 's:docstringFormat', p: 'rdfs:label', o: '"documentation format (Doxygen, JSDoc, PythonDocstring, RustDoc)"@en' },

            { s: 's:explainsArtifact', p: 'rdf:type', o: 'owl:ObjectProperty' },
            { s: 's:explainsArtifact', p: 'rdfs:domain', o: 's:ArchitecturalInsight' },
            { s: 's:explainsArtifact', p: 'rdfs:range', o: 's:SoftwareArtifact' },
            { s: 's:explainsArtifact', p: 'rdfs:label', o: '"explains artifact or entity"@en' },

            { s: 's:hasTopic', p: 'rdf:type', o: 'owl:ObjectProperty' },
            { s: 's:hasTopic', p: 'rdfs:domain', o: 's:ArchitecturalInsight' },
            { s: 's:hasTopic', p: 'rdfs:range', o: 's:TopicTag' },
            { s: 's:hasTopic', p: 'rdfs:label', o: '"tagged with topic"@en' },

            { s: 's:programmingLanguage', p: 'rdf:type', o: 'owl:DatatypeProperty' },
            { s: 's:layer', p: 'rdf:type', o: 'owl:DatatypeProperty' },
            { s: 's:httpMethod', p: 'rdf:type', o: 'owl:DatatypeProperty' },
            { s: 's:routePath', p: 'rdf:type', o: 'owl:DatatypeProperty' },
            { s: 's:name', p: 'rdf:type', o: 'owl:DatatypeProperty' },
            { s: 's:filePath', p: 'rdf:type', o: 'owl:DatatypeProperty' },
            { s: 's:startLine', p: 'rdf:type', o: 'owl:DatatypeProperty' },
            { s: 's:signature', p: 'rdf:type', o: 'owl:DatatypeProperty' },
            { s: 's:docstring', p: 'rdf:type', o: 'owl:DatatypeProperty' },
            { s: 's:linesCount', p: 'rdf:type', o: 'owl:DatatypeProperty' },
            { s: 's:insightText', p: 'rdf:type', o: 'owl:DatatypeProperty' },
            { s: 's:timestamp', p: 'rdf:type', o: 'owl:DatatypeProperty' }
        ];
    }

    public isTBoxSubject(subject: string): boolean {
        const clean = subject.replace(/^s:/, '');
        const tboxNames = new Set([
            'SoftwareArtifact', 'SourceFile', 'CodeEntity', 'ClassDefinition',
            'InterfaceDefinition', 'FunctionDefinition', 'MethodDefinition',
            'FunctionDescription', 'ExternalLibrary', 'ArchitecturalInsight', 'TopicTag',
            'containsEntity', 'definedInFile', 'memberOfClass', 'importsModule',
            'invokesFunction', 'inheritsFrom', 'disjointWith', 'hasFunctionDescription',
            'describesFunction', 'functionDescription', 'docstringFormat',
            'explainsArtifact', 'hasTopic', 'name', 'filePath', 'startLine', 'signature',
            'docstring', 'linesCount', 'insightText', 'timestamp'
        ]);
        if (tboxNames.has(clean) || tboxNames.has(subject)) return true;
        if (subject.startsWith('owl:') || subject.startsWith('rdfs:') || subject.startsWith('rdf:')) return true;
        return false;
    }

    public parseTurtle(turtleText: string): void {
        const lines = turtleText.split(/\r?\n/);
        const parsed: GraphTriple[] = [];
        let currentSubject = "";

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('@prefix') || trimmed.startsWith('#')) continue;

            const isIndented = /^\s+/.test(line);
            const isDotTerminated = trimmed.endsWith('.');
            const clean = trimmed.replace(/\s*[;.]$/, '').trim();

            if (isIndented && currentSubject) {
                // Indented line is strictly a predicate-object pair for currentSubject
                const firstSpace = clean.indexOf(' ');
                if (firstSpace !== -1) {
                    const p = clean.substring(0, firstSpace).trim();
                    const o = clean.substring(firstSpace + 1).trim();
                    if (p && o) {
                        parsed.push({ s: currentSubject, p, o });
                    }
                }
            } else {
                // Non-indented line declares a new subject
                const firstSpace = clean.indexOf(' ');
                if (firstSpace === -1) {
                    currentSubject = clean;
                } else {
                    const s = clean.substring(0, firstSpace).trim();
                    const rest = clean.substring(firstSpace + 1).trim();
                    const secondSpace = rest.indexOf(' ');
                    if (secondSpace !== -1) {
                        const p = rest.substring(0, secondSpace).trim();
                        const o = rest.substring(secondSpace + 1).trim();
                        parsed.push({ s, p, o });
                        currentSubject = isDotTerminated ? "" : s;
                    } else {
                        currentSubject = s;
                    }
                }
            }

            if (isDotTerminated) {
                currentSubject = "";
            }
        }
        this.triples = parsed;
    }

    public serializeTurtle(): string {
        let ttl = `@prefix s: <http://lollms.io/ontology#> .\n`;
        ttl += `@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .\n`;
        ttl += `@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n`;
        ttl += `@prefix owl: <http://www.w3.org/2002/07/owl#> .\n`;
        ttl += `@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\n\n`;

        ttl += `### ===================================================================\n`;
        ttl += `### 🏛️ TBOX: FORMAL SOFTWARE ENGINEERING ONTOLOGY SCHEMA\n`;
        ttl += `### ===================================================================\n\n`;

        const tboxBySubject = new Map<string, { p: string, o: string }[]>();
        const aboxBySubject = new Map<string, { p: string, o: string }[]>();

        for (const t of this.triples) {
            if (this.isTBoxSubject(t.s)) {
                if (!tboxBySubject.has(t.s)) tboxBySubject.set(t.s, []);
                tboxBySubject.get(t.s)!.push({ p: t.p, o: t.o });
            } else {
                if (!aboxBySubject.has(t.s)) aboxBySubject.set(t.s, []);
                aboxBySubject.get(t.s)!.push({ p: t.p, o: t.o });
            }
        }

        for (const [subj, poList] of tboxBySubject.entries()) {
            ttl += `${subj}\n`;
            poList.forEach((po, idx) => {
                const isLast = idx === poList.length - 1;
                ttl += `    ${po.p} ${po.o} ${isLast ? ' .\n' : ' ;\n'}`;
            });
            ttl += '\n';
        }

        ttl += `### ===================================================================\n`;
        ttl += `### 📦 ABOX: CODEBASE ASSERTIONS & ARCHITECTURAL INSTANCES\n`;
        ttl += `### ===================================================================\n\n`;

        for (const [subj, poList] of aboxBySubject.entries()) {
            ttl += `${subj}\n`;
            poList.forEach((po, idx) => {
                const isLast = idx === poList.length - 1;
                ttl += `    ${po.p} ${po.o} ${isLast ? ' .\n' : ' ;\n'}`;
            });
            ttl += '\n';
        }

        return ttl;
    }

    public async saveGraph(workspaceFolder?: vscode.WorkspaceFolder): Promise<void> {
        const dir = this.getKnowledgeDir(workspaceFolder);
        const ttlUri = this.getKnowledgeTtlUri(workspaceFolder);
        if (!dir || !ttlUri) return;

        try {
            await vscode.workspace.fs.createDirectory(dir);
            const content = this.serializeTurtle();
            await vscode.workspace.fs.writeFile(ttlUri, Buffer.from(content, 'utf8'));
        } catch (err: any) {
            Logger.error(`[KnowledgeManager] Failed to save ${KnowledgeManager.TTL_FILENAME}: ${err.message}`);
        }
    }

    public addTriple(triple: GraphTriple): void {
        const exists = this.triples.some(t => t.s === triple.s && t.p === triple.p && t.o === triple.o);
        if (!exists) {
            this.triples.push(triple);
        }
    }

    public removeTriplesForSubject(subject: string): void {
        this.triples = this.triples.filter(t => t.s !== subject);
    }

    public removeTriplesForFile(filePath: string): void {
        const cleanPath = filePath.replace(/\\/g, '/').trim();
        const fileNode = `s:file_${cleanPath.replace(/[^a-zA-Z0-9_]/g, '_')}`;
        this.triples = this.triples.filter(t => t.s !== fileNode && t.o !== fileNode);
    }

    public async recordInsight(
        topic: string,
        content: string,
        files: string[] = [],
        hashtags: string[] = [],
        workspaceFolder?: vscode.WorkspaceFolder
    ): Promise<string> {
        await this.initializeGraph(workspaceFolder);

        const cleanTopic = topic.trim() || 'General';
        const cleanContent = content.trim();
        const insightId = `s:insight_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        const timestamp = new Date().toISOString();

        this.addTriple({ s: insightId, p: 'rdf:type', o: 's:ArchitecturalInsight' });
        this.addTriple({ s: insightId, p: 's:name', o: `"${cleanTopic.replace(/"/g, "'")}"` });
        this.addTriple({ s: insightId, p: 's:insightText', o: JSON.stringify(cleanContent) });
        this.addTriple({ s: insightId, p: 's:timestamp', o: `"${timestamp}"^^xsd:dateTime` });

        for (const tag of hashtags) {
            const cleanTag = tag.replace(/^#/, '').trim().toLowerCase();
            if (!cleanTag) continue;
            const topicNode = `s:topic_${cleanTag.replace(/[^a-zA-Z0-9_]/g, '_')}`;
            this.addTriple({ s: topicNode, p: 'rdf:type', o: 's:TopicTag' });
            this.addTriple({ s: topicNode, p: 's:name', o: `"${cleanTag}"` });
            this.addTriple({ s: insightId, p: 's:hasTopic', o: topicNode });
        }

        for (const file of files) {
            const cleanFile = file.replace(/\\/g, '/').trim();
            if (!cleanFile) continue;
            const fileNode = `s:file_${cleanFile.replace(/[^a-zA-Z0-9_]/g, '_')}`;

            this.addTriple({ s: fileNode, p: 'rdf:type', o: 's:SourceFile' });
            this.addTriple({ s: fileNode, p: 's:filePath', o: `"${cleanFile}"` });
            this.addTriple({ s: fileNode, p: 's:name', o: `"${path.basename(cleanFile)}"` });

            this.addTriple({ s: insightId, p: 's:explainsArtifact', o: fileNode });
            this.addTriple({ s: fileNode, p: 's:containsEntity', o: insightId });
        }

        await this.saveGraph(workspaceFolder);
        Logger.info(`[KnowledgeManager] Ingested architectural insight '${cleanTopic}' into ABox.`);
        return insightId;
    }

    public async syncCodeGraph(
        nodes: Array<{ id: string; label: string; type: string; filePath?: string; signature?: string; docstring?: string; startLine?: number }>,
        edges: Array<{ source: string; target: string; label: string }>,
        workspaceFolder?: vscode.WorkspaceFolder
    ): Promise<void> {
        await this.initializeGraph(workspaceFolder);

        const { isPathBlockedFromGraph } = require('./codeGraphManager');

        const validNodes = nodes.filter(n => !n.filePath || !isPathBlockedFromGraph(n.filePath));
        const nodeIdMap = new Map<string, string>();

        validNodes.forEach(n => {
            const formalId = n.id.startsWith('s:') ? n.id : `s:${n.id}`;
            nodeIdMap.set(n.id, formalId);
            nodeIdMap.set(formalId, formalId);
        });

        const validEdges = edges.filter(e => {
            const src = nodeIdMap.get(e.source);
            const trg = nodeIdMap.get(e.target);
            return src !== undefined && trg !== undefined;
        });

        const baselineTbox = this.getBaselineOntologyTriples();
        const preservedInsights = this.triples.filter(t => 
            t.s.startsWith('s:insight_') || 
            t.s.startsWith('s:topic_') ||
            t.p === 's:hasTopic' ||
            t.p === 's:explainsArtifact'
        );

        this.triples = [...baselineTbox, ...preservedInsights];

        const typeMapping: Record<string, string> = {
            'file': 's:SourceFile',
            'component': 's:VueComponent',
            'script': 's:AutomationScript',
            'endpoint': 's:APIRoute',
            'store': 's:StateStore',
            'class': 's:ClassDefinition',
            'interface': 's:InterfaceDefinition',
            'function': 's:FunctionDefinition',
            'method': 's:MethodDefinition',
            'library': 's:ExternalLibrary'
        };

        const edgeMapping: Record<string, string> = {
            'contains': 's:containsEntity',
            'imports': 's:importsModule',
            'calls': 's:invokesFunction',
            'inherits': 's:inheritsFrom'
        };

        const fileNodeMap = new Map<string, string>();
        validNodes.forEach(n => {
            if ((n.type === 'file' || n.type === 'component' || n.type === 'script') && n.filePath) {
                const fId = nodeIdMap.get(n.id)!;
                fileNodeMap.set(n.filePath.replace(/\\/g, '/').toLowerCase(), fId);
            }
        });

        for (const n of validNodes) {
            const nodeId = nodeIdMap.get(n.id)!;
            const normType = n.type.toLowerCase();
            let rdfClass = typeMapping[normType] || 's:CodeEntity';

            const normPath = n.filePath ? n.filePath.replace(/\\/g, '/').toLowerCase() : '';
            const ext = normPath ? normPath.split('.').pop() || '' : '';

            // Language & Layer inference
            let lang = 'TypeScript';
            let layer = 'Shared';

            if (ext === 'py') {
                lang = 'Python';
                layer = 'Backend';
                if (normType === 'file') rdfClass = 's:BackendModule';
            } else if (ext === 'vue') {
                lang = 'Vue';
                layer = 'Frontend';
                if (normType === 'file') rdfClass = 's:VueComponent';
            } else if (['sh', 'bash', 'bat', 'cmd', 'ps1'].includes(ext)) {
                lang = ext === 'ps1' ? 'PowerShell' : (['bat', 'cmd'].includes(ext) ? 'Batch' : 'Bash');
                layer = 'DevOps';
                if (normType === 'file') rdfClass = 's:AutomationScript';
            } else if (['ts', 'js', 'tsx', 'jsx'].includes(ext)) {
                lang = ext.startsWith('t') ? 'TypeScript' : 'JavaScript';
                if (normPath.includes('backend') || normPath.includes('server') || normPath.includes('api')) {
                    layer = 'Backend';
                } else if (normPath.includes('frontend') || normPath.includes('client') || normPath.includes('ui') || normPath.includes('components') || normPath.includes('webui') || normPath.includes('web')) {
                    layer = 'Frontend';
                }
            }

            this.addTriple({ s: nodeId, p: 'rdf:type', o: rdfClass });
            if (rdfClass !== 's:SourceFile' && (rdfClass === 's:VueComponent' || rdfClass === 's:BackendModule' || rdfClass === 's:AutomationScript')) {
                this.addTriple({ s: nodeId, p: 'rdf:type', o: 's:SourceFile' });
            }
            this.addTriple({ s: nodeId, p: 's:name', o: `"${n.label.replace(/"/g, "'")}"` });
            this.addTriple({ s: nodeId, p: 's:programmingLanguage', o: `"${lang}"` });
            this.addTriple({ s: nodeId, p: 's:layer', o: `"${layer}"` });

            if (n.filePath) {
                this.addTriple({ s: nodeId, p: 's:filePath', o: `"${n.filePath.replace(/\\/g, '/')}"` });

                const ownerFileId = fileNodeMap.get(normPath);
                if (ownerFileId && ownerFileId !== nodeId) {
                    this.addTriple({ s: nodeId, p: 's:definedInFile', o: ownerFileId });
                    this.addTriple({ s: ownerFileId, p: 's:containsEntity', o: nodeId });
                }
            }
            if (n.startLine !== undefined) {
                this.addTriple({ s: nodeId, p: 's:startLine', o: String(n.startLine) });
            }
            if (n.signature) {
                this.addTriple({ s: nodeId, p: 's:signature', o: JSON.stringify(n.signature) });
            }
            if (n.docstring) {
                const cleanDoc = n.docstring.replace(/[\r\n]+/g, ' ').trim();
                const jsonDoc = JSON.stringify(cleanDoc);
                this.addTriple({ s: nodeId, p: 's:docstring', o: jsonDoc });
                this.addTriple({ s: nodeId, p: 's:functionDescription', o: jsonDoc });

                // Infer documentation format (Doxygen, JSDoc, Python docstring, Rustdoc)
                let docFormat = "GenericDocstring";
                if (cleanDoc.includes('@brief') || cleanDoc.includes('\\brief') || cleanDoc.includes('@param') || cleanDoc.includes('\\param') || cleanDoc.includes('@return') || cleanDoc.includes('\\return')) {
                    docFormat = "Doxygen";
                } else if (ext === 'py') {
                    docFormat = "PythonDocstring";
                } else if (['ts', 'js', 'tsx', 'jsx'].includes(ext)) {
                    docFormat = "JSDoc";
                } else if (ext === 'rs') {
                    docFormat = "RustDoc";
                }

                // First-class s:FunctionDescription entity node
                const descNodeId = `${nodeId}_desc`;
                this.addTriple({ s: descNodeId, p: 'rdf:type', o: 's:FunctionDescription' });
                this.addTriple({ s: descNodeId, p: 's:name', o: `"${n.label.replace(/"/g, "'")} Description"` });
                this.addTriple({ s: descNodeId, p: 's:functionDescription', o: jsonDoc });
                this.addTriple({ s: descNodeId, p: 's:docstring', o: jsonDoc });
                this.addTriple({ s: descNodeId, p: 's:docstringFormat', o: `"${docFormat}"` });
                this.addTriple({ s: descNodeId, p: 's:describesFunction', o: nodeId });
                this.addTriple({ s: nodeId, p: 's:hasFunctionDescription', o: descNodeId });
            }
            if ((n as any).httpMethod) {
                this.addTriple({ s: nodeId, p: 's:httpMethod', o: `"${(n as any).httpMethod}"` });
            }
            if ((n as any).routePath) {
                this.addTriple({ s: nodeId, p: 's:routePath', o: `"${(n as any).routePath}"` });
            }
        }

        for (const e of validEdges) {
            const src = nodeIdMap.get(e.source)!;
            const trg = nodeIdMap.get(e.target)!;
            const prop = edgeMapping[e.label.toLowerCase()] || `s:${e.label}`;
            this.addTriple({ s: src, p: prop, o: trg });

            if (prop === 's:containsEntity') {
                const srcNode = validNodes.find(n => nodeIdMap.get(n.id) === src);
                const trgNode = validNodes.find(n => nodeIdMap.get(n.id) === trg);
                if (srcNode?.type === 'class' && trgNode?.type === 'method') {
                    this.addTriple({ s: trg, p: 's:memberOfClass', o: src });
                }
            }
        }

        this.detectAndTagDisjointEntities(validNodes, nodeIdMap);

        await this.saveGraph(workspaceFolder);
        Logger.info(`[KnowledgeManager] Full ABox synchronized: ${validNodes.length} nodes and ${validEdges.length} semantic relations in ${KnowledgeManager.TTL_FILENAME}`);
    }

    private detectAndTagDisjointEntities(
        nodes: Array<{ id: string; label: string; type: string; filePath?: string }>,
        nodeIdMap: Map<string, string>
    ): void {
        const nameGroups = new Map<string, Array<{ id: string; filePath?: string; type: string }>>();

        for (const n of nodes) {
            if (n.type === 'function' || n.type === 'method' || n.type === 'class') {
                const key = `${n.type}:${n.label.toLowerCase()}`;
                if (!nameGroups.has(key)) nameGroups.set(key, []);
                nameGroups.get(key)!.push({
                    id: nodeIdMap.get(n.id) || n.id,
                    filePath: n.filePath?.replace(/\\/g, '/').toLowerCase(),
                    type: n.type
                });
            }
        }

        let disjointCount = 0;
        for (const [_key, group] of nameGroups.entries()) {
            if (group.length > 1) {
                for (let i = 0; i < group.length; i++) {
                    for (let j = i + 1; j < group.length; j++) {
                        const itemA = group[i];
                        const itemB = group[j];
                        if (itemA.filePath && itemB.filePath && itemA.filePath !== itemB.filePath) {
                            this.addTriple({ s: itemA.id, p: 's:disjointWith', o: itemB.id });
                            this.addTriple({ s: itemB.id, p: 's:disjointWith', o: itemA.id });
                            disjointCount++;
                        }
                    }
                }
            }
        }

        if (disjointCount > 0) {
            Logger.info(`[KnowledgeManager] Tagged ${disjointCount} cross-file redundant same-name entities as disjoint.`);
        }
    }

    public static stripSparqlComments(q: string): string {
        return q.split(/\r?\n/).map(line => {
            let inQuotes = false;
            let inIri = false;
            for (let i = 0; i < line.length; i++) {
                const ch = line[i];
                if (ch === '"' && (i === 0 || line[i - 1] !== '\\')) inQuotes = !inQuotes;
                if (ch === '<' && !inQuotes) inIri = true;
                if (ch === '>' && !inQuotes) inIri = false;
                if (ch === '#' && !inQuotes && !inIri) {
                    return line.substring(0, i);
                }
            }
            return line;
        }).join('\n').trim();
    }

    public parseSparqlWhereClause(whereClause: string): { triplePatterns: GraphTriple[]; filters: string[] } {
        const filters: string[] = [];
        const cleanWhere = whereClause.replace(/FILTER\s*\(([\s\S]+?)\)/gi, (_m, fBody) => {
            filters.push(fBody.trim());
            return "";
        });

        const tokenRegex = /(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|<[^>]+>|[;,.]|[^\s;,."<>]+)/g;
        const tokens = cleanWhere.match(tokenRegex) || [];

        const triplePatterns: GraphTriple[] = [];
        let curSubject: string | null = null;
        let curPredicate: string | null = null;
        let expect: 'subject' | 'predicate' | 'object' = 'subject';

        const normalizeTerm = (raw: string): string => {
            let t = raw.trim();
            if (!t || t.startsWith('?') || t.startsWith('"') || t.startsWith("'")) {
                return t;
            }
            if (t.startsWith('<') && t.endsWith('>')) {
                const iri = t.substring(1, t.length - 1);
                if (iri.includes('#')) {
                    const suffix = iri.split('#')[1];
                    return `s:${suffix}`;
                }
                return t;
            }
            if (t.toLowerCase() === 'a') {
                return 'rdf:type';
            }
            if (!t.includes(':') && !t.startsWith('?')) {
                return `s:${t}`;
            }
            return t;
        };

        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i].trim();
            if (!token) continue;

            if (token === '.') {
                curSubject = null;
                curPredicate = null;
                expect = 'subject';
                continue;
            }

            if (token === ';') {
                curPredicate = null;
                expect = 'predicate';
                continue;
            }

            if (token === ',') {
                expect = 'object';
                continue;
            }

            if (expect === 'subject') {
                curSubject = token;
                expect = 'predicate';
            } else if (expect === 'predicate') {
                if (token.startsWith('?') && curPredicate !== null) {
                    curSubject = token;
                    curPredicate = null;
                    expect = 'predicate';
                } else {
                    curPredicate = token;
                    expect = 'object';
                }
            } else if (expect === 'object') {
                if (curSubject && curPredicate) {
                    triplePatterns.push({
                        s: normalizeTerm(curSubject),
                        p: normalizeTerm(curPredicate),
                        o: normalizeTerm(token)
                    });
                }
                expect = 'predicate';
            }
        }

        return { triplePatterns, filters };
    }

    public async executeSparql(query: string, workspaceFolder?: vscode.WorkspaceFolder): Promise<string> {
        await this.initializeGraph(workspaceFolder);

        const cleanQuery = KnowledgeManager.stripSparqlComments(query).trim();

        const limitMatch = cleanQuery.match(/\bLIMIT\s+(\d+)\b/i);
        const limit = limitMatch ? parseInt(limitMatch[1], 10) : 50;

        const selectMatch = cleanQuery.match(/SELECT\s+(DISTINCT\s+)?([\?\*\w\s]+)\s+WHERE\s*\{([\s\S]+?)\}/i);
        const constructMatch = cleanQuery.match(/CONSTRUCT\s*\{([\s\S]+?)\}\s*WHERE\s*\{([\s\S]+?)\}/i);
        const askMatch = cleanQuery.match(/ASK\s+WHERE\s*\{([\s\S]+?)\}/i);

        if (!selectMatch && !askMatch && !constructMatch) {
            return `### ❌ SPARQL Query Error\nSupported syntax:\n- \`SELECT ?var WHERE { ?s ?p ?o . }\`\n- \`CONSTRUCT { ?s ?p ?o . } WHERE { ... }\`\n- \`ASK WHERE { ... }\`\n\nQuery:\n\`\`\`sparql\n${query}\n\`\`\``;
        }

        const whereClause = selectMatch ? selectMatch[3].trim() : (constructMatch ? constructMatch[2].trim() : askMatch![1].trim());
        const { triplePatterns, filters } = this.parseSparqlWhereClause(whereClause);

        const normPred = (raw: string): string => {
            const c = raw.replace(/^s:/i, '').replace(/^rdf:/i, '').toLowerCase().trim();
            if (c === 'a' || c === 'type') return 'type';
            if (c === 'contains' || c === 'containsentity') return 'contains';
            if (c === 'definedin' || c === 'definedinfile') return 'definedin';
            if (c === 'memberof' || c === 'memberofclass') return 'memberof';
            if (c === 'imports' || c === 'importsmodule') return 'imports';
            if (c === 'calls' || c === 'invokes' || c === 'invokesfunction') return 'calls';
            if (c === 'inherits' || c === 'inheritsfrom') return 'inherits';
            if (c === 'disjoint' || c === 'disjointwith') return 'disjoint';
            if (c === 'hasfunctiondescription' || c === 'functiondescription' || c === 'docstring') return 'functiondescription';
            if (c === 'describesfunction') return 'describesfunction';
            if (c === 'name' || c === 'label' || c === 'rdfs:label') return 'name';
            if (c === 'path' || c === 'filepath') return 'filepath';
            return c;
        };

        const normType = (raw: string): string => {
            const c = raw.replace(/^s:/i, '').replace(/^owl:/i, '').replace(/^rdfs?:/i, '').toLowerCase().trim();
            if (c === 'function' || c === 'functiondefinition') return 'function';
            if (c === 'method' || c === 'methoddefinition') return 'method';
            if (c === 'functiondescription' || c === 'description') return 'functiondescription';
            if (c === 'class' || c === 'classdefinition') return 'class';
            if (c === 'interface' || c === 'interfacedefinition') return 'interface';
            if (c === 'file' || c === 'sourcefile' || c === 'backendmodule') return 'file';
            if (c === 'component' || c === 'vuecomponent') return 'component';
            if (c === 'script' || c === 'automationscript') return 'script';
            if (c === 'route' || c === 'endpoint' || c === 'apiroute') return 'endpoint';
            if (c === 'store' || c === 'statestore') return 'store';
            if (c === 'library' || c === 'externallibrary') return 'library';
            if (c === 'artifact' || c === 'softwareartifact') return 'artifact';
            return c;
        };

        const matchTerm = (actual: string, queryTerm: string, isTypeCheck: boolean = false): boolean => {
            if (!actual || !queryTerm) return false;
            if (isTypeCheck) {
                const ta = normType(actual);
                const tq = normType(queryTerm);
                if (ta === tq) return true;
                if (tq === 'file' && (ta === 'component' || ta === 'script' || ta === 'file')) return true;
                if (tq === 'function' && (ta === 'method' || ta === 'endpoint')) return true;
                if (tq === 'artifact' && (ta === 'file' || ta === 'component' || ta === 'script')) return true;
                return false;
            }
            const cleanA = actual.replace(/^s:/i, '').replace(/^["']|["']$/g, '').toLowerCase().trim();
            const cleanQ = queryTerm.replace(/^s:/i, '').replace(/^["']|["']$/g, '').toLowerCase().trim();
            return cleanA === cleanQ;
        };

        let solutions: Record<string, string>[] = [{}];

        for (const pattern of triplePatterns) {
            const nextSolutions: Record<string, string>[] = [];
            const pNorm = normPred(pattern.p);
            const isTypePattern = pNorm === 'type';

            for (const binding of solutions) {
                const sBound = pattern.s.startsWith('?') ? binding[pattern.s] : pattern.s;
                const oBound = pattern.o.startsWith('?') ? binding[pattern.o] : pattern.o;

                for (const t of this.triples) {
                    const tpNorm = normPred(t.p);

                    let directMatch = false;
                    let inverseMatch = false;

                    if (isTypePattern && tpNorm === 'type') {
                        const sMatch = !sBound || matchTerm(t.s, sBound);
                        const oMatch = !oBound || matchTerm(t.o, oBound, true);
                        directMatch = sMatch && oMatch;
                    } else if (pNorm === 'contains') {
                        if (tpNorm === 'contains') {
                            const sMatch = !sBound || matchTerm(t.s, sBound);
                            const oMatch = !oBound || matchTerm(t.o, oBound);
                            directMatch = sMatch && oMatch;
                        } else if (tpNorm === 'definedin') {
                            const sMatch = !sBound || matchTerm(t.o, sBound);
                            const oMatch = !oBound || matchTerm(t.s, oBound);
                            inverseMatch = sMatch && oMatch;
                        }
                    } else if (pNorm === 'definedin') {
                        if (tpNorm === 'definedin') {
                            const sMatch = !sBound || matchTerm(t.s, sBound);
                            const oMatch = !oBound || matchTerm(t.o, oBound);
                            directMatch = sMatch && oMatch;
                        } else if (tpNorm === 'contains') {
                            const sMatch = !sBound || matchTerm(t.o, sBound);
                            const oMatch = !oBound || matchTerm(t.s, oBound);
                            inverseMatch = sMatch && oMatch;
                        }
                    } else {
                        const pMatch = pNorm === tpNorm;
                        const sMatch = !sBound || matchTerm(t.s, sBound);
                        const oMatch = !oBound || matchTerm(t.o, oBound);
                        directMatch = pMatch && sMatch && oMatch;
                    }

                    if (directMatch) {
                        const newBinding = { ...binding };
                        if (pattern.s.startsWith('?') && !binding[pattern.s]) newBinding[pattern.s] = t.s;
                        if (pattern.o.startsWith('?') && !binding[pattern.o]) newBinding[pattern.o] = t.o;
                        nextSolutions.push(newBinding);
                    } else if (inverseMatch) {
                        const newBinding = { ...binding };
                        if (pattern.s.startsWith('?') && !binding[pattern.s]) newBinding[pattern.s] = t.o;
                        if (pattern.o.startsWith('?') && !binding[pattern.o]) newBinding[pattern.o] = t.s;
                        nextSolutions.push(newBinding);
                    }
                }
            }
            solutions = nextSolutions;
            if (solutions.length === 0) break;
        }

        if (filters.length > 0) {
            solutions = solutions.filter(b => {
                return filters.every(f => {
                    const regMatch = f.match(/regex\s*\(\s*(\?[a-zA-Z0-9_]+)\s*,\s*['"]([^'"]+)['"](?:\s*,\s*['"]([iI])['"])?\s*\)/i);
                    if (regMatch) {
                        const val = (b[regMatch[1]] || '').replace(/^"|"$/g, '');
                        try {
                            const re = new RegExp(regMatch[2], regMatch[3] || '');
                            return re.test(val);
                        } catch { return false; }
                    }
                    return true;
                });
            });
        }

        if (askMatch) {
            return `### 🔍 SPARQL ASK Verdict: \`${solutions.length > 0 ? 'true' : 'false'}\``;
        }

        // ─────────────────────────────────────────────────────────────
        // SPARQL CONSTRUCT ENGINE: Instantiates graph from template
        // ─────────────────────────────────────────────────────────────
        if (constructMatch) {
            this.lastConstructedGraph = null;
            const templateClause = constructMatch[1].trim();
            const { triplePatterns: templatePatterns } = this.parseSparqlWhereClause(templateClause);

            const constructedTriples: GraphTriple[] = [];
            const seenTriples = new Set<string>();

            for (const sol of solutions) {
                for (const tp of templatePatterns) {
                    const resolveTerm = (t: string) => (t.startsWith('?') && sol[t] ? sol[t] : t);
                    const s = resolveTerm(tp.s);
                    const p = resolveTerm(tp.p);
                    const o = resolveTerm(tp.o);

                    if (!s.startsWith('?') && !p.startsWith('?') && !o.startsWith('?')) {
                        const key = `${s} ${p} ${o}`;
                        if (!seenTriples.has(key)) {
                            seenTriples.add(key);
                            constructedTriples.push({ s, p, o });
                        }
                    }
                }
            }

            if (constructedTriples.length === 0) {
                return `### 🎨 SPARQL CONSTRUCT Result\n*(0 triples constructed from ${solutions.length} query solutions)*`;
            }

            // Build visual graph nodes and edges from constructedTriples
            const nodesMap = new Map<string, any>();
            const edgesList: any[] = [];

            const nodeLabelMap = new Map<string, string>();
            for (const t of this.triples) {
                if (normPred(t.p) === 'name' || normPred(t.p) === 'filepath') {
                    nodeLabelMap.set(t.s, t.o.replace(/^"|"$/g, ''));
                }
            }

            for (const ct of constructedTriples) {
                const addNode = (id: string) => {
                    const cleanId = id.replace(/^s:/, '');
                    if (!nodesMap.has(cleanId)) {
                        const friendlyLabel = nodeLabelMap.get(ct.s) || nodeLabelMap.get(id) || nodeLabelMap.get(`s:${cleanId}`) || cleanId;
                        let inferredType = 'entity';
                        if (id.startsWith('s:file_') || id.endsWith('.py') || id.endsWith('.ts') || id.endsWith('.js') || id.endsWith('.vue')) inferredType = 'file';
                        else if (id.startsWith('s:class_') || id.includes('Class')) inferredType = 'class';
                        else if (id.startsWith('s:fn_') || id.startsWith('s:method_') || id.includes('Func')) inferredType = 'function';
                        else if (id.startsWith('s:ep_') || id.includes('Route')) inferredType = 'endpoint';
                        else if (id.startsWith('s:lib_') || id.includes('Library')) inferredType = 'library';

                        nodesMap.set(cleanId, {
                            id: cleanId,
                            rawId: id,
                            label: friendlyLabel,
                            type: inferredType
                        });
                    }
                };

                addNode(ct.s);
                addNode(ct.o);

                const srcClean = ct.s.replace(/^s:/, '');
                const trgClean = ct.o.replace(/^s:/, '');
                const predClean = ct.p.replace(/^s:/, '');

                edgesList.push({
                    id: `edge_c_${srcClean}_${predClean}_${trgClean}_${edgesList.length}`,
                    source: srcClean,
                    target: trgClean,
                    label: predClean
                });
            }

            const graphData = {
                nodes: Array.from(nodesMap.values()),
                edges: edgesList
            };

            this.lastConstructedGraph = graphData;

            let output = `### 🎨 SPARQL CONSTRUCT Query Result (${constructedTriples.length} triples, ${graphData.nodes.length} nodes)\n\n`;
            output += `| Subject | Predicate | Object |\n`;
            output += `| --- | --- | --- |\n`;
            for (const ct of constructedTriples.slice(0, 50)) {
                const sName = nodeLabelMap.get(ct.s) || ct.s.replace(/^s:/, '');
                const oName = nodeLabelMap.get(ct.o) || ct.o.replace(/^s:/, '');
                output += `| \`${sName}\` | \`${ct.p.replace(/^s:/, '')}\` | \`${oName}\` |\n`;
            }

            output += `\n\`\`\`json:constructed_graph\n${JSON.stringify(graphData, null, 2)}\n\`\`\`\n`;

            return output;
        }

        if (solutions.length === 0) {
            return `### 🔍 SPARQL Query Results\n*(0 matches found across ${this.triples.length} triples)*`;
        }

        const selectStr = selectMatch![2].trim();
        const vars = selectStr === '*' 
            ? Object.keys(solutions[0])
            : selectStr.split(/\s+/).filter(v => v.startsWith('?'));

        const nodeLabelMap = new Map<string, string>();
        for (const t of this.triples) {
            if (normPred(t.p) === 'name' || normPred(t.p) === 'filepath') {
                const cleanVal = t.o.replace(/^"|"$/g, '');
                if (!nodeLabelMap.has(t.s) || normPred(t.p) === 'name') {
                    nodeLabelMap.set(t.s, cleanVal);
                }
            }
        }

        const seenRows = new Set<string>();
        const uniqueSolutions = solutions.filter(sol => {
            const key = vars.map(v => sol[v] || '').join('||');
            if (seenRows.has(key)) return false;
            seenRows.add(key);
            return true;
        });

        let table = `### 🔍 SPARQL Query Results (${uniqueSolutions.length} matches)\n\n`;
        table += `| ${vars.map(v => `**${v}**`).join(' | ')} |\n`;
        table += `| ${vars.map(() => '---').join(' | ')} |\n`;

        for (const sol of uniqueSolutions.slice(0, 50)) {
            const row = vars.map(v => {
                const val = sol[v] || '(null)';
                const cleanVal = val.replace(/^"|"$/g, '');
                const friendlyLabel = nodeLabelMap.get(cleanVal) || nodeLabelMap.get(`s:${cleanVal}`);
                if (friendlyLabel) {
                    return `\`${friendlyLabel}\` <small style="opacity:0.6;">(${cleanVal.replace(/^s:/, '')})</small>`;
                }
                return `\`${cleanVal.replace(/^s:/, '')}\``;
            });
            table += `| ${row.join(' | ')} |\n`;
        }

        return table;
    }

    public getTBoxGraphElements(): { nodes: any[]; edges: any[] } {
        const nodesMap = new Map<string, any>();
        const edgesList: any[] = [];
        const tboxTriples = this.triples.filter(t => this.isTBoxSubject(t.s));

        for (const t of tboxTriples) {
            const sId = t.s.replace(/^s:/, '');
            if (!nodesMap.has(sId)) {
                nodesMap.set(sId, {
                    id: sId,
                    rawId: t.s,
                    label: sId,
                    type: 'tbox-class',
                    description: '',
                    degree: 0
                });
            }

            if (t.p === 'rdfs:label') {
                const label = t.o.replace(/^"|"(@[a-z]+)?$/g, '');
                nodesMap.get(sId)!.description = label;
            } else if (t.p === 'rdf:type') {
                if (t.o.includes('ObjectProperty') || t.o.includes('DatatypeProperty') || t.o.includes('SymmetricProperty')) {
                    nodesMap.get(sId)!.type = 'tbox-property';
                }
            }
        }

        const propertyDomains = new Map<string, string>();
        const propertyRanges = new Map<string, string>();

        for (const t of tboxTriples) {
            const sClean = t.s.replace(/^s:/, '');
            const oClean = t.o.replace(/^s:/, '');

            if (t.p === 'rdfs:subClassOf') {
                if (nodesMap.has(sClean) && nodesMap.has(oClean)) {
                    edgesList.push({
                        id: `edge_${sClean}_subClassOf_${oClean}`,
                        source: sClean,
                        target: oClean,
                        label: 'subClassOf'
                    });
                }
            } else if (t.p === 'rdfs:domain') {
                propertyDomains.set(sClean, oClean);
            } else if (t.p === 'rdfs:range') {
                propertyRanges.set(sClean, oClean);
            } else if (t.p === 'owl:inverseOf') {
                if (nodesMap.has(sClean) && nodesMap.has(oClean)) {
                    edgesList.push({
                        id: `edge_${sClean}_inverseOf_${oClean}`,
                        source: sClean,
                        target: oClean,
                        label: 'inverseOf'
                    });
                }
            }
        }

        // Link ObjectProperty edges between domain class and range class
        for (const [prop, domain] of propertyDomains.entries()) {
            const range = propertyRanges.get(prop);
            if (range && nodesMap.has(domain) && nodesMap.has(range)) {
                edgesList.push({
                    id: `edge_${domain}_${prop}_${range}`,
                    source: domain,
                    target: range,
                    label: prop
                });
            }
        }

        // Return formal ontology classes
        const classNodes = Array.from(nodesMap.values()).filter(n => n.type === 'tbox-class');

        return {
            nodes: classNodes,
            edges: edgesList
        };
    }

    public async getHighLevelGraphElements(
        workspaceFolder?: vscode.WorkspaceFolder, 
        connectedOnly: boolean = true,
        maxNodesLimit: number = 120,
        viewScope: 'abox' | 'tbox' | 'all' = 'abox'
    ): Promise<{ nodes: any[]; edges: any[]; totalGraphNodes?: number; isTruncated?: boolean }> {
        await this.initializeGraph(workspaceFolder);

        if (viewScope === 'tbox') {
            const tboxElements = this.getTBoxGraphElements();
            return {
                nodes: tboxElements.nodes,
                edges: tboxElements.edges,
                totalGraphNodes: tboxElements.nodes.length,
                isTruncated: false
            };
        }

        const nodesMap = new Map<string, any>();
        const edgesList: any[] = [];
        const { isPathBlockedFromGraph } = require('./codeGraphManager');

        const aboxTriples = this.triples.filter(t => !this.isTBoxSubject(t.s));

        for (const t of aboxTriples) {
            const sId = t.s;
            if (!nodesMap.has(sId)) {
                nodesMap.set(sId, {
                    id: sId,
                    label: sId.replace(/^s:/, '').replace(/^[a-z]+_/i, ''),
                    type: 'entity',
                    degree: 0
                });
            }

            if (t.p === 'rdf:type') {
                const rawType = t.o.replace(/^s:/, '').toLowerCase();
                let simplifiedType = 'entity';
                if (rawType.includes('vuecomponent') || rawType === 'component') simplifiedType = 'component';
                else if (rawType.includes('automationscript') || rawType === 'script') simplifiedType = 'script';
                else if (rawType.includes('apiroute') || rawType === 'endpoint') simplifiedType = 'endpoint';
                else if (rawType.includes('statestore') || rawType === 'store') simplifiedType = 'store';
                else if (rawType.includes('backendmodule')) simplifiedType = 'file';
                else if (rawType.includes('sourcefile') || rawType === 'file') simplifiedType = 'file';
                else if (rawType.includes('class')) simplifiedType = 'class';
                else if (rawType.includes('interface')) simplifiedType = 'interface';
                else if (rawType.includes('function')) simplifiedType = 'function';
                else if (rawType.includes('method')) simplifiedType = 'method';
                else if (rawType.includes('library')) simplifiedType = 'library';
                else if (rawType.includes('insight')) simplifiedType = 'insight';
                else if (rawType.includes('topic')) simplifiedType = 'topic';
                nodesMap.get(sId)!.type = simplifiedType;
            } else if (t.p === 's:name' || t.p === 's:label') {
                const nameVal = t.o.replace(/^"|"$/g, '').trim();
                if (nameVal) {
                    nodesMap.get(sId)!.label = nameVal;
                }
            } else if (t.p === 's:filePath') {
                const pathVal = t.o.replace(/^"|"$/g, '').trim();
                if (isPathBlockedFromGraph(pathVal)) {
                    nodesMap.delete(sId);
                    continue;
                }
                nodesMap.get(sId)!.filePath = pathVal;
                if (nodesMap.get(sId)!.type === 'file') {
                    nodesMap.get(sId)!.label = path.basename(pathVal) || pathVal;
                }
            } else if (t.p === 's:startLine') {
                nodesMap.get(sId)!.startLine = parseInt(t.o, 10);
            } else if (t.p === 's:docstring' || t.p === 's:functionDescription') {
                let doc = t.o.trim();
                if (doc.startsWith('"') && doc.endsWith('"')) {
                    doc = doc.substring(1, doc.length - 1);
                }
                doc = doc.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
                nodesMap.get(sId)!.docstring = doc;
            } else if (t.p === 's:signature') {
                let sig = t.o.trim();
                if (sig.startsWith('"') && sig.endsWith('"')) {
                    sig = sig.substring(1, sig.length - 1);
                }
                nodesMap.get(sId)!.signature = sig.replace(/\\"/g, '"');
            } else if (t.p === 's:docstringFormat') {
                nodesMap.get(sId)!.docFormat = t.o.replace(/^"|"$/g, '').trim();
            }
        }

        for (const [id, node] of nodesMap.entries()) {
            if (node.filePath && isPathBlockedFromGraph(node.filePath)) {
                nodesMap.delete(id);
            }
        }

        const edgeSet = new Set<string>();

        for (const t of aboxTriples) {
            const rawP = t.p.replace(/^s:/, '').toLowerCase();
            let friendlyLabel: string | null = null;

            if (rawP === 'contains' || rawP === 'containsentity') friendlyLabel = 'contains';
            else if (rawP === 'definedin' || rawP === 'definedinfile') friendlyLabel = 'definedIn';
            else if (rawP === 'memberof' || rawP === 'memberofclass') friendlyLabel = 'memberOf';
            else if (rawP === 'imports' || rawP === 'importsmodule') friendlyLabel = 'imports';
            else if (rawP === 'calls' || rawP === 'invokes' || rawP === 'invokesfunction') friendlyLabel = 'calls';
            else if (rawP === 'inherits' || rawP === 'inheritsfrom') friendlyLabel = 'inherits';
            else if (rawP === 'disjoint' || rawP === 'disjointwith') friendlyLabel = 'disjointWith';
            else if (rawP === 'exposes' || rawP === 'exposesendpoint') friendlyLabel = 'exposes';
            else if (rawP === 'explains' || rawP === 'explainsartifact') friendlyLabel = 'explains';
            else if (rawP === 'hastopic') friendlyLabel = 'hasTopic';

            if (friendlyLabel) {
                const targetId = t.o.startsWith('s:') ? t.o : `s:${t.o}`;
                if (nodesMap.has(t.s) && nodesMap.has(targetId)) {
                    const edgeKey = `${t.s}->${friendlyLabel}->${targetId}`;
                    if (!edgeSet.has(edgeKey)) {
                        edgeSet.add(edgeKey);
                        edgesList.push({
                            id: `edge_${t.s}_${friendlyLabel}_${targetId}`.replace(/[^a-zA-Z0-9_]/g, '_'),
                            source: t.s,
                            target: targetId,
                            label: friendlyLabel
                        });
                        nodesMap.get(t.s)!.degree = (nodesMap.get(t.s)!.degree || 0) + 1;
                        nodesMap.get(targetId)!.degree = (nodesMap.get(targetId)!.degree || 0) + 1;
                    }
                }
            } else if (rawP === 'calls' || rawP === 'invokes' || rawP === 'invokesfunction') {
                const targetId = t.o.startsWith('s:') ? t.o : `s:${t.o}`;
                if (nodesMap.has(t.s) && nodesMap.has(targetId)) {
                    const edgeKey = `${t.s}->calls->${targetId}`;
                    if (!edgeSet.has(edgeKey)) {
                        edgeSet.add(edgeKey);
                        edgesList.push({
                            id: `edge_${t.s}_calls_${targetId}`.replace(/[^a-zA-Z0-9_]/g, '_'),
                            source: t.s,
                            target: targetId,
                            label: 'calls'
                        });
                        nodesMap.get(t.s)!.degree = (nodesMap.get(t.s)!.degree || 0) + 1;
                        nodesMap.get(targetId)!.degree = (nodesMap.get(targetId)!.degree || 0) + 1;
                    }
                }
            }
        }

        const totalGraphNodes = nodesMap.size;
        const candidateNodes = Array.from(nodesMap.values());

        // If viewScope is calls, prioritize callables (functions, methods, endpoints) and caller entities
        if (viewScope === 'all' || (viewScope as any) === 'calls') {
            const callEdgesExist = edgesList.some(e => e.label === 'calls');
            if (callEdgesExist || (viewScope as any) === 'calls') {
                const callNodes = new Set<string>();
                edgesList.filter(e => e.label === 'calls').forEach(e => {
                    callNodes.add(e.source);
                    callNodes.add(e.target);
                });
                candidateNodes.forEach(n => {
                    if (callNodes.has(n.id)) {
                        n.degree = (n.degree || 0) + 50; // Boost connected call nodes
                    }
                });
            }
        }

        // Sort by architectural importance
        candidateNodes.sort((a, b) => {
            const typeWeight = (t: string) => {
                if ((viewScope as any) === 'calls') {
                    if (t === 'function' || t === 'method' || t === 'endpoint') return 20;
                    if (t === 'class') return 10;
                    return 1;
                }
                if (t === 'file' || t === 'component') return 10;
                if (t === 'class' || t === 'interface') return 8;
                if (t === 'endpoint' || t === 'store') return 6;
                if (t === 'function') return 5;
                if (t === 'method') return 4;
                return 1;
            };
            const wDiff = typeWeight(b.type) - typeWeight(a.type);
            if (wDiff !== 0) return wDiff;
            return (b.degree || 0) - (a.degree || 0);
        });

        const activeNodes: any[] = [];
        const targetLimit = Math.max(maxNodesLimit, 350);

        for (const node of candidateNodes) {
            if (connectedOnly && (node.degree || 0) === 0) continue;
            activeNodes.push(node);
            if (activeNodes.length >= targetLimit) break;
        }

        const activeNodeIdSet = new Set(activeNodes.map(n => n.id));
        const finalEdges = edgesList.filter(e => activeNodeIdSet.has(e.source) && activeNodeIdSet.has(e.target));

        return {
            nodes: activeNodes.map(n => ({
                id: n.id,
                label: n.label,
                type: n.type,
                filePath: n.filePath,
                startLine: n.startLine,
                degree: n.degree,
                signature: n.signature,
                docstring: n.docstring,
                docFormat: n.docFormat
            })),
            edges: finalEdges,
            totalGraphNodes,
            isTruncated: totalGraphNodes > activeNodes.length
        };
    }

    public async renderContextKnowledge(workspaceFolder?: vscode.WorkspaceFolder): Promise<string> {
        await this.initializeGraph(workspaceFolder);
        if (this.triples.length === 0) return "";

        let fileCount = 0;
        let classCount = 0;
        let funcCount = 0;
        let methodCount = 0;
        let descCount = 0;
        let componentCount = 0;
        let scriptCount = 0;
        let endpointCount = 0;
        let storeCount = 0;
        let relationCount = 0;
        let disjointCount = 0;
        const topicSet = new Set<string>();
        const languagesSet = new Set<string>();
        const layersSet = new Set<string>();

        for (const t of this.triples) {
            if (t.p === 'rdf:type') {
                const target = t.o;
                if (target === 's:SourceFile' || target === 's:File' || target === 's:BackendModule') fileCount++;
                else if (target === 's:VueComponent') componentCount++;
                else if (target === 's:AutomationScript') scriptCount++;
                else if (target === 's:ClassDefinition' || target === 's:Class') classCount++;
                else if (target === 's:FunctionDefinition' || target === 's:Function') funcCount++;
                else if (target === 's:MethodDefinition' || target === 's:Method') methodCount++;
                else if (target === 's:FunctionDescription') descCount++;
                else if (target === 's:APIRoute') endpointCount++;
                else if (target === 's:StateStore') storeCount++;
            }
            if (t.p === 's:programmingLanguage') {
                languagesSet.add(t.o.replace(/^"|"$/g, ''));
            }
            if (t.p === 's:layer') {
                layersSet.add(t.o.replace(/^"|"$/g, ''));
            }
            if (t.p === 's:hasTopic') {
                topicSet.add(t.o.replace(/^s:topic_/, ''));
            }
            if (t.p === 's:containsEntity' || t.p === 's:importsModule' || t.p === 's:invokesFunction' || t.p === 's:inheritsFrom' || t.p === 's:exposesEndpoint') {
                relationCount++;
            }
            if (t.p === 's:disjointWith') {
                disjointCount++;
            }
        }

        const entitiesParts: string[] = [
            `${fileCount} Files`
        ];
        if (componentCount > 0) entitiesParts.push(`${componentCount} Vue Components`);
        if (classCount > 0) entitiesParts.push(`${classCount} Classes`);
        if (funcCount > 0) entitiesParts.push(`${funcCount} Functions`);
        if (methodCount > 0) entitiesParts.push(`${methodCount} Methods`);
        if (descCount > 0) entitiesParts.push(`${descCount} Function Descriptions (Docstrings/Doxygen)`);
        if (endpointCount > 0) entitiesParts.push(`${endpointCount} API Endpoints`);
        if (storeCount > 0) entitiesParts.push(`${storeCount} Stores`);
        if (scriptCount > 0) entitiesParts.push(`${scriptCount} Scripts`);
        if (disjointCount > 0) entitiesParts.push(`${Math.round(disjointCount / 2)} Disjoint Pairs`);

        let output = `### 🕸️ KNOWLEDGE GRAPH ABOX TOPOLOGY (.lollms/knowledge.ttl)\n`;
        output += `- **Entities**: ${entitiesParts.join(' · ')}\n`;
        output += `- **Active Assertions**: ${relationCount} Connected Code Relations (containsEntity, importsModule, invokesFunction, inheritsFrom, exposesEndpoint)\n`;

        if (layersSet.size > 0 || languagesSet.size > 0) {
            const langs = Array.from(languagesSet).join(', ');
            const layers = Array.from(layersSet).join(' · ');
            output += `- **Stack Architecture**: ${layers}${langs ? ` (${langs})` : ''}\n`;
        }

        if (topicSet.size > 0) {
            output += `- **Indexed Topics**: ${Array.from(topicSet).slice(0, 10).map(t => `#${t}`).join(' ')}\n`;
        }
        output += `\n> 💡 **Ontology SPARQL Protocol**: Every code entity is connected to its file and parent class. Query with: \`<query_architecture>SELECT ?func ?file WHERE { ?file s:containsEntity ?func . ?func a s:FunctionDefinition } LIMIT 20</query_architecture>\`.\n`;

        return output.trim();
    }

    public async resetKnowledge(workspaceFolder?: vscode.WorkspaceFolder): Promise<void> {
        const ttlUri = this.getKnowledgeTtlUri(workspaceFolder);
        if (ttlUri) {
            try { await vscode.workspace.fs.delete(ttlUri); } catch {}
        }
        this.triples = this.getBaselineOntologyTriples();
        this.initialized = true;
        await this.saveGraph(workspaceFolder);
    }
}