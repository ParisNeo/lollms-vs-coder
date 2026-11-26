import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';

export interface CodeLossReviewOptions {
    filePath: string;
    title: string;
    reason: string;
    originalContent: string;
    proposedContent: string;
    allowAskAi?: boolean;
    signal?: AbortSignal;
}

export type CodeLossReviewDecision = 'accept' | 'reject' | 'ask_ai';

interface DiffOp {
    type: 'equal' | 'remove' | 'add';
    oldLine?: number;
    newLine?: number;
    text: string;
}

function escapeHtml(text: string): string {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function computeLineDiff(originalText: string, proposedText: string): { ops: DiffOp[]; added: number; removed: number } {
    const oldLines = originalText.replace(/\r\n/g, '\n').split('\n');
    const newLines = proposedText.replace(/\r\n/g, '\n').split('\n');

    let prefix = 0;
    while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
        prefix++;
    }

    let suffix = 0;
    while (
        suffix < oldLines.length - prefix &&
        suffix < newLines.length - prefix &&
        oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
    ) {
        suffix++;
    }

    const ops: DiffOp[] = [];
    for (let i = 0; i < prefix; i++) {
        ops.push({ type: 'equal', oldLine: i + 1, newLine: i + 1, text: oldLines[i] });
    }

    const oldMid = oldLines.slice(prefix, oldLines.length - suffix);
    const newMid = newLines.slice(prefix, newLines.length - suffix);
    const m = oldMid.length;
    const n = newMid.length;

    let added = 0;
    let removed = 0;

    if (m === 0 && n === 0) {
        // Identical
    } else if (m === 0) {
        for (let j = 0; j < n; j++) {
            ops.push({ type: 'add', newLine: prefix + j + 1, text: newMid[j] });
            added++;
        }
    } else if (n === 0) {
        for (let i = 0; i < m; i++) {
            ops.push({ type: 'remove', oldLine: prefix + i + 1, text: oldMid[i] });
            removed++;
        }
    } else if (m * n <= 2_500_000) {
        const dp = new Uint32Array((m + 1) * (n + 1));
        const stride = n + 1;
        for (let i = m - 1; i >= 0; i--) {
            const rowOff = i * stride;
            const nextRowOff = (i + 1) * stride;
            const oLine = oldMid[i];
            for (let j = n - 1; j >= 0; j--) {
                if (oLine === newMid[j]) {
                    dp[rowOff + j] = 1 + dp[nextRowOff + j + 1];
                } else {
                    const down = dp[nextRowOff + j];
                    const right = dp[rowOff + j + 1];
                    dp[rowOff + j] = down >= right ? down : right;
                }
            }
        }

        let i = 0;
        let j = 0;
        while (i < m && j < n) {
            if (oldMid[i] === newMid[j]) {
                ops.push({ type: 'equal', oldLine: prefix + i + 1, newLine: prefix + j + 1, text: oldMid[i] });
                i++;
                j++;
            } else if (dp[(i + 1) * stride + j] >= dp[i * stride + (j + 1)]) {
                ops.push({ type: 'remove', oldLine: prefix + i + 1, text: oldMid[i] });
                removed++;
                i++;
            } else {
                ops.push({ type: 'add', newLine: prefix + j + 1, text: newMid[j] });
                added++;
                j++;
            }
        }
        while (i < m) {
            ops.push({ type: 'remove', oldLine: prefix + i + 1, text: oldMid[i] });
            removed++;
            i++;
        }
        while (j < n) {
            ops.push({ type: 'add', newLine: prefix + j + 1, text: newMid[j] });
            added++;
            j++;
        }
    } else {
        for (let i = 0; i < m; i++) {
            ops.push({ type: 'remove', oldLine: prefix + i + 1, text: oldMid[i] });
            removed++;
        }
        for (let j = 0; j < n; j++) {
            ops.push({ type: 'add', newLine: prefix + j + 1, text: newMid[j] });
            added++;
        }
    }

    for (let k = 0; k < suffix; k++) {
        const oldIdx = oldLines.length - suffix + k;
        const newIdx = newLines.length - suffix + k;
        ops.push({ type: 'equal', oldLine: oldIdx + 1, newLine: newIdx + 1, text: oldLines[oldIdx] });
    }

    return { ops, added, removed };
}

export class CodeLossReviewPanel {
    public static confirm(options: CodeLossReviewOptions): Promise<CodeLossReviewDecision> {
        return new Promise<CodeLossReviewDecision>((resolve) => {
            const fileName = path.basename(options.filePath || 'file');
            const panel = vscode.window.createWebviewPanel(
                'lollmsCodeLossReview',
                `Review Diff: ${fileName}`,
                { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
                {
                    enableScripts: true,
                    retainContextWhenHidden: true
                }
            );

            let settled = false;
            const settle = (decision: CodeLossReviewDecision) => {
                if (settled) return;
                settled = true;
                if (options.signal) {
                    options.signal.removeEventListener('abort', onAbort);
                }
                resolve(decision);
                try {
                    panel.dispose();
                } catch {}
            };

            const onAbort = () => settle('reject');
            if (options.signal) {
                if (options.signal.aborted) {
                    settle('reject');
                    return;
                }
                options.signal.addEventListener('abort', onAbort, { once: true });
            }

            panel.onDidDispose(() => {
                settle('reject');
            });

            panel.webview.onDidReceiveMessage((msg) => {
                if (!msg || typeof msg.command !== 'string') return;
                if (msg.command === 'decision') {
                    if (msg.decision === 'accept') settle('accept');
                    else if (msg.decision === 'ask_ai' && options.allowAskAi) settle('ask_ai');
                    else settle('reject');
                }
            });

            panel.webview.html = CodeLossReviewPanel.buildHtml(panel.webview, options);
            panel.reveal(vscode.ViewColumn.Active, false);
        });
    }

    private static buildHtml(webview: vscode.Webview, options: CodeLossReviewOptions): string {
        const nonce = crypto.randomBytes(16).toString('hex');
        const { ops, added, removed } = computeLineDiff(options.originalContent, options.proposedContent);

        const origLines = options.originalContent ? options.originalContent.split(/\r?\n/).length : 0;
        const newLines = options.proposedContent ? options.proposedContent.split(/\r?\n/).length : 0;
        const origChars = options.originalContent.length;
        const newChars = options.proposedContent.length;
        const sizePct = origChars > 0 ? Math.round((newChars / origChars) * 100) : 100;

        // Render unified diff rows with collapsible unchanged context runs
        const CONTEXT_RADIUS = 3;
        const unifiedRows: string[] = [];
        const splitRows: string[] = [];

        const isChanged = ops.map(o => o.type !== 'equal');
        const keepVisible = new Array<boolean>(ops.length).fill(false);
        for (let i = 0; i < ops.length; i++) {
            if (isChanged[i]) {
                const start = Math.max(0, i - CONTEXT_RADIUS);
                const end = Math.min(ops.length - 1, i + CONTEXT_RADIUS);
                for (let k = start; k <= end; k++) keepVisible[k] = true;
            }
        }

        let foldCounter = 0;
        let idx = 0;
        while (idx < ops.length) {
            if (keepVisible[idx]) {
                const op = ops[idx];
                const sign = op.type === 'add' ? '+' : (op.type === 'remove' ? '-' : ' ');
                const cls = op.type === 'add' ? 'diff-add' : (op.type === 'remove' ? 'diff-rem' : 'diff-eq');
                unifiedRows.push(
                    `<tr class="${cls}">` +
                    `<td class="ln">${op.oldLine ?? ''}</td>` +
                    `<td class="ln">${op.newLine ?? ''}</td>` +
                    `<td class="sign">${sign}</td>` +
                    `<td class="code">${escapeHtml(op.text)}</td>` +
                    `</tr>`
                );
                idx++;
            } else {
                const foldId = `fold_${foldCounter++}`;
                const hiddenRows: string[] = [];
                let count = 0;
                while (idx < ops.length && !keepVisible[idx]) {
                    const op = ops[idx];
                    hiddenRows.push(
                        `<tr class="diff-eq folded-row" data-fold-group="${foldId}">` +
                        `<td class="ln">${op.oldLine ?? ''}</td>` +
                        `<td class="ln">${op.newLine ?? ''}</td>` +
                        `<td class="sign"> </td>` +
                        `<td class="code">${escapeHtml(op.text)}</td>` +
                        `</tr>`
                    );
                    count++;
                    idx++;
                }
                unifiedRows.push(
                    `<tr class="fold-banner" data-fold-target="${foldId}">` +
                    `<td colspan="4" class="fold-cell">⋯ ${count} unchanged line${count === 1 ? '' : 's'} hidden (click to expand)</td>` +
                    `</tr>`
                );
                unifiedRows.push(...hiddenRows);
            }
        }

        // Build side-by-side split rows pairing adjacent remove/add blocks
        let si = 0;
        while (si < ops.length) {
            if (ops[si].type === 'equal') {
                const op = ops[si];
                const hiddenCls = keepVisible[si] ? '' : ' split-unchanged-extra';
                splitRows.push(
                    `<tr class="${hiddenCls}">` +
                    `<td class="ln">${op.oldLine ?? ''}</td><td class="code diff-eq">${escapeHtml(op.text)}</td>` +
                    `<td class="ln">${op.newLine ?? ''}</td><td class="code diff-eq">${escapeHtml(op.text)}</td>` +
                    `</tr>`
                );
                si++;
            } else {
                const rems: DiffOp[] = [];
                const adds: DiffOp[] = [];
                while (si < ops.length && ops[si].type !== 'equal') {
                    if (ops[si].type === 'remove') rems.push(ops[si]);
                    else adds.push(ops[si]);
                    si++;
                }
                const maxLen = Math.max(rems.length, adds.length);
                for (let k = 0; k < maxLen; k++) {
                    const r = rems[k];
                    const a = adds[k];
                    splitRows.push(
                        `<tr>` +
                        `<td class="ln ${r ? 'diff-rem' : 'diff-empty'}">${r?.oldLine ?? ''}</td>` +
                        `<td class="code ${r ? 'diff-rem' : 'diff-empty'}">${r ? escapeHtml(r.text) : ''}</td>` +
                        `<td class="ln ${a ? 'diff-add' : 'diff-empty'}">${a?.newLine ?? ''}</td>` +
                        `<td class="code ${a ? 'diff-add' : 'diff-empty'}">${a ? escapeHtml(a.text) : ''}</td>` +
                        `</tr>`
                    );
                }
            }
        }

        const askAiButton = options.allowAskAi
            ? `<button id="btn-ask-ai" class="btn btn-secondary" title="Ask the AI to output the complete file without placeholders">Ask AI for Full Code</button>`
            : '';

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(options.title)}</title>
<style nonce="${nonce}">
    :root {
        --bg: var(--vscode-editor-background, #1e1e1e);
        --fg: var(--vscode-editor-foreground, #d4d4d4);
        --border: var(--vscode-widget-border, #3c3c3c);
        --header-bg: var(--vscode-sideBarSectionHeader-background, #252526);
        --warn-bg: rgba(214, 122, 13, 0.14);
        --warn-border: var(--vscode-charts-orange, #d67a0d);
        --add-bg: var(--vscode-diffEditor-insertedLineBackground, rgba(46, 160, 67, 0.2));
        --rem-bg: var(--vscode-diffEditor-removedLineBackground, rgba(248, 81, 73, 0.22));
        --mono: var(--vscode-editor-font-family, Consolas, 'Courier New', monospace);
    }
    * { box-sizing: border-box; }
    body {
        margin: 0;
        padding: 0;
        background: var(--bg);
        color: var(--fg);
        font-family: var(--vscode-font-family, sans-serif);
        display: flex;
        flex-direction: column;
        height: 100vh;
        overflow: hidden;
    }
    .top-banner {
        padding: 14px 18px;
        background: var(--warn-bg);
        border-bottom: 2px solid var(--warn-border);
        display: flex;
        flex-direction: column;
        gap: 8px;
        flex-shrink: 0;
    }
    .banner-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
    }
    .title {
        font-size: 14px;
        font-weight: 700;
        color: var(--warn-border);
        display: flex;
        align-items: center;
        gap: 8px;
    }
    .file-pill {
        font-family: var(--mono);
        font-size: 12px;
        padding: 2px 8px;
        border-radius: 4px;
        background: rgba(0, 0, 0, 0.25);
        border: 1px solid var(--border);
    }
    .reason {
        font-size: 12px;
        line-height: 1.45;
        opacity: 0.95;
    }
    .stats {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
        font-size: 11px;
        font-family: var(--mono);
    }
    .stat-badge {
        padding: 2px 8px;
        border-radius: 999px;
        border: 1px solid var(--border);
        background: var(--header-bg);
    }
    .stat-rem { color: var(--vscode-charts-red, #f85149); border-color: rgba(248, 81, 73, 0.45); }
    .stat-add { color: var(--vscode-charts-green, #3fb950); border-color: rgba(63, 185, 80, 0.45); }
    .toolbar {
        padding: 8px 18px;
        background: var(--header-bg);
        border-bottom: 1px solid var(--border);
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        flex-shrink: 0;
    }
    .toolbar-group {
        display: flex;
        align-items: center;
        gap: 8px;
    }
    .btn {
        border: 1px solid var(--border);
        border-radius: 4px;
        padding: 5px 12px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        background: var(--vscode-button-secondaryBackground, #3a3d41);
        color: var(--vscode-button-secondaryForeground, #ffffff);
    }
    .btn:hover { filter: brightness(1.1); }
    .btn.active {
        background: var(--vscode-button-background, #0e639c);
        color: var(--vscode-button-foreground, #ffffff);
        border-color: transparent;
    }
    .btn-accept {
        background: var(--vscode-charts-green, #2ea043);
        color: #ffffff;
        border-color: transparent;
    }
    .btn-reject {
        background: var(--vscode-charts-red, #d73a49);
        color: #ffffff;
        border-color: transparent;
    }
    .diff-container {
        flex: 1;
        overflow: auto;
        font-family: var(--mono);
        font-size: 12px;
        line-height: 1.45;
    }
    table.diff-table {
        width: 100%;
        border-collapse: collapse;
        table-layout: fixed;
    }
    table.diff-table td {
        padding: 1px 6px;
        vertical-align: top;
        white-space: pre-wrap;
        word-break: break-word;
    }
    td.ln {
        width: 48px;
        min-width: 48px;
        text-align: right;
        opacity: 0.55;
        user-select: none;
        border-right: 1px solid var(--border);
        font-size: 11px;
    }
    td.sign {
        width: 22px;
        min-width: 22px;
        text-align: center;
        user-select: none;
        font-weight: 700;
    }
    td.code {
        width: auto;
        padding-left: 8px;
    }
    .diff-add { background: var(--add-bg); }
    .diff-rem { background: var(--rem-bg); }
    .diff-empty { background: rgba(128, 128, 128, 0.08); }
    .folded-row { display: none; }
    .show-all .folded-row { display: table-row; }
    .show-all .fold-banner { display: none; }
    .split-unchanged-extra { display: none; }
    .show-all .split-unchanged-extra { display: table-row; }
    .fold-banner {
        background: rgba(128, 128, 128, 0.12);
        cursor: pointer;
    }
    .fold-banner:hover { background: rgba(128, 128, 128, 0.22); }
    .fold-cell {
        text-align: center;
        font-size: 11px;
        opacity: 0.8;
        padding: 4px 8px !important;
        font-style: italic;
    }
    .split-header th {
        position: sticky;
        top: 0;
        background: var(--header-bg);
        border-bottom: 1px solid var(--border);
        padding: 4px 8px;
        text-align: left;
        font-size: 11px;
        z-index: 2;
    }
    .footer {
        padding: 10px 18px;
        background: var(--header-bg);
        border-top: 1px solid var(--border);
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        flex-shrink: 0;
    }
    .footer-note {
        font-size: 12px;
        opacity: 0.85;
    }
    .hidden { display: none !important; }
</style>
</head>
<body>
    <div class="top-banner">
        <div class="banner-row">
            <div class="title">⚠️ ${escapeHtml(options.title)}</div>
            <span class="file-pill">${escapeHtml(options.filePath)}</span>
        </div>
        <div class="reason">${escapeHtml(options.reason)}</div>
        <div class="stats">
            <span class="stat-badge">Lines: ${origLines} → ${newLines}</span>
            <span class="stat-badge">Chars: ${origChars.toLocaleString()} → ${newChars.toLocaleString()} (${sizePct}%)</span>
            <span class="stat-badge stat-rem">-${removed} removed</span>
            <span class="stat-badge stat-add">+${added} added</span>
        </div>
    </div>

    <div class="toolbar">
        <div class="toolbar-group">
            <button id="btn-mode-unified" class="btn active">Unified Diff</button>
            <button id="btn-mode-split" class="btn">Side-by-Side Split</button>
            <button id="btn-toggle-full" class="btn">Show All Unchanged Lines</button>
        </div>
        <div class="toolbar-group">
            ${askAiButton}
            <button id="btn-reject-top" class="btn btn-reject">Reject &amp; Keep Original</button>
            <button id="btn-accept-top" class="btn btn-accept">Accept &amp; Apply Changes</button>
        </div>
    </div>

    <div id="diff-container" class="diff-container">
        <table id="unified-table" class="diff-table">
            <tbody>${unifiedRows.join('')}</tbody>
        </table>
        <table id="split-table" class="diff-table hidden">
            <thead class="split-header">
                <tr>
                    <th style="width:48px;">Line</th>
                    <th>Original (On Disk)</th>
                    <th style="width:48px;">Line</th>
                    <th>Proposed (New Content)</th>
                </tr>
            </thead>
            <tbody>${splitRows.join('')}</tbody>
        </table>
    </div>

    <div class="footer">
        <div class="footer-note">Verify the diff above carefully before accepting. Closing this tab rejects the changes.</div>
        <div class="toolbar-group">
            <button id="btn-reject" class="btn btn-reject">Reject &amp; Keep Original</button>
            <button id="btn-accept" class="btn btn-accept">Accept &amp; Apply Changes</button>
        </div>
    </div>

<script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const unifiedBtn = document.getElementById('btn-mode-unified');
    const splitBtn = document.getElementById('btn-mode-split');
    const fullBtn = document.getElementById('btn-toggle-full');
    const unifiedTable = document.getElementById('unified-table');
    const splitTable = document.getElementById('split-table');
    const diffContainer = document.getElementById('diff-container');

    unifiedBtn.addEventListener('click', () => {
        unifiedBtn.classList.add('active');
        splitBtn.classList.remove('active');
        unifiedTable.classList.remove('hidden');
        splitTable.classList.add('hidden');
    });

    splitBtn.addEventListener('click', () => {
        splitBtn.classList.add('active');
        unifiedBtn.classList.remove('active');
        splitTable.classList.remove('hidden');
        unifiedTable.classList.add('hidden');
    });

    let showingAll = false;
    fullBtn.addEventListener('click', () => {
        showingAll = !showingAll;
        diffContainer.classList.toggle('show-all', showingAll);
        fullBtn.classList.toggle('active', showingAll);
        fullBtn.textContent = showingAll ? 'Collapse Unchanged Lines' : 'Show All Unchanged Lines';
    });

    document.querySelectorAll('.fold-banner').forEach((banner) => {
        banner.addEventListener('click', () => {
            const target = banner.getAttribute('data-fold-target');
            if (!target) return;
            document.querySelectorAll('.folded-row[data-fold-group="' + target + '"]').forEach((row) => {
                row.style.display = 'table-row';
            });
            banner.style.display = 'none';
        });
    });

    const sendDecision = (decision) => {
        vscode.postMessage({ command: 'decision', decision });
    };

    document.getElementById('btn-accept').addEventListener('click', () => sendDecision('accept'));
    document.getElementById('btn-accept-top').addEventListener('click', () => sendDecision('accept'));
    document.getElementById('btn-reject').addEventListener('click', () => sendDecision('reject'));
    document.getElementById('btn-reject-top').addEventListener('click', () => sendDecision('reject'));
    const askAiBtn = document.getElementById('btn-ask-ai');
    if (askAiBtn) {
        askAiBtn.addEventListener('click', () => sendDecision('ask_ai'));
    }
</script>
</body>
</html>`;
    }
}