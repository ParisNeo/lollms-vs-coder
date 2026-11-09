import { TagPlugin, PluginContext } from '../pluginSystem';
import DOMPurify from 'dompurify';

const sanitizer = typeof DOMPurify === 'function' ? (DOMPurify as any)(window) : DOMPurify;

export function parseAndRenderFormContent(fullXml: string, innerXml: string, messageId?: string): string {
    const titleMatch = fullXml.match(/title=["'](.*?)["']/i);
    const idMatch = fullXml.match(/id=["'](.*?)["']/i);
    const title = titleMatch ? titleMatch[1] : "Decision Required";
    const formId = idMatch ? idMatch[1] : `form_${Date.now().toString(36)}`;

    // 1. Description / Prompt extraction
    let descriptionText = "";
    const descMatch = innerXml.match(/<description\b[^>]*>([\s\S]*?)<\/description>/i) ||
                      innerXml.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
    if (descMatch) {
        descriptionText = descMatch[1].trim();
    }

    // 2. Extract options / alternatives / inputs
    interface RadioOption {
        name: string;
        value: string;
        label: string;
        description?: string;
        checked?: boolean;
    }
    const radioGroups: Record<string, RadioOption[]> = {};
    const otherInputsHtml: string[] = [];
    const defaultGroupName = "decision";

    const addRadioOption = (name: string, val: string, lbl: string, desc?: string, chk?: boolean) => {
        const groupName = name || defaultGroupName;
        if (!radioGroups[groupName]) radioGroups[groupName] = [];

        const cleanVal = val || `option_${radioGroups[groupName].length + 1}`;
        const cleanLbl = lbl || cleanVal;

        radioGroups[groupName].push({
            name: groupName,
            value: cleanVal,
            label: cleanLbl,
            description: desc,
            checked: chk
        });
    };

    // A. Parse <choice>, <option>, <alternative>, <item> tags
    const choiceRegex = /<(?:choice|option|alternative|item)\b([^>]*?)>(?:([\s\S]*?)<\/(?:choice|option|alternative|item)>)?/gi;
    let cMatch: RegExpExecArray | null;

    while ((cMatch = choiceRegex.exec(innerXml)) !== null) {
        const attrStr = cMatch[1] || "";
        const bodyText = (cMatch[2] || "").trim();

        const attrs: Record<string, string> = {};
        attrStr.replace(/(\w+)=["']([^"']*)["']/g, (_: any, k: string, v: string) => {
            attrs[k.toLowerCase()] = v;
            return '';
        });

        const name = attrs.name || attrs.group || defaultGroupName;
        const value = attrs.value || attrs.id || attrs.key || (attrs.title ? attrs.title.toLowerCase().replace(/\s+/g, '_') : bodyText.slice(0, 30));
        let label = attrs.label || attrs.title || attrs.name || "";
        let optDesc = attrs.description || "";

        if (!label) {
            if (bodyText) {
                const lines = bodyText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
                label = lines[0];
                if (lines.length > 1) {
                    optDesc = lines.slice(1).join(' ');
                }
            } else {
                label = value;
            }
        } else if (bodyText && bodyText !== label) {
            optDesc = optDesc ? `${optDesc} - ${bodyText}` : bodyText;
        }

        const isChecked = attrs.checked === 'true' || attrs.selected === 'true';
        addRadioOption(name, value, label, optDesc, isChecked);
    }

    // B. Parse <input> tags
    const inputRegex = /<input\b([^>]*?)>(?:([\s\S]*?)<\/input>)?/gi;
    let iMatch: RegExpExecArray | null;

    while ((iMatch = inputRegex.exec(innerXml)) !== null) {
        const attrStr = iMatch[1] || "";
        const bodyText = (iMatch[2] || "").trim();

        const attrs: Record<string, string> = {};
        attrStr.replace(/(\w+)=["']([^"']*)["']/g, (_: any, k: string, v: string) => {
            attrs[k.toLowerCase()] = v;
            return '';
        });

        const type = (attrs.type || 'text').toLowerCase();
        const name = attrs.name || defaultGroupName;
        const value = attrs.value || attrs.id || bodyText || "";
        let label = attrs.label || attrs.title || bodyText || value;
        const isChecked = attrs.checked === 'true';

        if (type === 'radio') {
            addRadioOption(name, value, label, attrs.description, isChecked);
        } else if (type === 'checkbox') {
            otherInputsHtml.push(`
                <label class="checkbox-option" style="display: flex; align-items: center; gap: 8px; margin-bottom: 6px; font-size: 11.5px; cursor: pointer;">
                    <input type="checkbox" name="${name}" value="${value}" ${isChecked ? 'checked' : ''} style="cursor: pointer;">
                    <span>${sanitizer.sanitize(label)}</span>
                </label>
            `);
        } else {
            otherInputsHtml.push(`
                <div class="form-field" style="margin-bottom: 8px;">
                    <label style="display: block; font-size: 10.5px; font-weight: 600; margin-bottom: 4px;">${sanitizer.sanitize(label)}</label>
                    <input type="${type}" name="${name}" value="${value}" placeholder="${attrs.placeholder || ''}" style="width: 100%; box-sizing: border-box; padding: 6px 8px; border: 1px solid var(--vscode-input-border); background: var(--vscode-input-background); color: var(--vscode-input-foreground); border-radius: 4px; font-size: 11px;" />
                </div>
            `);
        }
    }

    // C. Parse <select> tags
    const selectRegex = /<select\b([^>]*?)>([\s\S]*?)<\/select>/gi;
    let sMatch: RegExpExecArray | null;

    while ((sMatch = selectRegex.exec(innerXml)) !== null) {
        const attrStr = sMatch[1] || "";
        const selectBody = sMatch[2] || "";
        const nameMatch = attrStr.match(/name=["']([^"']*)["']/i);
        const groupName = nameMatch ? nameMatch[1] : "select_choice";

        const optRegex = /<option\b([^>]*?)>(?:([\s\S]*?)<\/option>)?/gi;
        let om;
        while ((om = optRegex.exec(selectBody)) !== null) {
            const optAttrs: Record<string, string> = {};
            (om[1] || "").replace(/(\w+)=["']([^"']*)["']/g, (_: any, k: string, v: string) => {
                optAttrs[k.toLowerCase()] = v;
                return '';
            });
            const body = (om[2] || "").trim();
            const val = optAttrs.value || body;
            const lbl = optAttrs.label || body || val;
            const chk = optAttrs.selected === 'true' || optAttrs.checked === 'true';
            addRadioOption(groupName, val, lbl, undefined, chk);
        }
    }

    // D. FALLBACK HEURISTIC: If NO radio/choice/input tags were found, inspect the raw text for markdown list items!
    const totalOptionsFound = Object.values(radioGroups).reduce((acc, grp) => acc + grp.length, 0);
    if (totalOptionsFound === 0 && otherInputsHtml.length === 0) {
        const textToScan = descriptionText || innerXml.replace(/<[^>]+>/g, '\n');
        const listRegex = /(?:^|\n)\s*(?:[-*•]|\d+[\.\)])\s*(?:\*\*)?([^\n\r]+)/g;
        let lMatch;
        const fallbackItems: string[] = [];

        while ((lMatch = listRegex.exec(textToScan)) !== null) {
            const rawItem = lMatch[1].replace(/\*\*/g, '').trim();
            if (rawItem && rawItem.length > 2 && !rawItem.toLowerCase().startsWith('select') && !rawItem.toLowerCase().startsWith('please choose') && !rawItem.toLowerCase().startsWith('which approach')) {
                fallbackItems.push(rawItem);
            }
        }

        if (fallbackItems.length >= 2) {
            fallbackItems.forEach((itemText, idx) => {
                let lbl = itemText;
                let desc = "";
                if (itemText.includes(':')) {
                    const parts = itemText.split(':');
                    lbl = parts[0].trim();
                    desc = parts.slice(1).join(':').trim();
                } else if (itemText.includes(' - ')) {
                    const parts = itemText.split(' - ');
                    lbl = parts[0].trim();
                    desc = parts.slice(1).join(' - ').trim();
                }
                addRadioOption("decision", `option_${idx + 1}`, lbl, desc, idx === 0);
            });
        }
    }

    // Build the rendered HTML
    let bodyHtml = "";
    if (descriptionText) {
        bodyHtml += `<div class="form-description" style="font-size: 11px; opacity: 0.9; margin-bottom: 12px; line-height: 1.45;">${sanitizer.sanitize(descriptionText)}</div>`;
    }

    for (const groupName in radioGroups) {
        const options = radioGroups[groupName];
        if (options.length === 0) continue;

        // Ensure at least one option is checked by default so the user can easily validate
        const hasChecked = options.some(o => o.checked);
        if (!hasChecked && options.length > 0) {
            options[0].checked = true;
        }

        const optionsHtml = options.map((opt) => {
            const isChecked = opt.checked;
            const checkedClass = isChecked ? 'selected' : '';
            const borderStyle = isChecked 
                ? 'border: 1.5px solid var(--vscode-charts-blue); background: rgba(0, 122, 204, 0.12);' 
                : 'border: 1px solid var(--vscode-widget-border); background: rgba(0, 0, 0, 0.15);';

            return `
            <label class="radio-option ${checkedClass}" data-group="${opt.name}" style="display: flex; align-items: flex-start; gap: 10px; padding: 8px 12px; margin-bottom: 6px; border-radius: 6px; ${borderStyle} cursor: pointer; transition: all 0.15s ease; user-select: none;">
                <input type="radio" name="${opt.name}" value="${opt.value}" ${isChecked ? 'checked' : ''} style="margin-top: 2px; cursor: pointer; accent-color: var(--vscode-charts-blue); flex-shrink: 0;">
                <div style="flex: 1; min-width: 0;">
                    <div class="radio-label-title" style="font-weight: 600; font-size: 11.5px; color: var(--vscode-foreground);">${sanitizer.sanitize(opt.label)}</div>
                    ${opt.description ? `<div class="radio-label-desc" style="font-size: 10px; opacity: 0.75; margin-top: 2px; line-height: 1.35;">${sanitizer.sanitize(opt.description)}</div>` : ''}
                </div>
            </label>`;
        }).join('');

        bodyHtml += `<div class="radio-group" style="display: flex; flex-direction: column; gap: 2px; margin-bottom: 10px;">${optionsHtml}</div>`;
    }

    if (otherInputsHtml.length > 0) {
        bodyHtml += otherInputsHtml.join('');
    }

    const submitMatch = fullXml.match(/<submit\s+label=["'](.*?)["']\s*\/>/i);
    const submitLabel = submitMatch ? submitMatch[1] : "Validate Choice";

    const safeMsgId = messageId || "generic_msg";

    return `
    <div class="lollms-form-block" id="form-${formId}" data-form-id="${formId}" style="border: 1.5px solid var(--vscode-charts-purple, #9b59b6); border-radius: 8px; margin: 12px 0; overflow: hidden; background: var(--vscode-editor-inactiveSelectionBackground); box-shadow: 0 4px 12px rgba(0,0,0,0.15);">
        <div class="lollms-form-header" style="padding: 8px 14px; background: var(--vscode-sideBarSectionHeader-background); font-weight: 700; font-size: 12px; display: flex; align-items: center; gap: 8px; border-bottom: 1px solid var(--vscode-widget-border); color: var(--vscode-charts-purple, #9b59b6);">
            <span class="codicon codicon-question"></span> <span>${sanitizer.sanitize(title)}</span>
        </div>
        <div class="lollms-form-body" style="padding: 12px 14px;">
            ${bodyHtml}
        </div>
        <div class="lollms-form-footer" style="padding: 8px 14px; background: var(--vscode-sideBarSectionHeader-background); border-top: 1px solid var(--vscode-widget-border); display: flex; justify-content: flex-end;">
            <button class="code-action-btn apply-btn lollms-form-submit-btn" 
                    id="btn-submit-${formId}"
                    data-form-id="${formId}" 
                    data-message-id="${safeMsgId}"
                    style="height: 26px; padding: 0 14px; font-weight: bold; background: var(--vscode-charts-purple, #9b59b6) !important; color: white !important;">
                <span class="codicon codicon-check"></span> <span>${sanitizer.sanitize(submitLabel)}</span>
            </button>
        </div>
    </div>`;
}

export const formPlugin: TagPlugin = {
    id: 'lollms_form',
    tagPattern: /<(?:lollms_form|form)\b[^>]*>([\s\S]*?)<\/(?:lollms_form|form)>/gi,
    render: (match, context) => {
        const fullXml = match[0];
        const inner = match[1];
        return parseAndRenderFormContent(fullXml, inner, context.messageId);
    },
    initialize: () => {
        // Event delegation is handled exclusively in events.ts to prevent duplicate submissions
    }
};