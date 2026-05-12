export function isScrolledToBottom(el: HTMLElement): boolean {
    return el.scrollHeight - el.scrollTop - el.clientHeight < 20;
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
 * Enhanced Search/Replace (Aider) with multi-strategy matching.
 */
export function applySearchReplace(content: string, searchBlock: string, replaceBlock: string): { success: boolean, result: string, error?: string, strategy?: string } {
    const isCrlf = content.includes('\r\n');
    const normalizedContent = content.replace(/\r\n/g, '\n');
    const contentLines = normalizedContent.split('\n');

    let normalizedSearch = searchBlock.replace(/\r\n/g, '\n');
    let normalizedReplace = replaceBlock.replace(/\r\n/g, '\n');

    if (normalizedSearch.trim() === "") {
        const result = normalizedContent.endsWith('\n') ? normalizedContent + normalizedReplace : normalizedContent + '\n' + normalizedReplace;
        return { success: true, result: isCrlf ? result.replace(/\n/g, '\r\n') : result, strategy: 'append' };
    }

    // Pass 1-4: Systematic matching attempts
    const strategies = ['strict', 'trim_trailing', 'skip_placeholders', 'indent_agnostic'];

    for (const strategy of strategies) {
        let searchLines = normalizedSearch.split('\n');
        
        // Strategy Modifier: Skip AI meta-comments that break literal matching
        if (strategy === 'skip_placeholders') {
            searchLines = searchLines.filter(line => !isMetaPlaceholder(line));
            if (searchLines.length === 0) continue;
        }

        for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
            let match = true;
            let indentDelta: string | null = null;
            let matchedContentIndices: number[] = [];

            let searchIdx = 0;
            let contentOffset = 0;

            while (searchIdx < searchLines.length) {
                if (i + contentOffset >= contentLines.length) {
                    match = false; break;
                }

                const cLine = contentLines[i + contentOffset];
                const sLine = searchLines[searchIdx];

                const cTrim = cLine.trim();
                const sTrim = sLine.trim();

                let lineMatch = false;

                if (strategy === 'strict') {
                    lineMatch = (cLine === sLine);
                } else if (strategy === 'trim_trailing') {
                    lineMatch = (cLine.trimEnd() === sLine.trimEnd());
                } else if (strategy === 'skip_placeholders' || strategy === 'indent_agnostic') {
                    // Indentation agnostic: compare trimmed content
                    lineMatch = (cTrim === sTrim);
                }

                if (lineMatch || (cTrim === "" && sTrim === "")) {
                    // Capture first indentation of actual code to re-apply later
                    if (sTrim.length > 0 && indentDelta === null) {
                        indentDelta = cLine.match(/^\s*/)?.[0] || "";
                    }
                    matchedContentIndices.push(i + contentOffset);
                    searchIdx++;
                } else if (strategy === 'skip_placeholders' && isMetaPlaceholder(cLine)) {
                    // If file has a comment where we didn't expect one, but we are in skip mode, 
                    // we skip the FILE line and stay on the same SEARCH line
                    contentOffset++;
                    continue;
                } else {
                    match = false;
                    break;
                }
                contentOffset++;
            }

            if (match) {
                const targetIndent = indentDelta || "";
                const replaceLines = normalizedReplace.split('\n');
                
                // Re-calculate indentation for the replacement
                const adjustedReplace = replaceLines.map(line => {
                    if (line.trim().length === 0) return "";
                    const aiIndent = line.match(/^\s*/)?.[0] || "";
                    const searchBaseIndent = searchLines.find(l => l.trim().length > 0)?.match(/^\s*/)?.[0] || "";
                    
                    if (aiIndent.startsWith(searchBaseIndent)) {
                        return targetIndent + aiIndent.substring(searchBaseIndent.length) + line.trimStart();
                    }
                    return targetIndent + line.trimStart();
                });

                const before = contentLines.slice(0, i);
                const after = contentLines.slice(i + contentOffset);
                const finalResult = [...before, ...adjustedReplace, ...after].join('\n');
                
                return { 
                    success: true, 
                    result: isCrlf ? finalResult.replace(/\n/g, '\r\n') : finalResult,
                    strategy
                };
            }
        }
    }

    // Pass 5: Fuzzy Matching
    let bestScore = 0;
    let bestMatchStart = -1;
    let bestMatchEnd = -1;
    const searchLines = normalizedSearch.split('\n').filter(l => !isMetaPlaceholder(l));

    for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
        let totalScore = 0;
        for (let j = 0; j < searchLines.length; j++) {
            totalScore += calculateLineSimilarity(contentLines[i + j], searchLines[j]);
        }
        const avgScore = totalScore / searchLines.length;
        if (avgScore > bestScore) {
            bestScore = avgScore;
            bestMatchStart = i;
            bestMatchEnd = i + searchLines.length;
        }
    }

    if (bestScore > 0.8) {
        const before = contentLines.slice(0, bestMatchStart);
        const after = contentLines.slice(bestMatchEnd);
        const finalResult = [...before, normalizedReplace, ...after].join('\n');
        return { success: true, result: isCrlf ? finalResult.replace(/\n/g, '\r\n') : finalResult, strategy: 'fuzzy' };
    }

    return { 
        success: false, 
        result: content, 
        error: `Matching failed after trying strict, trimmed, placeholder-aware, and fuzzy strategies. Best match score: ${Math.round(bestScore * 100)}%.` 
    };
}