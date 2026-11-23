import { TagPlugin, PluginContext } from '../pluginSystem';
import DOMPurify from 'dompurify';

const sanitizer = typeof DOMPurify === 'function' ? (DOMPurify as any)(window) : DOMPurify;

function escapeAttr(val: string): string {
    return String(val || '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function parseTagAttrs(attrStr: string): Record<string, string> {
    const attrs: Record<string, string> = {};
    if (!attrStr) return attrs;
    const re = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(attrStr)) !== null) {
        attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? '';
    }
    return attrs;
}

export function parseAndRenderFormContent(fullXml: string, innerXml: string, messageId?: string): string {
    const rootAttrs = parseTagAttrs((fullXml.match(/^<(?:lollms_form|form)\b([^>]*)>/i) || [])[1] || '');
    const title = rootAttrs.title || "Input / Decision Required";
    const formId = rootAttrs.id || `form_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

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
    let autoFieldCounter = 0;

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

    // Strip <select> blocks before scanning standalone <option>/<choice> tags to prevent duplicate radio options
    const innerWithoutSelects = innerXml.replace(/<select\b[^>]*>[\s\S]*?<\/select>/gi, '');

    // A. Parse <choice>, <option>, <alternative>, <item> tags
    const choiceRegex = /<(?:choice|option|alternative|item)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:choice|option|alternative|item)>)/gi;
    let cMatch: RegExpExecArray | null;

    while ((cMatch = choiceRegex.exec(innerWithoutSelects)) !== null) {
        const attrs = parseTagAttrs(cMatch[1] || "");
        const bodyText = (cMatch[2] || "").trim();

        const name = attrs.name || attrs.group || defaultGroupName;
        const value = attrs.value || attrs.id || attrs.key || (attrs.title ? attrs.title.toLowerCase().replace(/\s+/g, '_') : bodyText.slice(0, 30));
        let label = attrs.label || attrs.title || "";
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

    // B. Parse <input> and <field> tags
    const inputRegex = /<(?:input|field)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:input|field)>)/gi;
    let iMatch: RegExpExecArray | null;

    while ((iMatch = inputRegex.exec(innerWithoutSelects)) !== null) {
        const attrs = parseTagAttrs(iMatch[1] || "");
        const bodyText = (iMatch[2] || "").trim();

        const type = (attrs.type || 'text').toLowerCase();
        const name = attrs.name || attrs.id || `field_${++autoFieldCounter}`;
        const value = attrs.value || bodyText || "";
        const label = attrs.label || attrs.title || attrs.name || bodyText || `Field ${autoFieldCounter}`;
        const isChecked = attrs.checked === 'true';

        if (type === 'radio') {
            addRadioOption(attrs.name || defaultGroupName, value || attrs.id || label, label, attrs.description, isChecked);
        } else if (type === 'checkbox') {
            otherInputsHtml.push(`
                <label class="checkbox-option" style="display: flex; align-items: center; gap: 8px; margin-bottom: 6px; font-size: 11.5px; cursor: pointer;">
                    <input type="checkbox" name="${escapeAttr(name)}" value="${escapeAttr(value || 'yes')}" ${isChecked ? 'checked' : ''} style="cursor: pointer;">
                    <span>${sanitizer.sanitize(label)}</span>
                </label>
            `);
        } else if (type === 'textarea') {
            otherInputsHtml.push(`
                <div class="form-field" style="margin-bottom: 8px;">
                    <label style="display: block; font-size: 10.5px; font-weight: 600; margin-bottom: 4px;">${sanitizer.sanitize(label)}</label>
                    <textarea name="${escapeAttr(name)}" rows="${escapeAttr(attrs.rows || '3')}" placeholder="${escapeAttr(attrs.placeholder || '')}" style="width: 100%; box-sizing: border-box; padding: 6px 8px; border: 1px solid var(--vscode-input-border); background: var(--vscode-input-background); color: var(--vscode-input-foreground); border-radius: 4px; font-size: 11px; resize: vertical;">${sanitizer.sanitize(value)}</textarea>
                </div>
            `);
        } else {
            otherInputsHtml.push(`
                <div class="form-field" style="margin-bottom: 8px;">
                    <label style="display: block; font-size: 10.5px; font-weight: 600; margin-bottom: 4px;">${sanitizer.sanitize(label)}</label>
                    <input type="${escapeAttr(type)}" name="${escapeAttr(name)}" value="${escapeAttr(value)}" placeholder="${escapeAttr(attrs.placeholder || '')}" style="width: 100%; box-sizing: border-box; padding: 6px 8px; border: 1px solid var(--vscode-input-border); background: var(--vscode-input-background); color: var(--vscode-input-foreground); border-radius: 4px; font-size: 11px;" />
                </div>
            `);
        }
    }

    // B2. Parse <textarea> tags
    const textareaRegex = /<textarea\b([^>]*?)(?:\/>|>([\s\S]*?)<\/textarea>)/gi;
    let tMatch: RegExpExecArray | null;
    while ((tMatch = textareaRegex.exec(innerWithoutSelects)) !== null) {
        const attrs = parseTagAttrs(tMatch[1] || "");
        const bodyText = (tMatch[2] || "").trim();
        const name = attrs.name || attrs.id || `details_${++autoFieldCounter}`;
        const label = attrs.label || attrs.title || attrs.name || "Details";
        const defaultVal = attrs.value || bodyText || "";
        otherInputsHtml.push(`
            <div class="form-field" style="margin-bottom: 8px;">
                <label style="display: block; font-size: 10.5px; font-weight: 600; margin-bottom: 4px;">${sanitizer.sanitize(label)}</label>
                <textarea name="${escapeAttr(name)}" rows="${escapeAttr(attrs.rows || '3')}" placeholder="${escapeAttr(attrs.placeholder || '')}" style="width: 100%; box-sizing: border-box; padding: 6px 8px; border: 1px solid var(--vscode-input-border); background: var(--vscode-input-background); color: var(--vscode-input-foreground); border-radius: 4px; font-size: 11px; resize: vertical;">${sanitizer.sanitize(defaultVal)}</textarea>
            </div>
        `);
    }

    // C. Parse <select> tags
    const selectRegex = /<select\b([^>]*?)>([\s\S]*?)<\/select>/gi;
    let sMatch: RegExpExecArray | null;

    while ((sMatch = selectRegex.exec(innerXml)) !== null) {
        const selectAttrs = parseTagAttrs(sMatch[1] || "");
        const selectBody = sMatch[2] || "";
        const groupName = selectAttrs.name || selectAttrs.id || `select_${++autoFieldCounter}`;

        const optRegex = /<option\b([^>]*?)(?:\/>|>([\s\S]*?)<\/option>)/gi;
        let om: RegExpExecArray | null;
        while ((om = optRegex.exec(selectBody)) !== null) {
            const optAttrs = parseTagAttrs(om[1] || "");
            const body = (om[2] || "").trim();
            const val = optAttrs.value || body;
            const lbl = optAttrs.label || body || val;
            const chk = optAttrs.selected === 'true' || optAttrs.checked === 'true';
            addRadioOption(groupName, val, lbl, optAttrs.description, chk);
        }
    }

    // D. FALLBACK HEURISTIC: If NO radio/choice/input tags were found, inspect the raw text for markdown list items
    let totalOptionsFound = Object.values(radioGroups).reduce((acc, grp) => acc + grp.length, 0);
    if (totalOptionsFound === 0 && otherInputsHtml.length === 0) {
        const textToScan = descriptionText || innerXml.replace(/<[^>]+>/g, '\n');
        const listRegex = /(?:^|\n)\s*(?:[-*•]|\d+[\.\)])\s*(?:\*\*)?([^\n\r]+)/g;
        let lMatch: RegExpExecArray | null;
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
            totalOptionsFound = Object.values(radioGroups).reduce((acc, grp) => acc + grp.length, 0);
        }
    }

    // E. Open-ended question fallback: ensure user always has an input field when no explicit inputs/options exist
    if (totalOptionsFound === 0 && otherInputsHtml.length === 0) {
        otherInputsHtml.push(`
            <div class="form-field" style="margin-bottom: 8px;">
                <label style="display: block; font-size: 10.5px; font-weight: 600; margin-bottom: 4px;">Your Response</label>
                <textarea name="response" rows="2" placeholder="Enter your answer here..." style="width: 100%; box-sizing: border-box; padding: 6px 8px; border: 1px solid var(--vscode-input-border); background: var(--vscode-input-background); color: var(--vscode-input-foreground); border-radius: 4px; font-size: 11px; resize: vertical;"></textarea>
            </div>
        `);
    }

    // Build the rendered HTML
    let bodyHtml = "";
    if (descriptionText) {
        bodyHtml += `<div class="form-description" style="font-size: 11px; opacity: 0.9; margin-bottom: 12px; line-height: 1.45;">${sanitizer.sanitize(descriptionText)}</div>`;
    }

    for (const groupName in radioGroups) {
        const options = radioGroups[groupName];
        if (options.length === 0) continue;

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
            <label class="radio-option ${checkedClass}" data-group="${escapeAttr(opt.name)}" style="display: flex; align-items: flex-start; gap: 10px; padding: 8px 12px; margin-bottom: 6px; border-radius: 6px; ${borderStyle} cursor: pointer; transition: all 0.15s ease; user-select: none;">
                <input type="radio" name="${escapeAttr(opt.name)}" value="${escapeAttr(opt.value)}" ${isChecked ? 'checked' : ''} style="margin-top: 2px; cursor: pointer; accent-color: var(--vscode-charts-blue); flex-shrink: 0;">
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

    const submitMatch = fullXml.match(/<submit\s+label=["'](.*?)["']\s*\/?>/i);
    const submitLabel = submitMatch ? submitMatch[1] : "Validate Choice";

    const safeMsgId = messageId || "generic_msg";

    return `
    <div class="lollms-form-block" id="form-${escapeAttr(formId)}" data-form-id="${escapeAttr(formId)}" style="border: 1.5px solid var(--vscode-charts-purple, #9b59b6); border-radius: 8px; margin: 12px 0; overflow: hidden; background: var(--vscode-editor-inactiveSelectionBackground); box-shadow: 0 4px 12px rgba(0,0,0,0.15);">
        <div class="lollms-form-header" style="padding: 8px 14px; background: var(--vscode-sideBarSectionHeader-background); font-weight: 700; font-size: 12px; display: flex; align-items: center; gap: 8px; border-bottom: 1px solid var(--vscode-widget-border); color: var(--vscode-charts-purple, #9b59b6);">
            <span class="codicon codicon-question"></span> <span>${sanitizer.sanitize(title)}</span>
        </div>
        <div class="lollms-form-body" style="padding: 12px 14px;">
            ${bodyHtml}
        </div>
        <div class="lollms-form-footer" style="padding: 8px 14px; background: var(--vscode-sideBarSectionHeader-background); border-top: 1px solid var(--vscode-widget-border); display: flex; justify-content: flex-end;">
            <button class="code-action-btn apply-btn lollms-form-submit-btn" 
                    id="btn-submit-${escapeAttr(formId)}"
                    data-form-id="${escapeAttr(formId)}" 
                    data-message-id="${escapeAttr(safeMsgId)}"
                    style="height: 26px; padding: 0 14px; font-weight: bold; background: var(--vscode-charts-purple, #9b59b6) !important; color: white !important;">
                <span class="codicon codicon-check"></span> <span>${sanitizer.sanitize(submitLabel)}</span>
            </button>
        </div>
    </div>`;
}

function renderStreamingFormPlaceholder(openTag: string): string {
    const attrs = parseTagAttrs((openTag.match(/^<(?:lollms_form|form)\b([^>]*)>/i) || [])[1] || '');
    const title = attrs.title || "Preparing Interactive Form...";
    return `
    <div class="lollms-form-block" style="border: 1.5px solid var(--vscode-charts-purple, #9b59b6); border-radius: 8px; margin: 12px 0; overflow: hidden; background: var(--vscode-editor-inactiveSelectionBackground); box-shadow: 0 4px 12px rgba(0,0,0,0.15);">
        <div class="lollms-form-header" style="padding: 8px 14px; background: var(--vscode-sideBarSectionHeader-background); font-weight: 700; font-size: 12px; display: flex; align-items: center; gap: 8px; color: var(--vscode-charts-purple, #9b59b6);">
            <span class="codicon codicon-question"></span> <span>${sanitizer.sanitize(title)}</span>
            <span style="margin-left:auto; font-size:10px; display:inline-flex; align-items:center; gap:5px; opacity:0.85;"><span class="spinner" style="width:10px; height:10px; border-width:1.5px;"></span> Preparing form...</span>
        </div>
    </div>`;
}

export const formPlugin: TagPlugin = {
    id: 'lollms_form',
    extractBlocks: (text: string, context: PluginContext) => {
        const blocks: { match: any; start: number; end: number; html: string }[] = [];
        if (!text || typeof text !== 'string') return blocks;

        // Protect fenced code blocks (except explicit xml/form wrapper fences around <lollms_form>) and inline backticks
        const protectedRanges: { start: number; end: number }[] = [];
        const fenceRegex = /```([a-zA-Z0-9_\-]*)[ \t]*\r?\n([\s\S]*?)(?:```|$)|`[^`\r\n]+`/g;
        let fMatch: RegExpExecArray | null;
        while ((fMatch = fenceRegex.exec(text)) !== null) {
            if (fMatch[0].startsWith('```')) {
                const langHint = (fMatch[1] || '').toLowerCase();
                const innerTrim = (fMatch[2] || '').trim();
                const isFormWrapperFence = (!langHint || ['xml', 'form', 'lollms_form'].includes(langHint)) &&
                    /^<lollms_form\b/i.test(innerTrim);
                if (isFormWrapperFence) continue;
            }
            protectedRanges.push({ start: fMatch.index, end: fMatch.index + fMatch[0].length });
        }

        const isProtected = (idx: number) => protectedRanges.some(r => idx >= r.start && idx < r.end);

        // 1. Match <lollms_form> (closed, or streaming unclosed)
        const lollmsOpenRegex = /<lollms_form\b([^>]*)>/gi;
        let m: RegExpExecArray | null;
        while ((m = lollmsOpenRegex.exec(text)) !== null) {
            if (isProtected(m.index)) continue;
            const start = m.index;
            const contentStart = start + m[0].length;
            const closeIdx = text.toLowerCase().indexOf('</lollms_form>', contentStart);
            const isClosed = closeIdx !== -1;

            if (!isClosed && context.isFinal) {
                const inner = text.substring(contentStart);
                const fullXml = `${m[0]}${inner}</lollms_form>`;
                const html = parseAndRenderFormContent(fullXml, inner, context.messageId);
                blocks.push({ match: m, start, end: text.length, html });
                break;
            }

            if (!isClosed) {
                blocks.push({
                    match: m,
                    start,
                    end: text.length,
                    html: renderStreamingFormPlaceholder(m[0])
                });
                break;
            }

            const end = closeIdx + '</lollms_form>'.length;
            const fullXml = text.substring(start, end);
            const inner = text.substring(contentStart, closeIdx);
            const html = parseAndRenderFormContent(fullXml, inner, context.messageId);
            blocks.push({ match: m, start, end, html });
            lollmsOpenRegex.lastIndex = end;
        }

        // 2. Match top-level line-start <form>...</form> outside protected ranges and already-matched <lollms_form> blocks
        const htmlFormRegex = /(?:^[ \t]*|(?<=>)[ \t]*)<form\b([^>]*)>([\s\S]*?)<\/form>/gim;
        let hm: RegExpExecArray | null;
        while ((hm = htmlFormRegex.exec(text)) !== null) {
            const start = hm.index;
            const end = start + hm[0].length;
            if (isProtected(start)) continue;
            if (blocks.some(b => start < b.end && end > b.start)) continue;
            const html = parseAndRenderFormContent(hm[0], hm[2] || '', context.messageId);
            blocks.push({ match: hm, start, end, html });
        }

        return blocks;
    },
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