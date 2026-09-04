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

/**
 * Normalizes Aider Search/Replace block content in the webview.
 * Handles standard Aider, indented markers, and lone "=======" separators.
 */
export function normalizeAiderContent(rawBlock: string): string {
    if (!rawBlock || typeof rawBlock !== 'string') return '';

    let text = rawBlock.replace(/\r\n/g, '\n');

    // 1. If it already has <<<<<<< SEARCH and >>>>>>> REPLACE, normalize markers to line start
    if (text.includes('<<<<<<< SEARCH') && text.includes('>>>>>>> REPLACE')) {
        return text.replace(/^[ \t]*(<<<<<<< SEARCH|=======|>>>>>>> REPLACE)[ \t]*/gm, '$1');
    }

    // 2. If it has <<<<<<< SEARCH and ======= but missing closing >>>>>>> REPLACE
    if (text.includes('<<<<<<< SEARCH') && text.includes('=======')) {
        let normalized = text.replace(/^[ \t]*(<<<<<<< SEARCH|=======)[ \t]*/gm, '$1');
        if (!normalized.includes('>>>>>>> REPLACE')) {
            normalized = normalized.trimEnd() + '\n>>>>>>> REPLACE';
        }
        return normalized;
    }

    // 3. If the AI emitted ONLY the ======= separator without outer markers
    const separatorRegex = /^[ \t]*={5,}[ \t]*$/m;
    if (separatorRegex.test(text)) {
        const parts = text.split(separatorRegex);
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

    while (i < lines.length) {
        const line = lines[i];
        if (line.trim().startsWith('<<<<<<< SEARCH')) {
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
                    if (trimmed.startsWith('<<<<<<< SEARCH')) {
                        depth++;
                        searchLines.push(curLine);
                    } else if (trimmed.startsWith('>>>>>>> REPLACE')) {
                        if (depth > 1) {
                            depth--;
                        }
                        searchLines.push(curLine);
                    } else if (trimmed.startsWith('=======') && depth === 1) {
                        inReplace = true;
                        depth = 0;
                    } else {
                        searchLines.push(curLine);
                    }
                } else {
                    if (trimmed.startsWith('<<<<<<< SEARCH')) {
                        depth++;
                        replaceLines.push(curLine);
                    } else if (trimmed.startsWith('>>>>>>> REPLACE')) {
                        if (depth > 0) {
                            depth--;
                            replaceLines.push(curLine);
                        } else {
                            isClosed = true;
                            break;
                        }
                    } else {
                        replaceLines.push(curLine);
                    }
                }
                i++;
            }

            if (isClosed || inReplace) {
                const searchPart = searchLines.join('\n');
                const replacePart = replaceLines.join('\n');
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
    const contentLines = normalizedContent.split('\n');

    let normalizedSearch = (searchBlock || "").replace(/\r\n/g, '\n');
    let normalizedReplace = (replaceBlock || "").replace(/\r\n/g, '\n');
    const replaceLines = normalizedReplace.split('\n');

    if (normalizedSearch.trim() === "") {
        const result = normalizedContent.endsWith('\n') ? normalizedContent + normalizedReplace : normalizedContent + '\n' + normalizedReplace;
        return { success: true, result: isCrlf ? result.replace(/\n/g, '\r\n') : result, strategy: 'append' };
    }

    const searchLines = normalizedSearch.split('\n');

    // 2. Find Match using an optimized and bounds-safe sliding window
    for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
        let match = true;

        for (let j = 0; j < searchLines.length; j++) {
            const cLine = contentLines[i + j];
            const sLine = searchLines[j];

            if (cLine === undefined || sLine === undefined) {
                match = false;
                break;
            }

            const cTrim = cLine.trim();
            const sTrim = sLine.trim();

            // Direct comparison or soft white-space check
            if (cTrim !== sTrim && !(cTrim === "" && sTrim === "")) {
                match = false;
                break;
            }
        }

        if (match) {
            // Find first non-empty line inside the match window to evaluate indentation delta
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
            const finalResult = [...before, ...adjustedReplace, ...after].join('\n');
            
            return { 
                success: true, 
                result: isCrlf ? finalResult.replace(/\n/g, '\r\n') : finalResult 
            };
        }
    }

    // Pass 5: Fuzzy Matching Fallback
    let bestScore = 0;
    let bestMatchStart = -1;
    let bestMatchEnd = -1;
    const fuzzySearchLines = searchLines.filter(l => {
        // Safe check for metadata placeholder
        const trimmed = l.trim();
        if (/^(\.{3,}|#\s*\.{3,}|(\/\/|--|;)\s*\.{3,})$/.test(trimmed)) return false;
        if (/(#|\/\/|--)\s*(\.{3,}|existing|rest of|same as)/i.test(trimmed)) return false;
        return true;
    });

    for (let i = 0; i <= contentLines.length - fuzzySearchLines.length; i++) {
        let totalScore = 0;
        for (let j = 0; j < fuzzySearchLines.length; j++) {
            const line1 = contentLines[i + j] || "";
            const line2 = fuzzySearchLines[j] || "";
            
            const l1 = line1.trim();
            const l2 = line2.trim();
            let score = 0;
            if (l1 === l2) {
                score = 1.0;
            } else if (l1 === "" || l2 === "") {
                score = 0.0;
            } else {
                const maxLen = Math.max(l1.length, l2.length);
                score = maxLen > 0 ? (1.0 - (Math.abs(l1.length - l2.length) / maxLen)) : 1.0;
            }
            totalScore += score;
        }
        const avgScore = totalScore / (fuzzySearchLines.length || 1);
        if (avgScore > bestScore) {
            bestScore = avgScore;
            bestMatchStart = i;
            bestMatchEnd = i + fuzzySearchLines.length;
        }
    }

    if (bestScore > 0.8 && bestMatchStart !== -1) {
        const before = contentLines.slice(0, bestMatchStart);
        const after = contentLines.slice(bestMatchEnd);
        const finalResult = normalizedReplace === ""
            ? [...before, ...after].join('\n')
            : [...before, normalizedReplace, ...after].join('\n');
        return { success: true, result: isCrlf ? finalResult.replace(/\n/g, '\r\n') : finalResult };
    }

    return { 
        success: false, 
        result: content, 
        error: `Matching failed. Best match score: ${Math.round(bestScore * 100)}%.` 
    };
}