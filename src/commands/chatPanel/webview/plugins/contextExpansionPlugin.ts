import { TagPlugin, PluginContext } from '../pluginSystem';
import { state } from '../dom.js';
import DOMPurify from 'dompurify';

export const contextExpansionPlugin: TagPlugin = {
    id: 'add_files_to_context',
    // Support <add_files_to_context paths='[...]'>Body</add_files_to_context>
    tagPattern: /(?:^[ \t]*|(?<=>)[ \t]*)<add_files_to_context\b([^>]*?)>([\s\S]*?)<\/add_files_to_context>/gim,

    render: (match, context) => {
        const attrPart = match[1] || "";
        let inner = match[2] || "";

        // SELF-HEALING CARVER: If the regex matched from an conversational inline tag to the final closing tag,
        // carve out the prefix prose and isolate only the actual execution block.
        const lastOpenTagIdx = inner.lastIndexOf('<add_files_to_context>');
        if (lastOpenTagIdx !== -1) {
            // Slice to start immediately after the last duplicate opening tag
            inner = inner.substring(lastOpenTagIdx + 22); 
        }

        let paths: string[] = [];

        const attrMatch = attrPart.match(/paths=['"](\[.*?\])['"]/i);
        if (attrMatch) {
            try { paths = JSON.parse(attrMatch[1].replace(/'/g, '"')); } catch(e) {}
        }

        if (paths.length === 0) {
            // Robust path splitter: parses files without extensions (e.g. LICENSE, Makefile) while ignoring stray XML brackets or dots
            paths = inner.split(/[\s\r\n,]+/)
                .map(p => p.trim().replace(/^['"]|['"]$/g, '')) // Strip accidentally outputted quotes
                .filter(p => p.length > 0 && !p.startsWith('<') && !p.startsWith('/') && p !== '...');
        }

        if (paths.length === 0) return null;

        // --- LIVE STATE CHECK ---
        // Prioritize state.lastContextData.files which is the Source of Truth for "Possessed" code.
        const activeState = state?.lastContextData ? state : (window as any).state;
        const currentFiles = activeState?.lastContextData?.files || [];
        
        const blockId = `ctx-exp-${context.messageId}-${Math.random().toString(36).substring(7)}`;
        const fileListJson = JSON.stringify(paths).replace(/"/g, '&quot;');

        // --- RESILIENT PATH MATCHING ---
        const isPathInContext = (p: string) => {
            if (!p) return false;
            const cleanP = p.replace(/\\/g, '/').replace(/^\.?\//, '').toLowerCase().trim();
            return (currentFiles || []).some((cf: any) => {
                const cfStr = typeof cf === 'string' ? cf : (cf?.path || '');
                if (!cfStr) return false;
                const cleanCf = cfStr.replace(/\\/g, '/').replace(/^\.?\//, '').toLowerCase().trim();
                return cleanCf === cleanP || cleanCf.endsWith('/' + cleanP) || cleanP.endsWith('/' + cleanCf);
            });
        };

        let allIncluded = true;
        const fileItems = (paths || []).map(f => {
            const isIncluded = isPathInContext(f);
            if (!isIncluded) allIncluded = false;

            const itemClass = isIncluded ? 'status-in-context' : 'status-not-in-context';
            const itemStyle = isIncluded 
                ? 'border-color: var(--vscode-charts-green, #388e3c); background: rgba(15, 157, 88, 0.1); border-left: 4px solid var(--vscode-charts-green, #388e3c); color: var(--vscode-charts-green, #388e3c);' 
                : 'border-color: var(--vscode-widget-border); background: var(--vscode-editor-background); color: var(--vscode-editor-foreground, #000000);';
            const iconStyle = isIncluded ? 'color: var(--vscode-charts-green, #388e3c);' : 'color: var(--vscode-editor-foreground, #000000);';

            return `
            <div class="expansion-file-item ${itemClass}" data-path="${f}" data-message-id="${context.messageId}" style="display:flex; align-items:center; padding: 6px 12px; margin-bottom: 4px; border: 1px solid var(--vscode-widget-border); border-radius: 4px; ${itemStyle}">
                <div style="display:flex; align-items:center; gap:8px;">
                    <span class="codicon ${isIncluded ? 'codicon-check' : 'codicon-file-add'}" style="${iconStyle}"></span>
                    <span class="file-label" style="font-family: var(--vscode-editor-font-family); font-size: 12px;">${f}</span>
                </div>
            </div>`;
        }).join('');

        const btnText = allIncluded ? 'Added to Context' : 'Add all to Context';
        const addBtnClass = allIncluded ? 'applied' : 'apply-btn';
        const btnIcon = allIncluded ? 'codicon-check' : 'codicon-add';

        // The Reprompt button stays active even if files are added
        const repromptText = allIncluded ? 'Reprompt AI' : 'Add & Reprompt';
        const repromptIcon = allIncluded ? 'codicon-play' : 'codicon-sync';

        return `
        <div class="context-expansion-block expansion-request-block" id="${blockId}" data-files="${fileListJson}" data-block-id="${blockId}">
            <div class="expansion-header">
                <span class="codicon codicon-library"></span>
                <span>Context Expansion Requested</span>
            </div>
            <div class="expansion-body">
                <div class="expansion-file-list" id="list-${blockId}" style="margin-bottom:12px;">
                    ${fileItems}
                </div>
                <div style="display:flex; gap: 8px; flex-wrap: wrap;">
                    <button class="code-action-btn ${addBtnClass} add-btn" ${allIncluded ? 'disabled' : ''} data-block-id="${blockId}">
                        <span class="codicon ${btnIcon}"></span> ${btnText}
                    </button>
                    <button class="code-action-btn apply-btn add-reprompt-btn" id="btn-reprompt-${blockId}" data-block-id="${blockId}">
                        <span class="codicon ${repromptIcon}"></span> ${repromptText}
                    </button>
                    <button class="code-action-btn secondary-btn replace-btn" data-block-id="${blockId}" title="Remove all other files from context and add these">
                        <span class="codicon codicon-clear-all"></span> Replace Context
                    </button>
                    <button class="code-action-btn secondary-btn save-selection-btn" data-files="${fileListJson}" title="Save this selection of files as a context file">
                        <span class="codicon codicon-save"></span> Save Selection
                    </button>
                    <button class="code-action-btn secondary-btn copy-btn" data-files="${fileListJson}" title="Copy the contents of the files in this card">
                        <span class="codicon codicon-clippy"></span> Copy Contents
                    </button>
                    <button class="code-action-btn secondary-btn copy-all-turn-btn" data-message-id="${context.messageId}" title="Copy the content of all files added to context in the current turn">
                        <span class="codicon codicon-copy"></span> Copy All
                    </button>
                </div>
            </div>
        </div>`;
    },

    initialize: (container, context) => {
        // Only query backend and sync DOM states ONCE at the conclusion of generation
        if (!context.isFinal) return;

        // Query backend for exact on-disk existence and inclusion status
        container.querySelectorAll('.context-expansion-block').forEach((block: any) => {
            try {
                const files = JSON.parse(block.dataset.files || '[]');
                if (files.length > 0 && block.id) {
                    context.vscode.postMessage({
                        command: 'checkFilesStatus',
                        files,
                        blockId: block.id
                    });
                }
            } catch (e) {}
        });

        // Single DOM sync at end of generation
        import('../ui.js').then(ui => ui.syncExpansionBlocks());

        const handleAdd = (btn: HTMLButtonElement, reprompt: boolean) => {
            const block = btn.closest('.context-expansion-block') as HTMLElement;
            if (!block) return;
            const files = JSON.parse(block.dataset.files || '[]');
            btn.innerHTML = '<div class="spinner"></div> Adding...';

            // Disable both buttons to prevent double-triggering
            block.querySelectorAll('.add-btn, .add-reprompt-btn, .replace-btn').forEach(b => (b as HTMLButtonElement).disabled = true);

            context.vscode.postMessage({ 
                command: 'addFilesToContext', 
                files, 
                blockId: block.id,
                reprompt // Flag to trigger automatic user feedback
            });
        };

        container.querySelectorAll('.add-btn').forEach(btn => {
            (btn as HTMLButtonElement).onclick = () => handleAdd(btn as HTMLButtonElement, false);
        });

        container.querySelectorAll('.add-reprompt-btn').forEach(btn => {
            (btn as HTMLButtonElement).onclick = () => handleAdd(btn as HTMLButtonElement, true);
        });

        container.querySelectorAll('.replace-btn').forEach(btn => {
            (btn as HTMLButtonElement).onclick = () => {
                const block = btn.closest('.context-expansion-block') as HTMLElement;
                const files = JSON.parse(block?.dataset.files || '[]');
                btn.innerHTML = '<div class="spinner"></div> Replacing...';

                // Disable buttons during transition
                block.querySelectorAll('.add-btn, .add-reprompt-btn, .replace-btn').forEach(b => (b as HTMLButtonElement).disabled = true);

                // 1. Reset selection first
                context.vscode.postMessage({
                    command: 'executeLollmsCommand',
                    details: { command: 'lollms-vs-coder.resetContextSelection' }
                });

                // 2. Add these files to context
                context.vscode.postMessage({ 
                    command: 'addFilesToContext', 
                    files, 
                    blockId: block.id,
                    reprompt: false
                });
            };
        });

        container.querySelectorAll('.save-selection-btn').forEach(btn => {
            (btn as HTMLButtonElement).onclick = () => {
                const files = JSON.parse((btn as HTMLElement).dataset.files || '[]');
                context.vscode.postMessage({
                    command: 'executeLollmsCommand',
                    details: {
                        command: 'lollms-vs-coder.saveCustomContextSelection',
                        params: [files]
                    }
                });
            };
        });

        container.querySelectorAll('.copy-btn').forEach(btn => {
            (btn as HTMLButtonElement).onclick = (e: MouseEvent) => {
                e.stopPropagation();
                const btnEl = btn as HTMLButtonElement;
                const files = JSON.parse(btnEl.dataset.files || '[]');
                if (files.length > 0) {
                    context.vscode.postMessage({ command: 'copyFilesToClipboard', files });
                    const origHtml = btnEl.innerHTML;
                    btnEl.classList.add('success');
                    btnEl.innerHTML = `<span class="codicon codicon-check"></span> Copied!`;
                    setTimeout(() => {
                        btnEl.classList.remove('success');
                        btnEl.innerHTML = origHtml;
                    }, 2000);
                }
            };
        });

        container.querySelectorAll('.copy-all-turn-btn').forEach(btn => {
            (btn as HTMLButtonElement).onclick = (e: MouseEvent) => {
                e.stopPropagation();
                const btnEl = btn as HTMLButtonElement;
                const msgId = btnEl.dataset.messageId;
                const wrapper = msgId ? document.querySelector(`.message-wrapper[data-message-id='${msgId}']`) : btnEl.closest('.message-wrapper');

                const allFiles: string[] = [];
                const searchScope = wrapper || container;
                searchScope.querySelectorAll('.context-expansion-block').forEach((block: any) => {
                    try {
                        const bFiles = JSON.parse(block.dataset.files || '[]');
                        if (Array.isArray(bFiles)) {
                            bFiles.forEach((f: string) => {
                                if (f && !allFiles.includes(f)) allFiles.push(f);
                            });
                        }
                    } catch {}
                });

                if (allFiles.length > 0) {
                    context.vscode.postMessage({ command: 'copyFilesToClipboard', files: allFiles });
                    const origHtml = btnEl.innerHTML;
                    btnEl.classList.add('success');
                    btnEl.innerHTML = `<span class="codicon codicon-check"></span> Copied All (${allFiles.length})!`;
                    setTimeout(() => {
                        btnEl.classList.remove('success');
                        btnEl.innerHTML = origHtml;
                    }, 2000);
                }
            };
        });
    }
};