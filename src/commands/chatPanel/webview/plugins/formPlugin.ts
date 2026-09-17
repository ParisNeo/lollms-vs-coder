import { TagPlugin, PluginContext } from '../pluginSystem';

export const formPlugin: TagPlugin = {
    id: 'lollms_form',
    tagPattern: /<lollms_form\b[^>]*>([\s\S]*?)<\/lollms_form>/gi,
    render: (match, context) => {
        const fullXml = match[0];
        const inner = match[1];
        const title = fullXml.match(/title=["'](.*?)["']/)?.[1] || "Decision Required";
        const formId = fullXml.match(/id=["'](.*?)["']/)?.[1] || "generic-form";

        const inputRegex = /<input\s+([^>]*?)\s*\/?>/gi;
        let inputsHtml = "";
        let m;
        const radioGroups: Record<string, string[]> = {};

        const descMatch = inner.match(/<description>([\s\S]*?)<\/description>/i) ||
                          inner.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
        const descriptionHtml = descMatch ? `<div class="form-description" style="font-size:11px; opacity:0.85; margin-bottom:12px; line-height:1.4;">${descMatch[1]}</div>` : '';

        while ((m = inputRegex.exec(inner)) !== null) {
            const attrStr = m[1];
            const attrs: any = {};
            attrStr.replace(/(\w+)=["']([^"']*)["']/g, (_: any, k: string, v: string) => (attrs[k] = v, ''));

            if (attrs.type === 'radio') {
                if (!radioGroups[attrs.name]) radioGroups[attrs.name] = [];
                radioGroups[attrs.name].push(`
                    <label class="radio-option" style="display:flex; align-items:center; gap:8px; margin-bottom:6px; cursor:pointer; padding:6px 10px; border-radius:6px; background:rgba(255,255,255,0.03); border:1px solid var(--vscode-widget-border);">
                        <input type="radio" name="${attrs.name}" value="${attrs.value}" ${attrs.checked === 'true' ? 'checked' : ''} style="margin:0; cursor:pointer;">
                        <span style="font-size:12px; font-weight:600;">${attrs.label}</span>
                    </label>`);
            } else {
                inputsHtml += `
                    <div class="form-field" style="margin-bottom:8px;">
                        <label style="font-size:11px; font-weight:bold; display:block; margin-bottom:4px;">${attrs.label}</label>
                        <input type="${attrs.type}" name="${attrs.name}" value="${attrs.value || ''}" placeholder="${attrs.placeholder || ''}" style="width:100%; box-sizing:border-box; padding:6px 8px; border-radius:4px; border:1px solid var(--vscode-input-border); background:var(--vscode-input-background); color:var(--vscode-input-foreground);" />
                    </div>`;
            }
        }

        for (const name in radioGroups) {
            inputsHtml += `<div class="radio-group">${radioGroups[name].join('')}</div>`;
        }

        const submitLabel = fullXml.match(/<submit\s+label=["'](.*?)["']\s*\/>/i)?.[1] || "Validate Choice";

        return `
        <div class="lollms-form-block" id="form-${formId}" style="border: 1.5px solid var(--vscode-charts-orange); border-radius: 8px; padding: 12px; margin: 12px 0; background: var(--vscode-editorWidget-background); box-shadow: 0 4px 15px rgba(0,0,0,0.2);">
            <div class="lollms-form-header" style="font-size: 13px; font-weight: bold; color: var(--vscode-charts-orange); display: flex; align-items: center; gap: 8px; margin-bottom: 10px; border-bottom: 1px solid var(--vscode-widget-border); padding-bottom: 6px;">
                <span class="codicon codicon-shield"></span> <span>${title}</span>
            </div>
            <div class="lollms-form-body">${descriptionHtml}${inputsHtml}</div>
            <div class="lollms-form-footer" style="display: flex; justify-content: flex-end; margin-top: 10px;">
                <button class="code-action-btn apply-btn lollms-form-submit-btn" data-form-id="${formId}" style="height: 28px; padding: 0 14px; font-weight: bold;">
                    <span class="codicon codicon-check"></span> <span>${submitLabel}</span>
                </button>
            </div>
        </div>`;
    },
    initialize: (container, context) => {
        container.querySelectorAll('.lollms-form-submit-btn').forEach(btn => {
            (btn as HTMLElement).onclick = (e) => {
                const formBlock = btn.closest('.lollms-form-block') as HTMLElement;
                const data: Record<string, string> = {};
                formBlock.querySelectorAll('input:checked, input[type="text"], input[type="number"], textarea').forEach((input: any) => {
                    if (input.name) data[input.name] = input.value;
                });
                context.vscode.postMessage({
                    command: 'sendMessage',
                    message: { role: 'user', content: `FORM_SUBMISSION:${JSON.stringify(data)}`, isSilentSignal: true }
                });
                formBlock.remove();
            };
        });
    }
};