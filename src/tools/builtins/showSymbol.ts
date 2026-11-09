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

export const showSymbolTool: ToolDefinition = {
    name: "show_symbol",
    description: "Retrieves the exact implementation source code of one or more specified symbols (functions, methods, classes, interfaces, etc.) from a file without loading the entire file. You can request multiple symbols at once separated by commas or in the 'symbols' list (e.g. 'path/to/file.py:funcA, funcB' or path='file.py' symbols='funcA, funcB').",
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
            description: "List or comma-separated string of symbol names to retrieve from the file at once.", 
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

        // 1. Parse target / path / symbol / symbols parameters
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

        let document: vscode.TextDocument;
        try {
            document = await vscode.workspace.openTextDocument(resolution.uri);
        } catch (err: any) {
            return { success: false, output: `Error reading '${filePath}': ${err.message}` };
        }

        // Try Language Server AST symbols provider once for the file
        let docSymbols: vscode.DocumentSymbol[] | undefined;
        try {
            docSymbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', resolution.uri);
        } catch {}

        const lang = document.languageId || path.extname(filePath).substring(1) || 'plaintext';
        const outputs: string[] = [];
        let successCount = 0;

        for (const rawSym of symbolsList) {
            const symbolParts = rawSym.split(':').map(p => p.trim()).filter(Boolean);
            if (symbolParts.length === 0) continue;

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

            if (matchedRange) {
                successCount++;
                const startLine = matchedRange.start.line;
                const endLine = matchedRange.end.line;
                const fullSymbolRange = new vscode.Range(new vscode.Position(startLine, 0), matchedRange.end);
                const symbolCode = document.getText(fullSymbolRange);
                const lineCount = endLine - startLine + 1;

                outputs.push(`### 📄 Symbol Code: \`${symbolParts.join(':')}\` in \`${filePath}\` (Lines ${startLine + 1}–${endLine + 1}, ${lineCount} lines)\n\`\`\`${lang}\n${symbolCode}\n\`\`\``);
            } else {
                outputs.push(`⚠️ Symbol '${symbolParts.join(':')}' was not found in '${filePath}'.`);
            }
        }

        if (successCount === 0) {
            return {
                success: false,
                output: outputs.join('\n\n')
            };
        }

        return {
            success: true,
            output: outputs.join('\n\n')
        };
    }
};