import * as vscode from 'vscode';
import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const updateFunctionTool: ToolDefinition = {
    name: "update_function",
    description: "Surgically replaces the body of a specific function, method, or class. Does not require Aider blocks. Best for refactoring known symbols.",
    isAgentic: true,
    isDefault: true,
    permissionGroup: 'filesystem_write',
    parameters: [
        { name: "file_path", type: "string", description: "Namespaced path to the file.", required: true },
        { name: "symbol_name", type: "string", description: "Name of the function/method to replace.", required: true },
        { name: "new_content", type: "string", description: "The full new code for this symbol.", required: true }
    ],
    async execute(params: { file_path: string, symbol_name: string, new_content: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        const filePath = params.file_path || (params as any).filePath || (params as any).path || (params as any).file || "";
        const rawSymbol = params.symbol_name || (params as any).symbolName || (params as any).symbol || (params as any).name || (params as any).function_name || "";
        const rawContent = params.new_content || (params as any).newContent || (params as any).content || (params as any).code || (params as any).body || "";

        const ext = path.extname(filePath).toLowerCase();
        const readOnlyDocExts = new Set(['.pdf', '.docx', '.xlsx', '.xls', '.pptx', '.msg', '.odt', '.rtf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.zip', '.exe', '.bin']);
        if (readOnlyDocExts.has(ext)) {
            return { success: false, output: `🛑 READ-ONLY ARTIFACT ERROR: Cannot update symbols in document/binary file '${filePath}'. Rich documents are read-only extracted text.` };
        }

        if (!filePath) return { success: false, output: "Error: file_path parameter is required." };
        if (!rawSymbol) return { success: false, output: "Error: symbol_name parameter is required." };

        const res = await env.contextManager.resolveWorkspaceFromPath(filePath);
        if (!res) return { success: false, output: `File not found: ${filePath}` };

        const doc = await vscode.workspace.openTextDocument(res.uri);
        const text = doc.getText();
        const targetParts = String(rawSymbol).split(/[:.]/).map(p => p.trim()).filter(p => p.length > 0);
        const targetLeaf = targetParts[targetParts.length - 1];
        const targetLeafNorm = targetLeaf
            .replace(/^(?:export\s+|default\s+|declare\s+|async\s+|public\s+|private\s+|protected\s+|static\s+|readonly\s+|override\s+|get\s+|set\s+|function\s+|class\s+|def\s+|fn\s+)+/gi, '')
            .split('(')[0]
            .split('<')[0]
            .split(':')[0]
            .split('=')[0]
            .trim()
            .toLowerCase();

        // 1. Try Document Symbol Provider
        let targetRange: vscode.Range | undefined;
        try {
            const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                'vscode.executeDocumentSymbolProvider', 
                res.uri
            );

            if (symbols && symbols.length > 0) {
                const findHierarchical = (syms: vscode.DocumentSymbol[], pathIdx: number): vscode.DocumentSymbol | undefined => {
                    const targetName = targetParts[pathIdx].toLowerCase();
                    for (const s of syms) {
                        const sNorm = s.name
                            .replace(/^(?:export\s+|default\s+|declare\s+|async\s+|public\s+|private\s+|protected\s+|static\s+|readonly\s+|override\s+|get\s+|set\s+|function\s+|class\s+|def\s+|fn\s+)+/gi, '')
                            .split('(')[0]
                            .split('<')[0]
                            .split(':')[0]
                            .split('=')[0]
                            .trim()
                            .toLowerCase();
                        const sClean = s.name.split('(')[0].split('<')[0].split(':')[0].trim().toLowerCase();

                        if (sNorm === targetLeafNorm || sClean === targetName || sClean.endsWith('.' + targetName) || sClean.endsWith('::' + targetName)) {
                            if (pathIdx === targetParts.length - 1) return s;
                            if (s.children && s.children.length > 0) {
                                const childMatch = findHierarchical(s.children, pathIdx + 1);
                                if (childMatch) return childMatch;
                            }
                        }
                    }
                    if (pathIdx === 0 && targetParts.length === 1) {
                        for (const s of syms) {
                            if (s.children && s.children.length > 0) {
                                const found = findHierarchical(s.children, 0);
                                if (found) return found;
                            }
                        }
                    }
                    return undefined;
                };

                const target = findHierarchical(symbols, 0);
                if (target) {
                    targetRange = target.range;
                }
            }
        } catch {
            // Symbol provider unavailable, proceed to line/brace scanner
        }

        // 2. Line & Brace Fallback Scanner
        if (!targetRange) {
            const isPython = doc.languageId === 'python';
            const lineCount = doc.lineCount;

            const pythonDefRegex = new RegExp(`^(\\s*)(?:async\\s+)?(?:def|class)\\s+${targetLeaf}\\b`);
            const jsMethodRegex = new RegExp(`^(\\s*)(?:(?:public|private|protected|static|readonly|async|get|set|override)\\s+)*(?:function\\s+)?${targetLeaf}\\s*(?:=\\s*(?:async\\s*)?\\([^)]*\\)\\s*=>|\\()`);
            const jsVarFuncRegex = new RegExp(`^(\\s*)(?:export\\s+)?(?:const|let|var)\\s+${targetLeaf}\\s*=\\s*`);
            const generalBraceRegex = new RegExp(`\\b${targetLeaf}\\b`);

            let declLineIdx = -1;
            let startLineIdx = -1;
            let baseIndent = 0;

            for (let i = 0; i < lineCount; i++) {
                const lineText = doc.lineAt(i).text;
                const trimmed = lineText.trim();
                if (trimmed.length === 0) continue;

                const isMatch = isPython 
                    ? pythonDefRegex.test(lineText)
                    : (jsMethodRegex.test(lineText) || jsVarFuncRegex.test(lineText) || generalBraceRegex.test(lineText));

                if (isMatch) {
                    declLineIdx = i;
                    baseIndent = lineText.match(/^\s*/)?.[0].length || 0;
                    startLineIdx = i;

                    let backtrack = i - 1;
                    while (backtrack >= 0) {
                        const prevText = doc.lineAt(backtrack).text.trim();
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

            if (declLineIdx !== -1) {
                let endLineIdx = declLineIdx;
                if (isPython) {
                    for (let j = declLineIdx + 1; j < lineCount; j++) {
                        const curText = doc.lineAt(j).text;
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
                    for (let j = declLineIdx; j < lineCount; j++) {
                        const lineText = doc.lineAt(j).text;
                        for (let ch of lineText) {
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

                const startPos = doc.lineAt(startLineIdx).range.start;
                const endPos = doc.lineAt(endLineIdx).range.end;
                targetRange = new vscode.Range(startPos, endPos);
            }
        }

        if (!targetRange) {
            return { success: false, output: `Symbol '${params.symbol_name}' could not be located in ${params.file_path}.` };
        }

        // 3. Normalize indentation and line start
        const startLine = targetRange.start.line;
        const startLineText = doc.lineAt(startLine).text;
        const prefixBeforeMatch = startLineText.substring(0, targetRange.start.character);
        const existingIndent = startLineText.match(/^\s*/)?.[0] || "";

        let effectiveRange = targetRange;
        if (prefixBeforeMatch.trim() === "") {
            effectiveRange = new vscode.Range(
                new vscode.Position(startLine, 0),
                targetRange.end
            );
        }

        const newLines = params.new_content.replace(/\r\n/g, '\n').split('\n');
        const firstNonEmptyLine = newLines.find(l => l.trim().length > 0);
        const firstLineIndent = firstNonEmptyLine ? (firstNonEmptyLine.match(/^\s*/)?.[0] || "") : "";
        const targetBaseIndent = existingIndent;

        let adjustedContent = params.new_content;
        if (firstNonEmptyLine && firstLineIndent !== targetBaseIndent) {
            const indentDelta = targetBaseIndent.length - firstLineIndent.length;
            if (indentDelta > 0) {
                const addSpaces = " ".repeat(indentDelta);
                adjustedContent = newLines.map(line => line.trim().length > 0 ? addSpaces + line : line).join('\n');
            } else if (indentDelta < 0) {
                const removeCount = Math.abs(indentDelta);
                adjustedContent = newLines.map(line => {
                    if (line.trim().length === 0) return line;
                    const curLeading = line.match(/^\s*/)?.[0].length || 0;
                    const toRemove = Math.min(curLeading, removeCount);
                    return line.substring(toRemove);
                }).join('\n');
            }
        }

        // 4. Apply Edit and persist
        const edit = new vscode.WorkspaceEdit();
        edit.replace(res.uri, effectiveRange, adjustedContent);
        const success = await vscode.workspace.applyEdit(edit);

        if (success) {
            await doc.save();
            return { success: true, output: `Successfully updated symbol '${params.symbol_name}' in ${params.file_path}.` };
        }
        return { success: false, output: "Failed to apply workspace edit to document." };
    }
};
