import { TagPlugin, PluginContext } from '../pluginSystem.js';
import { state } from '../dom.js';
import { normalizeAiderContent, parseAiderHunks } from '../utils.js';

function renderDiffLines(lines: string[], type: 'added' | 'removed' | 'unchanged'): string {
    return lines.map(line => {
        const escaped = line
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
        const safeLine = escaped.length === 0 ? ' ' : escaped;
        const prefix = type === 'added' ? '+ ' : (type === 'removed' ? '- ' : '  ');
        return `<div class="aider-diff-line aider-diff-${type}"><span class="aider-diff-marker" style="user-select:none; opacity:0.6; width:20px; display:inline-block; font-weight:bold;">${prefix}</span><span class="aider-diff-code" style="white-space:pre-wrap;">${safeLine}</span></div>`;
    }).join('');
}

function getCurrentDoctrineText(): string {
    const raw = (state as any)?.lastContextData?.briefing || "";
    if (!raw) return "";
    try {
        if (raw.startsWith('{')) {
            const parsed = JSON.parse(raw);
            return parsed.user_constraints || parsed.doctrine || Object.values(parsed).join('\n\n') || "";
        }
    } catch {}
    return raw;
}

function computeSimpleLineDiff(oldText: string, newText: string): string {
    const oldLines = oldText ? oldText.split(/\r?\n/).map(l => l.trimEnd()) : [];
    const newLines = newText ? newText.split(/\r?\n/).map(l => l.trimEnd()) : [];

    if (oldLines.length === 0) {
        return renderDiffLines(newLines, 'added');
    }

    const oldSet = new Set(oldLines);
    const newSet = new Set(newLines);

    const diffHtml: string[] = [];

    const removedLines = oldLines.filter(l => !newSet.has(l));
    if (removedLines.length > 0) {
        diffHtml.push(renderDiffLines(removedLines, 'removed'));
    }

    const addedLines = newLines.filter(l => !oldSet.has(l));
    if (addedLines.length > 0) {
        diffHtml.push(renderDiffLines(addedLines, 'added'));
    }

    const commonLines = newLines.filter(l => oldSet.has(l));
    if (commonLines.length > 0) {
        diffHtml.push(renderDiffLines(commonLines, 'unchanged'));
    }

    return diffHtml.join('');
}

export const missionBriefingPlugin: TagPlugin = {
    id: 'mission_briefing',
    tagPattern: /(?:^[ \t]*|(?<=>)[ \t]*)<mission_briefing\b([^>]*?)>([\s\S]*?)<\/mission_briefing>/gim,
    render: (match: RegExpExecArray, context: PluginContext) => {
        const attrStr = match[1] || "";
        const content = (match[2] || "").trim();

        const actionMatch = attrStr.match(/action=["'](write|patch)["']/i);
        const isPatch = actionMatch ? actionMatch[1].toLowerCase() === 'patch' : content.includes('<<<<<<< SEARCH');
        const action = isPatch ? 'PATCH' : 'WRITE';

        const scopeMatch = attrStr.match(/scope=["'](global|local)["']/i);
        const scope = scopeMatch ? scopeMatch[1].toUpperCase() : 'GLOBAL';

        const cardId = `doctrine-proposal-${context.messageId}-${Math.random().toString(36).substring(7)}`;

        let bodyHtml = "";

        if (isPatch) {
            const normalized = normalizeAiderContent(content);
            const hunks = parseAiderHunks(normalized);

            if (hunks.length > 0) {
                const diffHtmlParts: string[] = [];
                hunks.forEach((h, hIdx) => {
                    const sLines = (h.searchPart || "").replace(/\r\n/g, '\n').split('\n');
                    const rLines = (h.replacePart || "").replace(/\r\n/g, '\n').split('\n');

                    let pref = 0;
                    while (pref < sLines.length && pref < rLines.length && sLines[pref].trim() === rLines[pref].trim()) {
                        pref++;
                    }
                    let suff = 0;
                    while (suff < (sLines.length - pref) && suff < (rLines.length - pref) && sLines[sLines.length - 1 - suff].trim() === rLines[rLines.length - 1 - suff].trim()) {
                        suff++;
                    }

                    const headerHtml = hunks.length > 1 
                        ? `<div style="padding: 4px 8px; font-size: 10px; font-weight: bold; background: rgba(255,255,255,0.05); color: var(--vscode-charts-purple);">HUNK ${hIdx + 1} OF ${hunks.length}</div>`
                        : '';

                    diffHtmlParts.push(`
                        ${headerHtml}
                        ${renderDiffLines(sLines.slice(0, pref), 'unchanged')}
                        ${renderDiffLines(sLines.slice(pref, sLines.length - suff), 'removed')}
                        ${renderDiffLines(rLines.slice(pref, rLines.length - suff), 'added')}
                        ${renderDiffLines(sLines.slice(sLines.length - suff), 'unchanged')}
                    `);
                });
                bodyHtml = diffHtmlParts.join('<div style="height: 6px; border-bottom: 1px dashed var(--vscode-widget-border); margin: 6px 0;"></div>');
            } else {
                const currentDoctrine = getCurrentDoctrineText();
                bodyHtml = computeSimpleLineDiff(currentDoctrine, content);
            }
        } else {
            const currentDoctrine = getCurrentDoctrineText();
            bodyHtml = computeSimpleLineDiff(currentDoctrine, content);
        }

        return `
        <div class="technical-briefing-card mission-doctrine-card" id="${cardId}" style="border-left: 4px solid var(--vscode-charts-purple); margin: 16px 0; overflow: hidden; border-radius: 8px;">
            <div class="briefing-header" style="color: var(--vscode-charts-purple); display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: rgba(155, 89, 182, 0.1); border-bottom: 1px solid var(--vscode-widget-border);">
                <div style="display: flex; align-items: center; gap: 8px;">
                    <span class="codicon codicon-shield"></span>
                    <strong style="letter-spacing: 0.5px;">MISSION DOCTRINE & CONSTRAINTS (${action} &middot; ${scope})</strong>
                </div>
                <div style="display: flex; gap: 6px; align-items: center;">
                    <button class="code-action-btn apply-btn apply-briefing-btn" 
                            id="apply-btn-${cardId}" 
                            data-card-id="${cardId}" 
                            data-content="${encodeURIComponent(content)}" 
                            data-action="${action.toLowerCase()}" 
                            data-scope="${scope.toLowerCase()}" 
                            title="Apply this doctrine update to workspace context">
                        <i class="codicon codicon-check"></i> Apply Doctrine
                    </button>
                    <button class="code-action-btn secondary-btn inspect-briefing-btn" title="Open Mission Briefing Modal to inspect and manually edit">
                        <i class="codicon codicon-edit"></i> Edit in Modal
                    </button>
                </div>
            </div>
            <div class="briefing-content" style="padding: 10px 14px; font-size: 11.5px; line-height: 1.5; font-family: var(--vscode-editor-font-family); background: var(--vscode-editor-background); max-height: 280px; overflow-y: auto;">
                ${bodyHtml}
            </div>
        </div>`;
    },
    initialize: (container: HTMLElement, context: PluginContext) => {
        container.querySelectorAll('.apply-briefing-btn').forEach(btn => {
            (btn as HTMLElement).onclick = (e: MouseEvent) => {
                e.stopPropagation();
                const bEl = btn as HTMLButtonElement;
                const d = bEl.dataset;
                if (!d.content) return;

                bEl.disabled = true;
                bEl.innerHTML = '<span class="spinner" style="width:10px; height:10px; border-width:2px; margin-right:4px;"></span> Applying...';

                const content = decodeURIComponent(d.content);
                context.vscode.postMessage({
                    command: 'applyMissionBriefing',
                    content: content,
                    action: d.action || 'patch',
                    scope: d.scope || 'global',
                    cardId: d.cardId
                });
            };
        });

        container.querySelectorAll('.inspect-briefing-btn').forEach(btn => {
            (btn as HTMLElement).onclick = (e: MouseEvent) => {
                e.stopPropagation();
                context.vscode.postMessage({ command: 'requestMissionBriefingUI' });
            };
        });
    }
};

export default missionBriefingPlugin;