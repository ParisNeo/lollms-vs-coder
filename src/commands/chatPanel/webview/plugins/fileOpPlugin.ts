import { TagPlugin, PluginContext } from '../pluginSystem';
import { state } from '../dom.js';
import { normalizeAiderContent, parseAiderHunks, parseFileTagAttributes, isValidFilePath } from '../utils.js';

function renderDiffLines(lines: string[], type: 'added' | 'removed' | 'unchanged'): string {
    return lines.map(line => {
        const escaped = line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
        const safeLine = escaped.length === 0 ? ' ' : escaped;
        return `<div class="aider-diff-line aider-diff-${type}"><span class="aider-diff-code">${safeLine}</span></div>`;
    }).join('');
}

export interface ExtractedFileBlock {
    attrStr: string;
    rawContent: string;
    fullMatch: string;
    start: number;
    end: number;
    isClosed: boolean;
}

let _lastNormIn = '';
let _lastNormOut = '';

function isPlaceholderFilePath(p: string): boolean {
    const clean = (p || '').replace(/\\/g, '/').toLowerCase().trim();
    return !clean ||
        clean === '...' ||
        clean === 'path/to/file.ext' ||
        clean.startsWith('path/to/') ||
        clean === 'path/to/obsolete_file.ext';
}

export function normalizePseudoFileBlocks(text: string): string {
    if (!text || typeof text !== 'string') return '';
    if (text === _lastNormIn) return _lastNormOut;
    let result = text;

    // Normalize mid-line <file ...>...



    const replaceTagRegex = /<replace\b[^>]*>[\s\r\n]*<search\b[^>]*>([\s\S]*?)<\/search>[\s\r\n]*<(?:replace_with|replace)\b[^>]*>([\s\S]*?)<\/(?:replace_with|replace)>[\s\r\n]*<\/replace>/gi;
    
    result = result.replace(replaceTagRegex, (_match, s, r) => {
        return `<<<<<<< SEARCH\n${s.trimEnd()}\n=======\n${r.trimStart()}\n>>>>>>> REPLACE`;
    });

    const standaloneSearchReplace = /<search\b[^>]*>([\s\S]*?)<\/search>[\s\r\n]*<(?:replace_with|replace)\b[^>]*>([\s\S]*?)<\/(?:replace_with|replace)>/gi;
    result = result.replace(standaloneSearchReplace, (_match, s, r) => {
        return `<<<<<<< SEARCH\n${s.trimEnd()}\n=======\n${r.trimStart()}\n>>>>>>> REPLACE`;
    });

    const existingFileRanges: { start: number; end: number }[] = [];
    const existingFileRegex = /^[ \t]*<file\b[^>]*>[\s\S]*?<\/\s*file(?:\s+[^>\r\n]*)?\s*>/gim;
    let efm: RegExpExecArray | null;
    while ((efm = existingFileRegex.exec(result)) !== null) {
        existingFileRanges.push({ start: efm.index, end: efm.index + efm[0].length });
    }

    const fileHeaderRegex = /(?:(?:\$file\$|\*\*File\*\*|^File)\s*:\s*[`"']?([^\s`"'\r\n]+)[`"']?\s*(?:(?:\$action\$|\*\*Action\*\*|Action)\s*:\s*[`"']?(\w+)[`"']?)?)([\s\S]*?)(?=(?:(?:\$file\$|\*\*File\*\*|^File)\s*:\s*[`"']?[^\s`"'\r\n]+|<file\b|$))/gim;

    result = result.replace(fileHeaderRegex, (fullMatch, filePath, actionRaw, body, offset) => {
        if (existingFileRanges.some(r => offset >= r.start && offset < r.end)) return fullMatch;
        const cleanPath = (filePath || '').replace(/^[`"']|[`"']$/g, '').trim();
        if (!isValidFilePath(cleanPath)) return fullMatch;
        const action = (actionRaw && actionRaw.toLowerCase().includes('write')) ? 'write' : 'patch';

        if (/<file\b/i.test(body)) return fullMatch;

        const hunks = body.match(/<<<<<<< SEARCH[\s\S]*?>>>>>>> REPLACE/g);
        if (hunks && hunks.length > 0) {
            return `\n\n<file path="${cleanPath}" action="patch">\n${hunks.join('\n\n')}\n</file>\n\n`;
        }

        const fenceMatch = body.match(/```(?:\w+)?\r?\n([\s\S]*?)\r?\n```/);
        if (fenceMatch) {
            return `\n\n<file path="${cleanPath}" action="${action}">\n${fenceMatch[1]}\n</file>

\n\n`;
        }

        return fullMatch;
    });

    // Normalize <delete_code path="...">...</delete_code> into <file path="..." action="delete_code">...</file>
    result = result.replace(/^[ \t]*<delete_code\b([^>]*?)>([\s\S]*?)<\/delete_code>[ \t]*$/gim, (fullMatch, attrStr, body) => {
        const attrs = parseFileTagAttributes(attrStr);
        if (attrs?.path && isValidFilePath(attrs.path)) {
            return `\n\n<file path="${attrs.path}" action="delete_code">\n${body.trim()}\n</file>\n\n`;
        }
        return fullMatch;
    });

    // Normalize empty-replace or search-only Aider blocks so parseAiderHunks handles deletions cleanly
    result = result.replace(/<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n>>>>>>> REPLACE/g, (fullMatch, inner) => {
        if (!/^=======$/m.test(inner)) {
            return `<<<<<<< SEARCH\n${inner}\n=======\n\n>>>>>>> REPLACE`;
        }
        return fullMatch;
    });
    result = result.replace(/^[ \t]*=======\r?\n[ \t]*>>>>>>> REPLACE/gm, '=======\n\n>>>>>>> REPLACE');

    // Normalize <file path="..." action="delete" /> or <file path="..." action="delete"></file> into <delete_files>
    result = result.replace(/^[ \t]*<file\b([^>]*\baction=["']delete["'][^>]*?)(?:\/>|>([\s\S]*?)<\/file>)[ \t]*$/gim, (fullMatch, attrStr) => {
        const attrs = parseFileTagAttributes(attrStr);
        if (attrs?.path && isValidFilePath(attrs.path)) {
            return `\n\n<delete_files>\n${attrs.path}\n</delete_files>\n\n`;
        }
        return fullMatch;
    });

    // Normalize <delete_file ...> and self-closing <delete_files ... /> into canonical <delete_files>...</delete_files>
    result = result.replace(/^[ \t]*<(delete_file|delete_files)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)[ \t]*$/gim, (fullMatch, tagName, attrPart, inner) => {
        if (tagName.toLowerCase() === 'delete_files' && inner !== undefined) {
            return fullMatch;
        }
        const paths: string[] = [];
        const pathAttr = (attrPart || '').match(/\bpath=["']([^"']+)["']/i);
        if (pathAttr && isValidFilePath(pathAttr[1].trim())) {
            paths.push(pathAttr[1].trim());
        }
        const pathsAttr = (attrPart || '').match(/\bpaths=["'](\[.*?\])["']/i);
        if (pathsAttr) {
            try {
                const parsed = JSON.parse(pathsAttr[1].replace(/'/g, '"'));
                if (Array.isArray(parsed)) {
                    parsed.forEach(p => { if (typeof p === 'string' && isValidFilePath(p.trim())) paths.push(p.trim()); });
                }
            } catch {}
        }
        if (inner && inner.trim()) {
            inner.split(/[\r\n,]+/).map((l: string) => l.trim().replace(/^['"`]|['"`]$/g, '')).filter((l: string) => l && isValidFilePath(l)).forEach((l: string) => paths.push(l));
        }
        if (paths.length > 0) {
            return `\n\n<delete_files>\n${Array.from(new Set(paths)).join('\n')}\n</delete_files>\n\n`;
        }
        return fullMatch;
    });

    _lastNormIn = text;
    _lastNormOut = result;
    return result;
}

export function getFileContextStatus(filePath: string): 'muted' | 'structure_only' | 'full_content' | 'not_in_context' {
    if (!filePath) return 'not_in_context';
    const cleanP = filePath.replace(/\\/g, '/').toLowerCase().trim();

    const activeState = state || (window as any).state;
    const currentMuted = (activeState as any)?.mutedFiles || (window as any).state?.mutedFiles || activeState?.lastContextData?.mutedFiles || [];

    const isMuted = currentMuted.some((m: string) => {
        const cleanM = (typeof m === 'string' ? m : (m as any)?.path || '').replace(/\\/g, '/').toLowerCase().trim();
        return cleanM === cleanP || cleanP.endsWith('/' + cleanM) || cleanM.endsWith('/' + cleanP);
    });
    if (isMuted) return 'muted';

    const filesList: any[] = activeState?.lastContextData?.files || (window as any).state?.lastContextData?.files || [];
    const registry: Map<string, any> = (window as any).lazyFilesRegistry;

    let fileEntry: any = null;
    if (registry && typeof registry.entries === 'function') {
        for (const [k, v] of registry.entries()) {
            const cleanK = k.replace(/\\/g, '/').toLowerCase().trim();
            if (cleanK === cleanP || cleanP.endsWith('/' + cleanK) || cleanK.endsWith('/' + cleanP)) {
                fileEntry = v;
                break;
            }
        }
    }

    if (!fileEntry && Array.isArray(filesList) && filesList.length > 0) {
        fileEntry = filesList.find((f: any) => {
            const pathStr = typeof f === 'string' ? f : (f?.path || '');
            const cleanF = pathStr.replace(/\\/g, '/').toLowerCase().trim();
            return cleanF === cleanP || cleanP.endsWith('/' + cleanF) || cleanF.endsWith('/' + cleanP);
        });
    }

    if (!fileEntry) {
        return 'not_in_context';
    }

    const fileState = typeof fileEntry === 'object' ? fileEntry.state : undefined;
    if (fileState === 'definitions-only' || fileState === 'structure' || fileState === 'symbols') {
        return 'structure_only';
    }

    return 'full_content';
}
(window as any).getFileContextStatus = getFileContextStatus;

function findMatchingInlineBacktickEnd(line: string, startInLine: number): number {
    let tickCount = 0;
    while (startInLine + tickCount < line.length && line[startInLine + tickCount] === '`') {
        tickCount++;
    }
    if (tickCount === 0) return -1;
    let i = startInLine + tickCount;
    while (i < line.length) {
        if (line[i] === '`') {
            let closeCount = 0;
            while (i + closeCount < line.length && line[i + closeCount] === '`') {
                closeCount++;
            }
            if (closeCount === tickCount) {
                return i + closeCount;
            }
            i += closeCount;
        } else {
            i++;
        }
    }
    return -1;
}

let _lastExtractIn = '';
let _lastExtractOut: ExtractedFileBlock[] = [];

export function extractFileBlocks(text: string): ExtractedFileBlock[] {
    if (!text || typeof text !== 'string') return [];
    if (text === _lastExtractIn) return _lastExtractOut;
    const blocks: ExtractedFileBlock[] = [];

    const targetText = normalizePseudoFileBlocks(text);
    const len = targetText.length;

    let activeFence: { char: string; len: number } | null = null;
    let pendingWrapperFence: { start: number; char: string; len: number } | null = null;
    let inAiderHunk = false;
    let inThinkingTag: string | null = null;
    let processingBlockDepth = 0;
    let openBlock: {
        start: number;
        bodyStart: number;
        attrStr: string;
        startedAtLineStart: boolean;
        wrapperFence?: { start: number; char: string; len: number };
    } | null = null;

    const explicitPathAttrRegex = /\b(?:path|file_path|filepath|file)\s*=\s*(?:["'][^"']+["']|[^\s>]+)/i;
    const closeFileLineRegex = /^[ \t]*<\/\s*file(?:\s+[^>\r\n]*)?\s*>/i;
    const closeFileSliceRegex = /^<\/\s*file(?:\s+[^>\r\n]*)?\s*>/i;

    const isValidOpenTag = (attrStr: string, isAtLineStart: boolean): boolean => {
        const fileAttrs = parseFileTagAttributes(attrStr);
        if (!fileAttrs || !fileAttrs.path || !isValidFilePath(fileAttrs.path) || isPlaceholderFilePath(fileAttrs.path)) {
            return false;
        }
        if (!isAtLineStart && !explicitPathAttrRegex.test(attrStr)) {
            return false;
        }
        return true;
    };

    const nextNonEmptyLineStartsWithValidFile = (fromOffset: number): boolean => {
        let p = fromOffset;
        while (p < len) {
            let nl = targetText.indexOf('\n', p);
            if (nl === -1) nl = len;
            const line = targetText.slice(p, nl).replace(/\r$/, '');
            if (line.trim().length > 0) {
                const fm = line.match(/^[ \t]*<file\s+([^>]*?)>/i);
                return !!(fm && isValidOpenTag(fm[1] || '', true));
            }
            p = nl + 1;
        }
        return false;
    };

    const finalizeClosedBlock = (bodyEnd: number, closeEnd: number) => {
        if (!openBlock) return;
        let end = closeEnd;
        if (openBlock.wrapperFence) {
            const { char, len: fLen } = openBlock.wrapperFence;
            const textAfter = targetText.slice(end);
            const fenceAfterRegex = new RegExp(`^[ \\t]*(?:\\r?\\n)[ \\t]*${char}{${fLen},}[ \\t]*(?=\\r?\\n|$)`);
            const fenceAfterMatch = textAfter.match(fenceAfterRegex);
            if (fenceAfterMatch) {
                end += fenceAfterMatch[0].length;
            }
        }
        let rawContent = targetText.slice(openBlock.bodyStart, bodyEnd);
        if (/^```(?:\w+)?\r?\n([\s\S]*?)\r?\n```$/s.test(rawContent.trim())) {
            rawContent = rawContent.trim().replace(/^```(?:\w+)?\r?\n([\s\S]*?)\r?\n```$/s, '$1');
        }
        blocks.push({
            attrStr: openBlock.attrStr,
            rawContent,
            fullMatch: targetText.slice(openBlock.start, end),
            start: openBlock.start,
            end,
            isClosed: true
        });
        openBlock = null;
        inAiderHunk = false;
    };

    const hasClosedFenceWithOuterCloseFile = (fromOffset: number, fence: { char: string; len: number }): boolean => {
        let pos = fromOffset;
        let sawClosingFence = false;
        let openAfter = 0;
        let closeAfter = 0;
        while (pos < len) {
            let nl = targetText.indexOf('\n', pos);
            if (nl === -1) nl = len;
            const l = targetText.slice(pos, nl).replace(/\r$/, '');
            pos = nl + 1;

            if (!sawClosingFence) {
                const cf = l.match(/^[ \t]*(`{3,}|~{3,})(.*)$/);
                if (cf && cf[1][0] === fence.char && cf[1].length >= fence.len) {
                    const tr = cf[2] || '';
                    if (tr.trim() === '') {
                        sawClosingFence = true;
                        continue;
                    }
                    if (closeFileLineRegex.test(tr) && closeAfter >= openAfter) {
                        return true;
                    }
                }
            }

            if (closeFileLineRegex.test(l)) {
                closeAfter++;
                if (sawClosingFence && closeAfter > openAfter) {
                    return true;
                }
            } else {
                const nf = l.match(/^[ \t]*<file\s+([^>\r\n]*?)>/i);
                if (nf && !nf[1].trim().endsWith('/') && isValidOpenTag(nf[1] || '', true)) {
                    openAfter++;
                }
            }
        }
        return false;
    };

    let lineStart = 0;
    while (lineStart < len) {
        let nlIdx = targetText.indexOf('\n', lineStart);
        let lineEnd = nlIdx === -1 ? len : nlIdx;
        if (lineEnd > lineStart && targetText[lineEnd - 1] === '\r') {
            lineEnd--;
        }
        const nextLineStart = nlIdx === -1 ? len : nlIdx + 1;
        const lineText = targetText.slice(lineStart, lineEnd);

        if (!openBlock && !activeFence) {
            if (processingBlockDepth > 0) {
                const opens = (lineText.match(/<details\b/gi) || []).length;
                const closes = (lineText.match(/<\/details\s*>/gi) || []).length;
                processingBlockDepth = Math.max(0, processingBlockDepth + opens - closes);
                lineStart = nextLineStart;
                continue;
            }
            if (/^[ \t]*<details\b[^>]*class=["'][^"']*processing-block[^"']*["']/i.test(lineText)) {
                const opens = (lineText.match(/<details\b/gi) || []).length;
                const closes = (lineText.match(/<\/details\s*>/gi) || []).length;
                processingBlockDepth = Math.max(0, opens - closes);
                lineStart = nextLineStart;
                continue;
            }
            if (inThinkingTag) {
                if (new RegExp(`</${inThinkingTag}\\s*>`, 'i').test(lineText)) {
                    inThinkingTag = null;
                }
                lineStart = nextLineStart;
                continue;
            }
            const thinkOpenMatch = lineText.match(/^[ \t]*<(think|thinking|thought|analysis|reasoning)\b[^>]*>/i);
            if (thinkOpenMatch) {
                const tagN = thinkOpenMatch[1].toLowerCase();
                if (!new RegExp(`</${tagN}\\s*>`, 'i').test(lineText.slice(thinkOpenMatch[0].length))) {
                    inThinkingTag = tagN;
                }
                lineStart = nextLineStart;
                continue;
            }
        }

        if (openBlock && !activeFence) {
            if (/^[ \t]*<\/(?:think|thinking|thought|analysis|reasoning)>[ \t]*$/i.test(lineText)) {
                // Malformed <file> tag opened during thinking without closing before </think>: discard so parser recovers
                openBlock = null;
                inAiderHunk = false;
                pendingWrapperFence = null;
                lineStart = nextLineStart;
                continue;
            }
            if (/^[ \t]*<details\b[^>]*class=["'][^"']*processing-block[^"']*["']/i.test(lineText)) {
                // Auto-terminate unclosed <file> before an injected auto-execution processing block
                const rawContent = targetText.slice(openBlock.bodyStart, lineStart);
                if (openBlock.startedAtLineStart && rawContent.trim().length > 0) {
                    blocks.push({
                        attrStr: openBlock.attrStr,
                        rawContent,
                        fullMatch: targetText.slice(openBlock.start, lineStart),
                        start: openBlock.start,
                        end: lineStart,
                        isClosed: false
                    });
                }
                openBlock = null;
                inAiderHunk = false;
                pendingWrapperFence = null;
                const opens = (lineText.match(/<details\b/gi) || []).length;
                const closes = (lineText.match(/<\/details\s*>/gi) || []).length;
                processingBlockDepth = Math.max(0, opens - closes);
                lineStart = nextLineStart;
                continue;
            }
        }

        if (openBlock) {
            const trimmedLine = lineText.trim();
            if (/^<{7}\s*search\b/i.test(trimmedLine)) {
                inAiderHunk = true;
            } else if (/^>{7}\s*replace\b/i.test(trimmedLine)) {
                inAiderHunk = false;
            }
        }

        if (activeFence) {
            const closeFenceMatch = lineText.match(/^[ \t]*(`{3,}|~{3,})(.*)$/);
            if (closeFenceMatch && closeFenceMatch[1][0] === activeFence.char && closeFenceMatch[1].length >= activeFence.len) {
                const trailing = closeFenceMatch[2] || '';
                if (trailing.trim() === '') {
                    activeFence = null;
                    lineStart = nextLineStart;
                    continue;
                }
                if (openBlock && closeFileLineRegex.test(trailing)) {
                    const colOffset = lineText.indexOf(trailing);
                    activeFence = null;
                    let col = colOffset;
                    while (col < lineText.length) {
                        if (lineText[col] === '`') {
                            const endCol = findMatchingInlineBacktickEnd(lineText, col);
                            if (endCol !== -1) { col = endCol; continue; }
                        }
                        const closeMatch = openBlock && lineText[col] === '<' ? lineText.slice(col).match(closeFileSliceRegex) : null;
                        if (closeMatch) {
                            finalizeClosedBlock(lineStart + col, lineStart + col + closeMatch[0].length);
                            col += closeMatch[0].length;
                            continue;
                        }
                        col++;
                    }
                    lineStart = nextLineStart;
                    continue;
                }
            }
            if (openBlock && closeFileLineRegex.test(lineText) && !hasClosedFenceWithOuterCloseFile(nextLineStart, activeFence)) {
                activeFence = null;
            } else {
                lineStart = nextLineStart;
                continue;
            }
        }

        const openFenceMatch = lineText.match(/^[ \t]*(`{3,}|~{3,})(.*)$/);
        if (openFenceMatch) {
            const fMarker = openFenceMatch[1];
            const fChar = fMarker[0];
            const fLen = fMarker.length;
            const fTrailing = openFenceMatch[2] || '';
            const isSingleLineInline = fChar === '`' && fTrailing.includes(fMarker);

            if (!isSingleLineInline) {
                if (!openBlock && nextNonEmptyLineStartsWithValidFile(nextLineStart)) {
                    pendingWrapperFence = { start: lineStart, char: fChar, len: fLen };
                } else {
                    pendingWrapperFence = null;
                    activeFence = { char: fChar, len: fLen };
                }
                lineStart = nextLineStart;
                continue;
            }
        }

        let col = 0;
        let seenNonWhitespace = false;
        while (col < lineText.length) {
            const ch = lineText[col];
            if (ch === '`') {
                seenNonWhitespace = true;
                pendingWrapperFence = null;
                const endCol = findMatchingInlineBacktickEnd(lineText, col);
                if (endCol !== -1) {
                    col = endCol;
                    continue;
                }
                col++;
                continue;
            }

            if (ch === '<') {
                const slice = lineText.slice(col);

                if (openBlock) {
                    const closeMatch = slice.match(closeFileSliceRegex);
                    if (closeMatch) {
                        const closeLen = closeMatch[0].length;
                        const closeEnd = lineStart + col + closeLen;
                        let adjustedEnd = closeEnd;
                        if (!seenNonWhitespace) {
                            const trailingAfterClose = lineText.slice(col + closeLen);
                            if (trailingAfterClose.trim() === '') {
                                adjustedEnd = nextLineStart;
                            }
                        }
                        finalizeClosedBlock(lineStart + col, adjustedEnd);
                        col += closeLen;
                        seenNonWhitespace = true;
                        continue;
                    }

                    if (!seenNonWhitespace && !inAiderHunk) {
                        const nextOpenMatch = slice.match(/^<file\s+([^>\r\n]*?)>/i);
                        if (nextOpenMatch && isValidOpenTag(nextOpenMatch[1] || '', true)) {
                            finalizeClosedBlock(lineStart + col, lineStart + col);
                            if (nextOpenMatch[1].trim().endsWith('/')) {
                                col += nextOpenMatch[0].length;
                                seenNonWhitespace = true;
                                continue;
                            }
                            openBlock = {
                                start: lineStart + col,
                                bodyStart: lineStart + col + nextOpenMatch[0].length,
                                attrStr: nextOpenMatch[1] || '',
                                startedAtLineStart: true
                            };
                            inAiderHunk = false;
                            col += nextOpenMatch[0].length;
                            seenNonWhitespace = true;
                            continue;
                        }
                    }
                } else {
                    const openMatch = slice.match(/^<file\s+([^>\r\n]*?)>/i);
                    if (openMatch && isValidOpenTag(openMatch[1] || '', !seenNonWhitespace)) {
                        if (openMatch[1].trim().endsWith('/')) {
                            pendingWrapperFence = null;
                            col += openMatch[0].length;
                            seenNonWhitespace = true;
                            continue;
                        }
                        const wrapper = !seenNonWhitespace ? pendingWrapperFence || undefined : undefined;
                        openBlock = {
                            start: wrapper ? wrapper.start : lineStart + col,
                            bodyStart: lineStart + col + openMatch[0].length,
                            attrStr: openMatch[1] || '',
                            startedAtLineStart: !seenNonWhitespace,
                            wrapperFence: wrapper
                        };
                        inAiderHunk = false;
                        pendingWrapperFence = null;
                        col += openMatch[0].length;
                        seenNonWhitespace = true;
                        continue;
                    }
                }
            }

            if (ch !== ' ' && ch !== '\t') {
                seenNonWhitespace = true;
                pendingWrapperFence = null;
            }
            col++;
        }

        lineStart = nextLineStart;
    }

    if (openBlock && openBlock.startedAtLineStart) {
        let rawContent = targetText.slice(openBlock.bodyStart);
        if (/^```(?:\w+)?\r?\n([\s\S]*?)\r?\n```$/s.test(rawContent.trim())) {
            rawContent = rawContent.trim().replace(/^```(?:\w+)?\r?\n([\s\S]*?)\r?\n```$/s, '$1');
        }
        blocks.push({
            attrStr: openBlock.attrStr,
            rawContent,
            fullMatch: targetText.slice(openBlock.start),
            start: openBlock.start,
            end: len,
            isClosed: false
        });
    }

    _lastExtractIn = text;
    _lastExtractOut = blocks;
    return blocks;
}

export const fileMutationPlugin: TagPlugin = {
    id: 'file_mutation',
    extractBlocks: (content: string, context: PluginContext) => {
        const blocks = extractFileBlocks(content);
        const results: { match: any, start: number, end: number, html: string }[] = [];
        blocks.forEach((b, idx) => {
            const matchObj = [b.fullMatch, b.attrStr, b.rawContent];
            (matchObj as any).index = b.start;
            const html = fileMutationPlugin.render(matchObj, {
                ...context,
                blockIndex: context.blockIndex !== undefined ? context.blockIndex + idx : idx
            });
            if (html) {
                results.push({
                    match: matchObj,
                    start: b.start,
                    end: b.end,
                    html
                });
            }
        });
        return results;
    },
    render: (match, context) => {
        const attrStr = match[1] || "";
        let rawContent = (match[2] || "").trim();

        // Strip markdown code fences if model wrapped content inside <file> tag
        if (/^```(?:\w+)?\r?\n([\s\S]*?)\r?\n```$/s.test(rawContent)) {
            rawContent = rawContent.replace(/^```(?:\w+)?\r?\n([\s\S]*?)\r?\n```$/s, '$1').trim();
        }

        const fileAttrs = parseFileTagAttributes(attrStr, rawContent);
        if (!fileAttrs || !fileAttrs.path) return null;

        const escapeHtmlAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
        const filePath = fileAttrs.path;
        const safeFilePath = escapeHtmlAttr(filePath);
        const action = fileAttrs.action;
        const symbol = fileAttrs.symbol || "";
        const safeSymbol = escapeHtmlAttr(symbol);

        

        const isDeleteCode = action === 'delete_code';
        const isPatch = !isDeleteCode && (action === 'patch' || (action !== 'write' && action !== 'update_symbol' && rawContent.includes('<<<<<<< SEARCH')));
        const blockIdx = context.blockIndex !== undefined ? context.blockIndex : 0;
        const blockId = `file-mutation-${context.messageId}-${blockIdx}`;
        const actionLabel = isDeleteCode ? 'DELETE CODE' : (isPatch ? 'SURGICAL PATCH' : (symbol ? `SYMBOL: ${symbol}` : 'WRITE FILE'));
        const actionIcon = isDeleteCode ? 'codicon-diff-removed' : (isPatch ? 'codicon-diff-modified' : (symbol ? 'codicon-symbol-method' : 'codicon-file-code'));

        const ext = filePath.split('.').pop() || 'plaintext';
        // Only mark as streaming if the message is genuinely still in-flight AND global state is generating
        const isActivelyGenerating = state.isGenerating || (window as any).state?.isGenerating;
        const isStreaming = !context.isFinal && isActivelyGenerating && !match[0].includes('</file>');

        // Check persisted state
        const activeState = state?.appliedState ? state : (window as any).state;
        const appliedHunks = activeState?.appliedState?.[context.messageId]?.[blockIdx] || [];
        const isApplied = appliedHunks.includes(-1);

        let bodyHtml = "";

        if (isDeleteCode) {
            let cleanDelete = rawContent;
            if (cleanDelete.includes('<<<<<<< SEARCH')) {
                const parsedDel = parseAiderHunks(normalizeAiderContent(cleanDelete));
                if (parsedDel.length > 0) {
                    cleanDelete = parsedDel.map(h => h.searchPart).filter(Boolean).join('\n');
                } else {
                    cleanDelete = cleanDelete.replace(/<<<<<<< SEARCH\r?\n?/g, '').replace(/\r?\n?=======[\s\S]*?>>>>>>> REPLACE/g, '').replace(/\r?\n?>>>>>>> REPLACE/g, '');
                }
            }
            const delLines = cleanDelete.replace(/\r\n/g, '\n').split('\n');
            bodyHtml = `
            <div class="hunk-contents-wrapper">
                <div class="aider-hunk-bubble">
                    <div class="aider-hunk-content">
                        <pre style="margin:0; padding:12px; background:var(--vscode-editor-background); border:none; overflow:auto; max-height:350px;">${renderDiffLines(delLines, 'removed')}</pre>
                    </div>
                </div>
            </div>`;
        } else if (isPatch) {
            const normalizedRaw = normalizeAiderContent(rawContent);
            const hunks = parseAiderHunks(normalizedRaw);

            if (hunks.length > 0) {
                if (hunks.length > 1) {
                    // --- MULTI-HUNK TABBED VIEW ---
                    const navTabsHtml = hunks.map((h, hIdx) => {
                        const isHunkApplied = appliedHunks.includes(hIdx) || isApplied;
                        const statusClass = isHunkApplied ? 'status-completed' : '';
                        const statusIcon = isHunkApplied ? 'codicon-check' : 'codicon-primitive-dot';

                        return `
                        <div class="hunk-tab hunk-tab-${hIdx} ${hIdx === 0 ? 'active' : ''} ${statusClass}" data-hunk-index="${hIdx}">
                            <span class="hunk-status-icon"><i class="codicon ${statusIcon}"></i></span> HUNK ${hIdx + 1}
                        </div>`;
                    }).join('');

                    const panesHtml = hunks.map((h, hIdx) => {
                        const sLines = (h.searchPart || "").replace(/\r\n/g, '\n').split('\n');
                        const rawRLines = (h.replacePart || "").replace(/\r\n/g, '\n').split('\n');
                        const rLines = (rawRLines.length === 1 && rawRLines[0] === '') ? [] : rawRLines;

                        let pref = 0;
                        while (pref < sLines.length && pref < rLines.length && sLines[pref].trim() === rLines[pref].trim()) {
                            pref++;
                        }
                        let suff = 0;
                        while (suff < (sLines.length - pref) && suff < (rLines.length - pref) && sLines[sLines.length - 1 - suff].trim() === rLines[rLines.length - 1 - suff].trim()) {
                            suff++;
                        }

                        const isHunkApplied = appliedHunks.includes(hIdx) || isApplied;

                        return `
                        <div class="hunk-tab-content hunk-pane-${hIdx} ${hIdx === 0 ? 'active' : ''}" id="pane-${blockId}-${hIdx}">
                            <div class="aider-hunk-bubble">
                                <div class="aider-hunk-content">
                                    <pre style="margin:0; padding:12px; background:var(--vscode-editor-background); border:none; overflow:auto; max-height:350px;">${renderDiffLines(sLines.slice(0, pref), 'unchanged')}${renderDiffLines(sLines.slice(pref, sLines.length - suff), 'removed')}${renderDiffLines(rLines.slice(pref, rLines.length - suff), 'added')}${renderDiffLines(sLines.slice(sLines.length - suff), 'unchanged')}</pre>
                                </div>
                                <div class="aider-hunk-header" style="border-top: 1px solid var(--vscode-widget-border); border-bottom: none;">
                                    <div style="font-size: 10px; opacity:0.7;">Hunk ${hIdx + 1} of ${hunks.length}</div>
                                    <div class="aider-hunk-actions">
                                        <button class="code-action-btn delete-btn undo-hunk-btn" style="display: ${isHunkApplied ? 'inline-flex' : 'none'};" data-hunk-index="${hIdx}" title="Undo this hunk"><i class="codicon codicon-discard"></i> Undo</button>
                                        <button class="code-action-btn secondary-btn raw-hunk-btn" data-hunk-index="${hIdx}" title="Open Raw Stitching view for this hunk"><i class="codicon codicon-tools"></i> Raw</button>
                                        <button class="code-action-btn apply-btn hunk-fix-ai-btn" data-hunk-index="${hIdx}" style="background-color: var(--vscode-charts-purple) !important; color: white !important;" title="Ask AI to repair this specific hunk"><i class="codicon codicon-sparkle"></i> Fix Hunk</button>
                                        <button class="code-action-btn apply-btn apply-hunk-btn ${isHunkApplied ? 'applied' : ''}" data-hunk-index="${hIdx}" title="Apply this hunk"><i class="codicon ${isHunkApplied ? 'codicon-check' : 'codicon-arrow-swap'}"></i> Apply Hunk</button>
                                    </div>
                                </div>
                            </div>
                        </div>`;
                    }).join('');

                    bodyHtml = `
                    <div class="hunk-tabs-container">
                        <div class="hunk-tabs-nav">
                            ${navTabsHtml}
                        </div>
                        <div class="hunk-contents-wrapper">
                            ${panesHtml}
                        </div>
                    </div>`;
                } else {
                    // Single hunk view
                    const h = hunks[0];
                    const sLines = (h.searchPart || "").replace(/\r\n/g, '\n').split('\n');
                    const rawRLines = (h.replacePart || "").replace(/\r\n/g, '\n').split('\n');
                    const rLines = (rawRLines.length === 1 && rawRLines[0] === '') ? [] : rawRLines;

                    let pref = 0;
                    while (pref < sLines.length && pref < rLines.length && sLines[pref].trim() === rLines[pref].trim()) {
                        pref++;
                    }
                    let suff = 0;
                    while (suff < (sLines.length - pref) && suff < (rLines.length - pref) && sLines[sLines.length - 1 - suff].trim() === rLines[rLines.length - 1 - suff].trim()) {
                        suff++;
                    }

                    bodyHtml = `
                    <div class="hunk-contents-wrapper">
                        <div class="aider-hunk-bubble">
                            <div class="aider-hunk-content">
                                <pre style="margin:0; padding:12px; background:var(--vscode-editor-background); border:none; overflow:auto; max-height:350px;">${renderDiffLines(sLines.slice(0, pref), 'unchanged')}${renderDiffLines(sLines.slice(pref, sLines.length - suff), 'removed')}${renderDiffLines(rLines.slice(pref, rLines.length - suff), 'added')}${renderDiffLines(sLines.slice(sLines.length - suff), 'unchanged')}</pre>
                            </div>
                        </div>
                    </div>`;
                }
            } else {
                const escapedCode = rawContent.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
                bodyHtml = `<pre style="margin:0; padding:12px; max-height:400px; overflow:auto;"><code class="language-${ext}">${escapedCode}</code></pre>`;
            }
        } else {
            const escapedCode = rawContent.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
            bodyHtml = `<pre style="margin:0; padding:12px; max-height:400px; overflow:auto;"><code class="language-${ext}">${escapedCode}</code></pre>`;
        }

        const encodedRawCode = encodeURIComponent(rawContent);

        // Render open by default if not applied
        const openAttr = isApplied ? '' : 'open';
        const applyBtnClass = isStreaming ? 'apply-btn' : (isApplied ? 'applied' : 'apply-btn');
        const applyBtnIcon = isStreaming ? 'codicon-loading spin' : (isApplied ? 'codicon-check' : (isPatch ? 'codicon-arrow-swap' : 'codicon-tools'));
        const applyBtnTitle = isStreaming ? 'Streaming code changes...' : (isApplied ? 'Successfully applied. Click to re-apply.' : (isPatch ? 'Review Diff & Apply Patch' : 'Apply File Content'));
        const applyBtnDisabled = isStreaming ? 'disabled style="opacity:0.6;"' : '';

        return `
        <details class="code-collapsible file-mutation-card" id="${blockId}" data-path="${safeFilePath}" data-action="${action}" data-symbol="${safeSymbol}" data-block-index="${blockIdx}" data-raw-code="${encodedRawCode}" ${openAttr}>
            <summary class="code-summary">
                <div class="summary-lang-label">
                    <span class="lang-badge" data-lang="${escapeHtmlAttr(ext)}">${escapeHtmlAttr(ext)}</span>
                    <span class="path-display-label" style="font-family: var(--vscode-editor-font-family); font-size: 11px; font-weight: bold; margin-left: 8px; color: var(--vscode-textLink-foreground);">
                        <i class="codicon ${actionIcon}"></i> ${safeFilePath}${safeSymbol ? ` (${safeSymbol})` : ''}
                    </span>
                    <span class="mode-badge active" style="font-size: 9px; padding: 1px 6px; margin-left: 6px;">${actionLabel}</span>
                    ${isStreaming ? '<span class="file-stream-indicator" style="display: inline-flex; align-items: center; gap: 4px; font-size: 10px; color: var(--vscode-charts-blue); font-weight: bold; margin-left: 6px;"><i class="codicon codicon-sync spin"></i> Streaming...</span>' : ''}
                    <button class="code-action-btn goto-file-btn" style="height: 18px; font-size: 9px; padding: 0 5px;" title="Goto: Open this file">Goto</button>
                </div>
                <div class="code-actions">
                    <button class="code-action-btn copy-mutation-btn" title="Copy Content"><i class="codicon codicon-copy"></i></button>
                    ${isPatch ? `<button class="code-action-btn raw-stitch-mutation-btn" title="Open Manual Stitching View"><i class="codicon codicon-source-control"></i></button>` : ''}
                    ${isApplied ? `<button class="code-action-btn secondary-btn redo-mutation-btn" title="Redo / Re-apply this change"><i class="codicon codicon-redo"></i></button>` : ''}
                    ${(isApplied && isPatch) ? `<button class="code-action-btn delete-btn undo-mutation-btn" title="Undo this patch"><i class="codicon codicon-discard"></i></button>` : ''}
                    <button class="code-action-btn ${applyBtnClass} apply-mutation-btn" ${applyBtnDisabled} title="${applyBtnTitle}"><i class="codicon ${applyBtnIcon}"></i></button>
                </div>
            </summary>
            ${bodyHtml}
        </details>`;
    },
    initialize: (container, context) => {
        container.querySelectorAll('.file-mutation-card').forEach((card: any) => {
            const filePath = card.dataset.path;
            const action = card.dataset.action;
            const symbol = card.dataset.symbol;
            const blockIndex = parseInt(card.dataset.blockIndex || "0", 10);
            const rawCodeAttr = card.dataset.rawCode;
            const rawContent = rawCodeAttr ? decodeURIComponent(rawCodeAttr) : (card.querySelector('pre code')?.textContent || "");

            // Tab navigation for multi-hunk cards
            card.querySelectorAll('.hunk-tab').forEach((tab: HTMLElement) => {
                tab.onclick = (e: MouseEvent) => {
                    e.stopPropagation();
                    const hIdx = tab.dataset.hunkIndex;
                    const nav = tab.closest('.hunk-tabs-nav');
                    const wrapper = card.querySelector('.hunk-contents-wrapper');

                    if (nav && wrapper && hIdx !== undefined) {
                        nav.querySelectorAll('.hunk-tab').forEach((t: Element) => t.classList.remove('active'));
                        wrapper.querySelectorAll('.hunk-tab-content').forEach((p: Element) => p.classList.remove('active'));

                        tab.classList.add('active');
                        wrapper.querySelector(`.hunk-pane-${hIdx}`)?.classList.add('active');
                    }
                };
            });

            const setApplyingStopStyle = (btnEl: HTMLElement, active: boolean) => {
                if (active) {
                    btnEl.dataset.applying = 'true';
                    btnEl.dataset.prevHtml = btnEl.innerHTML;
                    btnEl.dataset.prevTitle = btnEl.title;
                    btnEl.classList.add('stop-btn-red');
                    btnEl.style.setProperty('background-color', 'var(--vscode-charts-red, #e51400)', 'important');
                    btnEl.style.setProperty('color', '#ffffff', 'important');
                    btnEl.style.setProperty('border-color', 'var(--vscode-charts-red, #e51400)', 'important');
                    btnEl.title = 'Applying... Click to stop';
                    btnEl.innerHTML = '<div class="spinner" style="border-color: rgba(255,255,255,0.35); border-top-color: #ffffff;"></div>';
                } else {
                    delete btnEl.dataset.applying;
                    btnEl.classList.remove('stop-btn-red');
                    btnEl.style.removeProperty('background-color');
                    btnEl.style.removeProperty('color');
                    btnEl.style.removeProperty('border-color');
                    if (btnEl.dataset.prevHtml) btnEl.innerHTML = btnEl.dataset.prevHtml;
                    if (btnEl.dataset.prevTitle) btnEl.title = btnEl.dataset.prevTitle;
                }
            };

            const dispatchApplyMutation = (triggerBtn: HTMLElement, hIdx?: number) => {
                if (triggerBtn.dataset.applying === 'true') {
                    setApplyingStopStyle(triggerBtn, false);
                    context.vscode.postMessage({ command: 'stopGeneration' });
                    return;
                }
                setApplyingStopStyle(triggerBtn, true);

                if (action === 'delete_code') {
                    context.vscode.postMessage({
                        command: 'deleteCodeBlock',
                        filePath,
                        content: rawContent,
                        messageId: context.messageId,
                        blockIndex: blockIndex,
                        blockId: card.id,
                        options: { silent: false, autoSave: false, blockId: card.id, blockIndex: blockIndex }
                    });
                } else if (action === 'patch' || (action !== 'write' && action !== 'update_symbol' && rawContent.includes('<<<<<<< SEARCH'))) {
                    context.vscode.postMessage({
                        command: 'replaceCode',
                        filePath,
                        content: rawContent,
                        messageId: context.messageId,
                        blockIndex: blockIndex,
                        hunkIndex: hIdx,
                        blockId: card.id,
                        options: { silent: false, autoSave: false, blockId: card.id, blockIndex: blockIndex, hunkIndex: hIdx }
                    });
                } else {
                    const targetPath = symbol ? `${filePath}:${symbol}` : filePath;
                    context.vscode.postMessage({
                        command: 'applyFileContent',
                        filePath: targetPath,
                        content: rawContent,
                        messageId: context.messageId,
                        blockIndex: blockIndex,
                        blockId: card.id,
                        options: { silent: false, autoSave: false, blockId: card.id, blockIndex: blockIndex }
                    });
                }
            };

            // Individual Hunk Apply buttons
            card.querySelectorAll('.apply-hunk-btn').forEach((hunkBtn: HTMLElement) => {
                hunkBtn.onclick = (e: MouseEvent) => {
                    e.stopPropagation();
                    const hIdx = parseInt(hunkBtn.dataset.hunkIndex || "0", 10);
                    dispatchApplyMutation(hunkBtn, hIdx);
                };
            });

            // Individual Hunk Fix with AI buttons directly inside the hunk pane
            card.querySelectorAll('.hunk-fix-ai-btn').forEach((fixBtn: HTMLElement) => {
                fixBtn.onclick = (e: MouseEvent) => {
                    e.stopPropagation();
                    const hIdx = parseInt((fixBtn as HTMLElement).dataset.hunkIndex || "0", 10);
                    (fixBtn as HTMLButtonElement).disabled = true;
                    fixBtn.innerHTML = '<div class="spinner"></div> Fixing...';

                    context.vscode.postMessage({
                        command: 'replaceCode',
                        filePath,
                        content: "REPAIR_REQUESTED",
                        messageId: context.messageId,
                        blockIndex: blockIndex,
                        hunkIndex: hIdx,
                        options: { silent: true, blockIndex: blockIndex, hunkIndex: hIdx }
                    });
                };
            });

            // Individual Hunk Raw Stitch buttons directly inside the hunk pane
            card.querySelectorAll('.raw-hunk-btn').forEach((rawBtn: HTMLElement) => {
                rawBtn.onclick = (e: MouseEvent) => {
                    e.stopPropagation();
                    const hIdx = parseInt((rawBtn as HTMLElement).dataset.hunkIndex || "0", 10);
                    if (typeof (window as any).openRawCodeModal === 'function') {
                        (window as any).openRawCodeModal(context.messageId, blockIndex, filePath, rawContent, hIdx, card.id);
                    }
                };
            });

            // Individual Hunk Undo buttons
            card.querySelectorAll('.undo-hunk-btn').forEach((undoHunkBtn: HTMLElement) => {
                undoHunkBtn.onclick = (e: MouseEvent) => {
                    e.stopPropagation();
                    const hIdx = parseInt((undoHunkBtn as HTMLElement).dataset.hunkIndex || "0", 10);
                    (undoHunkBtn as HTMLButtonElement).disabled = true;
                    undoHunkBtn.innerHTML = '<div class="spinner"></div>';

                    context.vscode.postMessage({
                        command: 'replaceCode',
                        filePath,
                        content: rawContent,
                        messageId: context.messageId,
                        blockIndex: blockIndex,
                        hunkIndex: hIdx,
                        blockId: card.id,
                        options: { undo: true, silent: true, autoSave: true, blockId: card.id, blockIndex: blockIndex, hunkIndex: hIdx }
                    });
                };
            });

            const applyBtn = card.querySelector('.apply-mutation-btn') as HTMLButtonElement;
            if (applyBtn) {
                applyBtn.onclick = (e: MouseEvent) => {
                    e.stopPropagation();
                    dispatchApplyMutation(applyBtn);
                };
            }

            const redoBtn = card.querySelector('.redo-mutation-btn') as HTMLButtonElement;
            if (redoBtn) {
                redoBtn.onclick = (e: MouseEvent) => {
                    e.stopPropagation();
                    dispatchApplyMutation(redoBtn);
                };
            }

            const undoBtn = card.querySelector('.undo-mutation-btn') as HTMLButtonElement;
            if (undoBtn) {
                undoBtn.onclick = (e: MouseEvent) => {
                    e.stopPropagation();
                    undoBtn.disabled = true;
                    undoBtn.innerHTML = '<div class="spinner"></div>';

                    context.vscode.postMessage({
                        command: 'replaceCode',
                        filePath,
                        content: rawContent,
                        messageId: context.messageId,
                        blockIndex: blockIndex,
                        blockId: card.id,
                        options: { undo: true, silent: true, autoSave: true, blockId: card.id, blockIndex: blockIndex }
                    });
                };
            }

            const copyBtn = card.querySelector('.copy-mutation-btn');
            if (copyBtn) {
                copyBtn.onclick = (e: MouseEvent) => {
                    e.stopPropagation();
                    context.vscode.postMessage({ command: 'copyToClipboard', text: rawContent });
                };
            }

            const gotoBtn = card.querySelector('.goto-file-btn');
            if (gotoBtn) {
                gotoBtn.onclick = (e: MouseEvent) => {
                    e.stopPropagation();
                    context.vscode.postMessage({ command: 'openFile', path: filePath });
                };
            }

            const rawStitchBtn = card.querySelector('.raw-stitch-mutation-btn');
            if (rawStitchBtn) {
                rawStitchBtn.onclick = (e: MouseEvent) => {
                    e.stopPropagation();
                    if (typeof (window as any).openRawCodeModal === 'function') {
                        (window as any).openRawCodeModal(context.messageId, blockIndex, filePath, rawContent, 0, card.id);
                    }
                };
            }
        });
    }
};

export const fileOpPlugin: TagPlugin = {
    id: 'file_operations',
    tagPattern: /<(move_files|copy_files|delete_files|remove_files_from_context|mute_files|unmute_files)\b([^>]*?)>([\s\S]*?)<\/\1>/gim,

    render: (match) => {
        const type = match[1];
        const attrPart = match[2] || "";
        const inner = (match[3] || "").trim();

        let lines: string[] = [];

        const attrMatch = attrPart.match(/paths=['"](\[.*?\])['"]/i);
        if (attrMatch) {
            try { lines = JSON.parse(attrMatch[1].replace(/'/g, '"')); } catch(e) {}
        }

        if (lines.length === 0) {
            const singlePathAttr = attrPart.match(/\bpath=['"]([^'"]+)['"]/i);
            if (singlePathAttr && singlePathAttr[1].trim()) {
                lines.push(singlePathAttr[1].trim());
            }
        }

        if (lines.length === 0) {
            lines = inner.split('\n')
                .map(l => l.trim().replace(/^['"`]|['"`]$/g, '').replace(/^-\s*/, '').trim())
                .filter(l => l.length > 0 && !l.startsWith('<') && l !== '...');
        }

        if (type === 'delete_files') {
            lines = Array.from(new Set(lines.filter(l => isValidFilePath(l))));
        }

        if (lines.length === 0) return null;

        const blockId = `file-op-${type}-${Date.now().toString(36)}-${Math.random().toString(36).substring(7)}`;

        let title = "", icon = "", command = "", btnText = "";
        let detailsHtml = "";
        let payload: any = {};
        let allFullyActive = false;

        if (type === 'remove_files_from_context') {
            title = "Context Pruning Proposed";
            icon = "codicon-clear-all";
            command = "bulkRemoveFiles";
            btnText = `Remove from Context (${lines.length} files)`;
            detailsHtml = lines.map(p => `
                <div class="expansion-file-item" style="display: flex; align-items: center; gap: 8px; padding: 4px 8px; font-family: var(--vscode-editor-font-family); font-size: 11px;">
                    <span class="codicon codicon-trash" style="color: var(--vscode-charts-red, #f44336);"></span>
                    <span class="file-label" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${p}</span>
                </div>
            `).join('');
            payload = { paths: lines };
        } else if (type === 'mute_files') {
            title = "File Content Muting Proposed (0 Tokens)";
            icon = "codicon-eye-closed";
            command = "bulkMuteFiles";
            btnText = `Mute Files (${lines.length})`;
            detailsHtml = lines.map(p => `
                <div class="expansion-file-item" style="display: flex; align-items: center; gap: 8px; padding: 4px 8px; font-family: var(--vscode-editor-font-family); font-size: 11px;">
                    <span class="codicon codicon-eye-closed" style="color: var(--vscode-charts-orange, #ff9800);"></span>
                    <span class="file-label" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${p}</span>
                </div>
            `).join('');
            payload = { paths: lines };
        } else if (type === 'unmute_files') {
            title = "File Content Activation (Unmute) Proposed";
            icon = "codicon-eye";
            command = "bulkUnmuteFiles";

            const linesStatus = lines.map(p => ({
                path: p,
                status: getFileContextStatus(p)
            }));

            const mutedLines = linesStatus.filter(x => x.status === 'muted').map(x => x.path);
            const structureOnlyLines = linesStatus.filter(x => x.status === 'structure_only').map(x => x.path);
            const notInContextLines = linesStatus.filter(x => x.status === 'not_in_context').map(x => x.path);
            const fullyActiveLines = linesStatus.filter(x => x.status === 'full_content').map(x => x.path);

            const needsActivationLines = [...mutedLines, ...structureOnlyLines, ...notInContextLines];
            allFullyActive = needsActivationLines.length === 0;

            let btnText = "Activate Full Content";
            if (allFullyActive) {
                btnText = "All Files Fully Active [C]";
            } else if (structureOnlyLines.length > 0 && mutedLines.length === 0) {
                btnText = `Upgrade to Full Content (${structureOnlyLines.length})`;
            } else if (mutedLines.length > 0) {
                btnText = `Unmute to Full Content (${needsActivationLines.length})`;
            } else {
                btnText = `Activate Full Content (${needsActivationLines.length})`;
            }

            let infoBannerHtml = "";
            if (allFullyActive) {
                infoBannerHtml = `
                <div style="padding: 6px 10px; background: rgba(56, 142, 60, 0.1); border: 1px solid var(--vscode-charts-green); border-radius: 4px; font-size: 11px; margin-bottom: 8px; color: var(--vscode-charts-green); display: flex; align-items: center; gap: 6px;">
                    <i class="codicon codicon-check"></i> All requested files are ALREADY active in context [C] with full source code loaded.
                </div>`;
            } else if (structureOnlyLines.length > 0) {
                infoBannerHtml = `
                <div style="padding: 6px 10px; background: rgba(0, 122, 204, 0.1); border: 1px solid var(--vscode-charts-blue); border-radius: 4px; font-size: 11px; margin-bottom: 8px; color: var(--vscode-charts-blue); display: flex; align-items: center; gap: 6px;">
                    <i class="codicon codicon-symbol-class"></i> ${structureOnlyLines.length} file(s) are currently loaded as <strong>Structure Only [D]</strong>. Click below to upgrade to full source code [C].
                </div>`;
            } else if (fullyActiveLines.length > 0) {
                infoBannerHtml = `
                <div style="padding: 6px 10px; background: rgba(0, 122, 204, 0.08); border: 1px solid var(--vscode-charts-blue); border-radius: 4px; font-size: 11px; margin-bottom: 8px; color: var(--vscode-foreground); display: flex; align-items: center; gap: 6px;">
                    <i class="codicon codicon-info"></i> ${fullyActiveLines.length} file(s) are already fully active [C]. Activating remaining ${needsActivationLines.length} file(s).
                </div>`;
            }

            detailsHtml = infoBannerHtml + linesStatus.map(item => {
                const p = item.path;
                const status = item.status;
                const encodedSingle = JSON.stringify([p]).replace(/"/g, '&quot;');

                let badgeHtml = '';
                let statusClass = 'status-in-context';
                let iconName = 'codicon-check';
                let iconColor = 'var(--vscode-charts-green, #4caf50)';
                let rowBg = '';
                let rowBorder = '';

                if (status === 'structure_only') {
                    statusClass = 'status-structure-only';
                    iconName = 'codicon-symbol-class';
                    iconColor = 'var(--vscode-charts-blue, #007acc)';
                    rowBg = 'background: rgba(0, 122, 204, 0.1);';
                    rowBorder = 'border-left: 4px solid var(--vscode-charts-blue, #007acc); border-color: rgba(0, 122, 204, 0.35);';
                    badgeHtml = `<span class="file-token-badge weight-medium" style="border-color: var(--vscode-charts-blue); color: var(--vscode-charts-blue); background: rgba(0, 122, 204, 0.15); font-weight: bold;">[STRUCTURE ONLY - [D]]</span>`;
                } else if (status === 'muted') {
                    statusClass = 'status-not-in-context';
                    iconName = 'codicon-eye-closed';
                    iconColor = 'var(--vscode-charts-orange, #ff9800)';
                    rowBg = 'background: rgba(255, 152, 0, 0.08);';
                    rowBorder = 'border-left: 4px solid var(--vscode-charts-orange, #ff9800);';
                    badgeHtml = `<span class="file-token-badge weight-muted" style="border-color: var(--vscode-charts-orange); color: var(--vscode-charts-orange);">[MUTED - WILL UNMUTE]</span>`;
                } else if (status === 'not_in_context') {
                    statusClass = 'status-not-exist';
                    iconName = 'codicon-file-add';
                    iconColor = 'var(--vscode-charts-orange, #ff9800)';
                    rowBorder = 'border-left: 4px solid var(--vscode-charts-orange, #ff9800);';
                    badgeHtml = `<span class="file-token-badge weight-light" style="border-color: var(--vscode-charts-orange); color: var(--vscode-charts-orange);">[NOT IN CONTEXT - WILL LOAD]</span>`;
                } else {
                    statusClass = 'status-in-context';
                    iconName = 'codicon-check';
                    iconColor = 'var(--vscode-charts-green, #4caf50)';
                    rowBg = 'background: rgba(15, 157, 88, 0.08);';
                    rowBorder = 'border-left: 4px solid var(--vscode-charts-green, #4caf50);';
                    badgeHtml = `<span class="file-token-badge weight-light" style="border-color: var(--vscode-charts-green); color: var(--vscode-charts-green);">[FULL CONTENT - [C]]</span>`;
                }

                return `
                <div class="expansion-file-item ${statusClass}" data-path="${p}" style="display: flex; align-items: center; justify-content: space-between; padding: 4px 8px; font-family: var(--vscode-editor-font-family); font-size: 11px; ${rowBg} ${rowBorder}">
                    <div style="display: flex; align-items: center; gap: 8px; min-width: 0;">
                        <span class="codicon ${iconName}" style="color: ${iconColor};"></span>
                        <span class="file-label" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${p}</span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 6px; margin-left: 8px;">
                        ${badgeHtml}
                        <button class="code-action-btn secondary-btn copy-unmute-files-btn copy-files-to-clipboard-btn" data-files="${encodedSingle}" title="Copy this file as a <file> block into clipboard" style="height: 18px; font-size: 9px; padding: 0 5px;">
                            <span class="codicon codicon-copy"></span>
                        </button>
                    </div>
                </div>`;
            }).join('');
            payload = { paths: needsActivationLines.length > 0 ? needsActivationLines : lines };
        } else if (type === 'delete_files') {
            title = `File Deletion Proposed (${lines.length} file${lines.length > 1 ? 's' : ''})`;
            icon = "codicon-trash";
            command = "deleteFile";
            btnText = lines.length === 1 ? `Delete File` : `Delete All (${lines.length} files)`;
            detailsHtml = lines.map((p, idx) => {
                const rowId = `${blockId}-del-${idx}`;
                return `
                <div class="expansion-file-item delete-file-row" id="${rowId}" data-path="${p}" style="display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 8px; font-family: var(--vscode-editor-font-family); font-size: 11px; border-left: 3px solid var(--vscode-charts-red, #f44336);">
                    <div style="display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1;">
                        <span class="codicon codicon-trash" style="color: var(--vscode-charts-red, #f44336); flex-shrink: 0;"></span>
                        <span class="file-label" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${p}">${p}</span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 4px; flex-shrink: 0;">
                        <button class="code-action-btn secondary-btn open-delete-target-btn" data-path="${p}" style="height: 18px; font-size: 9px; padding: 0 5px;" title="Open file to inspect before deleting">
                            <span class="codicon codicon-go-to-file"></span> Open
                        </button>
                        ${lines.length > 1 ? `
                        <button class="code-action-btn delete-btn delete-single-file-btn" data-path="${p}" data-row-id="${rowId}" data-block-id="${blockId}" style="height: 18px; font-size: 9px; padding: 0 6px;" title="Delete only this file">
                            <span class="codicon codicon-trash"></span> Delete
                        </button>` : ''}
                    </div>
                </div>`;
            }).join('');
            payload = { filePaths: lines, paths: lines };
        } else if (type === 'move_files' || type === 'copy_files') {
            title = type === 'move_files' ? "Move/Rename Proposed" : "Copy Proposed";
            icon = type === 'move_files' ? "codicon-arrow-swap" : "codicon-files";
            command = type === 'move_files' ? "bulkMoveFiles" : "bulkCopyFiles";
            btnText = type === 'move_files' ? "Apply Move" : "Apply Copy";
            const ops: { src: string, dest: string }[] = [];
            lines.forEach(l => {
                const [src, dest] = l.split('->').map(s => s.trim());
                if (src && dest) {
                    ops.push({ src, dest });
                }
            });
            detailsHtml = ops.map(op => `
                <div class="file-operation-details" style="display: flex; align-items: center; gap: 8px; padding: 4px 8px; font-family: var(--vscode-editor-font-family); font-size: 11px;">
                    <span>${op.src}</span>
                    <i class="codicon codicon-arrow-right"></i>
                    <span style="font-weight: bold;">${op.dest}</span>
                </div>
            `).join('');
            payload = { operations: ops };
        }

        const isUnmuteType = type === 'unmute_files';
        const isDeleteType = type === 'delete_files';
        const encodedPaths = encodeURIComponent(JSON.stringify(lines));
        const encodedFilesJson = JSON.stringify(lines).replace(/"/g, '&quot;');

        const isUnmuteDisabled = isUnmuteType && allFullyActive;
        const actionButtonsHtml = isUnmuteType ? `
            <button class="code-action-btn secondary-btn copy-unmute-files-btn copy-files-to-clipboard-btn" data-files="${encodedFilesJson}" data-block-id="${blockId}" title="Copy content of these files as <file> blocks into clipboard">
                <span class="codicon codicon-copy"></span> Copy to Clipboard
            </button>
            <button class="code-action-btn ${isUnmuteDisabled ? 'applied' : 'apply-btn'} file-op-btn unmute-btn" ${isUnmuteDisabled ? 'disabled' : ''} data-command="bulkUnmuteFiles" data-payload='${JSON.stringify({ paths: payload.paths || lines, reprompt: false })}' data-block-id="${blockId}">
                <span class="codicon ${isUnmuteDisabled ? 'codicon-check' : 'codicon-eye'}"></span> ${btnText}
            </button>
            <button class="code-action-btn apply-btn unmute-reprompt-btn" ${isUnmuteDisabled ? 'disabled style="opacity:0.6;"' : ''} data-command="bulkUnmuteFiles" data-payload='${JSON.stringify({ paths: payload.paths || lines, reprompt: true })}' data-block-id="${blockId}" style="background: var(--vscode-charts-green) !important; color: white !important; font-weight: bold;" title="Activate full source code and immediately ask AI to proceed">
                <span class="codicon codicon-play"></span> ${allFullyActive ? 'Reprompt AI' : 'Activate & Reprompt'}
            </button>
        ` : (isDeleteType ? `
            <button class="code-action-btn delete-btn delete-all-files-btn" data-paths="${encodedPaths}" data-block-id="${blockId}" style="background-color: var(--vscode-charts-red, #e53935) !important; color: white !important; font-weight: bold;">
                <span class="codicon codicon-trash"></span> ${btnText}
            </button>
        ` : `
            <button class="code-action-btn apply-btn file-op-btn" data-command="${command}" data-payload='${JSON.stringify(payload)}'>
                <span class="codicon codicon-check"></span> ${btnText}
            </button>
        `);

        const cardExtraClass = isUnmuteType ? 'unmute-files-block assistant-executable-card' : (isDeleteType ? 'delete-files-block' : '');
        const borderAccent = isUnmuteType
            ? 'border-left: 4px solid var(--vscode-charts-green);'
            : (isDeleteType ? 'border-left: 4px solid var(--vscode-charts-red, #e53935);' : 'border-left: 4px solid var(--vscode-charts-orange);');

        return `
        <div class="file-operation-block ${cardExtraClass}" id="${blockId}" data-action-type="${isUnmuteType ? 'unmute' : 'file_op'}" data-paths="${encodedPaths}" data-payload="${encodedPaths}" style="background-color: var(--vscode-editor-inactiveSelectionBackground); border: 1px solid var(--vscode-widget-border); ${borderAccent} border-radius: 8px; margin: 12px 0; overflow: hidden;">
            <div class="file-operation-header" style="padding: 8px 12px; background: var(--vscode-sideBarSectionHeader-background); display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 12px;">
                <span class="codicon ${icon}" style="${isUnmuteType ? 'color: var(--vscode-charts-green);' : ''}"></span> 
                <span>${title}</span>
            </div>
            <div class="expansion-body" style="padding: 12px;">
                <div class="expansion-file-list" style="margin-bottom: 12px; max-height: 240px; overflow-y: auto;">
                    ${detailsHtml}
                </div>
                <div class="file-operation-actions" style="display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap;">
                    ${actionButtonsHtml}
                </div>
            </div>
        </div>`;
    },
    initialize: (container, context) => {
        container.querySelectorAll('.file-op-btn').forEach(btn => {
            (btn as HTMLElement).onclick = (e: MouseEvent) => {
                e.stopPropagation();
                const d = (btn as HTMLElement).dataset;
                if (!d.command || !d.payload) return;
                const parsedPayload = JSON.parse(d.payload);
                context.vscode.postMessage({ command: d.command, ...parsedPayload });
                (btn as HTMLButtonElement).disabled = true;
                btn.innerHTML = '<i class="codicon codicon-check"></i> Applied';
                btn.classList.add('applied');
            };
        });

        container.querySelectorAll('.open-delete-target-btn').forEach(btn => {
            (btn as HTMLElement).onclick = (e: MouseEvent) => {
                e.stopPropagation();
                const filePath = (btn as HTMLElement).dataset.path;
                if (filePath) {
                    context.vscode.postMessage({ command: 'openFile', path: filePath });
                }
            };
        });

        container.querySelectorAll('.delete-single-file-btn').forEach(btn => {
            (btn as HTMLElement).onclick = (e: MouseEvent) => {
                e.stopPropagation();
                const btnEl = btn as HTMLButtonElement;
                const filePath = btnEl.dataset.path;
                const rowId = btnEl.dataset.rowId;
                const blockId = btnEl.dataset.blockId || btnEl.closest('.delete-files-block')?.id;
                if (!filePath) return;

                btnEl.disabled = true;
                btnEl.innerHTML = '<span class="codicon codicon-loading spin"></span> Deleting...';
                context.vscode.postMessage({
                    command: 'deleteFile',
                    filePaths: [filePath],
                    rowId,
                    blockId
                });
            };
        });

        container.querySelectorAll('.delete-all-files-btn').forEach(btn => {
            (btn as HTMLElement).onclick = (e: MouseEvent) => {
                e.stopPropagation();
                const btnEl = btn as HTMLButtonElement;
                const rawPaths = btnEl.dataset.paths;
                const blockId = btnEl.dataset.blockId || btnEl.closest('.delete-files-block')?.id;
                if (!rawPaths) return;

                try {
                    const paths: string[] = JSON.parse(decodeURIComponent(rawPaths));
                    const blockEl = blockId ? document.getElementById(blockId) : null;
                    const remainingPaths = blockEl
                        ? paths.filter(p => {
                            const row = Array.from(blockEl.querySelectorAll('.delete-file-row')).find((r: any) => r.dataset.path === p);
                            return !row || !row.classList.contains('status-deleted');
                        })
                        : paths;

                    if (remainingPaths.length === 0) return;

                    btnEl.disabled = true;
                    btnEl.innerHTML = '<span class="codicon codicon-loading spin"></span> Deleting...';
                    context.vscode.postMessage({
                        command: 'deleteFile',
                        filePaths: remainingPaths,
                        blockId
                    });
                } catch {}
            };
        });

        container.querySelectorAll('.unmute-reprompt-btn').forEach(btn => {
            (btn as HTMLElement).onclick = (e: MouseEvent) => {
                e.stopPropagation();
                const d = (btn as HTMLElement).dataset;
                if (!d.command || !d.payload) return;
                const parsedPayload = JSON.parse(d.payload);
                (btn as HTMLButtonElement).disabled = true;
                btn.innerHTML = '<div class="spinner"></div> Unmuting & Answering...';
                context.vscode.postMessage({ command: d.command, ...parsedPayload });
            };
        });

        container.querySelectorAll('.copy-unmute-files-btn').forEach(btn => {
            (btn as HTMLElement).onclick = (e: MouseEvent) => {
                e.stopPropagation();
                const btnEl = btn as HTMLButtonElement;
                const raw = btnEl.dataset.files;
                if (!raw) return;
                try {
                    const files = JSON.parse(raw);
                    context.vscode.postMessage({
                        command: 'copyFilesToClipboard',
                        files: files
                    });
                    const origHtml = btnEl.innerHTML;
                    btnEl.innerHTML = '<span class="codicon codicon-check"></span> Copied!';
                    btnEl.classList.add('success');
                    setTimeout(() => {
                        btnEl.innerHTML = origHtml;
                        btnEl.classList.remove('success');
                    }, 2000);
                } catch (err) {
                    console.error("Failed to copy unmute files to clipboard:", err);
                }
            };
        });
    }
};

export const unpackDirectoryPlugin: TagPlugin = {
    id: 'unpack_directory',
    tagPattern: /<unpack_directory\b([^>]*?)>([\s\S]*?)<\/unpack_directory>/gim,
    render: (match) => {
        const inner = (match[2] || "").trim();
        const dirs = inner.split(/[\s\r\n,]+/).map(d => d.trim().replace(/^['"]|['"]$/g, '')).filter(d => d && !d.startsWith('<'));
        if (dirs.length === 0) return null;
        return `
        <div class="file-operation-block" style="background-color: var(--vscode-editor-inactiveSelectionBackground); border: 1px solid var(--vscode-widget-border); border-left: 4px solid var(--vscode-charts-blue); border-radius: 8px; margin: 12px 0; overflow: hidden;">
            <div class="file-operation-header" style="padding: 8px 12px; background: var(--vscode-sideBarSectionHeader-background); display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 12px;">
                <span class="codicon codicon-folder-opened"></span> 
                <span>Directory Unpack Request</span>
            </div>
            <div class="expansion-body" style="padding: 12px;">
                <div style="font-size: 12px; margin-bottom: 8px;">Unroll truncated folder: <strong>${dirs.join(', ')}</strong></div>
            </div>
        </div>`;
    }
};

export function extractStructurePaths(attrStr: string, inner: string): string[] {
    const paths: string[] = [];
    const addPath = (raw: string) => {
        if (!raw) return;
        const clean = raw.trim().replace(/^['"`]|['"`]$/g, '').replace(/^-\s*/, '').trim();
        if (clean && isValidFilePath(clean) && !paths.includes(clean)) {
            paths.push(clean);
        }
    };

    const attrRegex = /(?:path|paths|files|target)=["']([^"']+)["']/gi;
    let aMatch: RegExpExecArray | null;
    while ((aMatch = attrRegex.exec(attrStr)) !== null) {
        const val = aMatch[1].trim();
        if (val.startsWith('[') && val.endsWith(']')) {
            try {
                const parsed = JSON.parse(val.replace(/'/g, '"'));
                if (Array.isArray(parsed)) {
                    parsed.forEach(p => addPath(String(p)));
                }
            } catch {
                val.slice(1, -1).split(/[\r\n,]+/).forEach(addPath);
            }
        } else {
            val.split(/[\r\n,;\s]+/).forEach(addPath);
        }
    }

    if (inner && inner.trim()) {
        const lines = inner.split(/[\r\n,;]+/);
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('<')) continue;
            trimmed.split(/\s+/).forEach(addPath);
        }
    }

    return paths;
}

export const loadStructurePlugin: TagPlugin = {
    id: 'load_structure',
    tagPattern: /<(?:load_structure|read_definitions)\b([^>]*?)(?:\/>|>(?:([\s\S]*?)<\/(?:load_structure|read_definitions)>)?)/gim,
    render: (match, context) => {
        const attrStr = match[1] || "";
        const inner = (match[2] || "").trim();
        const paths = extractStructurePaths(attrStr, inner);
        if (paths.length === 0) return null;

        const blockId = `struct-req-${Date.now().toString(36)}-${Math.random().toString(36).substring(7)}`;
        const encodedFiles = encodeURIComponent(JSON.stringify(paths));
        const titleText = paths.length === 1 
            ? `Structure &amp; Signatures Request: <code>${paths[0]}</code>`
            : `Structure &amp; Signatures Request: (${paths.length} files)`;

        const filesListHtml = paths.length > 1 ? `
            <div class="expansion-file-list" style="margin: 6px 0 10px 0; max-height: 180px; overflow-y: auto;">
                ${paths.map(f => `
                    <div class="expansion-file-item" style="display: flex; align-items: center; justify-content: space-between; padding: 4px 8px; font-family: var(--vscode-editor-font-family); font-size: 11px;">
                        <div style="display: flex; align-items: center; gap: 8px; min-width: 0;">
                            <span class="codicon codicon-symbol-class" style="color: var(--vscode-charts-blue);"></span>
                            <span class="file-label" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${f}</span>
                        </div>
                        <div style="display: flex; align-items: center; gap: 4px;">
                            <button class="code-action-btn secondary-btn copy-single-structure-btn" data-path="${f}" style="height: 18px; font-size: 9px; padding: 0 5px;" title="Copy structure &amp; signatures for this file to clipboard">
                                <i class="codicon codicon-copy"></i>
                            </button>
                            <button class="code-action-btn secondary-btn peek-file-open-btn" data-path="${f}" style="height: 18px; font-size: 9px; padding: 0 5px;" title="Open file in editor">
                                <span class="codicon codicon-file"></span>
                            </button>
                        </div>
                    </div>
                `).join('')}
            </div>` : '';

        return `
        <div class="file-operation-block assistant-executable-card load-structure-card" id="${blockId}" data-action-type="load_structure" data-files="${encodedFiles}" data-paths="${encodedFiles}" data-payload="${encodedFiles}" style="background-color: var(--vscode-editor-inactiveSelectionBackground); border: 1.5px solid var(--vscode-charts-blue); border-radius: 8px; margin: 10px 0; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.15);">
            <div class="file-operation-header" style="padding: 8px 12px; background: var(--vscode-sideBarSectionHeader-background); display: flex; align-items: center; justify-content: space-between; font-weight: 600; font-size: 12px; border-bottom: 1px solid var(--vscode-widget-border); flex-wrap: wrap; gap: 6px;">
                <div style="display: flex; align-items: center; gap: 8px; min-width: 0;">
                    <span class="codicon codicon-symbol-class" style="color: var(--vscode-charts-blue);"></span>
                    <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${titleText}</span>
                </div>
                <div style="display: flex; gap: 6px; align-items: center; flex-wrap: wrap;">
                    <button class="code-action-btn secondary-btn copy-structure-btn" data-files="${encodedFiles}" data-block-id="${blockId}" style="height: 22px; font-size: 10px; padding: 0 8px;" title="Copy extracted structure and signatures to clipboard">
                        <i class="codicon codicon-copy"></i> Copy Structure
                    </button>
                    <button class="code-action-btn apply-btn load-structure-btn" data-files="${encodedFiles}" data-block-id="${blockId}" style="height: 22px; font-size: 10px; padding: 0 10px; font-weight: bold;">
                        <i class="codicon codicon-symbol-class"></i> Load Structure (${paths.length > 1 ? `${paths.length} Files &middot; ` : ''}Tokens Saved)
                    </button>
                    <button class="code-action-btn apply-btn load-structure-reprompt-btn" data-files="${encodedFiles}" data-block-id="${blockId}" style="height: 22px; font-size: 10px; padding: 0 8px; font-weight: bold; background: var(--vscode-charts-green) !important; color: white !important;" title="Load structure into context and immediately reprompt AI">
                        <i class="codicon codicon-play"></i> Load &amp; Reprompt
                    </button>
                    <button class="code-action-btn secondary-btn load-full-file-btn" data-files="${encodedFiles}" data-block-id="${blockId}" style="height: 22px; font-size: 10px; padding: 0 8px;">
                        <i class="codicon codicon-file"></i> Load Full File${paths.length > 1 ? 's' : ''}
                    </button>
                </div>
            </div>
            <div class="expansion-body" style="padding: 8px 12px; font-size: 11px; opacity: 0.85;">
                ${filesListHtml}
                <div>The AI requested the architectural structure and typed signatures for <strong>${paths.length === 1 ? paths[0] : `${paths.length} files`}</strong>. Note: Generating structure takes extra analysis time; privilege using Unmute to load full code when context budget allows. Unmuting upgrades structure files directly to full code.</div>
            </div>
        </div>`;
    },
    initialize: (container, context) => {
        container.querySelectorAll('.copy-structure-btn, .copy-single-structure-btn').forEach(btn => {
            (btn as HTMLElement).onclick = (e: MouseEvent) => {
                e.stopPropagation();
                const btnEl = btn as HTMLButtonElement;
                const raw = btnEl.dataset.files;
                let files: string[] = [];
                try {
                    files = JSON.parse(decodeURIComponent(raw || '[]'));
                } catch {
                    if (btnEl.dataset.path) files = [btnEl.dataset.path];
                }
                if (btnEl.dataset.path && !files.includes(btnEl.dataset.path)) {
                    files.push(btnEl.dataset.path);
                }
                if (files.length === 0) return;

                const origHtml = btnEl.innerHTML;
                btnEl.disabled = true;
                btnEl.innerHTML = `<i class="codicon codicon-loading spin"></i> Copying...`;

                context.vscode.postMessage({
                    command: 'copyStructureToClipboard',
                    files
                });

                setTimeout(() => {
                    btnEl.disabled = false;
                    btnEl.innerHTML = `<i class="codicon codicon-check"></i> Copied!`;
                    setTimeout(() => {
                        btnEl.innerHTML = origHtml;
                    }, 2000);
                }, 500);
            };
        });

        container.querySelectorAll('.load-structure-btn').forEach(btn => {
            (btn as HTMLElement).onclick = (e: MouseEvent) => {
                e.stopPropagation();
                const btnEl = btn as HTMLButtonElement;
                const raw = btnEl.dataset.files;
                let files: string[] = [];
                try {
                    files = JSON.parse(decodeURIComponent(raw || '[]'));
                } catch {
                    if (btnEl.dataset.path) files = [btnEl.dataset.path];
                }
                if (files.length === 0) return;

                btnEl.disabled = true;
                btnEl.innerHTML = `<div class="spinner"></div> Loading Structure (${files.length})...`;

                context.vscode.postMessage({
                    command: 'loadFilesStructure',
                    files,
                    blockId: btnEl.dataset.blockId || btnEl.closest('.file-operation-block')?.id,
                    reprompt: false
                });
            };
        });

        container.querySelectorAll('.load-structure-reprompt-btn').forEach(btn => {
            (btn as HTMLElement).onclick = (e: MouseEvent) => {
                e.stopPropagation();
                const btnEl = btn as HTMLButtonElement;
                const raw = btnEl.dataset.files;
                let files: string[] = [];
                try {
                    files = JSON.parse(decodeURIComponent(raw || '[]'));
                } catch {
                    if (btnEl.dataset.path) files = [btnEl.dataset.path];
                }
                if (files.length === 0) return;

                btnEl.disabled = true;
                btnEl.innerHTML = `<div class="spinner"></div> Loading &amp; Answering...`;

                context.vscode.postMessage({
                    command: 'loadFilesStructure',
                    files,
                    blockId: btnEl.dataset.blockId || btnEl.closest('.file-operation-block')?.id,
                    reprompt: true
                });
            };
        });

        container.querySelectorAll('.load-full-file-btn').forEach(btn => {
            (btn as HTMLElement).onclick = (e: MouseEvent) => {
                e.stopPropagation();
                const btnEl = btn as HTMLButtonElement;
                const raw = btnEl.dataset.files;
                let files: string[] = [];
                try {
                    files = JSON.parse(decodeURIComponent(raw || '[]'));
                } catch {
                    if (btnEl.dataset.path) files = [btnEl.dataset.path];
                }
                if (files.length === 0) return;

                btnEl.disabled = true;
                btnEl.innerHTML = `<div class="spinner"></div> Loading Full File${files.length > 1 ? 's' : ''}...`;

                context.vscode.postMessage({
                    command: 'bulkUnmuteFiles',
                    paths: files,
                    reprompt: true
                });
            };
        });

        container.querySelectorAll('.load-structure-card .peek-file-open-btn').forEach(btn => {
            (btn as HTMLElement).onclick = (e: MouseEvent) => {
                e.stopPropagation();
                const filePath = (btn as HTMLElement).dataset.path;
                if (filePath) {
                    context.vscode.postMessage({ command: 'openFile', path: filePath });
                }
            };
        });
    }
};

export function extractSymbolRequests(attrStr: string, inner: string): { filePath: string; symbols: string[] } | null {
    let filePath = "";
    const symbols: string[] = [];

    const addSymbol = (s: string) => {
        if (!s) return;
        const clean = s.trim().replace(/^['"`]|['"`]$/g, '').replace(/^-\s*/, '').trim();
        if (clean && !symbols.includes(clean)) {
            symbols.push(clean);
        }
    };

    // 1. Check path / file attribute
    const pathMatch = attrStr.match(/(?:path|file)=["']([^"']+)["']/i);
    if (pathMatch) {
        filePath = pathMatch[1].trim();
    }

    // 2. Check target attribute
    const targetMatch = attrStr.match(/target=["']([^"']+)["']/i);
    if (targetMatch) {
        const rawTarget = targetMatch[1].trim();
        if (rawTarget.includes(':') && !/^[a-zA-Z]:[\\/]/.test(rawTarget)) {
            const colonIdx = rawTarget.indexOf(':');
            if (!filePath) filePath = rawTarget.substring(0, colonIdx).trim();
            const afterColon = rawTarget.substring(colonIdx + 1).trim();
            afterColon.split(/[\r\n,;]+/).forEach(addSymbol);
        } else if (!filePath) {
            filePath = rawTarget;
        }
    }

    // 3. Check symbol / symbols attributes
    const symRegex = /(?:symbol|symbols)=["']([^"']+)["']/gi;
    let sm: RegExpExecArray | null;
    while ((sm = symRegex.exec(attrStr)) !== null) {
        sm[1].split(/[\r\n,;]+/).forEach(addSymbol);
    }

    // 4. Check inner content
    if (inner && inner.trim()) {
        const lines = inner.split(/[\r\n,;]+/);
        for (const line of lines) {
            const trimmed = line.trim().replace(/^-\s*/, '').trim();
            if (!trimmed || trimmed.startsWith('<')) continue;
            if (!filePath && isValidFilePath(trimmed)) {
                filePath = trimmed;
            } else if (trimmed.includes(':') && !filePath && !/^[a-zA-Z]:[\\/]/.test(trimmed)) {
                const colonIdx = trimmed.indexOf(':');
                filePath = trimmed.substring(0, colonIdx).trim();
                trimmed.substring(colonIdx + 1).split(/[\r\n,;]+/).forEach(addSymbol);
            } else {
                trimmed.split(/[\r\n,;]+/).forEach(addSymbol);
            }
        }
    }

    if (!filePath || symbols.length === 0) return null;
    return { filePath, symbols };
}

export const showSymbolPlugin: TagPlugin = {
    id: 'show_symbol',
    tagPattern: /<(?:show_symbol|read_symbol|get_symbol_code)\b([^>]*?)(?:\/>|>(?:([\s\S]*?)<\/(?:show_symbol|read_symbol|get_symbol_code)>)?)/gim,
    render: (match, context) => {
        const attrStr = match[1] || "";
        const inner = (match[2] || "").trim();
        const parsed = extractSymbolRequests(attrStr, inner);
        if (!parsed) return null;

        const { filePath, symbols } = parsed;
        const blockId = `sym-req-${Date.now().toString(36)}-${Math.random().toString(36).substring(7)}`;
        const encodedSymbols = encodeURIComponent(JSON.stringify(symbols));

        const displayLabel = symbols.length === 1 
            ? `<code>${filePath} &rsaquo; ${symbols[0]}</code>`
            : `<code>${filePath}</code> (${symbols.length} symbols)`;

        const symbolsListHtml = symbols.length > 1 ? `
            <div class="expansion-file-list" style="margin: 6px 0 10px 0; max-height: 180px; overflow-y: auto;">
                ${symbols.map(s => `
                    <div class="expansion-file-item" style="display: flex; align-items: center; justify-content: space-between; padding: 4px 8px; font-family: var(--vscode-editor-font-family); font-size: 11px;">
                        <div style="display: flex; align-items: center; gap: 8px; min-width: 0;">
                            <span class="codicon codicon-symbol-method" style="color: var(--vscode-charts-orange);"></span>
                            <span class="file-label" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600;">${s}</span>
                        </div>
                        <div style="display: flex; align-items: center; gap: 6px;">
                            <span class="file-token-badge weight-light" style="font-size: 9px; border-color: rgba(255, 152, 0, 0.4); color: var(--vscode-charts-orange);">Symbol</span>
                            <button class="code-action-btn secondary-btn copy-single-sym-btn" data-target="${filePath}" data-symbol="${s}" style="height: 18px; font-size: 9px; padding: 0 5px;" title="Copy this symbol code to clipboard">
                                <i class="codicon codicon-copy"></i>
                            </button>
                        </div>
                    </div>
                `).join('')}
            </div>` : '';

        return `
        <div class="file-operation-block assistant-executable-card show-symbol-card" id="${blockId}" data-action-type="show_symbol" data-target="${filePath}" data-symbols="${encodedSymbols}" style="background-color: var(--vscode-editor-inactiveSelectionBackground); border: 1.5px solid var(--vscode-charts-orange); border-radius: 8px; margin: 10px 0; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.15);">
            <div class="file-operation-header" style="padding: 8px 12px; background: var(--vscode-sideBarSectionHeader-background); display: flex; align-items: center; justify-content: space-between; font-weight: 600; font-size: 12px; border-bottom: 1px solid var(--vscode-widget-border); flex-wrap: wrap; gap: 6px;">
                <div style="display: flex; align-items: center; gap: 8px; min-width: 0;">
                    <span class="codicon codicon-symbol-method" style="color: var(--vscode-charts-orange);"></span>
                    <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">Symbol Code Request: ${displayLabel}</span>
                </div>
                <div style="display: flex; gap: 6px;">
                    <button class="code-action-btn secondary-btn copy-sym-btn" data-target="${filePath}" data-symbols="${encodedSymbols}" style="height: 22px; font-size: 10px; padding: 0 8px;" title="Copy symbol code to clipboard">
                        <i class="codicon codicon-copy"></i> Copy Symbol
                    </button>
                    <button class="code-action-btn apply-btn execute-sym-btn" data-target="${filePath}" data-symbols="${encodedSymbols}" data-message-id="${context.messageId}" style="height: 22px; font-size: 10px; padding: 0 10px; font-weight: bold; background: var(--vscode-charts-orange) !important; color: white !important;">
                        <i class="codicon codicon-play"></i> Inspect &amp; Reprompt (${symbols.length > 1 ? `${symbols.length} Symbols` : 'Symbol'})
                    </button>
                </div>
            </div>
            <div class="expansion-body" style="padding: 8px 12px; font-size: 11px; opacity: 0.85;">
                ${symbolsListHtml}
                <div>The AI requested the implementation code of <strong>${symbols.length === 1 ? symbols[0] : `${symbols.length} symbols`}</strong> from <code>${filePath}</code> without loading the entire file. Click to retrieve the symbol code and send it to the AI.</div>
            </div>
        </div>`;
    },
    initialize: (container, context) => {
        container.querySelectorAll('.copy-sym-btn, .copy-single-sym-btn').forEach(btn => {
            (btn as HTMLElement).onclick = (e: MouseEvent) => {
                e.stopPropagation();
                const btnEl = btn as HTMLButtonElement;
                const target = btnEl.dataset.target;
                const symbol = btnEl.dataset.symbol;
                const rawSymbols = btnEl.dataset.symbols;
                if (!target) return;

                let symbols: string[] = [];
                if (rawSymbols) {
                    try { symbols = JSON.parse(decodeURIComponent(rawSymbols)); } catch { symbols = [rawSymbols]; }
                }
                if (symbol && !symbols.includes(symbol)) {
                    symbols = [symbol];
                }

                const origHtml = btnEl.innerHTML;
                btnEl.disabled = true;
                btnEl.innerHTML = `<i class="codicon codicon-loading spin"></i> Copying...`;

                context.vscode.postMessage({
                    command: 'executeShowSymbol',
                    target,
                    symbols: symbols.length > 0 ? symbols : undefined,
                    symbol: symbols.length === 1 ? symbols[0] : undefined,
                    copyOnly: true
                });

                setTimeout(() => {
                    btnEl.disabled = false;
                    btnEl.innerHTML = `<i class="codicon codicon-check"></i> Copied!`;
                    setTimeout(() => {
                        btnEl.innerHTML = origHtml;
                    }, 2000);
                }, 500);
            };
        });

        container.querySelectorAll('.execute-sym-btn').forEach(btn => {
            (btn as HTMLElement).onclick = (e: MouseEvent) => {
                e.stopPropagation();
                const btnEl = btn as HTMLButtonElement;
                const target = btnEl.dataset.target;
                const rawSymbols = btnEl.dataset.symbols;
                const messageId = btnEl.dataset.messageId;
                if (!target) return;

                let symbols: string[] = [];
                if (rawSymbols) {
                    try { symbols = JSON.parse(decodeURIComponent(rawSymbols)); } catch { symbols = [rawSymbols]; }
                }

                btnEl.disabled = true;
                btnEl.innerHTML = `<div class="spinner"></div> Retrieving ${symbols.length > 1 ? `${symbols.length} Symbols` : 'Symbol'}...`;

                context.vscode.postMessage({
                    command: 'executeShowSymbol',
                    target,
                    symbols: symbols.length > 0 ? symbols : undefined,
                    symbol: symbols.length === 1 ? symbols[0] : undefined,
                    messageId,
                    reprompt: true
                });
            };
        });
    }
};

export function extractPeekPaths(attrStr: string, inner: string): string[] {
    const paths: string[] = [];
    const addPath = (raw: string) => {
        if (!raw) return;
        const clean = raw.trim().replace(/^['"`]|['"`]$/g, '').replace(/^-\s*/, '').trim();
        if (clean && !clean.startsWith('<') && !paths.includes(clean)) {
            paths.push(clean);
        }
    };

    const attrRegex = /(?:path|paths|file|files|target)=["']([^"']+)["']/gi;
    let aMatch: RegExpExecArray | null;
    while ((aMatch = attrRegex.exec(attrStr)) !== null) {
        const val = aMatch[1].trim();
        if (val.startsWith('[') && val.endsWith(']')) {
            try {
                const parsed = JSON.parse(val.replace(/'/g, '"'));
                if (Array.isArray(parsed)) {
                    parsed.forEach(p => addPath(String(p)));
                }
            } catch {
                val.slice(1, -1).split(/[\r\n,]+/).forEach(addPath);
            }
        } else {
            val.split(/[\r\n,;\s]+/).forEach(addPath);
        }
    }

    if (inner && inner.trim()) {
        const lines = inner.split(/[\r\n,;]+/);
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('<')) continue;
            trimmed.split(/\s+/).forEach(addPath);
        }
    }

    return paths;
}

export const peekFilesPlugin: TagPlugin = {
    id: 'peek_files',
    tagPattern: /<peek_files\b([^>]*?)(?:\/>|>(?:([\s\S]*?)<\/peek_files>)?)/gim,
    render: (match, context) => {
        const attrStr = match[1] || "";
        const inner = (match[2] || "").trim();
        const rawPaths = extractPeekPaths(attrStr, inner);
        if (rawPaths.length === 0) return null;

        const linesMatch = attrStr.match(/lines=["']?(\d+)["']?/i);
        const wordsMatch = attrStr.match(/words=["']?(\d+)["']?/i);
        const offsetMatch = attrStr.match(/offset=["']?(\d+)["']?/i);
        const fromMatch = attrStr.match(/from=["']?(top|bottom)["']?/i);
        const regexMatch = attrStr.match(/regex=["']([^"']+)["']/i);

        const peekOptions: any = {};
        if (linesMatch) peekOptions.lines = parseInt(linesMatch[1], 10);
        if (wordsMatch) peekOptions.words = parseInt(wordsMatch[1], 10);
        if (offsetMatch) peekOptions.offset = parseInt(offsetMatch[1], 10);
        if (fromMatch) peekOptions.from = fromMatch[1].toLowerCase();
        if (regexMatch) peekOptions.regex = regexMatch[1];

        const blockId = `peek-block-${context.messageId}-${Date.now().toString(36)}`;
        // Phase-5 unified rendering: agent mode is 100% embedded in assistant mode, so it
        // renders the IDENTICAL inline fallback card as assistant mode. Only dynamic mode
        // retains a divergent rendering path. The gate is therefore keyed on dynamicMode only.
        const isUnifiedInlineMode = !context.capabilities?.dynamicMode;

        // In Assistant/Agent (embedded) modes, peek_files presents clean fallback options to Add to Context or Unmute
        if (isUnifiedInlineMode) {
            return `
            <div class="file-operation-block" style="background-color: var(--vscode-editor-inactiveSelectionBackground); border: 1.5px solid var(--vscode-charts-orange); border-radius: 8px; margin: 12px 0; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.15);">
                <div class="file-operation-header" style="padding: 8px 12px; background: var(--vscode-sideBarSectionHeader-background); display: flex; align-items: center; justify-content: space-between; font-weight: 600; font-size: 12px; border-bottom: 1px solid var(--vscode-widget-border);">
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <span class="codicon codicon-info" style="color: var(--vscode-charts-orange);"></span>
                        <span>File Reading in Assistant Mode (${rawPaths.length} files)</span>
                    </div>
                </div>
                <div class="expansion-body" style="padding: 10px 12px;">
                    <div style="font-size: 11px; opacity: 0.85; margin-bottom: 8px;">
                        The AI requested to inspect file content. In Assistant mode, files must be loaded into context or unmuted:
                    </div>
                    <div style="display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px;">
                        ${rawPaths.map(f => `<button class="code-action-btn secondary-btn peek-file-open-btn" data-path="${f}" style="font-size: 10px; height: 22px;"><i class="codicon codicon-file"></i> ${f.split('/').pop()}</button>`).join('')}
                    </div>
                    <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                        <button class="code-action-btn apply-btn add-files-to-context-btn" data-files='${JSON.stringify(rawPaths)}' data-block-id="${blockId}" style="height: 24px; font-size: 11px; padding: 0 10px;">
                            <i class="codicon codicon-add"></i> Add to Context (${rawPaths.length})
                        </button>
                        <button class="code-action-btn secondary-btn file-op-btn" data-command="bulkUnmuteFiles" data-payload='${JSON.stringify({ paths: rawPaths })}' style="height: 24px; font-size: 11px; padding: 0 10px;">
                            <i class="codicon codicon-eye"></i> Unmute (${rawPaths.length})
                        </button>
                    </div>
                </div>
            </div>`;
        }

        const filesPayload = rawPaths.map(p => ({
            path: p,
            ...peekOptions
        }));

        const encodedPayload = encodeURIComponent(JSON.stringify(filesPayload));

        let criteriaLabel = "";
        if (peekOptions.regex) criteriaLabel = ` &middot; Regex: <code>${peekOptions.regex}</code>`;
        else if (peekOptions.lines) criteriaLabel = ` &middot; ${peekOptions.lines} lines (${peekOptions.from || 'top'})`;
        else if (peekOptions.words) criteriaLabel = ` &middot; ${peekOptions.words} words (${peekOptions.from || 'top'})`;

        return `
        <div class="file-operation-block peek-files-block assistant-executable-card" id="${blockId}" data-action-type="peek" data-payload="${encodedPayload}" style="background-color: var(--vscode-editor-inactiveSelectionBackground); border: 1.5px solid var(--vscode-charts-green); border-radius: 8px; margin: 12px 0; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.15);">
            <div class="file-operation-header" style="padding: 8px 12px; background: var(--vscode-sideBarSectionHeader-background); display: flex; align-items: center; justify-content: space-between; font-weight: 600; font-size: 12px; border-bottom: 1px solid var(--vscode-widget-border);">
                <div style="display: flex; align-items: center; gap: 8px;">
                    <span class="codicon codicon-eye" style="color: var(--vscode-charts-green);"></span> 
                    <span>Peek Files Request (${rawPaths.length}${criteriaLabel})</span>
                </div>
                <div style="display: flex; gap: 6px; align-items: center;">
                    <button class="code-action-btn secondary-btn copy-peek-output-btn" data-payload="${encodedPayload}" title="Copy peeked slice to clipboard" style="height: 22px; font-size: 10px; padding: 0 8px;">
                        <i class="codicon codicon-copy"></i> Copy Slice
                    </button>
                    <button class="code-action-btn apply-btn execute-peek-reprompt-btn" data-payload="${encodedPayload}" data-message-id="${context.messageId}" title="Inspect files on disk and immediately send results back to the AI as next turn" style="height: 22px; font-size: 10px; padding: 0 10px; font-weight: bold; background: var(--vscode-charts-green) !important; color: white !important;">
                        <i class="codicon codicon-sync"></i> Peek & Reprompt AI
                    </button>
                </div>
            </div>
            <div class="expansion-body" style="padding: 10px 12px;">
                <div style="display: flex; gap: 6px; flex-wrap: wrap;">
                    ${rawPaths.map(f => `<button class="code-action-btn secondary-btn peek-file-open-btn" data-path="${f}" style="font-size: 10px; height: 22px;"><i class="codicon codicon-file"></i> ${f.split('/').pop()}</button>`).join('')}
                </div>
                <div class="peek-render-preview" style="display:none; margin-top:8px; max-height:220px; overflow-y:auto; font-family:var(--vscode-editor-font-family); font-size:11px; background:var(--vscode-editor-background); border:1px solid var(--vscode-widget-border); border-radius:4px; padding:8px; white-space:pre-wrap;"></div>
            </div>
        </div>`;
    },
    initialize: (container, context) => {
        container.querySelectorAll('.peek-file-open-btn').forEach(btn => {
            (btn as HTMLElement).onclick = (e: MouseEvent) => {
                e.stopPropagation();
                const filePath = (btn as HTMLElement).dataset.path;
                if (filePath) {
                    context.vscode.postMessage({ command: 'openFile', path: filePath });
                }
            };
        });

        container.querySelectorAll('.copy-peek-output-btn').forEach(btn => {
            (btn as HTMLElement).onclick = (e: MouseEvent) => {
                e.stopPropagation();
                const btnEl = btn as HTMLButtonElement;
                const encoded = btnEl.dataset.payload;
                if (!encoded) return;

                try {
                    const payload = JSON.parse(decodeURIComponent(encoded));
                    context.vscode.postMessage({
                        command: 'peekFilesAndCopy',
                        files: payload
                    });

                    const origHtml = btnEl.innerHTML;
                    btnEl.innerHTML = '<i class="codicon codicon-check"></i> Copied!';
                    setTimeout(() => { btnEl.innerHTML = origHtml; }, 2000);
                } catch {}
            };
        });

        container.querySelectorAll('.execute-peek-reprompt-btn').forEach(btn => {
            (btn as HTMLElement).onclick = (e: MouseEvent) => {
                e.stopPropagation();
                const btnEl = btn as HTMLButtonElement;
                const encoded = btnEl.dataset.payload;
                if (!encoded) return;

                btnEl.disabled = true;
                btnEl.innerHTML = '<div class="spinner"></div> Peeking & Answering...';

                try {
                    const payload = JSON.parse(decodeURIComponent(encoded));
                    context.vscode.postMessage({
                        command: 'executePeekAndReprompt',
                        files: payload,
                        messageId: btnEl.dataset.messageId
                    });
                } catch (err: any) {
                    btnEl.disabled = false;
                    btnEl.innerHTML = '<i class="codicon codicon-error"></i> Failed';
                }
            };
        });
    }
};

export function extractRunTestsTargets(attrStr: string, inner: string): string[] {
    const targets: string[] = [];
    const addT = (raw: string) => {
        if (!raw) return;
        const clean = raw.trim().replace(/^['"`]|['"`]$/g, '').replace(/^-\s*/, '').trim();
        if (clean && !clean.startsWith('<') && !targets.includes(clean)) {
            targets.push(clean);
        }
    };

    const attrRegex = /(?:targets|files|paths|path|file)=["']([^"']+)["']/gi;
    let aMatch: RegExpExecArray | null;
    while ((aMatch = attrRegex.exec(attrStr)) !== null) {
        const val = aMatch[1].trim();
        if (val.startsWith('[') && val.endsWith(']')) {
            try {
                const parsed = JSON.parse(val.replace(/'/g, '"'));
                if (Array.isArray(parsed)) parsed.forEach(p => addT(String(p)));
            } catch {
                val.slice(1, -1).split(/[\r\n,]+/).forEach(addT);
            }
        } else {
            val.split(/[\r\n,;]+/).forEach(addT);
        }
    }

    if (inner && inner.trim()) {
        inner.split(/[\r\n,;]+/).forEach(addT);
    }

    return targets;
}

export const runTestsPlugin: TagPlugin = {
    id: 'run_tests',
    tagPattern: /<run_tests\b([^>]*?)(?:\/>|>(?:([\s\S]*?)<\/run_tests>)?)/gim,
    render: (match, context) => {
        const attrStr = match[1] || "";
        const inner = (match[2] || "").trim();
        const targets = extractRunTestsTargets(attrStr, inner);
        if (targets.length === 0) return null;

        const runnerMatch = attrStr.match(/\brunner=["']([^"']+)["']/i);
        const filterMatch = attrStr.match(/\bfilter=["']([^"']+)["']/i);
        const runner = runnerMatch ? runnerMatch[1].trim() : 'auto';
        const filter = filterMatch ? filterMatch[1].trim() : undefined;

        const blockId = `run-tests-${context.messageId}-${Math.random().toString(36).substring(7)}`;
        const payload = { targets, runner, filter };
        const encodedPayload = encodeURIComponent(JSON.stringify(payload));

        return `
        <div class="file-operation-block assistant-executable-card run-tests-card" id="${blockId}" data-action-type="run_tests" data-payload="${encodedPayload}" style="background-color: var(--vscode-editor-inactiveSelectionBackground); border: 1.5px solid var(--vscode-charts-green); border-radius: 8px; margin: 10px 0; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.15);">
            <div class="file-operation-header" style="padding: 8px 12px; background: var(--vscode-sideBarSectionHeader-background); display: flex; align-items: center; justify-content: space-between; font-weight: 600; font-size: 12px; border-bottom: 1px solid var(--vscode-widget-border); flex-wrap: wrap; gap: 6px;">
                <div style="display: flex; align-items: center; gap: 8px; min-width: 0;">
                    <span class="codicon codicon-beaker" style="color: var(--vscode-charts-green);"></span>
                    <span>Run Tests Request (${targets.join(', ')})</span>
                    <span class="file-token-badge weight-light" style="font-size: 9px; padding: 1px 6px;">${runner}</span>
                    ${filter ? `<span class="file-token-badge weight-medium" style="font-size: 9px; padding: 1px 6px;">filter: ${filter}</span>` : ''}
                </div>
                <div style="display: flex; gap: 6px; align-items: center;">
                    <button class="code-action-btn secondary-btn run-tests-local-btn" data-payload="${encodedPayload}" data-block-id="${blockId}" style="height: 22px; font-size: 10px; padding: 0 8px;">
                        <i class="codicon codicon-terminal"></i> Run Tests
                    </button>
                    <button class="code-action-btn apply-btn run-tests-reprompt-btn" data-payload="${encodedPayload}" data-block-id="${blockId}" style="height: 22px; font-size: 10px; padding: 0 10px; font-weight: bold; background: var(--vscode-charts-green) !important; color: white !important;">
                        <i class="codicon codicon-play"></i> Run &amp; Reprompt
                    </button>
                </div>
            </div>
            <div class="expansion-body" style="padding: 8px 12px; font-size: 11px;">
                <div style="display: flex; gap: 6px; flex-wrap: wrap;">
                    ${targets.map(t => `<span class="file-token-badge weight-light" style="font-family: var(--vscode-editor-font-family);"><i class="codicon codicon-beaker"></i> ${t}</span>`).join('')}
                </div>
                <div class="run-tests-output-preview" style="display:none; margin-top:8px; max-height:260px; overflow-y:auto; font-family:var(--vscode-editor-font-family); font-size:11px; background:var(--vscode-editor-background); border:1px solid var(--vscode-widget-border); border-radius:4px; padding:8px; white-space:pre-wrap;"></div>
            </div>
        </div>`;
    },
    initialize: (container, context) => {
        container.querySelectorAll('.run-tests-local-btn, .run-tests-reprompt-btn').forEach(btn => {
            (btn as HTMLElement).onclick = (e: MouseEvent) => {
                e.stopPropagation();
                const btnEl = btn as HTMLButtonElement;
                const encoded = btnEl.dataset.payload;
                const blockId = btnEl.dataset.blockId;
                const isReprompt = btnEl.classList.contains('run-tests-reprompt-btn');
                if (!encoded) return;

                try {
                    const payload = JSON.parse(decodeURIComponent(encoded));
                    const card = blockId ? document.getElementById(blockId) : btnEl.closest('.run-tests-card');
                    card?.querySelectorAll('.run-tests-local-btn, .run-tests-reprompt-btn').forEach((b: any) => {
                        b.disabled = true;
                        b.style.opacity = '0.6';
                    });
                    btnEl.innerHTML = `<div class="spinner"></div> Running Tests...`;

                    context.vscode.postMessage({
                        command: 'runTestsOnly',
                        targets: payload.targets,
                        runner: payload.runner,
                        filter: payload.filter,
                        blockId,
                        reprompt: isReprompt
                    });
                } catch {}
            };
        });
    }
};

export const executeCodePlugin: TagPlugin = {
    id: 'execute_code',
    tagPattern: /<execute_code\b([^>]*?)>([\s\S]*?)<\/execute_code>/gim,
    render: (match) => {
        const attrStr = match[1] || '';
        const codeBody = (match[2] || '').trim();
        if (!codeBody) return null;

        const langMatch = attrStr.match(/\blang=["']?([\w\-\+#.]+)["']?/i);
        const rawLang = (langMatch ? langMatch[1] : 'bash').toLowerCase();
        const escapeHtml = (s: string) => s
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
        const safeLang = escapeHtml(rawLang);
        const escapedCode = escapeHtml(codeBody);
        const blockId = `exec-code-${Date.now().toString(36)}-${Math.random().toString(36).substring(7)}`;

        return `
        <div class="file-operation-block execute-code-card" id="${blockId}" style="background-color: var(--vscode-editor-inactiveSelectionBackground); border: 1.5px solid var(--vscode-charts-orange); border-radius: 8px; margin: 10px 0; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.15);">
            <div class="file-operation-header" style="padding: 8px 12px; background: var(--vscode-sideBarSectionHeader-background); display: flex; align-items: center; justify-content: space-between; font-weight: 600; font-size: 12px; border-bottom: 1px solid var(--vscode-widget-border);">
                <div style="display: flex; align-items: center; gap: 8px;">
                    <span class="codicon codicon-terminal" style="color: var(--vscode-charts-orange);"></span>
                    <span>Execute Code</span>
                    <span class="lang-badge" data-lang="${safeLang}">${safeLang}</span>
                </div>
                <button class="code-action-btn copy-exec-code-btn" data-code="${encodeURIComponent(codeBody)}" title="Copy code to clipboard" style="height: 22px; font-size: 10px; padding: 0 8px;">
                    <i class="codicon codicon-copy"></i> Copy
                </button>
            </div>
            <div class="expansion-body" style="padding: 0;">
                <pre style="margin: 0; padding: 10px 12px; max-height: 300px; overflow: auto; background: var(--vscode-editor-background);"><code class="language-${safeLang}">${escapedCode}</code></pre>
            </div>
        </div>`;
    },
    initialize: (container, context) => {
        container.querySelectorAll('.copy-exec-code-btn').forEach(btn => {
            (btn as HTMLElement).onclick = (e: MouseEvent) => {
                e.stopPropagation();
                const btnEl = btn as HTMLButtonElement;
                const raw = btnEl.dataset.code;
                if (!raw) return;
                try {
                    context.vscode.postMessage({ command: 'copyToClipboard', text: decodeURIComponent(raw) });
                    const orig = btnEl.innerHTML;
                    btnEl.innerHTML = '<i class="codicon codicon-check"></i> Copied!';
                    setTimeout(() => { btnEl.innerHTML = orig; }, 2000);
                } catch {}
            };
        });
    }
};

export const readExternalFilePlugin: TagPlugin = {
    id: 'read_external_file',
    tagPattern: /<read_external_file\b([^>]*?)(?:\/>|>(?:([\s\S]*?)<\/read_external_file>)?)/gim,
    render: (match) => {
        const attrStr = match[1] || "";
        const rawInner = (match[2] || "").trim();
        const pMatch = attrStr.match(/(?:path|file|file_path|filePath)=["']([^"']+)["']/i);
        const startMatch = attrStr.match(/start_line=["']?(\d+)["']?/i);
        const endMatch = attrStr.match(/end_line=["']?(\d+)["']?/i);
        const reqPath = (pMatch ? pMatch[1] : rawInner.split(/[\r\n]+/)[0] || '').replace(/^['"]|['"]$/g, '').trim();

        const blockId = `read-ext-${Date.now().toString(36)}-${Math.random().toString(36).substring(7)}`;
        const payload = {
            path: reqPath || undefined,
            start_line: startMatch ? parseInt(startMatch[1], 10) : undefined,
            end_line: endMatch ? parseInt(endMatch[1], 10) : undefined
        };
        const encodedPayload = encodeURIComponent(JSON.stringify(payload));
        const label = reqPath || 'List All Linked External Files';

        return `
        <div class="file-operation-block assistant-executable-card read-external-card" id="${blockId}" data-action-type="read_external_file" data-payload="${encodedPayload}" style="background-color: var(--vscode-editor-inactiveSelectionBackground); border: 1.5px solid var(--vscode-charts-teal, #00b4d8); border-radius: 8px; margin: 10px 0; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.15);">
            <div class="file-operation-header" style="padding: 8px 12px; background: var(--vscode-sideBarSectionHeader-background); display: flex; align-items: center; justify-content: space-between; font-weight: 600; font-size: 12px; border-bottom: 1px solid var(--vscode-widget-border); flex-wrap: wrap; gap: 6px;">
                <div style="display: flex; align-items: center; gap: 8px; min-width: 0;">
                    <span class="codicon codicon-link" style="color: var(--vscode-charts-teal, #00b4d8);"></span>
                    <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">External Reference Request: <code>${label}</code></span>
                </div>
                <div style="display: flex; gap: 6px; align-items: center;">
                    <button class="code-action-btn secondary-btn read-ext-local-btn" data-payload="${encodedPayload}" data-block-id="${blockId}" style="height: 22px; font-size: 10px; padding: 0 8px;">
                        <i class="codicon codicon-eye"></i> View
                    </button>
                    <button class="code-action-btn apply-btn read-ext-reprompt-btn" data-payload="${encodedPayload}" data-block-id="${blockId}" style="height: 22px; font-size: 10px; padding: 0 10px; font-weight: bold; background: var(--vscode-charts-teal, #00b4d8) !important; color: white !important;">
                        <i class="codicon codicon-play"></i> Read &amp; Reprompt
                    </button>
                </div>
            </div>
            <div class="expansion-body" style="padding: 8px 12px; font-size: 11px;">
                <div>The AI requested read-only access to linked external reference: <code>${label}</code></div>
                <div class="read-ext-output-preview" style="display:none; margin-top:8px; max-height:260px; overflow-y:auto; font-family:var(--vscode-editor-font-family); font-size:11px; background:var(--vscode-editor-background); border:1px solid var(--vscode-widget-border); border-radius:4px; padding:8px; white-space:pre-wrap;"></div>
            </div>
        </div>`;
    },
    initialize: (container, context) => {
        container.querySelectorAll('.read-ext-local-btn, .read-ext-reprompt-btn').forEach(btn => {
            (btn as HTMLElement).onclick = (e: MouseEvent) => {
                e.stopPropagation();
                const btnEl = btn as HTMLButtonElement;
                const encoded = btnEl.dataset.payload;
                const blockId = btnEl.dataset.blockId;
                const isReprompt = btnEl.classList.contains('read-ext-reprompt-btn');
                if (!encoded) return;

                try {
                    const payload = JSON.parse(decodeURIComponent(encoded));
                    const card = blockId ? document.getElementById(blockId) : btnEl.closest('.read-external-card');
                    card?.querySelectorAll('.read-ext-local-btn, .read-ext-reprompt-btn').forEach((b: any) => {
                        b.disabled = true;
                        b.style.opacity = '0.6';
                    });
                    btnEl.innerHTML = `<div class="spinner"></div> Reading...`;

                    context.vscode.postMessage({
                        command: 'readExternalFileOnly',
                        path: payload.path,
                        start_line: payload.start_line,
                        end_line: payload.end_line,
                        blockId,
                        reprompt: isReprompt
                    });
                } catch {}
            };
        });
    }
};