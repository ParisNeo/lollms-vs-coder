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
    description: "Retrieves the exact implementation source code of a specified symbol (function, method, class, interface, etc.) without reading the entire file. Call using 'target' (e.g. 'path/to/file.py:function_name' or 'path/to/file.ts:ClassName:methodName') or separate path and symbol parameters.",
    isAgentic: true,
    isDefault: true,
    permissionGroup: 'filesystem_read',
    parameters: [
        { 
            name: "target", 
            type: "string", 
            description: "The file path and symbol identifier separated by colon, e.g. 'src/utils.ts:myFunction' or 'app/models.py:User:get_by_id'.", 
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
            description: "The symbol name or member path (e.g. 'function_name' or 'ClassName:method_name') if not specified in target.", 
            required: false 
        }
    ],
    async execute(params: { target?: string; path?: string; symbol?: string; file?: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        const rawTarget = (params.target || params.path || params.file || "").trim();
        let filePath = "";
        let symbolParts: string[] = [];

        // 1. Parse target / path / symbol parameters
        if (rawTarget.includes(':') && !/^[a-zA-Z]:[\\/]/.test(rawTarget)) {
            const parts = rawTarget.split(':');
            filePath = parts[0].trim();
            symbolParts = parts.slice(1).map(p => p.trim()).filter(Boolean);
        } else {
            filePath = rawTarget;
            if (params.symbol) {
                symbolParts = params.symbol.split(':').map(p => p.trim()).filter(Boolean);
            }
        }

        if (filePath.startsWith('/') || filePath.startsWith('\\')) {
            filePath = filePath.substring(1);
        }

        if (!filePath) {
            return { success: false, output: "Error: File path is required in 'target' or 'path' parameter." };
        }

        if (symbolParts.length === 0) {
            return { success: false, output: `Error: Symbol name is required. Specify target as 'path/to/file.ext:symbol_name' or provide the 'symbol' parameter.` };
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

        let matchedRange: vscode.Range | null = null;

        // 2. Try Language Server AST symbols provider first
        try {
            const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', resolution.uri);
            if (symbols && symbols.length > 0) {
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

                const matched = findHierarchical(symbols, 0);
                if (matched) {
                    matchedRange = matched.range;
                }
            }
        } catch {}

        // 3. Fallback: Fast AST/indentation text scanner
        if (!matchedRange) {
            matchedRange = findSymbolInDocumentText(document, symbolParts);
        }

        if (!matchedRange) {
            return { 
                success: false, 
                output: `Error: Symbol '${symbolParts.join(':')}' was not found in '${filePath}'. Check the exact symbol name or inspect the file outline.` 
            };
        }

        // Expand range to start of line to capture full indentation
        const startLine = matchedRange.start.line;
        const endLine = matchedRange.end.line;
        const fullSymbolRange = new vscode.Range(new vscode.Position(startLine, 0), matchedRange.end);
        const symbolCode = document.getText(fullSymbolRange);
        const lineCount = endLine - startLine + 1;
        const lang = document.languageId || path.extname(filePath).substring(1) || 'plaintext';

        return {
            success: true,
            output: `### 📄 Symbol Code: \`${symbolParts.join(':')}\` in \`${filePath}\` (Lines ${startLine + 1}–${endLine + 1}, ${lineCount} lines)\n\`\`\`${lang}\n${symbolCode}\n\`\`\``
        };
    }
};