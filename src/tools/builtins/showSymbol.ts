import * as vscode from 'vscode';
import * as path from 'path';
import { ToolDefinition, ToolExecutionEnv } from '../tool';

function normalizeSymbolIdentifier(raw: string): string {
    return raw
        .replace(/^(?:export\s+|default\s+|declare\s+|async\s+|public\s+|private\s+|protected\s+|static\s+|readonly\s+|override\s+|get\s+|set\s+|function\s+|class\s+|def\s+|fn\s+)+/gi, '')
        .split('(')[0]
        .split('<')[0]
        .split(':')[0]
        .split('=')[0]
        .replace(/^#/, '')
        .trim()
        .toLowerCase();
}

function findSymbolInDocumentText(document: vscode.TextDocument, targetMember: string[]): vscode.Range | null {
    const isPython = document.languageId === 'python';
    const lineCount = document.lineCount;
    const targetLeaf = targetMember[targetMember.length - 1].trim();
    const targetParent = targetMember.length > 1 ? targetMember[0].trim() : null;

    let searchStartLine = 0;
    let searchEndLine = lineCount;

    if (targetParent) {
        const parentRegex = isPython
            ? new RegExp(`^(\\s*)class\\s+${targetParent}\\b`)
            : new RegExp(`^(\\s*)(?:export\\s+)?(?:abstract\\s+)?class\\s+${targetParent}\\b`);

        for (let i = 0; i < lineCount; i++) {
            const lineText = document.lineAt(i).text;
            const m = lineText.match(parentRegex);
            if (m) {
                searchStartLine = i;
                if (isPython) {
                    const classIndent = m[1].length;
                    searchEndLine = lineCount;
                    for (let j = i + 1; j < lineCount; j++) {
                        const curText = document.lineAt(j).text;
                        if (curText.trim().length === 0 || curText.trim().startsWith('#')) continue;
                        const curIndent = curText.match(/^\s*/)?.[0].length || 0;
                        if (curIndent <= classIndent) {
                            searchEndLine = j;
                            break;
                        }
                    }
                }
                break;
            }
        }
    }

    const escapedLeaf = targetLeaf.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pythonDefRegex = new RegExp(`^(\\s*)(?:async\\s+)?(?:def|class)\\s+${escapedLeaf}\\b`);
    const jsMethodRegex = new RegExp(`^(\\s*)(?:(?:public|private|protected|static|readonly|async|get|set|override)\\s+)*(?:function\\s+)?${escapedLeaf}\\s*(?:=\\s*(?:async\\s*)?\\([^)]*\\)\\s*=>|\\()`);
    const jsVarFuncRegex = new RegExp(`^(\\s*)(?:export\\s+)?(?:const|let|var)\\s+${escapedLeaf}\\s*=\\s*`);
    const generalDeclRegex = new RegExp(`\\b${escapedLeaf}\\s*(?:=|\\(|:)`);

    let declLineIdx = -1;
    let startLineIdx = -1;
    let baseIndent = 0;

    for (let i = searchStartLine; i < searchEndLine; i++) {
        const lineText = document.lineAt(i).text;
        const trimmed = lineText.trim();
        if (trimmed.length === 0 || trimmed.startsWith('//') || (isPython && trimmed.startsWith('#'))) continue;

        const isMatch = isPython
            ? (pythonDefRegex.test(lineText) || new RegExp(`^(\\s*)(?:def|class)\\s+${escapedLeaf}\\b`).test(lineText))
            : (jsMethodRegex.test(lineText) || jsVarFuncRegex.test(lineText) || generalDeclRegex.test(lineText));

        if (isMatch) {
            declLineIdx = i;
            baseIndent = lineText.match(/^\s*/)?.[0].length || 0;
            startLineIdx = i;

            let backtrack = i - 1;
            while (backtrack >= searchStartLine) {
                const prevText = document.lineAt(backtrack).text.trim();
                if (prevText.startsWith('@') || prevText.startsWith('/**') || prevText.startsWith('*') || prevText.startsWith('//')) {
                    startLineIdx = backtrack;
                    backtrack--;
                } else {
                    break;
                }
            }
            break;
        }
    }

    if (declLineIdx === -1) return null;

    let endLineIdx = declLineIdx;

    if (isPython) {
        for (let j = declLineIdx + 1; j < searchEndLine; j++) {
            const curText = document.lineAt(j).text;
            if (curText.trim().length === 0) {
                endLineIdx = j;
                continue;
            }
            const curIndent = curText.match(/^\s*/)?.[0].length || 0;
            if (curIndent <= baseIndent && !curText.trim().startsWith('#')) {
                break;
            }
            endLineIdx = j;
        }
    } else {
        let braceCount = 0;
        let foundFirstBrace = false;
        for (let j = declLineIdx; j < searchEndLine; j++) {
            const lineText = document.lineAt(j).text;
            for (const ch of lineText) {
                if (ch === '{') {
                    braceCount++;
                    foundFirstBrace = true;
                } else if (ch === '}') {
                    braceCount--;
                }
            }
            endLineIdx = j;
            if (foundFirstBrace && braceCount <= 0) {
                break;
            }
        }
    }

    const startPos = document.lineAt(startLineIdx).range.start;
    const endPos = document.lineAt(endLineIdx).range.end;
    return new vscode.Range(startPos, endPos);
}

/**
 * Locate and extract a symbol's implementation source from an already-opened document.
 * Used both by the show_symbol tool (to validate) and by the context renderer
 * (to build the placeholder-based partial-file display).
 */
export interface SymbolExtractionResult {
    found: boolean;
    range?: vscode.Range;
    code?: string;
    languageId?: string;
}

export async function extractSymbolFromDocument(
    document: vscode.TextDocument,
    symbolParts: string[] = [],
    docSymbols?: vscode.DocumentSymbol[]
): Promise<SymbolExtractionResult> {
    if (!symbolParts || symbolParts.length === 0) return { found: false };

    let matchedRange: vscode.Range | null = null;

    if (docSymbols && docSymbols.length > 0) {
        const findHierarchical = (syms: vscode.DocumentSymbol[], pathIdx: number): vscode.DocumentSymbol | null => {
            const targetName = symbolParts[pathIdx].toLowerCase();
            const targetNorm = normalizeSymbolIdentifier(symbolParts[pathIdx]);

            for (const s of syms) {
                const sNorm = normalizeSymbolIdentifier(s.name);
                const sClean = s.name.split('(')[0].split('<')[0].split(':')[0].trim().toLowerCase();

                const isMatch = sNorm === targetNorm || sClean === targetName || sClean.endsWith('.' + targetName) || sClean.endsWith('::' + targetName);
                if (isMatch) {
                    if (pathIdx === symbolParts.length - 1) {
                        return s;
                    }
                    if (s.children && s.children.length > 0) {
                        const childMatch = findHierarchical(s.children, pathIdx + 1);
                        if (childMatch) return childMatch;
                    }
                }
            }

            if (pathIdx === 0 && symbolParts.length === 1) {
                for (const s of syms) {
                    if (s.children && s.children.length > 0) {
                        const found = findHierarchical(s.children, 0);
                        if (found) return found;
                    }
                }
            }
            return null;
        };

        const matched = findHierarchical(docSymbols, 0);
        if (matched) {
            matchedRange = matched.range;
        }
    }

    if (!matchedRange) {
        matchedRange = findSymbolInDocumentText(document, symbolParts);
    }

    if (!matchedRange) return { found: false };

    const startLine = matchedRange.start.line;
    const fullRange = new vscode.Range(new vscode.Position(startLine, 0), matchedRange.end);
    const code = document.getText(fullRange);

    return {
        found: true,
        range: matchedRange,
        code,
        languageId: document.languageId
    };
}

/**
 * Best-effort unmute of the target file within the active discussion so the
 * newly-expanded symbol becomes visible on the next context build.
 */
async function attemptUnmuteFile(env: ToolExecutionEnv, uri: vscode.Uri, filePath: string): Promise<void> {
    try {
        const agent: any = (env as any).agentManager;
        if (!agent) return;

        let disc: any = null;
        const panel = agent.panel || agent._panel;
        if (panel && typeof panel.getCurrentDiscussion === 'function') {
            disc = panel.getCurrentDiscussion();
        } else if (typeof agent.getCurrentDiscussion === 'function') {
            disc = agent.getCurrentDiscussion();
        } else if (agent.discussion) {
            disc = agent.discussion;
        }

        if (!disc || !Array.isArray(disc.mutedFiles) || disc.mutedFiles.length === 0) return;

        const cleanPath = (p: string) => p.replace(/\\/g, '/').toLowerCase().trim().replace(/^\.?\/+/, '');
        const isMatch = (a: string, b: string) => {
            const ca = cleanPath(a);
            const cb = cleanPath(b);
            return ca === cb || ca.endsWith('/' + cb) || cb.endsWith('/' + ca);
        };

        const before = disc.mutedFiles.length;
        disc.mutedFiles = disc.mutedFiles.filter((m: string) =>
            !isMatch(m, filePath) && !isMatch(m, uri.fsPath)
        );

        if (disc.mutedFiles.length === before) return;

        if (disc.capabilities && Array.isArray(disc.capabilities.mutedFiles)) {
            disc.capabilities.mutedFiles = [...disc.mutedFiles];
        }

        const dm = agent.discussionManager || agent._discussionManager;
        if (dm && typeof dm.saveDiscussion === 'function') {
            await dm.saveDiscussion(disc);
        }
    } catch {
        // Swallow — state mutation was already applied, unmute is optional polish.
    }
}

export const showSymbolTool: ToolDefinition = {
    name: "show_symbol",
    description: "Expands specific symbol(s) (functions, methods, classes, interfaces, etc.) from a file into the CONTEXT file view WITHOUT dumping their code into chat history. On the next model turn, the file's context block will display the requested implementation(s) inline in their file-relative positions (surrounded by '...' placeholder regions for the rest of the file). Call this ONCE per symbol; do NOT re-call for symbols you have already expanded. If the file is already fully loaded [C] you will be told you already possess it — no action taken.",
    isAgentic: true,
    isDefault: true,
    permissionGroup: 'filesystem_read',
    parameters: [
        {
            name: "target",
            type: "string",
            description: "The file path and symbol identifier(s) separated by colon, e.g. 'src/utils.ts:myFunction' or 'app/models.py:User:get_by_id, User:save'.",
            required: false
        },
        {
            name: "path",
            type: "string",
            description: "The relative workspace file path if not specified in target.",
            required: false
        },
        {
            name: "symbol",
            type: "string",
            description: "Single symbol name or comma-separated symbol names (e.g. 'function_name' or 'funcA, funcB').",
            required: false
        },
        {
            name: "symbols",
            type: "array",
            description: "List or comma-separated string of symbol names to expand into context at once.",
            required: false
        }
    ],
    async execute(params: { target?: string; path?: string; symbol?: string; symbols?: string | string[]; file?: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        const rawTarget = (params.target || params.path || params.file || "").trim();
        let filePath = "";
        const symbolsList: string[] = [];

        const addSym = (s: string) => {
            const clean = s.trim().replace(/^['"`]|['"`]$/g, '').trim();
            if (clean && !symbolsList.includes(clean)) symbolsList.push(clean);
        };

        if (rawTarget.includes(':') && !/^[a-zA-Z]:[\\/]/.test(rawTarget)) {
            const colonIdx = rawTarget.indexOf(':');
            filePath = rawTarget.substring(0, colonIdx).trim();
            rawTarget.substring(colonIdx + 1).split(/[\r\n,;]+/).forEach(addSym);
        } else {
            filePath = rawTarget;
        }

        if (params.symbol) {
            params.symbol.split(/[\r\n,;]+/).forEach(addSym);
        }

        if (params.symbols) {
            if (Array.isArray(params.symbols)) {
                params.symbols.forEach(s => String(s).split(/[\r\n,;]+/).forEach(addSym));
            } else if (typeof params.symbols === 'string') {
                params.symbols.split(/[\r\n,;]+/).forEach(addSym);
            }
        }

        if (filePath.startsWith('/') || filePath.startsWith('\\')) {
            filePath = filePath.substring(1);
        }

        if (!filePath) {
            return { success: false, output: "Error: File path is required in 'target' or 'path' parameter." };
        }

        if (symbolsList.length === 0) {
            return { success: false, output: `Error: At least one symbol name is required. Specify target as 'path/to/file.ext:symbol_name' or provide the 'symbol' / 'symbols' parameter.` };
        }

        const resolution = await env.contextManager.resolveWorkspaceFromPath(filePath);
        if (!resolution) {
            return { success: false, output: `Error: File '${filePath}' not found on disk.` };
        }

        if (signal.aborted) {
            return { success: false, output: "Operation cancelled." };
        }

        const provider = env.contextManager.getContextStateProvider();
        if (!provider) {
            return { success: false, output: "Error: Context state provider is unavailable. Cannot expand symbol into context." };
        }

        // Read current context state — determines transition
        let currentState: any = 'tree-only';
        try {
            currentState = provider.getStateForUri(resolution.uri);
        } catch {
            // Keep default
        }

        // CASE 1: full file already loaded — warn and stop.
        if (currentState === 'included') {
            return {
                success: true,
                output: `ℹ️ File '${filePath}' is ALREADY loaded with full content in context [C]. You already possess every symbol in this file. No action taken — re-requesting is not needed.`
            };
        }

        // Load the document to validate that the requested symbols actually exist
        let document: vscode.TextDocument;
        try {
            document = await vscode.workspace.openTextDocument(resolution.uri);
        } catch (err: any) {
            return { success: false, output: `Error reading '${filePath}': ${err.message}` };
        }

        let docSymbols: vscode.DocumentSymbol[] | undefined;
        try {
            docSymbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', resolution.uri);
        } catch {}

        const validSymbols: string[] = [];
        const notFoundSymbols: string[] = [];

        for (const rawSym of symbolsList) {
            const parts = rawSym.split(':').map(p => p.trim()).filter(Boolean);
            if (parts.length === 0) continue;
            const res = await extractSymbolFromDocument(document, parts, docSymbols);
            if (res.found) {
                validSymbols.push(rawSym);
            } else {
                notFoundSymbols.push(rawSym);
            }
        }

        if (validSymbols.length === 0) {
            return {
                success: false,
                output: `❌ No valid symbols found in '${filePath}'.\n${notFoundSymbols.map(s => `• '${s}' not found.`).join('\n')}`
            };
        }

        // Determine the new symbol-state (merge with any already-expanded symbols)
        let existingSymbols: string[] = [];
        if (typeof currentState === 'string' && currentState.startsWith('symbols:')) {
            existingSymbols = currentState.substring(8).split(',').map((s: string) => s.trim()).filter(Boolean);
        }

        const merged = [...existingSymbols];
        const alreadyExpanded: string[] = [];
        for (const sym of validSymbols) {
            if (merged.some(s => s.toLowerCase() === sym.toLowerCase())) {
                alreadyExpanded.push(sym);
            } else {
                merged.push(sym);
            }
        }

        const newState = `symbols:${merged.join(', ')}` as any;

        try {
            await provider.setStateForUri(resolution.uri, newState);
        } catch (e: any) {
            return { success: false, output: `Failed to update file context state: ${e.message}` };
        }

        // Best-effort unmute if the file is currently muted in the active discussion
        await attemptUnmuteFile(env, resolution.uri, filePath);

        // Compose a concise confirmation (this is what lands in chat history — keep tight)
        let transitionLabel = 'File added to context in symbol-focused view.';
        if (typeof currentState === 'string' && currentState.startsWith('symbols:')) {
            transitionLabel = 'Symbol implementation uncompressed under the existing symbol-focused context view.';
        } else if (currentState === 'definitions-only' || currentState === 'structure') {
            transitionLabel = 'File upgraded from structure-only [D] to symbol-focused context view.';
        }

        const lines: string[] = [
            `✅ ${transitionLabel}`,
            `📁 File: ${filePath}`,
            `🔓 Expanded symbol(s): ${validSymbols.join(', ')}`
        ];

        if (alreadyExpanded.length > 0) {
            lines.push(`ℹ️ Already expanded in context (no-op): ${alreadyExpanded.join(', ')}`);
        }

        lines.push('');
        lines.push(`On your next turn, this file's context block will render the requested implementation(s) inline in their file-relative positions — the rest of the file is collapsed with "..." placeholders. Indentation is preserved verbatim so you can produce accurate patches. Do NOT call show_symbol again for these symbols; inspect the file block in context instead.`);

        if (notFoundSymbols.length > 0) {
            lines.push('');
            lines.push(`⚠️ Not found in file (skipped): ${notFoundSymbols.join(', ')}`);
        }

        lines.push('');
        lines.push(`If this file was muted in the current discussion and still does not appear on your next turn, output \`<unmute_files>\\n${filePath}\\n</unmute_files>

\` once.`);

        return { success: true, output: lines.join('\n') };
    }
};