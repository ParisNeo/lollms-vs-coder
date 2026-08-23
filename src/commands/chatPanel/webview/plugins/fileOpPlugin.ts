import { TagPlugin, PluginContext } from '../pluginSystem';
import { state } from '../dom.js';

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

        const pathMatch = attrStr.match(/path=["']([^"']+)["']/i);
        if (!pathMatch) return null;

        const filePath = pathMatch[1].trim();
        const actionMatch = attrStr.match(/action=["']([^"']+)["']/i);
        const symbolMatch = attrStr.match(/symbol=["']([^"']+)["']/i);

        const action = (actionMatch ? actionMatch[1] : (rawContent.includes('<<<<<<< SEARCH') ? 'patch' : 'write')).toLowerCase();
        const symbol = symbolMatch ? symbolMatch[1].trim() : "";

        const isPatch = action === 'patch' || rawContent.includes('<<<<<<< SEARCH');
        const blockId = `file-op-block-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
        const actionLabel = isPatch ? 'SURGICAL PATCH' : (symbol ? `SYMBOL: ${symbol}` : 'WRITE FILE');
        const actionIcon = isPatch ? 'codicon-diff-modified' : (symbol ? 'codicon-symbol-method' : 'codicon-file-code');

        const ext = filePath.split('.').pop() || 'plaintext';
        const isStreaming = !context.isFinal && !match[0].includes('</file>');

        // Check persisted state
        const blockIdx = context.blockIndex !== undefined ? context.blockIndex : 0;
        const activeState = state?.appliedState ? state : (window as any).state;
        const appliedHunks = activeState?.appliedState?.[context.messageId]?.[blockIdx] || [];
        const isApplied = appliedHunks.includes(-1);

        let bodyHtml = "";

        if (isPatch) {
            // Parse Aider hunks with green/red diff rendering
            const aiderRegex = /<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>> REPLACE/g;
            const matches = [...rawContent.matchAll(aiderRegex)];

            if (matches.length > 0) {
                const hunksHtml = matches.map((m, hIdx) => {
                    const sLines = (m[1] || "").replace(/\r\n/g, '\n').split('\n');
                    const rLines = (m[2] || "").replace(/\r\n/g, '\n').split('\n');

                    let pref = 0;
                    while (pref < sLines.length && pref < rLines.length && sLines[pref].trim() === rLines[pref].trim()) {
                        pref++;
                    }
                    let suff = 0;
                    while (suff < (sLines.length - pref) && suff < (rLines.length - pref) && sLines[sLines.length - 1 - suff].trim() === rLines[rLines.length - 1 - suff].trim()) {
                        suff++;
                    }

                    return `
                    <div class="aider-hunk-bubble" style="border-bottom: ${hIdx < matches.length - 1 ? '1px solid var(--vscode-widget-border)' : 'none'};">
                        ${matches.length > 1 ? `<div style="font-size:10px; font-weight:bold; opacity:0.7; padding:4px 12px; background:rgba(0,0,0,0.15);">HUNK ${hIdx + 1} of ${matches.length}</div>` : ''}
                        <div class="aider-hunk-content">
                            <pre style="margin:0; padding:12px; background:var(--vscode-editor-background); border:none; overflow:auto; max-height:350px;">${renderDiffLines(sLines.slice(0, pref), 'unchanged')}${renderDiffLines(sLines.slice(pref, sLines.length - suff), 'removed')}${renderDiffLines(rLines.slice(pref, rLines.length - suff), 'added')}${renderDiffLines(sLines.slice(sLines.length - suff), 'unchanged')}</pre>
                        </div>
                    </div>`;
                }).join('');

                bodyHtml = `<div class="hunk-contents-wrapper">${hunksHtml}</div>`;
            } else {
                const escapedCode = rawContent.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
                bodyHtml = `<pre style="margin:0; padding:12px; max-height:400px; overflow:auto;"><code class="language-${ext}">${escapedCode}</code></pre>`;
            }
        } else {
            const escapedCode = rawContent.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
            bodyHtml = `<pre style="margin:0; padding:12px; max-height:400px; overflow:auto;"><code class="language-${ext}">${escapedCode}</code></pre>`;
        }

        const encodedRawCode = encodeURIComponent(rawContent);

        // Render collapsed by default if already applied
        const openAttr = isApplied ? '' : 'open';
        const applyBtnClass = isStreaming ? 'apply-btn' : (isApplied ? 'applied' : 'apply-btn');
        const applyBtnIcon = isStreaming ? 'codicon-loading spin' : (isApplied ? 'codicon-check' : 'codicon-tools');
        const applyBtnTitle = isStreaming ? 'Streaming code changes...' : (isApplied ? 'Successfully applied. Click to re-apply.' : 'Review Diff & Apply');
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
                    ${isStreaming ? '<span class="status-label-inline" style="font-size:10px; color:var(--vscode-charts-blue); margin-left:8px;"><i class="codicon codicon-sync spin"></i> Streaming...</span>' : ''}
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
                        ui.openRawCodeModal(context.messageId, blockIndex, filePath, rawContent, 0);
                    });
                };
            }
        });
    }
};

export const fileOpPlugin: TagPlugin = {
    id: 'file_operations',
    tagPattern: /^[ \t]*<(move_files|copy_files|delete_files|remove_files_from_context)>([\s\S]*?)<\/\1>/gim,
    render: (match) => {
        const type = match[1];
        const inner = match[2].trim();
        const lines = inner.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        
        let title = "", icon = "", command = "", btnText = "";
        let detailsHtml = "";

        if (type === 'delete_files') {
            title = "Propose Deletion"; icon = "codicon-trash"; command = "deleteFile"; btnText = "Delete All";
            detailsHtml = lines.map(p => `<div class="expansion-file-item"><span class="codicon codicon-file"></span> ${p}</div>`).join('');
        } else if (type === 'move_files' || type === 'copy_files') {
            title = type === 'move_files' ? "Propose Move" : "Propose Copy";
            icon = type === 'move_files' ? "codicon-arrow-swap" : "codicon-files";
            command = type === 'move_files' ? "bulkMoveFiles" : "bulkCopyFiles";
            btnText = "Apply Changes";
            detailsHtml = lines.map(l => {
                const [src, dest] = l.split('->');
                return `<div class="file-operation-details"><span>${src}</span> <i class="codicon codicon-arrow-right"></i> <span>${dest}</span></div>`;
            }).join('');
        }

        const payload = type === 'delete_files' ? { filePaths: lines } : { operations: lines.map(l => ({ src: l.split('->')[0], dest: l.split('->')[1] })) };

        return `
        <div class="file-operation-block">
            <div class="file-operation-header"><span class="codicon ${icon}"></span> <span>${title}</span></div>
            <div class="expansion-body">
                <div class="expansion-file-list">${detailsHtml}</div>
                <div class="file-operation-actions">
                    <button class="code-action-btn apply-btn file-op-btn" data-command="${command}" data-payload='${JSON.stringify(payload)}'>${btnText}</button>
                </div>
            </div>
        </div>`;
    },
    initialize: (container, context) => {
        container.querySelectorAll('.file-op-btn').forEach(btn => {
            (btn as HTMLElement).onclick = () => {
                const d = (btn as HTMLElement).dataset;
                const parsedPayload = JSON.parse(d.payload!);
                context.vscode.postMessage({ command: d.command, ...parsedPayload });
                (btn as HTMLButtonElement).disabled = true;
                btn.innerHTML = '<i class="codicon codicon-check"></i> Applied';
            };
        });
    }
};