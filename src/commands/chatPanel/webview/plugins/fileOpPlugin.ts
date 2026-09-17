import { TagPlugin, PluginContext } from '../pluginSystem';
import { state } from '../dom.js';
import { normalizeAiderContent, parseAiderHunks, parseFileTagAttributes } from '../utils.js';

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

export function extractFileBlocks(text: string): ExtractedFileBlock[] {
    const blocks: ExtractedFileBlock[] = [];
    if (!text || typeof text !== 'string') return blocks;

    const openTagRegex = /^[ \t]*<file\s+([^>]*?)>/gim;
    let match: RegExpExecArray | null;

    while ((match = openTagRegex.exec(text)) !== null) {
        const start = match.index;
        const attrStr = match[1] || "";
        const bodyStart = match.index + match[0].length;

        let depth = 1;
        let isClosed = false;
        let end = text.length;
        let bodyEnd = text.length;

        const tagFinder = /<file\b([^>]*?)>|<\/file>/gi;
        tagFinder.lastIndex = bodyStart;

        let innerMatch: RegExpExecArray | null;
        while ((innerMatch = tagFinder.exec(text)) !== null) {
            const tag = innerMatch[0];
            if (tag.toLowerCase() === '</file>') {
                depth--;
                if (depth === 0) {
                    isClosed = true;
                    bodyEnd = innerMatch.index;
                    end = innerMatch.index + tag.length;
                    break;
                }
            } else {
                const innerAttr = innerMatch[1] || "";
                if (!innerAttr.trim().endsWith('/')) {
                    depth++;
                }
            }
        }

        const rawContent = text.substring(bodyStart, bodyEnd);
        const fullMatch = text.substring(start, end);

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
        if (!fileAttrs || !fileAttrs.path) return null;

        const filePath = fileAttrs.path;
        const action = fileAttrs.action;
        const symbol = fileAttrs.symbol || "";

        

        const isPatch = action === 'patch' || rawContent.includes('<<<<<<< SEARCH');
        const blockIdx = context.blockIndex !== undefined ? context.blockIndex : 0;
        const blockId = `file-mutation-${context.messageId}-${blockIdx}`;
        const actionLabel = isPatch ? 'SURGICAL PATCH' : (symbol ? `SYMBOL: ${symbol}` : 'WRITE FILE');
        const actionIcon = isPatch ? 'codicon-diff-modified' : (symbol ? 'codicon-symbol-method' : 'codicon-file-code');

        const ext = filePath.split('.').pop() || 'plaintext';
        const isStreaming = !context.isFinal && !match[0].includes('</file>');

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

                    if (action === 'patch' || rawContent.includes('<<<<<<< SEARCH')) {
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
    tagPattern: /(?:^[ \t]*|(?<=>)[ \t]*)<(move_files|copy_files|delete_files|remove_files_from_context)\b([^>]*?)>([\s\S]*?)<\/\1>/gim,
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

        return `
        <div class="file-operation-block" style="background-color: var(--vscode-editor-inactiveSelectionBackground); border: 1px solid var(--vscode-widget-border); border-left: 4px solid var(--vscode-charts-orange); border-radius: 8px; margin: 12px 0; overflow: hidden;">
            <div class="file-operation-header" style="padding: 8px 12px; background: var(--vscode-sideBarSectionHeader-background); display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 12px;">
                <span class="codicon ${icon}"></span> 
                <span>${title}</span>
            </div>
            <div class="expansion-body" style="padding: 12px;">
                <div class="expansion-file-list" style="margin-bottom: 12px; max-height: 240px; overflow-y: auto;">
                    ${detailsHtml}
                </div>
                <div class="file-operation-actions" style="display: flex; justify-content: flex-end; gap: 8px;">
                    <button class="code-action-btn apply-btn file-op-btn" data-command="${command}" data-payload='${JSON.stringify(payload)}'>
                        <span class="codicon codicon-check"></span> ${btnText}
                    </button>
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

        const filesPayload = rawPaths.map(p => ({
            path: p,
            ...peekOptions
        }));

        const encodedPayload = encodeURIComponent(JSON.stringify(filesPayload));
        const blockId = `peek-block-${context.messageId}-${Date.now().toString(36)}`;

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