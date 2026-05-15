import { TagPlugin, PluginContext } from '../pluginSystem';
import DOMPurify from 'dompurify';

export const contextExpansionPlugin: TagPlugin = {
    id: 'add_files_to_context',
    // Support <add_files_to_context paths='[...]'>Body</add_files_to_context>
    tagPattern: /<add_files_to_context\b([^>]*?)>([\s\S]*?)<\/add_files_to_context>/gi,
    
    render: (match, context) => {
        const attrPart = match[1] || "";
        const inner = match[2] || "";
        let paths: string[] = [];

        const attrMatch = attrPart.match(/paths=['"](\[.*?\])['"]/i);
        if (attrMatch) {
            try { paths = JSON.parse(attrMatch[1].replace(/'/g, '"')); } catch(e) {}
        }

        if (paths.length === 0) {
            paths = inner.split(/[\s\r\n,]+/).map(p => p.trim()).filter(p => p.length > 0 && p.includes('.'));
        }

        if (paths.length === 0) return null;

        // --- LIVE STATE CHECK ---
        // Prioritize state.lastContextData.files which is the Source of Truth for "Possessed" code.
        const globalState = (window as any).state;
        const currentFiles = globalState?.lastContextData?.files || [];
        
        const blockId = `ctx-exp-${context.messageId}-${Math.random().toString(36).substring(7)}`;
        const fileListJson = JSON.stringify(paths).replace(/"/g, '&quot;');

        // --- RESILIENT PATH MATCHING ---
        const isPathInContext = (p: string) => {
            if (!p) return false;
            const cleanP = p.replace(/\\/g, '/').replace(/^\.?\//, '').toLowerCase().trim();
            return (currentFiles || []).some((cf: string) => {
                const cleanCf = cf.replace(/\\/g, '/').replace(/^\.?\//, '').toLowerCase().trim();
                return cleanCf === cleanP || cleanCf.endsWith('/' + cleanP) || cleanP.endsWith('/' + cleanCf);
            });
        };

        let allIncluded = true;
        const fileItems = (paths || []).map(f => {
            const isIncluded = isPathInContext(f);
            if (!isIncluded) allIncluded = false;

            const itemStyle = isIncluded ? 'border-color: var(--vscode-charts-green); background: rgba(15, 157, 88, 0.1); border-left: 4px solid var(--vscode-charts-green);' : '';
            const iconStyle = isIncluded ? 'color: var(--vscode-charts-green);' : '';

            return `
            <div class="expansion-file-item" data-path="${f}" data-message-id="${context.messageId}" style="display:flex; align-items:center; padding: 6px 12px; margin-bottom: 4px; border: 1px solid var(--vscode-widget-border); border-radius: 4px; ${itemStyle}">
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
        <div class="context-expansion-block expansion-request-block" id="${blockId}" data-files="${fileListJson}">
            <div class="expansion-header">
                <span class="codicon codicon-library"></span>
                <span>Context Expansion Requested</span>
            </div>
            <div class="expansion-body">
                <div class="expansion-file-list" style="margin-bottom:12px;">
                    ${fileItems}
                </div>
                <div style="display:flex; gap: 8px; flex-wrap: wrap;">
                    <button class="code-action-btn ${addBtnClass} add-btn" ${allIncluded ? 'disabled' : ''} data-block-id="${blockId}">
                        <span class="codicon ${btnIcon}"></span> ${btnText}
                    </button>
                    <button class="code-action-btn apply-btn add-reprompt-btn" data-block-id="${blockId}">
                        <span class="codicon ${repromptIcon}"></span> ${repromptText}
                    </button>
                    <button class="code-action-btn secondary-btn copy-btn" data-files="${fileListJson}">
                        <span class="codicon codicon-clippy"></span> Copy Contents
                    </button>
                </div>
            </div>
        </div>`;
    },

    initialize: (container, context) => {
        // Immediate sync for the whole DOM since we just injected new elements
        import('../ui.js').then(ui => ui.syncExpansionBlocks());

        const handleAdd = (btn: HTMLButtonElement, reprompt: boolean) => {
            const block = btn.closest('.context-expansion-block') as HTMLElement;
            const files = JSON.parse(block?.dataset.files || '[]');
            btn.innerHTML = '<div class="spinner"></div> Adding...';

            // Disable both buttons to prevent double-triggering
            block.querySelectorAll('.add-btn, .add-reprompt-btn').forEach(b => (b as HTMLButtonElement).disabled = true);

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

        container.querySelectorAll('.copy-btn').forEach(btn => {
            (btn as HTMLButtonElement).onclick = () => {
                const files = JSON.parse((btn as HTMLElement).dataset.files || '[]');
                context.vscode.postMessage({ command: 'copyFilesToClipboard', files });
            };
        });
    }
};