export function isScrolledToBottom(el: HTMLElement): boolean {
    return el.scrollHeight - el.scrollTop - el.clientHeight < 20;
}

/**
 * Collapses a details block while preserving its exact vertical position in the viewport.
 * Prevents the scroll viewport from jumping disorientingly when height changes.
 */
export function collapseBlockWithScrollPreservation(blockEl: HTMLDetailsElement, messagesDiv: HTMLElement | null) {
    if (!blockEl) return;
    if (!messagesDiv) {
        blockEl.open = false;
        return;
    }

    const summary = blockEl.querySelector('summary') || blockEl;
    const rectBefore = summary.getBoundingClientRect();

    blockEl.open = false;

    const rectAfter = summary.getBoundingClientRect();
    const diffY = rectBefore.top - rectAfter.top;

    if (diffY !== 0) {
        messagesDiv.scrollTop += diffY;
    }
}

/**
 * Executes an action that modifies DOM height while anchoring the scrollbar 
 * to a reference element so the viewport stays perfectly stationary.
 */
export function preserveScrollPosition(refElement: HTMLElement | null, container: HTMLElement | null, action: () => void) {
    if (!refElement || !container) {
        action();
        return;
    }
    const rectBefore = refElement.getBoundingClientRect().top;

    action();

    const rectAfter = refElement.getBoundingClientRect().top;
    const diffY = rectBefore - rectAfter;
    if (diffY !== 0) {
        container.scrollTop += diffY;
    }
}

/**
 * Calculates a similarity score between two strings (0.0 to 1.0).
 * Uses a simple character-based overlap metric for fuzzy matching.
 */
export function calculateLineSimilarity(a: string, b: string): number {
    if (a === b) return 1.0;
    if (!a || !b) return 0.0;

    const aTrim = a.trim();
    const bTrim = b.trim();
    if (aTrim === bTrim) return 0.95; // Nearly identical, just whitespace diff

    const maxLen = Math.max(aTrim.length, bTrim.length);
    if (maxLen === 0) return 1.0;

    // Simple Levenshtein distance calculation
    const matrix: number[][] = [];
    for (let i = 0; i <= bTrim.length; i++) {
        matrix[i] = [i];
    }
    for (let j = 0; j <= aTrim.length; j++) {
        matrix[0][j] = j;
    }

    for (let i = 1; i <= bTrim.length; i++) {
        for (let j = 1; j <= aTrim.length; j++) {
            if (bTrim.charAt(i - 1) === aTrim.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1, // substitution
                    matrix[i][j - 1] + 1,     // insertion
                    matrix[i - 1][j] + 1      // deletion
                );
            }
        }
    }

    const distance = matrix[bTrim.length][aTrim.length];
    return 1.0 - (distance / maxLen);
}


function isMetaPlaceholder(line: string): boolean {
    const trimmed = line.trim();
    // 1. Just ellipses
    if (/^(\.{3,}|#\s*\.{3,}|(\/\/|--|;)\s*\.{3,})$/.test(trimmed)) return true;
    // 2. Comments containing "existing", "rest of", "..."
    if (/(#|\/\/|--)\s*(\.{3,}|existing|rest of|same as)/i.test(trimmed)) return true;
    return false;
}

export function isValidFilePath(filePath: string): boolean {
    if (!filePath || typeof filePath !== 'string') return false;
    let clean = filePath.trim().replace(/^['"`]|['"`]$/g, '');

    if (clean.includes(':') && !/^[a-zA-Z]:[\\/]/.test(clean)) {
        clean = clean.split(':')[0].trim();
    }
    if (/^[a-zA-Z]:[\\/]/.test(clean)) {
        clean = clean.substring(2);
    }

    clean = clean.replace(/\\/g, '/');
    if (clean.length < 2) return false;
    if (/[\[\](){}<>"'`;=*?|,\!@\$^\t\n\r]/.test(clean)) return false;
    if (/\s/.test(clean)) return false;
    if (clean.startsWith('/') || clean.endsWith('/') || clean.endsWith('.')) return false;

    if (/^(?:block\s*\d+|file\.ext|path\/to\/file.*|filename\.ext|code_block|snippet|undefined|null|none)$/i.test(clean)) {
        return false;
    }

    const base = clean.split('/').pop() || '';
    if (!base || base === '.' || base === '..') return false;

    const knownFiles = new Set([
        'dockerfile', 'makefile', 'license', 'procfile', 'gemfile', 'rakefile',
        '.gitignore', '.env', '.env.example', '.vscodeignore', '.prettierrc',
        '.eslintrc', '.editorconfig', 'changelog.md', 'readme.md'
    ]);
    if (knownFiles.has(base.toLowerCase())) return true;

    const extMatch = base.match(/\.([a-zA-Z0-9_\-]+)$/);
    if (!extMatch) return false;

    const ext = extMatch[1].toLowerCase();
    if (ext.length > 10 || /^\d+$/.test(ext)) return false;

    const forbidden = new Set([
        'def', 'class', 'function', 'return', 'import', 'export', 'from', 'const',
        'let', 'var', 'if', 'else', 'while', 'for', 'true', 'false', 'null', 'undefined',
        'dict', 'list', 'str', 'int', 'float', 'bool', 'self', 'this'
    ]);
    const baseWithoutExt = base.substring(0, base.lastIndexOf('.')).toLowerCase();
    if (!clean.includes('/') && forbidden.has(baseWithoutExt) && (ext === 'path' || ext === 'get' || ext === 'set')) {
        return false;
    }

    return true;
}

export function sanitizeAiderMarkers(text: string): string {
    if (!text) return '';
    return text
        .split('\n')
        .filter(line => {
            const trimmed = line.trim();
            if (/^<{5,}\s*search\b/i.test(trimmed)) return false;
            if (/^={5,}(?:\s*.*)?$/.test(trimmed)) return false;
            if (/^>{5,}\s*replace\b/i.test(trimmed)) return false;
            if (/^(<{5,}|>{5,})$/.test(trimmed)) return false;
            return true;
        })
        .join('\n');
}

/**
 * Normalizes Aider Search/Replace block content in the webview.
 * Handles standard Aider, indented markers, and lone "=======" separators.
 */
export function normalizeAiderContent(rawBlock: string): string {
    if (!rawBlock || typeof rawBlock !== 'string') return '';

    let text = rawBlock.replace(/\r\n/g, '\n');

    // 1. If it already has <<<<<<< SEARCH and >>>>>>> REPLACE, normalize markers to line start
    if (text.includes('<<<<<<< SEARCH') && text.includes('>>>>>>> REPLACE')) {
        return text.replace(/^[ \t]*(<<<<<<< SEARCH|={5,}|>>>>>>> REPLACE)[ \t]*/gm, (match, marker) => {
            if (marker.startsWith('<')) return '<<<<<<< SEARCH';
            if (marker.startsWith('=')) return '=======';
            if (marker.startsWith('>')) return '>>>>>>> REPLACE';
            return match;
        });
    }

    // 2. If it has <<<<<<< SEARCH and ======= but missing closing >>>>>>> REPLACE
    if (text.includes('<<<<<<< SEARCH') && text.includes('=======')) {
        let normalized = text.replace(/^[ \t]*(<<<<<<< SEARCH|={5,})[ \t]*/gm, (match, marker) => {
            if (marker.startsWith('<')) return '<<<<<<< SEARCH';
            if (marker.startsWith('=')) return '=======';
            return match;
        });
        if (!normalized.includes('>>>>>>> REPLACE')) {
            normalized = normalized.trimEnd() + '\n>>>>>>> REPLACE';
        }
        return normalized;
    }

    // 3. If the AI emitted ONLY the ======= separator without outer markers
    const separatorRegex = /^[ \t]*={5,}[ \t]*$/m;
    if (separatorRegex.test(text)) {
        const cleanText = text.replace(/^[ \t]*>{7}\s*REPLACE[ \t]*$/gm, '').replace(/^[ \t]*<{7}\s*SEARCH[ \t]*$/gm, '');
        const parts = cleanText.split(separatorRegex);
        if (parts.length === 2) {
            const searchPart = parts[0];
            const replacePart = parts[1];
            return `<<<<<<< SEARCH\n${searchPart.trimEnd()}\n=======\n${replacePart.trimStart()}\n>>>>>>> REPLACE`;
        } else if (parts.length > 2) {
            let result = '';
            for (let i = 0; i < parts.length - 1; i += 2) {
                const s = parts[i];
                const r = parts[i + 1] || '';
                result += `<<<<<<< SEARCH\n${s.trimEnd()}\n=======\n${r.trimStart()}\n>>>>>>> REPLACE\n\n`;
            }
            return result.trim();
        }
    }

    return text;
}

export interface AiderHunk {
    fullMatch: string;
    searchPart: string;
    replacePart: string;
    startIndex: number;
    endIndex: number;
}

/**
 * Balanced Aider hunk parser that tracks nested <<<<<<< SEARCH / >>>>>>> REPLACE markers.
 */
export function parseAiderHunks(rawBlock: string): AiderHunk[] {
    const hunks: AiderHunk[] = [];
    if (!rawBlock || typeof rawBlock !== 'string') return hunks;

    const lines = rawBlock.replace(/\r\n/g, '\n').split('\n');
    let i = 0;

    const isSearchMarker = (l: string) => /^<{7}\s*search\b/i.test(l.trim());
    const isReplaceMarker = (l: string) => /^>{7}\s*replace\b/i.test(l.trim());
    const isSeparatorMarker = (l: string) => /^={5,}$/.test(l.trim());

    while (i < lines.length) {
        const line = lines[i];
        if (isSearchMarker(line)) {
            const startLineIdx = i;
            const searchLines: string[] = [];
            const replaceLines: string[] = [];
            let inReplace = false;
            let depth = 1;
            let isClosed = false;

            i++;
            while (i < lines.length) {
                const curLine = lines[i];
                const trimmed = curLine.trim();

                if (!inReplace) {
                    if (isSearchMarker(curLine)) {
                        depth++;
                        searchLines.push(curLine);
                    } else if (isReplaceMarker(curLine)) {
                        if (depth > 1) {
                            depth--;
                            searchLines.push(curLine);
                        } else {
                            isClosed = true;
                            break;
                        }
                    } else if (isSeparatorMarker(curLine) && depth === 1) {
                        inReplace = true;
                        depth = 0;
                    } else {
                        searchLines.push(curLine);
                    }
                } else {
                    if (isSearchMarker(curLine)) {
                        if (depth === 0) {
                            isClosed = true;
                            i--;
                            break;
                        } else {
                            depth++;
                            replaceLines.push(curLine);
                        }
                    } else if (isReplaceMarker(curLine)) {
                        if (depth > 0) {
                            depth--;
                            replaceLines.push(curLine);
                        } else {
                            isClosed = true;
                            break;
                        }
                    } else if (isSeparatorMarker(curLine) && depth === 0) {
                        // Skip duplicate separator line to avoid leaking ======= into replace output
                        i++;
                        continue;
                    } else {
                        replaceLines.push(curLine);
                    }
                }
                i++;
            }

            if (isClosed || inReplace) {
                const searchPart = sanitizeAiderMarkers(searchLines.join('\n'));
                const replacePart = sanitizeAiderMarkers(replaceLines.join('\n'));
                const fullMatch = lines.slice(startLineIdx, i + 1).join('\n');
                hunks.push({
                    fullMatch,
                    searchPart,
                    replacePart,
                    startIndex: startLineIdx,
                    endIndex: i
                });
            }
        }
        i++;
    }

    return hunks;
}

export function applySearchReplace(content: string, searchBlock: string, replaceBlock: string): { success: boolean, result: string, error?: string } {
    const isCrlf = content.includes('\r\n');
    const normalizedContent = content.replace(/\r\n/g, '\n');

    let normalizedSearch = sanitizeAiderMarkers((searchBlock || "").replace(/\r\n/g, '\n'));
    let normalizedReplace = sanitizeAiderMarkers((replaceBlock || "").replace(/\r\n/g, '\n'));

    // Strip any residual marker lines from replaceBlock to prevent leaks
    normalizedReplace = normalizedReplace
        .split('\n')
        .filter(l => !/^<{5,}\s*search\b|^={5,}(?:\s*.*)?$|^>{5,}\s*replace\b/i.test(l.trim()))
        .join('\n');

    // 1. Reject Empty Search on Existing Non-Empty Files (Prevents misplacing code at the end)
    if (normalizedSearch.trim() === "") {
        if (normalizedContent.trim() === "") {
            return { success: true, result: isCrlf ? normalizedReplace.replace(/\n/g, '\r\n') : normalizedReplace };
        }
        return {
            success: false,
            result: content,
            error: "Empty SEARCH block provided for an existing file. A SEARCH block must specify the exact lines to replace."
        };
    }

    const contentLines = normalizedContent.split('\n');
    const searchLines = normalizedSearch.split('\n');
    const replaceLines = normalizedReplace === "" ? [] : normalizedReplace.split('\n');

    // 2. Safe Repetition Guard
    const trimS = normalizedSearch.trim();
    const trimR = normalizedReplace.trim();
    if (trimS.length > 0 && trimR.length > 20 && !normalizedContent.includes(trimS) && normalizedContent.includes(trimR)) {
        return { success: true, result: content };
    }

    // 3. Find Matches: Collect all candidate locations
    const candidateMatches: { index: number; isExactIndent: boolean }[] = [];

    for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
        let match = true;
        let isExact = true;

        for (let j = 0; j < searchLines.length; j++) {
            const cLine = contentLines[i + j];
            const sLine = searchLines[j];

            if (cLine === undefined || sLine === undefined) {
                match = false;
                break;
            }

            if (cLine !== sLine) {
                isExact = false;
            }

            const cTrim = cLine.trim();
            const sTrim = sLine.trim();

            if (cTrim !== sTrim && !(cTrim === "" && sTrim === "")) {
                match = false;
                break;
            }
        }

        if (match) {
            candidateMatches.push({ index: i, isExactIndent: isExact });
        }
    }

    // 4. Ambiguity Guard: Prevent replacing the wrong place on short search blocks
    if (candidateMatches.length > 1 && searchLines.length <= 2) {
        const exactMatches = candidateMatches.filter(m => m.isExactIndent);
        if (exactMatches.length !== 1) {
            return {
                success: false,
                result: content,
                error: `Ambiguous SEARCH block: The ${searchLines.length}-line snippet matches ${candidateMatches.length} different locations in the file. Include 2-3 lines of surrounding context to specify which location to replace.`
            };
        }
    }

    const bestMatch = candidateMatches.find(m => m.isExactIndent) || candidateMatches[0];

    if (bestMatch !== undefined) {
        const i = bestMatch.index;

        let matchedFileIndent = "";
        let matchedAiIndent = "";
        for (let j = 0; j < searchLines.length; j++) {
            if (searchLines[j].trim().length > 0) {
                matchedFileIndent = contentLines[i + j].match(/^\s*/)?.[0] || "";
                matchedAiIndent = searchLines[j].match(/^\s*/)?.[0] || "";
                break;
            }
        }

        const indentDelta = matchedFileIndent.length - matchedAiIndent.length;

        const adjustedReplace = replaceLines.map(line => {
            if (line.trim().length === 0) return "";
            const currentLineIndent = line.match(/^\s*/)?.[0] || "";
            const newIndentLength = Math.max(0, currentLineIndent.length + indentDelta);
            return " ".repeat(newIndentLength) + line.trimStart();
        });

        const before = contentLines.slice(0, i);
        const after = contentLines.slice(i + searchLines.length);
        const finalResult = normalizedReplace === ""
            ? [...before, ...after].join('\n')
            : [...before, ...adjustedReplace, ...after].join('\n');

        // Post-application integrity check: verify no leaked conflict markers
        const leaked = finalResult.split('\n').find(l => /^<{5,}\s*search\b|^={5,}(?:\s*.*)?$|^>{5,}\s*replace\b/i.test(l.trim()));
        if (leaked) {
            return {
                success: false,
                result: content,
                error: `Integrity check failed: Leaked Aider marker detected in replacement (${leaked.trim()}). Modification rejected to protect file integrity.`
            };
        }

        return { 
            success: true, 
            result: isCrlf ? finalResult.replace(/\n/g, '\r\n') : finalResult 
        };
    }

    return { 
        success: false, 
        result: content, 
        error: "The SEARCH block was not found in the file. Ensure the code you are trying to match is identical to the file content, including indentation and blank lines." 
    };
}

export interface FileTagAttributes {
    path: string;
    action: 'write' | 'patch' | 'update_symbol';
    symbol?: string;
}

/**
 * Parses attributes from <file ...> tags resiliently.
 * Handles synonymous attribute names like file="...", filepath="...", target="...",
 * unquoted values, or missing actions.
 */
export function parseFileTagAttributes(attrStr: string, rawContent?: string): FileTagAttributes | null {
    if (!attrStr && !rawContent) return null;
    const cleanAttr = (attrStr || "").trim();

    // 1. Extract path with all common synonyms
    const pathRegex = /(?:^|\s+)(?:path|file_path|filepath|file|target|name|filename)\s*=\s*(?:["']([^"']+)["']|([^\s>]+))/i;
    const pathMatch = cleanAttr.match(pathRegex);
    let filePath = pathMatch ? (pathMatch[1] || pathMatch[2] || "").trim() : "";

    // Fallback: Check if attribute string starts with unkeyed path
    if (!filePath) {
        const unkeyedMatch = cleanAttr.match(/^(?:["']([^"']+)["']|([^\s=>"']+\.[a-zA-Z0-9_\-]+))/);
        if (unkeyedMatch) {
            filePath = (unkeyedMatch[1] || unkeyedMatch[2] || "").trim();
        }
    }

    if (!filePath) return null;

    filePath = filePath.replace(/^['"]|['"]$/g, '').trim();

    if (!isValidFilePath(filePath)) {
        return null;
    }

    // 2. Extract action with synonyms (action, type, mode)
    const actionRegex = /(?:^|\s+)(?:action|type|mode)\s*=\s*(?:["']([^"']+)["']|([^\s>]+))/i;
    const actionMatch = cleanAttr.match(actionRegex);
    const actionRaw = actionMatch ? (actionMatch[1] || actionMatch[2] || "").toLowerCase().trim() : "";

    // 3. Extract symbol
    const symbolRegex = /(?:^|\s+)(?:symbol|function|method|class)\s*=\s*(?:["']([^"']+)["']|([^\s>]+))/i;
    const symbolMatch = cleanAttr.match(symbolRegex);
    let symbol = symbolMatch ? (symbolMatch[1] || symbolMatch[2] || "").trim() : "";

    if (!symbol && filePath.includes(':') && !/^[a-zA-Z]:[\\/]/.test(filePath)) {
        const parts = filePath.split(':');
        filePath = parts[0].trim();
        symbol = parts.slice(1).join(':').trim();
    }

    let action: 'write' | 'patch' | 'update_symbol' = 'write';
    if (actionRaw === 'write' || actionRaw === 'create' || actionRaw === 'overwrite' || actionRaw === 'new') {
        action = 'write';
    } else if (actionRaw === 'update_symbol' || (symbol && actionRaw !== 'patch')) {
        action = 'update_symbol';
    } else if (actionRaw === 'patch' || (rawContent && rawContent.includes('<<<<<<< SEARCH'))) {
        action = 'patch';
    }

    return { path: filePath, action, symbol: symbol || undefined };
}