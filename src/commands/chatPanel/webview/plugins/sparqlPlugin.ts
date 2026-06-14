import { TagPlugin } from '../pluginSystem';
import DOMPurify from 'dompurify';

export const sparqlPlugin: TagPlugin = {
    id: 'query_architecture',
    tagPattern: /<query_architecture>([\s\S]*?)<\/query_architecture>/gi,
    render: (match, context) => {
        const queryText = match[1].trim();
        const blockId = `sparql-req-${context.messageId}-${Math.random().toString(36).substring(7)}`;

        const isAuto = context.capabilities?.autoApply === true;
        const escapedQuery = queryText.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

        return `
        <div class="generation-block sparql-block" id="${blockId}" data-query="${encodeURIComponent(queryText)}">
            <div class="generation-header" style="background: rgba(155, 89, 182, 0.1); border-bottom: 1px solid var(--vscode-widget-border);">
                <span class="summary-lang-label" style="color: var(--vscode-charts-purple); font-weight: 800;">
                    <i class="codicon codicon-graph"></i> SPARQL-lite Query Request
                </span>
                <div class="code-actions">
                    <button class="code-action-btn apply-btn run-sparql-btn" 
                            id="btn-${blockId}"
                            style="background-color: var(--vscode-charts-purple) !important; color: white !important;"
                            data-query="${encodeURIComponent(queryText)}"
                            data-block-id="${blockId}">
                        <i class="codicon codicon-play"></i> Run & Reprompt
                    </button>
                </div>
            </div>
            <div class="generation-body" style="padding: 12px; background: var(--vscode-editor-background);">
                <pre style="margin: 0; padding: 10px; background: rgba(0,0,0,0.15); border: 1px solid var(--vscode-widget-border); border-radius: 4px; font-family: monospace; font-size: 11px; white-space: pre-wrap; overflow-x: auto;">${escapedQuery}</pre>
                ${isAuto ? `<div style="font-size: 10px; color: var(--vscode-charts-green); margin-top: 8px;"><i class="codicon codicon-sync spin"></i> Auto-Apply Active: Querying complete ontology graph...</div>` : ''}
            </div>
        </div>`;
    },
    initialize: (container, context) => {
        container.querySelectorAll('.run-sparql-btn').forEach(btn => {
            const button = btn as HTMLButtonElement;
            const block = button.closest('.sparql-block') as HTMLElement;
            const query = decodeURIComponent(button.dataset.query || '');

            const run = (autoReprompt: boolean) => {
                button.innerHTML = '<div class="spinner"></div> Running...';
                button.disabled = true;

                context.vscode.postMessage({
                    command: 'executeLollmsCommand',
                    details: {
                        command: 'lollms-vs-coder.runSparqlQueryDirectly',
                        params: { 
                            query: query,
                            messageId: context.messageId,
                            blockId: button.dataset.blockId,
                            reprompt: autoReprompt
                        }
                    }
                });
            };

            button.onclick = () => run(true);

            // AUTO-APPLY: If autoApply is active, execute instantly!
            if (context.capabilities?.autoApply === true && !button.disabled) {
                setTimeout(() => run(true), 100);
            }
        });
    }
};
