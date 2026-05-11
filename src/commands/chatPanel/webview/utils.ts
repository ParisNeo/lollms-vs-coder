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

export function applySearchReplace(content: string, searchBlock: string, replaceBlock: string): { success: boolean, result: string, error?: string } {
    const isCrlf = content.includes('\r\n');
    const normalizedContent = content.replace(/\r\n/g, '\n');
    
    // CRITICAL: We DO NOT trimEnd() here because trailing newlines 
    // are often used as anchors in AIDER blocks.
    let normalizedSearch = searchBlock.replace(/\r\n/g, '\n');
    let normalizedReplace = replaceBlock.replace(/\r\n/g, '\n');

    // 1. Handle Empty Search (Prepend/Append logic)
    if (normalizedSearch.trim() === "") {
        const result = normalizedContent.endsWith('\n') ? normalizedContent + normalizedReplace : normalizedContent + '\n' + normalizedReplace;
        return { success: true, result: isCrlf ? result.replace(/\n/g, '\r\n') : result };
    }

    const contentLines = normalizedContent.split('\n');
    const searchLines = normalizedSearch.split('\n');
    const replaceLines = normalizedReplace.split('\n');

    // 2. Find Match using a "Sliding Window" 
    // We iterate through every line of the file looking for the start of the block
    for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
        let match = true;
        let indentDelta: string | null = null;

        for (let j = 0; j < searchLines.length; j++) {
            const cLine = contentLines[i + j];
            const sLine = searchLines[j];

            // --- IMPROVED COMPARISON ---
            // We compare trimmed versions to ignore trailing spaces/tabs
            // but we also allow for the AI to have missed an empty line 
            // if the original file has one (lenient blank line matching)
            const cTrim = cLine.trim();
            const sTrim = sLine.trim();

            if (cTrim !== sTrim) {
                // Special case: if both are empty-ish, it's a match
                if (cTrim === "" && sTrim === "") {
                    // Match
                } else {
                    match = false;
                    break;
                }
            }

            // Detect Indentation Shift (e.g., file has 4 spaces, AI provided 2)
            if (sTrim.length > 0 && indentDelta === null) {
                const cIndent = cLine.match(/^\s*/)?.[0] || "";
                const sIndent = sLine.match(/^\s*/)?.[0] || "";
                
                // We store the original file's indentation to re-apply it to the replacement
                indentDelta = cIndent; 
            }
        }

        if (match) {
            // SUCCESS: Match found. Now reconstruct the file.
            const targetIndent = indentDelta || "";
            
            // Re-apply original indentation to the replacement lines
            const adjustedReplace = replaceLines.map(line => {
                if (line.trim().length === 0) return "";
                // If AI already provided indentation, we try to preserve the relative nesting
                const aiIndent = line.match(/^\s*/)?.[0] || "";
                const searchBaseIndent = searchLines.find(l => l.trim().length > 0)?.match(/^\s*/)?.[0] || "";
                
                if (aiIndent.startsWith(searchBaseIndent)) {
                    // Re-base AI indentation onto the file's indentation
                    return targetIndent + aiIndent.substring(searchBaseIndent.length) + line.trimStart();
                }
                return targetIndent + line.trimStart();
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

    // 3. Fuzzy matching fallback for minor typos or non-consistent whitespace
    let bestScore = 0;
    let bestMatchIndex = -1;
    const THRESHOLD = 0.85; // 85% similarity required to apply the change anyway

    for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
        let currentBlockScore = 0;
        let possible = true;

        if (calculateLineSimilarity(contentLines[i], searchLines[0]) < 0.5) continue; 

        for (let j = 0; j < searchLines.length; j++) {
            const score = calculateLineSimilarity(contentLines[i + j], searchLines[j]);
            if (score < 0.4) { 
                possible = false;
                break; 
            }
            currentBlockScore += score;
        }

        if (possible) {
            const averageScore = currentBlockScore / searchLines.length;
            if (averageScore > bestScore) {
                bestScore = averageScore;
                bestMatchIndex = i;
            }
        }
    }

    // --- CHECK IF ALREADY APPLIED (Repetition Guard) ---
    const trimR = normalizedReplace.trim();
    if (trimR.length > 0) {
        if (normalizedContent.includes(normalizedReplace) || normalizedContent.includes(trimR)) {
            return { success: true, result: normalizedContent };
        }
    }

    // 4. Final Fallback: All matching strategies failed.
    return { 
        success: false, 
        result: content, 
        error: "The SEARCH block was not found in the file. Ensure the code you are trying to match is identical to the file content, including indentation and blank lines." 
    };
}