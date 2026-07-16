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
                <div class="code-actions" style="display:flex; gap:6px;">
                    <button class="code-action-btn secondary-btn run-local-sparql-btn" 
                            id="btn-local-${blockId}"
                            data-query="${encodeURIComponent(queryText)}"
                            data-block-id="${blockId}"
                            title="Execute locally and display results inside this card without reprompting">
                        <i class="codicon codicon-terminal"></i> Run
                    </button>
                    <button class="code-action-btn apply-btn run-reprompt-sparql-btn" 
                            id="btn-reprompt-${blockId}"
                            style="background-color: var(--vscode-charts-purple) !important; color: white !important;"
                            data-query="${encodeURIComponent(queryText)}"
                            data-block-id="${blockId}"
                            title="Execute and automatically feed the results back to the AI chat">
                        <i class="codicon codicon-play"></i> Run & Reprompt
                    </button>
                </div>
            </div>
            <div class="generation-body" style="padding: 12px; background: var(--vscode-editor-background); display:flex; flex-direction:column; gap:8px;">
                <pre style="margin: 0; padding: 10px; background: rgba(0,0,0,0.15); border: 1px solid var(--vscode-widget-border); border-radius: 4px; font-family: monospace; font-size: 11px; white-space: pre-wrap; overflow-x: auto;">${escapedQuery}</pre>
                ${isAuto ? `<div style="font-size: 10px; color: var(--vscode-charts-green);"><i class="codicon codicon-sync spin"></i> Auto-Apply Active: Querying complete ontology graph...</div>` : ''}
                <div class="sparql-results-render-area" style="display:none; max-height:250px; overflow-y:auto; border-top: 1px solid var(--vscode-widget-border); padding-top:8px;"></div>
            </div>
        </div>`;
    },
    initialize: (container, context) => {
        const block = container.querySelector('.sparql-block') as HTMLElement;
        if (!block) return;

        const query = decodeURIComponent(block.dataset.query || '');

        const runQuery = (button: HTMLButtonElement, autoReprompt: boolean) => {
            // Lock both buttons
            block.querySelectorAll('.run-local-sparql-btn, .run-reprompt-sparql-btn').forEach((btn: any) => {
                btn.disabled = true;
                btn.style.opacity = '0.5';
            });

            button.innerHTML = '<div class="spinner"></div> Running...';

            context.vscode.postMessage({
                command: 'executeLollmsCommand',
                details: {
                    command: 'lollms-vs-coder.runSparqlQueryDirectly',
                    params: { 
                        query: query,
                        messageId: context.messageId,
                        blockId: block.id,
                        reprompt: autoReprompt
                    }
                }
            });
        };

        const localBtn = block.querySelector('.run-local-sparql-btn') as HTMLButtonElement;
        if (localBtn) {
            localBtn.onclick = (e) => {
                e.stopPropagation();
                runQuery(localBtn, false);
            };
        }

        const repromptBtn = block.querySelector('.run-reprompt-sparql-btn') as HTMLButtonElement;
        if (repromptBtn) {
            repromptBtn.onclick = (e) => {
                e.stopPropagation();
                runQuery(repromptBtn, true);
            };
        }
    }
};
