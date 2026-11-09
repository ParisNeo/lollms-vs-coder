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

export function normalizePseudoFileBlocks(text: string): string {
    if (!text || typeof text !== 'string') return '';
    let result = text;

    const replaceTagRegex = /<replace\b[^>]*>[\s\r\n]*<search\b[^>]*>([\s\S]*?)<\/search>[\s\r\n]*<(?:replace_with|replace)\b[^>]*>([\s\S]*?)<\/(?:replace_with|replace)>[\s\r\n]*<\/replace>/gi;
    result = result.replace(replaceTagRegex, (_match, s, r) => {
        return `<<<<<<< SEARCH\n${s.trimEnd()}\n=======\n${r.trimStart()}\n>>>>>>> REPLACE`;
    });

    const standaloneSearchReplace = /<search\b[^>]*>([\s\S]*?)<\/search>[\s\r\n]*<(?:replace_with|replace)\b[^>]*>([\s\S]*?)<\/(?:replace_with|replace)>/gi;
    result = result.replace(standaloneSearchReplace, (_match, s, r) => {
        return `<<<<<<< SEARCH\n${s.trimEnd()}\n=======\n${r.trimStart()}\n>>>>>>> REPLACE`;
    });

    const fileHeaderRegex = /(?:(?:\$file\$|\*\*File\*\*|^File)\s*:\s*[`"']?([^\s`"'\r\n]+)[`"']?\s*(?:(?:\$action\$|\*\*Action\*\*|Action)\s*:\s*[`"']?(\w+)[`"']?)?)([\s\S]*?)(?=(?:(?:\$file\$|\*\*File\*\*|^File)\s*:\s*[`"']?[^\s`"'\r\n]+|<file\b|$))/gim;

    result = result.replace(fileHeaderRegex, (fullMatch, filePath, actionRaw, body) => {
        const cleanPath = (filePath || '').replace(/^[`"']|[`"']$/g, '').trim();
        if (!isValidFilePath(cleanPath)) return fullMatch;
        const action = (actionRaw && actionRaw.toLowerCase().includes('write')) ? 'write' : 'patch';

        if (body.includes('<file\b')) return fullMatch;

        const hunks = body.match(/<<<<<<< SEARCH[\s\S]*?>>>>>>> REPLACE/g);
        if (hunks && hunks.length > 0) {
            return `\n\n<file path="${cleanPath}" action="patch">\n${hunks.join('\n\n')}\n</file>\n\n`;
        }

        const fenceMatch = body.match(/```(?:\w+)?\r?\n([\s\S]*?)\r?\n```/);
        if (fenceMatch) {
            return `\n\n<file path="${cleanPath}" action="${action}">\n${fenceMatch[1]}\n</file>\n\n`;
        }

        return fullMatch;
    });

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

export function extractFileBlocks(text: string): ExtractedFileBlock[] {
    const blocks: ExtractedFileBlock[] = [];
    if (!text || typeof text !== 'string') return blocks;

    const targetText = normalizePseudoFileBlocks(text);
    const openTagRegex = /^[ \t]*<file\s+([^>]*?)>/gim;
    let match: RegExpExecArray | null;

    while ((match = openTagRegex.exec(targetText)) !== null) {
        let start = match.index;
        const attrStr = match[1] || "";
        const bodyStart = match.index + match[0].length;

        const fileAttrs = parseFileTagAttributes(attrStr);
        if (!fileAttrs || !fileAttrs.path || !isValidFilePath(fileAttrs.path)) {
            continue;
        }

        let isClosed = false;
        let end = targetText.length;
        let bodyEnd = targetText.length;

        // Strictly match line-start tags to prevent inline code strings (e.g. `<file path="...">`) from corrupting depth
        const tagFinder = /(?:^|\r?\n)[ \t]*(?:(<\/file>[ \t]*(?:\r?\n|$))|(<file\s+[^>]*?>))/gim;
        tagFinder.lastIndex = bodyStart;

        let innerMatch: RegExpExecArray | null;
        while ((innerMatch = tagFinder.exec(targetText)) !== null) {
            const closeTag = innerMatch[1];
            const nextOpenTag = innerMatch[2];

            if (closeTag) {
                isClosed = true;
                bodyEnd = innerMatch.index;
                end = innerMatch.index + innerMatch[0].length;
                break;
            } else if (nextOpenTag) {
                const nextAttrs = parseFileTagAttributes(nextOpenTag);
                if (nextAttrs && nextAttrs.path && isValidFilePath(nextAttrs.path)) {
                    isClosed = true;
                    bodyEnd = innerMatch.index;
                    end = innerMatch.index;
                    break;
                }
            }
        }

        const textBefore = targetText.substring(0, start);
        const fenceBeforeMatch = textBefore.match(/(?:^|\n)[ \t]*(`{3,}|~{3,})(?:[a-zA-Z0-9_\-]+)?[ \t]*\r?\n[ \t]*$/);

        let fenceLen = 0;
        let fenceChar = '';
        if (fenceBeforeMatch) {
            fenceChar = fenceBeforeMatch[1][0];
            fenceLen = fenceBeforeMatch[1].length;
            const matchOffsetInBefore = textBefore.length - fenceBeforeMatch[0].length;
            const newlineIndex = fenceBeforeMatch[0].indexOf('\n');
            start = newlineIndex !== -1 ? matchOffsetInBefore + newlineIndex + 1 : matchOffsetInBefore;
        }

        if (fenceLen > 0 && isClosed) {
            const textAfter = targetText.substring(end);
            const fenceAfterRegex = new RegExp(`^[ \\t]*(?:\\r?\\n)[ \\t]*${fenceChar}{${fenceLen},}[ \\t]*(?=\\r?\\n|$)`);
            const fenceAfterMatch = textAfter.match(fenceAfterRegex);
            if (fenceAfterMatch) {
                end += fenceAfterMatch[0].length;
            }
        }

        let rawContent = targetText.substring(bodyStart, bodyEnd);
        if (/^```(?:\w+)?\r?\n([\s\S]*?)\r?\n```$/s.test(rawContent.trim())) {
            rawContent = rawContent.trim().replace(/^```(?:\w+)?\r?\n([\s\S]*?)\r?\n```$/s, '$1');
        }

        const fullMatch = targetText.substring(start, end);

        blocks.push({
            attrStr,
            rawContent,
            fullMatch,
            start,
            end,
            isClosed
        });

        openTagRegex.lastIndex = end;
    }

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
        if (!fileAttrs || !fileAttrs.path || !isValidFilePath(fileAttrs.path)) return null;

        const filePath = fileAttrs.path;
        const action = fileAttrs.action;
        const symbol = fileAttrs.symbol || "";

        

        const isPatch = action === 'patch' || (action !== 'write' && action !== 'update_symbol' && rawContent.includes('<<<<<<< SEARCH'));
        const blockIdx = context.blockIndex !== undefined ? context.blockIndex : 0;
        const blockId = `file-mutation-${context.messageId}-${blockIdx}`;
        const actionLabel = isPatch ? 'SURGICAL PATCH' : (symbol ? `SYMBOL: ${symbol}` : 'WRITE FILE');
        const actionIcon = isPatch ? 'codicon-diff-modified' : (symbol ? 'codicon-symbol-method' : 'codicon-file-code');

        const ext = filePath.split('.').pop() || 'plaintext';
        // Only mark as streaming if the message is genuinely still in-flight AND global state is generating
        const isActivelyGenerating = state.isGenerating || (window as any).state?.isGenerating;
        const isStreaming = !context.isFinal && isActivelyGenerating && !match[0].includes('</file>');

        // Check persisted state
        const activeState = state?.appliedState ? state : (window as any).state;
        const appliedHunks = activeState?.appliedState?.[context.messageId]?.[blockIdx] || [];
        const isApplied = appliedHunks.includes(-1);

        let bodyHtml = "";

        if (isPatch) {
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
                        const rLines = (h.replacePart || "").replace(/\r\n/g, '\n').split('\n');

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
                    const rLines = (h.replacePart || "").replace(/\r\n/g, '\n').split('\n');

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
        <details class="code-collapsible file-mutation-card" id="${blockId}" data-path="${filePath}" data-action="${action}" data-symbol="${symbol}" data-block-index="${blockIdx}" data-raw-code="${encodedRawCode}" ${openAttr}>
            <summary class="code-summary">
                <div class="summary-lang-label">
                    <span class="lang-badge" data-lang="${ext}">${ext}</span>
                    <span class="path-display-label" style="font-family: var(--vscode-editor-font-family); font-size: 11px; font-weight: bold; margin-left: 8px; color: var(--vscode-textLink-foreground);">
                        <i class="codicon ${actionIcon}"></i> ${filePath}${symbol ? ` (${symbol})` : ''}
                    </span>
                    <span class="mode-badge active" style="font-size: 9px; padding: 1px 6px; margin-left: 6px;">${actionLabel}</span>
                    ${isStreaming ? '<span class="file-stream-indicator" style="display: inline-flex; align-items: center; gap: 4px; font-size: 10px; color: var(--vscode-charts-blue); font-weight: bold; margin-left: 6px;"><i class="codicon codicon-sync spin"></i> Streaming...</span>' : ''}
                    <button class="code-action-btn goto-file-btn" style="height: 18px; font-size: 9px; padding: 0 5px;" title="Goto: Open this file">Goto</button>
                </div>
                <div class="code-actions">
                    <button class="code-action-btn copy-mutation-btn" title="Copy Content"><i class="codicon codicon-copy"></i></button>
                    ${isPatch ? `<button class="code-action-btn raw-stitch-mutation-btn" title="Open Manual Stitching View"><i class="codicon codicon-source-control"></i></button>` : ''}
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

            // Individual Hunk Apply buttons
            card.querySelectorAll('.apply-hunk-btn').forEach((hunkBtn: HTMLElement) => {
                hunkBtn.onclick = (e: MouseEvent) => {
                    e.stopPropagation();
                    const hIdx = parseInt((hunkBtn as HTMLElement).dataset.hunkIndex || "0", 10);
                    (hunkBtn as HTMLButtonElement).disabled = true;
                    hunkBtn.innerHTML = '<div class="spinner"></div>';

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
                    import('../ui.js').then(ui => {
                        ui.openRawCodeModal(context.messageId, blockIndex, filePath, rawContent, hIdx, card.id);
                    });
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
                    applyBtn.disabled = true;
                    applyBtn.innerHTML = '<div class="spinner"></div>';

                    if (action === 'patch' || (action !== 'write' && action !== 'update_symbol' && rawContent.includes('<<<<<<< SEARCH'))) {
                        context.vscode.postMessage({
                            command: 'replaceCode',
                            filePath,
                            content: rawContent,
                            messageId: context.messageId,
                            blockIndex: blockIndex,
                            blockId: card.id,
                            options: { silent: false, autoSave: false, blockId: card.id, blockIndex: blockIndex }
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
                    import('../ui.js').then(ui => {
                        ui.openRawCodeModal(context.messageId, blockIndex, filePath, rawContent, 0, card.id);
                    });
                };
            }
        });
    }
};

export const fileOpPlugin: TagPlugin = {
    id: 'file_operations',
    tagPattern: /(?:^[ \t]*|(?<=>)[ \t]*)<(move_files|copy_files|delete_files|remove_files_from_context|mute_files|unmute_files)\b([^>]*?)>([\s\S]*?)<\/\1>/gim,
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
            lines = inner.split('\n')
                .map(l => l.trim().replace(/^['"]|['"]$/g, ''))
                .filter(l => l.length > 0 && !l.startsWith('<') && l !== '...');
        }

        if (lines.length === 0) return null;

        let title = "", icon = "", command = "", btnText = "";
        let detailsHtml = "";
        let payload: any = {};

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
            const allFullyActive = needsActivationLines.length === 0;

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
            title = "File Deletion Proposed";
            icon = "codicon-trash";
            command = "deleteFile";
            btnText = `Delete All (${lines.length} files)`;
            detailsHtml = lines.map(p => `
                <div class="expansion-file-item" style="display: flex; align-items: center; gap: 8px; padding: 4px 8px; font-family: var(--vscode-editor-font-family); font-size: 11px;">
                    <span class="codicon codicon-file"></span>
                    <span class="file-label" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${p}</span>
                </div>
            `).join('');
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
        const blockId = `file-op-${type}-${Date.now().toString(36)}-${Math.random().toString(36).substring(7)}`;
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
        ` : `
            <button class="code-action-btn apply-btn file-op-btn" data-command="${command}" data-payload='${JSON.stringify(payload)}'>
                <span class="codicon codicon-check"></span> ${btnText}
            </button>
        `;

        const cardExtraClass = isUnmuteType ? 'unmute-files-block assistant-executable-card' : '';
        const borderAccent = isUnmuteType ? 'border-left: 4px solid var(--vscode-charts-green);' : 'border-left: 4px solid var(--vscode-charts-orange);';

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
    tagPattern: /(?:^[ \t]*|(?<=>)[ \t]*)<unpack_directory\b([^>]*?)>([\s\S]*?)<\/unpack_directory>/gim,
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
    tagPattern: /(?:^[ \t]*|(?<=>)[ \t]*)<(?:load_structure|read_definitions)\b([^>]*?)(?:\/>|>(?:([\s\S]*?)<\/(?:load_structure|read_definitions)>)?)/gim,
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
                        <button class="code-action-btn secondary-btn peek-file-open-btn" data-path="${f}" style="height: 18px; font-size: 9px; padding: 0 5px;" title="Open file in editor">
                            <span class="codicon codicon-file"></span>
                        </button>
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
                <div>The AI requested the architectural structure and typed signatures for <strong>${paths.length === 1 ? paths[0] : `${paths.length} files`}</strong> without loading full file bodies to conserve context budget.</div>
            </div>
        </div>`;
    },
    initialize: (container, context) => {
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
    tagPattern: /(?:^[ \t]*|(?<=>)[ \t]*)<(?:show_symbol|read_symbol|get_symbol_code)\b([^>]*?)(?:\/>|>(?:([\s\S]*?)<\/(?:show_symbol|read_symbol|get_symbol_code)>)?)/gim,
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
                        <span class="file-token-badge weight-light" style="font-size: 9px; border-color: rgba(255, 152, 0, 0.4); color: var(--vscode-charts-orange);">Symbol</span>
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

export const peekFilesPlugin: TagPlugin = {
    id: 'peek_files',
    tagPattern: /(?:^[ \t]*|(?<=>)[ \t]*)<peek_files\b([^>]*?)>([\s\S]*?)<\/peek_files>/gim,
    render: (match, context) => {
        const attrStr = match[1] || "";
        const inner = (match[2] || "").trim();
        const rawPaths = inner.split(/[\s\r\n,]+/).map(p => p.trim().replace(/^['"]|['"]$/g, '')).filter(p => p && !p.startsWith('<'));
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