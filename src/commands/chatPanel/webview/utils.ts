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
 * Enhanced Search/Replace (Aider) with multi-strategy matching.
 */
export function applySearchReplace(content: string, searchBlock: string, replaceBlock: string): { success: boolean, result: string, error?: string, strategy?: string } {
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
                // SUCCESS: Match found. Now reconstruct the file with strict indentation re-basing.
                
                // 1. Find the first non-empty line index in the SEARCH block to use as anchor
                const firstContentIdx = searchLines.findIndex(l => l.trim().length > 0);
                const anchorIdx = firstContentIdx === -1 ? 0 : firstContentIdx;

                // 2. Calculate actual file indentation at the match site
                const fileAnchorLine = contentLines[i + anchorIdx];
                const fileIndent = fileAnchorLine?.match(/^\s*/)?.[0] || "";

                // 3. Calculate AI's search anchor indentation
                const aiAnchorLine = searchLines[anchorIdx];
                const aiIndent = aiAnchorLine?.match(/^\s*/)?.[0] || "";
                
                // 4. Re-apply the delta to every line of the replacement
                const adjustedReplace = replaceLines.map(line => {
                    if (line.trim().length === 0) return "";
                    
                    const currentLineIndent = line.match(/^\s*/)?.[0] || "";
                    
                    // --- RELATIVE SHIFT LOGIC ---
                    // We calculate how far this line is indented relative to the AI's anchor line,
                    // then apply that same offset to the file's real indentation level.
                    if (currentLineIndent.startsWith(aiIndent)) {
                        const relativeNesting = currentLineIndent.substring(aiIndent.length);
                        return fileIndent + relativeNesting + line.trimStart();
                    } else if (aiIndent.startsWith(currentLineIndent)) {
                        // Handle cases where replacement lines are less indented than the anchor
                        const negativeOffset = aiIndent.length - currentLineIndent.length;
                        const newIndentLen = Math.max(0, fileIndent.length - negativeOffset);
                        return " ".repeat(newIndentLen) + line.trimStart();
                    }
                    
                    // Default: Match the file's base level if the AI's internal spacing is chaotic
                    return fileIndent + line.trimStart();
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