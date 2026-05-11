import { TagPlugin, PluginContext } from '../pluginSystem';

export const formPlugin: TagPlugin = {
    id: 'lollms_form',
    tagPattern: /<lollms_form\b[^>]*>([\s\S]*?)<\/lollms_form>/gi,
    render: (match, context) => {
        const fullXml = match[0];
        const inner = match[1];
        const title = fullXml.match(/title=["'](.*?)["']/)?.[1] || "Decision Required";
        const formId = fullXml.match(/id=["'](.*?)["']/)?.[1] || "generic-form";

        const inputRegex = /<input\s+([^>]*?)\s*\/>/gi;
        let inputsHtml = "";
        let m;
        const radioGroups: Record<string, string[]> = {};

        while ((m = inputRegex.exec(inner)) !== null) {
            const attrStr = m[1];
            const attrs: any = {};
            attrStr.replace(/(\w+)=["']([^"']*)["']/g, (_: any, k: string, v: string) => (attrs[k] = v, ''));

            if (attrs.type === 'radio') {
                if (!radioGroups[attrs.name]) radioGroups[attrs.name] = [];
                radioGroups[attrs.name].push(`
                    <label class="radio-option">
                        <input type="radio" name="${attrs.name}" value="${attrs.value}" ${attrs.checked === 'true' ? 'checked' : ''}>
                        <span>${attrs.label}</span>
                    </label>`);
            } else {
                inputsHtml += `
                    <div class="form-field">
                        <label>${attrs.label}</label>
                        <input type="${attrs.type}" name="${attrs.name}" value="${attrs.value || ''}" placeholder="${attrs.placeholder || ''}" />
                    </div>`;
            }
        }

        for (const name in radioGroups) {
            inputsHtml += `<div class="radio-group">${radioGroups[name].join('')}</div>`;
        }

        const submitLabel = fullXml.match(/<submit\s+label=["'](.*?)["']\s*\/>/i)?.[1] || "Validate Choice";

        return `
        <div class="lollms-form-block" id="form-${formId}">
            <div class="lollms-form-header"><span class="codicon codicon-question"></span> <span>${title}</span></div>
            <div class="lollms-form-body">${inputsHtml}</div>
            <div class="lollms-form-footer">
                <button class="code-action-btn apply-btn lollms-form-submit-btn" data-form-id="${formId}">
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