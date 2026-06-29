import { TagPlugin, PluginContext } from '../pluginSystem';
import DOMPurify from 'dompurify';

export const toolPlugin: TagPlugin = {
    id: 'lollms_tool',
    // Matches the simplified <lollms_tool>JSON</lollms_tool> format
    tagPattern: /^[ \t]*<lollms_tool>([\s\S]*?)<\/lollms_tool>/gim,

    render: (match, context) => {
        const rawJson = match[1].trim();
        let parsedCall: any = {};

        try {
            // primary parse
            parsedCall = JSON.parse(rawJson);
        } catch (e) {
            try {
                // secondary repair
                const repaired = rawJson
                    .replace(/\\`/g, '`')
                    .replace(/[\r\n\t]/g, ' ')
                    .replace(/,\s*([\]}])/g, '$1');
                parsedCall = JSON.parse(repaired);
            } catch (err) {
                // tertiary key-value carving for name/arguments
                const nameMatch = rawJson.match(/"name"\s*:\s*"([^"]+)"/);
                const argsMatch = rawJson.match(/"(?:arguments|params)"\s*:\s*(\{[\s\S]*\})/);
                if (nameMatch) {
                    parsedCall.name = nameMatch[1];
                    if (argsMatch) {
                        try { parsedCall.arguments = JSON.parse(argsMatch[1]); } catch {}
                    }
                }
            }
        }

        const toolName = parsedCall.name || "unknown_tool";
        const params = parsedCall.arguments || parsedCall.params || {};

        const blockId = `tool-req-${context.messageId}-${Math.random().toString(36).substring(7)}`;

        // Structure the parameters into a human-readable list
        // --- DYNAMIC UI LOGIC ---
        let icon = "wrench";
        let color = "var(--vscode-charts-orange)";
        let groupLabel = "REQUEST ACTION";

        if (toolName.includes('command') || toolName.includes('script')) {
            icon = "terminal"; color = "var(--vscode-charts-red)"; groupLabel = "EXECUTE SHELL";
        } else if (toolName.includes('search') || toolName.includes('scrape')) {
            icon = "globe"; color = "var(--vscode-charts-blue)"; groupLabel = "WEB RESEARCH";
        } else if (toolName.includes('file')) {
            icon = "file-code"; color = "var(--vscode-charts-green)"; groupLabel = "FILE SYSTEM";
        }

        const paramsHtml = Object.entries(params || {}).map(([k, v]) => {
            let inputElement = "";
            
            if (k === 'options' && Array.isArray(v)) {
                // RENDER INTERACTIVE OPTIONS AS RADIO BUTTONS
                const optionsHtml = v.map((opt: string, idx: number) => `
                    <label class="radio-option" style="margin-bottom: 6px; display: flex; align-items: center; gap: 8px; cursor: pointer; padding: 6px 10px; background: rgba(0,0,0,0.15); border: 1px solid var(--vscode-widget-border); border-radius: 4px;">
                        <input type="radio" name="tool-option-group" value="${opt}" ${idx === 0 ? 'checked' : ''} class="tool-param-radio" style="margin: 0; cursor: pointer;">
                        <span style="font-size: 11px;">${opt}</span>
                    </label>
                `).join('');
                inputElement = `<div class="radio-group" style="display: flex; flex-direction: column; gap: 6px;">${optionsHtml}</div>`;
            } else {
                const isLongText = typeof v === 'string' && (v.length > 60 || ['target', 'query', 'command', 'instructions', 'code', 'script'].includes(k));
                inputElement = isLongText 
                    ? `<textarea class="tool-param-input" data-key="${k}" rows="5"
                           style="width: 100%; background:rgba(0,0,0,0.1); border: 1px solid var(--vscode-widget-border); padding:6px 10px; border-radius:4px; font-family:var(--vscode-editor-font-family); font-size:12px; color: var(--vscode-foreground); outline: none; resize: vertical;">${v}</textarea>`
                    : `<input type="text" class="tool-param-input" data-key="${k}" value="${typeof v === 'string' ? v : JSON.stringify(v)}" 
                           style="width: 100%; background:rgba(0,0,0,0.1); border: 1px solid var(--vscode-widget-border); padding:6px 10px; border-radius:4px; font-family:var(--vscode-editor-font-family); font-size:12px; color: var(--vscode-foreground); outline: none;">`;
            }

            return `
            <div style="margin-bottom:8px;">
                <span style="font-size:9px; font-weight:900; opacity:0.6; text-transform:uppercase; display: block; margin-bottom: 4px;">${k}</span>
                ${inputElement}
            </div>
            `;
        }).join('');

        return `
        <div class="generation-block" style="border: 1px solid ${color}; border-left: 5px solid ${color};">
            <div class="generation-header" style="background: ${color}1a;">
                <span class="summary-lang-label" style="color: ${color}; font-weight: 800;">
                    <i class="codicon codicon-${icon}"></i> ${groupLabel}: ${toolName.toUpperCase()}
                </span>
                <div class="code-actions" style="display:flex; gap:6px;">
                    <button class="code-action-btn secondary-btn run-local-tool-btn" 
                            id="btn-local-${blockId}"
                            data-tool="${toolName}" 
                            data-params='${JSON.stringify(params).replace(/'/g, "&apos;")}'
                            data-block-id="${blockId}"
                            title="Execute locally and display results inside the chat history without requesting an AI response">
                        <i class="codicon codicon-terminal"></i> Run
                    </button>
                    <button class="code-action-btn apply-btn run-reprompt-tool-btn" 
                            id="btn-reprompt-${blockId}"
                            style="background-color: ${color} !important; color: white !important;"
                            data-tool="${toolName}" 
                            data-params='${JSON.stringify(params).replace(/'/g, "&apos;")}'
                            data-block-id="${blockId}"
                            title="Execute and automatically ask Lollms to analyze the output">
                        <i class="codicon codicon-play"></i> Run & Reprompt
                    </button>
                </div>
            </div>
            <div class="generation-body" style="padding:12px; background: var(--vscode-editor-background);">
                <div class="tool-params-preview" style="display:flex; flex-direction:column; gap:8px;">
                    ${paramsHtml}
                </div>
            </div>
        </div>`;
    },

    initialize: (container, context) => {
        const block = container.querySelector('.generation-block') as HTMLElement;
        if (!block) return;

        const runTool = (button: HTMLButtonElement, autoReprompt: boolean) => {
            const toolName = button.dataset.tool;

            // 1. Start with original params
            let finalParams: any = {};
            try {
                finalParams = JSON.parse(button.dataset.params || '{}');
            } catch(e) {}

            // 2. Scrape edited values from the UI inputs
            const inputs = block.querySelectorAll('.tool-param-input');
            inputs.forEach((input: any) => {
                const key = input.dataset.key;
                if (key) {
                    finalParams[key] = input.value;
                }
            });

            // Scrape selected radio option if present (for request_user_input)
            const checkedRadio = block.querySelector('.tool-param-radio:checked') as HTMLInputElement;
            if (checkedRadio) {
                finalParams['options'] = checkedRadio.value;
            }

            // Lock all action buttons inside this block
            block.querySelectorAll('.run-local-tool-btn, .run-tool-btn, .run-reprompt-tool-btn, .run-local-this-btn').forEach((btn: any) => {
                btn.disabled = true;
                btn.style.opacity = '0.5';
            });

            if (toolName === 'request_user_input') {
                button.innerHTML = '<div class="spinner"></div> Submitting...';
                const choiceVal = checkedRadio ? checkedRadio.value : "";

                context.vscode.postMessage({
                    command: 'sendMessage',
                    message: {
                        role: 'user',
                        content: `FORM_SUBMISSION:${JSON.stringify({ decision: choiceVal })}`,
                        isSilentSignal: true
                    }
                });

                setTimeout(() => {
                    const wrapper = block.closest('.message-wrapper');
                    if (wrapper) wrapper.remove();
                }, 200);
            } else {
                button.innerHTML = '<div class="spinner"></div> Running...';
                context.vscode.postMessage({
                    command: 'runTool',
                    tool: toolName,
                    params: finalParams,
                    buttonId: button.dataset.blockId,
                    reprompt: autoReprompt
                });
            }
        };

        // --- SINGLE, EXCLUSIVE CLICK REGISTRATION LOOP ---
        // Binds exactly one event handler per action button to guarantee single-execution.
        block.querySelectorAll('.run-local-tool-btn, .run-tool-btn, .run-reprompt-tool-btn').forEach((btn: any) => {
            const isReprompt = btn.classList.contains('run-reprompt-tool-btn') || btn.classList.contains('run-tool-btn');
            btn.onclick = (e: MouseEvent) => {
                e.preventDefault();
                e.stopPropagation();
                runTool(btn, isReprompt);
            };
        });
    }
};
