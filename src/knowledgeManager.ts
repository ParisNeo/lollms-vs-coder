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
            // New project: initialize baseline ontology triples
            this.triples = this.getBaselineOntologyTriples();
            await this.saveGraph(workspaceFolder);
            Logger.info(`[KnowledgeManager] Initialized new knowledge graph with baseline ontology.`);
        }
        this.initialized = true;
    }

    /**
     * Formal, standard-compliant Software Engineering Ontology (TBox).
     * Defines an expressive taxonomy of artifacts, code entities, relations, and insights.
     */
    private getBaselineOntologyTriples(): GraphTriple[] {
        return [
            // Core Classes (Taxonomy)
            { s: 's:SoftwareArtifact', p: 'rdf:type', o: 'owl:Class' },
            { s: 's:SoftwareArtifact', p: 'rdfs:label', o: '"Software Artifact"@en' },

            { s: 's:SourceFile', p: 'rdf:type', o: 'owl:Class' },
            { s: 's:SourceFile', p: 'rdfs:subClassOf', o: 's:SoftwareArtifact' },
            { s: 's:SourceFile', p: 'rdfs:label', o: '"Source File"@en' },

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

            { s: 's:ExternalLibrary', p: 'rdf:type', o: 'owl:Class' },
            { s: 's:ExternalLibrary', p: 'rdfs:label', o: '"External Library / Dependency"@en' },

            { s: 's:ArchitecturalInsight', p: 'rdf:type', o: 'owl:Class' },
            { s: 's:ArchitecturalInsight', p: 'rdfs:label', o: '"Architectural Insight"@en' },

            { s: 's:TopicTag', p: 'rdf:type', o: 'owl:Class' },
            { s: 's:TopicTag', p: 'rdfs:label', o: '"Topic Tag"@en' },

            // Object Properties (Relationships)
            { s: 's:containsEntity', p: 'rdf:type', o: 'owl:ObjectProperty' },
            { s: 's:containsEntity', p: 'rdfs:domain', o: 's:SoftwareArtifact' },
            { s: 's:containsEntity', p: 'rdfs:range', o: 's:CodeEntity' },
            { s: 's:containsEntity', p: 'rdfs:label', o: '"contains code entity"@en' },

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
            { s: 's:inheritsFrom', p: 'rdfs:label', o: '"inherits from"@en' },

            { s: 's:explainsArtifact', p: 'rdf:type', o: 'owl:ObjectProperty' },
            { s: 's:explainsArtifact', p: 'rdfs:domain', o: 's:ArchitecturalInsight' },
            { s: 's:explainsArtifact', p: 'rdfs:range', o: 's:SoftwareArtifact' },
            { s: 's:explainsArtifact', p: 'rdfs:label', o: '"explains artifact or entity"@en' },

            { s: 's:hasTopic', p: 'rdf:type', o: 'owl:ObjectProperty' },
            { s: 's:hasTopic', p: 'rdfs:domain', o: 's:ArchitecturalInsight' },
            { s: 's:hasTopic', p: 'rdfs:range', o: 's:TopicTag' },
            { s: 's:hasTopic', p: 'rdfs:label', o: '"tagged with topic"@en' },

            // Datatype Properties (Attributes)
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

    public parseTurtle(turtleText: string): void {
        const lines = turtleText.split(/\r?\n/);
        const parsed: GraphTriple[] = [];
        let currentSubject = "";

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('@prefix') || trimmed.startsWith('#')) continue;

            // Check if line establishes a new subject without predicate (e.g. "s:my_subject")
            if (!trimmed.includes(';') && !trimmed.endsWith('.') && !trimmed.includes(' ')) {
                currentSubject = trimmed;
                continue;
            }

            // Clean terminator
            const isDotTerminated = trimmed.endsWith('.');
            const isSemicolonTerminated = trimmed.endsWith(';');
            const clean = trimmed.replace(/\s*[;.]$/, '').trim();

            const parts = clean.match(/^(\S+)\s+(\S+)\s+(.+)$/);
            if (parts) {
                // Single line triple: s p o
                currentSubject = parts[1].trim();
                const p = parts[2].trim();
                const o = parts[3].trim();
                parsed.push({ s: currentSubject, p, o });
            } else {
                // Continuation line with predicate and object: p o (for currentSubject)
                const predObjMatch = clean.match(/^(\S+)\s+(.+)$/);
                if (predObjMatch && currentSubject) {
                    const p = predObjMatch[1].trim();
                    const o = predObjMatch[2].trim();
                    parsed.push({ s: currentSubject, p, o });
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

        // Section 1: TBox Vocabulary
        ttl += `### ===================================================================\n`;
        ttl += `### 🏛️ TBOX: FORMAL SOFTWARE ENGINEERING ONTOLOGY\n`;
        ttl += `### ===================================================================\n\n`;

        const tboxSubjects = new Set(this.getBaselineOntologyTriples().map(t => t.s));
        const tboxBySubject = new Map<string, { p: string, o: string }[]>();
        const aboxBySubject = new Map<string, { p: string, o: string }[]>();

        for (const t of this.triples) {
            if (tboxSubjects.has(t.s)) {
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

        // Section 2: ABox Individuals & Links
        ttl += `### ===================================================================\n`;
        ttl += `### 📦 ABOX: CODEBASE INSTANCES & ARCHITECTURAL RELATIONSHIPS\n`;
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

    /**
     * Ingests an architectural insight emitted by the LLM into the unified Knowledge Graph.
     */
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
        const safeTopicId = cleanTopic.toLowerCase().replace(/[^a-z0-9_]/g, '_');
        const insightId = `s:insight_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        const timestamp = new Date().toISOString();

        // 1. Insight individual
        this.addTriple({ s: insightId, p: 'rdf:type', o: 's:Insight' });
        this.addTriple({ s: insightId, p: 's:topicName', o: `"${cleanTopic}"` });
        this.addTriple({ s: insightId, p: 's:insightText', o: JSON.stringify(cleanContent) });
        this.addTriple({ s: insightId, p: 's:timestamp', o: `"${timestamp}"^^xsd:dateTime` });

        // 2. Connect to hashtags/topics
        for (const tag of hashtags) {
            const cleanTag = tag.replace(/^#/, '').trim().toLowerCase();
            if (!cleanTag) continue;
            const topicNode = `s:topic_${cleanTag}`;
            this.addTriple({ s: topicNode, p: 'rdf:type', o: 's:Topic' });
            this.addTriple({ s: topicNode, p: 's:name', o: `"${cleanTag}"` });
            this.addTriple({ s: insightId, p: 's:hasTopic', o: topicNode });
        }

        // 3. Connect to related files in the graph
        for (const file of files) {
            const cleanFile = file.replace(/\\/g, '/').trim();
            if (!cleanFile) continue;
            const fileNode = `s:file_${cleanFile.replace(/[^a-zA-Z0-9_]/g, '_')}`;

            // Ensure file node exists in graph
            this.addTriple({ s: fileNode, p: 'rdf:type', o: 's:File' });
            this.addTriple({ s: fileNode, p: 's:path', o: `"${cleanFile}"` });
            this.addTriple({ s: fileNode, p: 's:name', o: `"${path.basename(cleanFile)}"` });

            // Bi-directional understanding relations
            this.addTriple({ s: insightId, p: 's:relatesTo', o: fileNode });
            this.addTriple({ s: insightId, p: 's:explains', o: fileNode });
        }

        await this.saveGraph(workspaceFolder);
        Logger.info(`[KnowledgeManager] Ingested insight '${cleanTopic}' with ${files.length} files and ${hashtags.length} hashtags.`);
        return insightId;
    }

    public addTriple(triple: GraphTriple): void {
        // Prevent exact duplicates
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
        // Remove triples where file is subject or object
        this.triples = this.triples.filter(t => t.s !== fileNode && t.o !== fileNode);
    }

    /**
     * Synchronizes AST code graph nodes and edges into the unified Knowledge Graph ABox.
     * Completely populates instances of s:File, s:Class, s:Function, s:Method, and s:Library.
     */
    /**
     * Synchronizes AST code graph nodes and edges into the unified Knowledge Graph ABox.
     * Maps nodes to formal ontology classes and links relationships cleanly.
     */
    public async syncCodeGraph(
        nodes: Array<{ id: string; label: string; type: string; filePath?: string; signature?: string; docstring?: string }>,
        edges: Array<{ source: string; target: string; label: string }>,
        workspaceFolder?: vscode.WorkspaceFolder
    ): Promise<void> {
        await this.initializeGraph(workspaceFolder);

        const { isPathBlockedFromGraph } = require('./codeGraphManager');

        // Filter incoming nodes to strictly valid project source files
        const validNodes = nodes.filter(n => !n.filePath || !isPathBlockedFromGraph(n.filePath));
        const nodeIdMap = new Map<string, string>(); // oldId -> formalId

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

        // Retain formal TBox baseline and human/AI insights & topic tags
        const baselineTbox = this.getBaselineOntologyTriples();
        const preservedInsights = this.triples.filter(t => 
            t.s.startsWith('s:insight_') || 
            t.s.startsWith('s:topic_') ||
            t.p === 's:hasTopic' ||
            t.p === 's:explainsArtifact'
        );

        this.triples = [...baselineTbox, ...preservedInsights];

        // Map AST types to formal OWL classes
        const typeMapping: Record<string, string> = {
            'file': 's:SourceFile',
            'class': 's:ClassDefinition',
            'interface': 's:InterfaceDefinition',
            'function': 's:FunctionDefinition',
            'method': 's:MethodDefinition',
            'library': 's:ExternalLibrary'
        };

        // Map edge labels to formal OWL object properties
        const edgeMapping: Record<string, string> = {
            'contains': 's:containsEntity',
            'imports': 's:importsModule',
            'calls': 's:invokesFunction',
            'inherits': 's:inheritsFrom'
        };

        for (const n of validNodes) {
            const nodeId = nodeIdMap.get(n.id)!;
            const rdfClass = typeMapping[n.type.toLowerCase()] || 's:CodeEntity';

            this.addTriple({ s: nodeId, p: 'rdf:type', o: rdfClass });
            this.addTriple({ s: nodeId, p: 's:name', o: `"${n.label.replace(/"/g, "'")}"` });

            if (n.filePath) {
                this.addTriple({ s: nodeId, p: 's:filePath', o: `"${n.filePath.replace(/\\/g, '/')}"` });
            }
            if (n.signature) {
                this.addTriple({ s: nodeId, p: 's:signature', o: JSON.stringify(n.signature) });
            }
            if (n.docstring) {
                this.addTriple({ s: nodeId, p: 's:docstring', o: JSON.stringify(n.docstring.replace(/[\r\n]+/g, ' ')) });
            }
        }

        for (const e of validEdges) {
            const src = nodeIdMap.get(e.source)!;
            const trg = nodeIdMap.get(e.target)!;
            const prop = edgeMapping[e.label.toLowerCase()] || `s:${e.label}`;
            this.addTriple({ s: src, p: prop, o: trg });
        }

        await this.saveGraph(workspaceFolder);
        Logger.info(`[KnowledgeManager] Full ABox synchronized: ${validNodes.length} code entities and ${validEdges.length} semantic relationships saved to ${KnowledgeManager.TTL_FILENAME}.`);
    }

    /**
     * Incrementally synchronizes a single file's AST and relationships into the ABox.
     */
    public async syncFileToABox(
        relPath: string,
        nodes: Array<{ id: string; label: string; type: string; signature?: string; docstring?: string }>,
        edges: Array<{ source: string; target: string; label: string }>,
        workspaceFolder?: vscode.WorkspaceFolder
    ): Promise<void> {
        const { isPathBlockedFromGraph } = require('./codeGraphManager');
        if (isPathBlockedFromGraph(relPath)) {
            return;
        }

        await this.initializeGraph(workspaceFolder);

        const cleanPath = relPath.replace(/\\/g, '/').trim();
        this.removeTriplesForFile(cleanPath);

        const fileNodeId = `s:file_${cleanPath.replace(/[^a-zA-Z0-9_]/g, '_')}`;
        this.addTriple({ s: fileNodeId, p: 'rdf:type', o: 's:File' });
        this.addTriple({ s: fileNodeId, p: 's:path', o: `"${cleanPath}"` });
        this.addTriple({ s: fileNodeId, p: 's:name', o: `"${path.basename(cleanPath)}"` });

        for (const n of nodes) {
            const typeCap = n.type ? (n.type.charAt(0).toUpperCase() + n.type.slice(1)) : 'Symbol';
            const symId = `s:sym_${cleanPath.replace(/[^a-zA-Z0-9_]/g, '_')}_${n.label.replace(/[^a-zA-Z0-9_]/g, '_')}`;
            this.addTriple({ s: symId, p: 'rdf:type', o: `s:${typeCap}` });
            this.addTriple({ s: symId, p: 's:name', o: `"${n.label.replace(/"/g, "'")}"` });
            this.addTriple({ s: symId, p: 's:path', o: `"${cleanPath}"` });
            this.addTriple({ s: fileNodeId, p: 's:contains', o: symId });

            if (n.signature) {
                this.addTriple({ s: symId, p: 's:signature', o: JSON.stringify(n.signature) });
            }
            if (n.docstring) {
                this.addTriple({ s: symId, p: 's:docstring', o: JSON.stringify(n.docstring.replace(/[\r\n]+/g, ' ')) });
            }
        }

        for (const e of edges) {
            const src = e.source.startsWith('s:') ? e.source : `s:${e.source}`;
            const trg = e.target.startsWith('s:') ? e.target : `s:${e.target}`;
            const rel = e.label.startsWith('s:') ? e.label : `s:${e.label}`;
            this.addTriple({ s: src, p: rel, o: trg });
        }

        await this.saveGraph(workspaceFolder);
    }

    /**
     * Executes SPARQL-lite queries over the unified graph.
     */
    public async executeSparql(query: string, workspaceFolder?: vscode.WorkspaceFolder): Promise<string> {
        await this.initializeGraph(workspaceFolder);

        const cleanQuery = query.replace(/#.*/g, '').trim();
        const selectMatch = cleanQuery.match(/SELECT\s+(DISTINCT\s+)?([\?\*\w\s]+)\s+WHERE\s*\{([\s\S]+?)\}(?:\s*LIMIT\s+(\d+))?/i);
        const askMatch = cleanQuery.match(/ASK\s+WHERE\s*\{([\s\S]+?)\}/i);

        if (!selectMatch && !askMatch) {
            return `### ❌ SPARQL Query Error\nSupported syntax: \`SELECT ?var WHERE { ?s ?p ?o . }\` or \`ASK WHERE { ... }\`.\nQuery: \`\`\`sparql\n${query}\n\`\`\``;
        }

        const whereClause = selectMatch ? selectMatch[3].trim() : askMatch![1].trim();
        const statements = whereClause.split(/\s*\.\s*(?=(?:[^"']*["'][^"']*["'])*[^"']*$)/).filter(s => s.trim().length > 0);

        const triplePatterns: GraphTriple[] = [];
        const filters: string[] = [];

        for (const stmt of statements) {
            const trimmed = stmt.trim();
            const fMatch = trimmed.match(/^FILTER\s*\(([\s\S]+)\)$/i);
            if (fMatch) {
                filters.push(fMatch[1].trim());
            } else {
                const parts = trimmed.split(/\s+/);
                if (parts.length >= 3) {
                    let s = parts[0];
                    let p = parts[1];
                    let o = parts.slice(2).join(' ');
                    if (p === 'a') p = 'rdf:type';
                    triplePatterns.push({ s, p, o });
                }
            }
        }

        const matchTerm = (actual: string, queryTerm: string): boolean => {
            if (!actual || !queryTerm) return false;
            const cleanA = actual.replace(/^s:/i, '').replace(/['"]/g, '').toLowerCase().trim();
            const cleanQ = queryTerm.replace(/^s:/i, '').replace(/['"]/g, '').toLowerCase().trim();
            return cleanA === cleanQ;
        };

        let solutions: Record<string, string>[] = [{}];

        for (const pattern of triplePatterns) {
            const nextSolutions: Record<string, string>[] = [];

            for (const binding of solutions) {
                const sBound = pattern.s.startsWith('?') ? binding[pattern.s] : pattern.s;
                const pBound = pattern.p.startsWith('?') ? binding[pattern.p] : pattern.p;
                const oBound = pattern.o.startsWith('?') ? binding[pattern.o] : pattern.o;

                for (const t of this.triples) {
                    const sMatch = !sBound || matchTerm(t.s, sBound);
                    const pMatch = !pBound || matchTerm(t.p, pBound);
                    const oMatch = !oBound || matchTerm(t.o, oBound);

                    if (sMatch && pMatch && oMatch) {
                        const newBinding = { ...binding };
                        if (pattern.s.startsWith('?') && !binding[pattern.s]) newBinding[pattern.s] = t.s;
                        if (pattern.p.startsWith('?') && !binding[pattern.p]) newBinding[pattern.p] = t.p;
                        if (pattern.o.startsWith('?') && !binding[pattern.o]) newBinding[pattern.o] = t.o;
                        nextSolutions.push(newBinding);
                    }
                }
            }
            solutions = nextSolutions;
            if (solutions.length === 0) break;
        }

        // Apply filters
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

        if (solutions.length === 0) {
            return `### 🔍 SPARQL Query Results\n*(0 matches found across ${this.triples.length} triples)*`;
        }

        const selectStr = selectMatch![2].trim();
        const vars = selectStr === '*' 
            ? Object.keys(solutions[0])
            : selectStr.split(/\s+/).filter(v => v.startsWith('?'));

        let table = `### 🔍 SPARQL Query Results (${solutions.length} matches)\n\n`;
        table += `| ${vars.map(v => `**${v}**`).join(' | ')} |\n`;
        table += `| ${vars.map(() => '---').join(' | ')} |\n`;

        for (const sol of solutions.slice(0, 50)) {
            const row = vars.map(v => {
                const val = sol[v] || '(null)';
                return val.replace(/^"|"$/g, '');
            });
            table += `| ${row.join(' | ')} |\n`;
        }

        return table;
    }

    /**
     * Extracts Cytoscape-compatible high-level graph elements (nodes & edges)
     * representing the ontology: Files, Classes, Functions, Insights, Topics, and their links.
     */
    public async getHighLevelGraphElements(workspaceFolder?: vscode.WorkspaceFolder): Promise<{ nodes: any[]; edges: any[] }> {
        await this.initializeGraph(workspaceFolder);

        const nodesMap = new Map<string, any>();
        const edgesList: any[] = [];
        const { isPathBlockedFromGraph } = require('./codeGraphManager');

        // 1. Scan triples for individuals
        const tboxClasses = new Set([
            's:SoftwareArtifact', 's:SourceFile', 's:CodeEntity', 's:ClassDefinition',
            's:InterfaceDefinition', 's:FunctionDefinition', 's:MethodDefinition',
            's:ExternalLibrary', 's:ArchitecturalInsight', 's:TopicTag',
            's:containsEntity', 's:importsModule', 's:invokesFunction', 's:inheritsFrom',
            's:explainsArtifact', 's:hasTopic', 's:name', 's:filePath', 's:startLine',
            's:signature', 's:docstring', 's:linesCount', 's:insightText', 's:timestamp',
            'owl:Class', 'owl:ObjectProperty', 'owl:DatatypeProperty', 'rdfs:Class', 'rdf:Property'
        ]);

        for (const t of this.triples) {
            if (tboxClasses.has(t.s) || tboxClasses.has(t.o)) {
                if (t.p === 'rdf:type' && (t.o === 'owl:Class' || t.o === 'owl:ObjectProperty' || t.o === 'owl:DatatypeProperty' || t.o === 'rdfs:Class')) {
                    continue;
                }
            }

            const sId = t.s;
            if (!nodesMap.has(sId)) {
                nodesMap.set(sId, {
                    id: sId,
                    label: sId.replace(/^s:/, '').replace(/^[a-z]+_/i, ''),
                    type: 'entity'
                });
            }

            if (t.p === 'rdf:type') {
                const rawType = t.o.replace(/^s:/, '');
                let simplifiedType = 'entity';
                if (rawType.includes('SourceFile') || rawType === 'File') simplifiedType = 'file';
                else if (rawType.includes('Class')) simplifiedType = 'class';
                else if (rawType.includes('Interface')) simplifiedType = 'interface';
                else if (rawType.includes('Function')) simplifiedType = 'function';
                else if (rawType.includes('Method')) simplifiedType = 'method';
                else if (rawType.includes('Library')) simplifiedType = 'library';
                else if (rawType.includes('Insight')) simplifiedType = 'insight';
                else if (rawType.includes('Topic')) simplifiedType = 'topic';
                nodesMap.get(sId)!.type = simplifiedType;
            } else if (t.p === 's:name' || t.p === 's:topicName' || t.p === 's:label') {
                nodesMap.get(sId)!.label = t.o.replace(/^"|"$/g, '');
            } else if (t.p === 's:filePath' || t.p === 's:path') {
                const pathVal = t.o.replace(/^"|"$/g, '');
                if (isPathBlockedFromGraph(pathVal)) {
                    nodesMap.delete(sId);
                    continue;
                }
                nodesMap.get(sId)!.filePath = pathVal;
                nodesMap.get(sId)!.label = path.basename(pathVal) || pathVal;
            }
        }

        // Secondary cleanup: remove any node whose path is blocked
        for (const [id, node] of nodesMap.entries()) {
            if (node.filePath && isPathBlockedFromGraph(node.filePath)) {
                nodesMap.delete(id);
            }
        }

        // 2. Scan relationships
        const relProps = new Set([
            's:containsEntity', 's:contains',
            's:importsModule', 's:imports',
            's:invokesFunction', 's:calls',
            's:inheritsFrom', 's:inherits',
            's:explainsArtifact', 's:explains',
            's:hasTopic'
        ]);

        for (const t of this.triples) {
            if (relProps.has(t.p)) {
                const targetId = t.o.startsWith('s:') ? t.o : `s:${t.o}`;
                if (nodesMap.has(t.s) && nodesMap.has(targetId)) {
                    let friendlyLabel = t.p.replace(/^s:/, '');
                    if (friendlyLabel === 'containsEntity') friendlyLabel = 'contains';
                    else if (friendlyLabel === 'importsModule') friendlyLabel = 'imports';
                    else if (friendlyLabel === 'invokesFunction') friendlyLabel = 'calls';
                    else if (friendlyLabel === 'inheritsFrom') friendlyLabel = 'inherits';
                    else if (friendlyLabel === 'explainsArtifact') friendlyLabel = 'explains';

                    edgesList.push({
                        id: `edge_${t.s}_${friendlyLabel}_${targetId}`.replace(/[^a-zA-Z0-9_]/g, '_'),
                        source: t.s,
                        target: targetId,
                        label: friendlyLabel
                    });
                }
            }
        }

        let allNodes = Array.from(nodesMap.values());

        // Fail-safe: If graph is empty, load active context files from workspace
        if (allNodes.length <= 1) {
            const folder = workspaceFolder || vscode.workspace.workspaceFolders?.[0];
            if (folder) {
                try {
                    const findUris = await vscode.workspace.findFiles(
                        new vscode.RelativePattern(folder, '**/*.{ts,js,py,vue,cs,cpp}'),
                        '**/{node_modules,venv,.venv,dist,build,out,data,data_workspace,.lollms}/**',
                        30
                    );
                    findUris.forEach(u => {
                        const rel = path.relative(folder.uri.fsPath, u.fsPath).replace(/\\/g, '/');
                        if (!isPathBlockedFromGraph(rel)) {
                            const id = `s:file_${rel.replace(/[^a-zA-Z0-9_]/g, '_')}`;
                            if (!nodesMap.has(id)) {
                                nodesMap.set(id, {
                                    id,
                                    label: path.basename(rel),
                                    type: 'file',
                                    filePath: rel
                                });
                            }
                        }
                    });
                    allNodes = Array.from(nodesMap.values());
                } catch {}
            }
        }

        return {
            nodes: allNodes.slice(0, 80),
            edges: edgesList.slice(0, 150)
        };
    }

    /**
     * Renders a high-level, compact Knowledge Graph summary for prompt grounding.
     * Informs the model about the graph structure and provides instructions on how
     * to deepen understanding via SPARQL queries.
     */
    public async renderContextKnowledge(workspaceFolder?: vscode.WorkspaceFolder): Promise<string> {
        await this.initializeGraph(workspaceFolder);
        if (this.triples.length === 0) return "";

        // Tally high-level entities
        let fileCount = 0;
        let classCount = 0;
        let funcCount = 0;
        const topicSet = new Set<string>();
        const insightMap = new Map<string, { topic: string; text: string; files: string[]; hashtags: string[] }>();

        for (const t of this.triples) {
            if (t.p === 'rdf:type') {
                if (t.o === 's:File') fileCount++;
                else if (t.o === 's:Class') classCount++;
                else if (t.o === 's:Function') funcCount++;
            }
            if (t.p === 's:hasTopic') {
                topicSet.add(t.o.replace(/^s:topic_/, ''));
            }
            if (t.s.startsWith('s:insight_')) {
                if (!insightMap.has(t.s)) {
                    insightMap.set(t.s, { topic: '', text: '', files: [], hashtags: [] });
                }
                const entry = insightMap.get(t.s)!;
                if (t.p === 's:topicName') entry.topic = t.o.replace(/^"|"$/g, '');
                if (t.p === 's:insightText') {
                    try { entry.text = JSON.parse(t.o); } catch { entry.text = t.o.replace(/^"|"$/g, ''); }
                }
                if (t.p === 's:relatesTo') entry.files.push(t.o.replace(/^s:file_/, '').replace(/_/g, '/'));
                if (t.p === 's:hasTopic') entry.hashtags.push('#' + t.o.replace(/^s:topic_/, ''));
            }
        }

        const recentInsights = Array.from(insightMap.values()).reverse().slice(0, 5);

        let output = `### 🕸️ KNOWLEDGE GRAPH TOP-LEVEL TOPOLOGY (.lollms/knowledge.ttl)\n`;
        output += `- **Entities**: ${fileCount} Files · ${classCount} Classes · ${funcCount} Functions · ${insightMap.size} Architectural Insights · ${topicSet.size} Topics\n`;
        if (topicSet.size > 0) {
            output += `- **Indexed Topics**: ${Array.from(topicSet).slice(0, 10).map(t => `#${t}`).join(' ')}\n`;
        }
        output += `\n> 💡 **SPARQL Deepening Protocol**: This is a high-level graph projection. When you need deeper contracts, function signatures, caller/callee relations, or deeper insight contents, query the ontology with: \`<query_architecture>SELECT ?func ?doc WHERE { ?class s:contains ?func . ?func s:docstring ?doc } ...</query_architecture>\`.\n\n`;

        if (recentInsights.length > 0) {
            output += `#### 🧠 Key Architectural Insights:\n`;
            for (const ins of recentInsights) {
                const filesPart = ins.files.length > 0 ? ` [Files: ${ins.files.map(f => `\`${f}\``).join(', ')}]` : '';
                output += `- **${ins.topic}** ${ins.hashtags.join(' ')}${filesPart}\n`;
                if (ins.text) {
                    const snippet = ins.text.length > 250 ? ins.text.substring(0, 240) + '...' : ins.text;
                    output += `  > ${snippet.replace(/\n+/g, ' ')}\n`;
                }
            }
        }

        return output.trim();
    }

    public async readRootKnowledge(workspaceFolder?: vscode.WorkspaceFolder): Promise<string> {
        return await this.renderContextKnowledge(workspaceFolder);
    }

    public async readSectionKnowledge(sectionPath: string, workspaceFolder?: vscode.WorkspaceFolder): Promise<string> {
        await this.initializeGraph(workspaceFolder);
        const cleanSection = sectionPath.replace(/^#/, '').trim().toLowerCase();
        for (const t of this.triples) {
            if (t.s.startsWith('s:insight_') && t.p === 's:topicName') {
                const topicVal = t.o.replace(/^"|"$/g, '').toLowerCase();
                if (topicVal === cleanSection || topicVal.includes(cleanSection)) {
                    const textTriple = this.triples.find(tr => tr.s === t.s && tr.p === 's:insightText');
                    if (textTriple) {
                        try {
                            return JSON.parse(textTriple.o);
                        } catch {
                            return textTriple.o.replace(/^"|"$/g, '');
                        }
                    }
                }
            }
        }
        return "";
    }

    public async incrementAccessCount(_sectionPath: string): Promise<number> {
        return 1;
    }

    public async updateKnowledge(sectionPath: string, content: string, workspaceFolder?: vscode.WorkspaceFolder): Promise<void> {
        const topic = sectionPath.trim() || 'Architecture Knowledge';
        await this.recordInsight(topic, content, [], ['#architecture', '#knowledge'], workspaceFolder);
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