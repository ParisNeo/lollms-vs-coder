import { TagPlugin, PluginContext } from '../pluginSystem.js';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { isValidFilePath } from '../utils.js';

const sanitizer = typeof DOMPurify === 'function' ? (DOMPurify as any)(window) : DOMPurify;

function renderPlanHtml(inner: string, context: PluginContext): string {
    const findingsMatch = inner.match(/<findings\b[^>]*>([\s\S]*?)(?:<\/findings>|$)/i);
    const findingsText = findingsMatch ? findingsMatch[1].trim() : "";

    // Parse all phases
    const phaseRegex = /<phase\b[^>]*(?:id|number)=["']?(\d+)["']?[^>]*>([\s\S]*?)(?:<\/phase>|$)/gi;
    let pMatch: RegExpExecArray | null;
    const phases: { id: number; instruction: string; files: string[] }[] = [];

    while ((pMatch = phaseRegex.exec(inner)) !== null) {
        const phaseId = parseInt(pMatch[1], 10);
        const pBody = pMatch[2];

        const instMatch = pBody.match(/<(?:instruction|instructions)>([\s\S]*?)<\/(?:instruction|instructions)>/i);
        const instruction = instMatch ? instMatch[1].trim() : pBody.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '').trim();

        const filesMatch = pBody.match(/<(?:files_list|target_files|edit_files|files|filesList)>([\s\S]*?)<\/(?:files_list|target_files|edit_files|files|filesList)>/i);
        const rawFilesText = filesMatch ? filesMatch[1] : pBody;
        const files: string[] = [];

        rawFilesText.split(/[\r\n,]+/).forEach(l => {
            const clean = l.replace(/^[\s*#\-`'"]+|[\s*#\-`'"]+$/g, '').trim();
            if (clean && isValidFilePath(clean) && !files.includes(clean)) {
                files.push(clean);
            }
        });

        // Also check backtick-enclosed paths inside the phase body
        [...pBody.matchAll(/`([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9_\-]+)`/g)].forEach(m => {
            if (isValidFilePath(m[1]) && !files.includes(m[1])) {
                files.push(m[1]);
            }
        });

        phases.push({ id: phaseId, instruction, files });
    }

    const blockId = `lib-plan-${context.messageId}-${context.blockIndex ?? 0}`;
    const totalPhasesLabel = phases.length === 1 ? '1 Phase' : `${phases.length} Phases`;

    // 1. Findings sub-content as its own collapsible details block
    const parsedFindings = findingsText ? (sanitizer.sanitize(marked.parse(findingsText) as string) as string).trim() : "";
    const findingsHtml = findingsText ? `
    <details open class="processing-block plan-findings-block" style="border-left: 3px solid var(--vscode-charts-orange); background: rgba(214, 122, 13, 0.08); margin: 6px 0 10px 0; border-radius: 6px;">
        <summary style="color: var(--vscode-charts-orange); font-weight: bold; cursor: pointer; padding: 6px 10px; display: flex; align-items: center; gap: 6px;">
            <i class="codicon codicon-library"></i> <span>Architectural Findings &amp; System Mechanics</span>
        </summary>
        <div class="processing-body markdown-body plan-findings-body" style="padding: 6px 14px 10px 14px; font-size: 11.5px; line-height: 1.5; white-space: normal; min-height: 100px; max-height: 540px; overflow-y: auto;">${parsedFindings}</div>
    </details>` : '';

    // 2. All phases as individual collapsible details blocks
    const phasesHtml = phases.map(ph => {
        const parsedInst = ph.instruction ? (sanitizer.sanitize(marked.parse(ph.instruction) as string) as string).trim() : '';
        return `
    <details open class="processing-block plan-phase-block" style="border-left: 3px solid var(--vscode-charts-blue); background: rgba(0, 122, 204, 0.08); margin: 6px 0; border-radius: 6px;">
        <summary style="color: var(--vscode-textLink-foreground); font-weight: bold; cursor: pointer; padding: 6px 10px; display: flex; align-items: center; justify-content: space-between;">
            <span style="display: flex; align-items: center; gap: 6px;">
                <i class="codicon codicon-play"></i> <span>Phase ${ph.id}</span>
            </span>
            <span class="file-token-badge weight-light" style="font-size: 9.5px; padding: 1px 6px;">${ph.files.length} target file${ph.files.length === 1 ? '' : 's'}</span>
        </summary>
        <div class="processing-body plan-phase-body" style="padding: 6px 14px 10px 14px; font-size: 11.5px; line-height: 1.5; display: flex; flex-direction: column; gap: 6px; white-space: normal; min-height: 80px; max-height: 480px; overflow-y: auto;">${parsedInst ? `<div class="markdown-body phase-instruction-body" style="font-size: 11.5px; opacity: 0.95; margin: 0; padding: 0;">${parsedInst}</div>` : ''}${ph.files.length > 0 ? `
            <div style="display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px;">
                ${ph.files.map(f => `
                    <span class="summary-file-pill" onclick="vscode.postMessage({command:'openFile', path:'${f}'})" style="cursor:pointer; display:inline-flex; align-items:center; gap:4px; padding:2px 8px; border-radius:3px; background:var(--vscode-editor-background); border:1px solid var(--vscode-widget-border); font-size:10.5px;" title="Click to open ${f}">
                        <i class="codicon codicon-file-code"></i> <code>${f}</code>
                    </span>
                `).join('')}
            </div>` : '<div style="opacity:0.6; font-size:10px;">(No specific target files specified for this phase)</div>'}</div>
    </details>`;
    }).join('');

    // 3. Outer <plan> tag rendered as its own collapsible details block
    return `
    <details open class="processing-block librarian-plan-card" id="${blockId}" style="margin: 10px 0; border: 1.5px solid var(--vscode-charts-orange); border-radius: 8px; background: rgba(0,0,0,0.12); box-shadow: 0 4px 12px rgba(0,0,0,0.15);">
        <summary style="padding: 8px 12px; cursor: pointer; font-weight: bold; font-size: 12px; color: var(--vscode-charts-orange); display: flex; align-items: center; justify-content: space-between; background: var(--vscode-sideBarSectionHeader-background);">
            <span style="display: flex; align-items: center; gap: 6px;">
                <i class="codicon codicon-checklist"></i> <span>Librarian Architecture &amp; Execution Plan (${totalPhasesLabel})</span>
            </span>
            <span class="mode-badge active" style="font-size: 9px; padding: 1px 6px;">Plan Active</span>
        </summary>
        <div class="processing-body librarian-plan-body" style="padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; max-height: none !important; white-space: normal;">${findingsHtml}${phasesHtml}</div>
    </details>`;
}

export const librarianDecisionPlugin: TagPlugin = {
    id: 'librarian_decision_tag',
    tagPattern: /(?:^[ \t]*|(?<=>)[ \t]*)<librarian_decision\b([^>]*?)>([\s\S]*?)<\/librarian_decision>/gim,
    render: (match, context) => {
        const attrStr = match[1] || "";
        const content = (match[2] || "").trim();

        const suffMatch = attrStr.match(/sufficient=["'](true|false)["']/i);
        const isSufficient = suffMatch ? suffMatch[1].toLowerCase() === 'true' : content.toLowerCase().includes('sufficient="true"');

        const blockId = `lib-dec-${context.messageId}-${context.blockIndex ?? 0}`;
        const accentColor = isSufficient ? 'var(--vscode-charts-green)' : 'var(--vscode-charts-orange)';
        const statusIcon = isSufficient ? 'codicon-pass-filled' : 'codicon-search';
        const titleText = isSufficient 
            ? 'Phase 0 Inspection: Context Sufficient (Direct to Coder)' 
            : 'Phase 0 Inspection: Context Insufficient (Scouting Required)';

        const parsedRationale = (sanitizer.sanitize(marked.parse(content) as string) as string).trim();

        return `
        <div class="librarian-decision-card" id="${blockId}" style="margin: 8px 0; padding: 8px 14px; background: rgba(0, 0, 0, 0.15); border: 1.5px solid ${accentColor}; border-radius: 8px; font-size: 11.5px; box-shadow: 0 2px 8px rgba(0,0,0,0.15);">
            <div style="display: flex; align-items: center; gap: 8px; font-weight: 700; color: ${accentColor}; font-size: 12px; margin-bottom: 4px;">
                <i class="codicon ${statusIcon}"></i>
                <span>${titleText}</span>
            </div>
            <div class="markdown-body librarian-decision-body" style="font-size: 11.5px; opacity: 0.95; line-height: 1.45; min-height: 40px; max-height: 380px; overflow-y: auto;">${parsedRationale}</div>
        </div>`;
    }
};

export const librarianPlanPlugin: TagPlugin = {
    id: 'librarian_plan_tag',
    tagPattern: /(?:^[ \t]*|(?<=>)[ \t]*)<plan\b([^>]*?)>([\s\S]*?)(?:<\/plan>|$)/gim,
    extractBlocks: (text: string, context: PluginContext) => {
        const blocks: { html: string; start: number; end: number }[] = [];
        if (!text || typeof text !== 'string') return blocks;

        const openTagRegex = /(?:^|\n)[ \t]*<plan\b([^>]*)>/gi;
        let match: RegExpExecArray | null;

        while ((match = openTagRegex.exec(text)) !== null) {
            const start = match.index;
            const contentStart = start + match[0].length;
            const closeTag = '</plan>';
            const closeIdx = text.toLowerCase().indexOf(closeTag, contentStart);
            const isClosed = closeIdx !== -1;
            const end = isClosed ? closeIdx + closeTag.length : text.length;
            const inner = isClosed ? text.substring(contentStart, closeIdx) : text.substring(contentStart);

            const html = renderPlanHtml(inner, context);
            if (html) {
                blocks.push({ html, start, end });
            }
            if (!isClosed) break;
            openTagRegex.lastIndex = end;
        }

        return blocks;
    },
    render: (match, context) => {
        const inner = (match[2] || "").trim();
        return renderPlanHtml(inner, context);
    }
};

export const librarianPlugin: TagPlugin = {
    id: 'librarian_tag',
    tagPattern: /(?:^[ \t]*|(?<=>)[ \t]*)<(?:librarian|ask_librarian|consult_librarian|governor|ask_governor)\b([^>]*?)>([\s\S]*?)<\/(?:librarian|ask_librarian|consult_librarian|governor|ask_governor)>/gim,
    render: (_match, _context) => {
        return '';
    },
    initialize: () => {}
};

export const librarianOffPlugin: TagPlugin = {
    id: 'librarian_off_tag',
    tagPattern: /(?:^[ \t]*|(?<=>)[ \t]*)<librarian_off\b([^>]*?)>([\s\S]*?)<\/librarian_off>|(?:^[ \t]*|(?<=>)[ \t]*)<librarian_off\s*(?:\/|>[\s\S]*?<\/librarian_off)>/gim,
    render: (_match, _context) => {
        return '';
    },
    initialize: () => {}
};

export const multiStepsTaskPlugin: TagPlugin = {
    id: 'multi_steps_task_tag',
    tagPattern: /(?:^[ \t]*|(?<=>)[ \t]*)<(?:MultiSteps_TASK|multisteps_task|multi_steps_task)\b([^>]*?)>([\s\S]*?)<\/(?:MultiSteps_TASK|multisteps_task|multi_steps_task)>/gim,
    render: (_match, _context) => {
        return '';
    },
    initialize: () => {}
};

export default librarianPlanPlugin;