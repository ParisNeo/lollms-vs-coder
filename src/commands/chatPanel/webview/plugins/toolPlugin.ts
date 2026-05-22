import { TagPlugin, PluginContext } from '../pluginSystem';
import DOMPurify from 'dompurify';

export const toolPlugin: TagPlugin = {
    id: 'lollms_tool',
    // Matches <lollms_tool name="tool_name" params='{"key": "val"}' />
    tagPattern: /<lollms_tool\s+([^>]*?)\s*\/>/gi,

    render: (match, context) => {
        const attrStr = match[1];
        const attrs: any = {};

        // --- ENHANCED ATTRIBUTE PARSER ---
        // Handles both name="val" and name='{"json": "val"}' correctly
        const attrRegex = /(\w+)\s*=\s*(?:'([^']*)'|"([^"]*)")/g;
        let m;
        while ((m = attrRegex.exec(attrStr)) !== null) {
            const key = m[1].toLowerCase();
            const val = m[2] !== undefined ? m[2] : m[3];
            attrs[key] = val;
        }

        const toolName = attrs.name;
        if (!toolName) return null;

        let params: any = {};
        try {
            // Unescape common XML entities before parsing JSON
            const cleanJson = attrs.params ? attrs.params.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>') : '{}';
            params = JSON.parse(cleanJson);
        } catch (e) {
            console.error("Failed to parse tool params", e);
            params = { error: "Invalid JSON in params attribute" };
        }

        const blockId = `tool-req-${context.messageId}-${Math.random().toString(36).substring(7)}`;
        
        // Structure the parameters into a human-readable list
        // --- DYNAMIC UI LOGIC ---
        let icon = "wrench";
        let color = "var(--vscode-charts-orange)";
        let groupLabel = "REQUEST ACTION";

        // Logic based on tool name or common groupings
        if (toolName.includes('command') || toolName.includes('script')) {
            icon = "terminal"; color = "var(--vscode-charts-red)"; groupLabel = "EXECUTE SHELL";
        } else if (toolName.includes('search') || toolName.includes('scrape')) {
            icon = "globe"; color = "var(--vscode-charts-blue)"; groupLabel = "WEB RESEARCH";
        } else if (toolName.includes('file')) {
            icon = "file-code"; color = "var(--vscode-charts-green)"; groupLabel = "FILE SYSTEM";
        }

        const paramsHtml = Object.entries(params || {}).map(([k, v]) => `
            <div style="margin-bottom:4px;">
                <span style="font-size:9px; font-weight:900; opacity:0.6; text-transform:uppercase;">${k}</span>
                <input type="text" class="tool-param-input" data-key="${k}" value="${typeof v === 'string' ? v : JSON.stringify(v)}" 
                       style="width: 100%; background:rgba(0,0,0,0.1); border: 1px solid var(--vscode-widget-border); padding:6px 10px; border-radius:4px; font-family:var(--vscode-editor-font-family); font-size:12px; color: var(--vscode-foreground); outline: none;">
            </div>
        `).join('');

        return `
        <div class="generation-block" style="border: 1px solid ${color}; border-left: 5px solid ${color};">
            <div class="generation-header" style="background: ${color}1a;">
                <span class="summary-lang-label" style="color: ${color}; font-weight: 800;">
                    <i class="codicon codicon-${icon}"></i> ${groupLabel}: ${toolName.toUpperCase()}
                </span>
                <div class="code-actions">
                    <button class="code-action-btn apply-btn run-tool-btn" 
                            id="btn-${blockId}"
                            style="background-color: ${color} !important; color: white !important;"
                            data-tool="${toolName}" 
                            data-params='${JSON.stringify(params).replace(/'/g, "&apos;")}'
                            data-block-id="${blockId}">
                        <i class="codicon codicon-play"></i> Run Tool
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
        container.querySelectorAll('.run-tool-btn').forEach(btn => {
            (btn as HTMLButtonElement).onclick = () => {
                const button = btn as HTMLElement;
                const block = button.closest('.generation-block');
                const toolName = button.dataset.tool;

                // 1. Start with original params
                let finalParams: any = {};
                try {
                    finalParams = JSON.parse(button.dataset.params || '{}');
                } catch(e) {}

                // 2. Scrape edited values from the UI inputs
                if (block) {
                    const inputs = block.querySelectorAll('.tool-param-input');
                    inputs.forEach((input: any) => {
                        const key = input.dataset.key;
                        if (key) {
                            finalParams[key] = input.value;
                        }
                    });
                }

                button.innerHTML = '<div class="spinner"></div> Running...';
                button.disabled = true;

                context.vscode.postMessage({
                    command: 'runTool',
                    tool: toolName,
                    params: finalParams,
                    buttonId: button.dataset.blockId
                });
            };
        });
    }
};
