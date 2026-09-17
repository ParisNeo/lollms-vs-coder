import { TagPlugin, PluginContext } from '../pluginSystem';

export const missionBriefingPlugin: TagPlugin = {
    id: 'mission_briefing',
    tagPattern: /(?:^[ \t]*|(?<=>)[ \t]*)<mission_briefing\b([^>]*?)>([\s\S]*?)<\/mission_briefing>/gim,
    render: (match: RegExpExecArray, context: PluginContext) => {
        const attrStr = match[1] || "";
        const content = (match[2] || "").trim();

        const actionMatch = attrStr.match(/action=["'](write|patch)["']/i);
        const action = actionMatch ? actionMatch[1].toUpperCase() : (content.includes('<<<<<<< SEARCH') ? 'PATCH' : 'WRITE');
        const scopeMatch = attrStr.match(/scope=["'](global|local)["']/i);
        const scope = scopeMatch ? scopeMatch[1].toUpperCase() : 'GLOBAL';

        const escaped = content
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");

        return `
        <div class="technical-briefing-card mission-doctrine-card" style="border-left: 4px solid var(--vscode-charts-purple); margin: 16px 0;">
            <div class="briefing-header" style="color: var(--vscode-charts-purple); display: flex; justify-content: space-between; align-items: center;">
                <div style="display: flex; align-items: center; gap: 8px;">
                    <span class="codicon codicon-shield"></span>
                    <strong style="letter-spacing: 0.5px;">MISSION DOCTRINE & CONSTRAINTS (${action} &middot; ${scope})</strong>
                </div>
                <button class="code-action-btn secondary-btn inspect-briefing-btn" style="height: 22px; font-size: 10px; padding: 0 8px;">
                    <i class="codicon codicon-edit"></i> Edit Doctrine
                </button>
            </div>
            <div class="briefing-content" style="padding: 10px 14px; font-size: 12px; line-height: 1.5; font-family: var(--vscode-editor-font-family); background: rgba(0,0,0,0.15); border-radius: 4px; margin: 8px 12px 12px 12px; max-height: 200px; overflow-y: auto; white-space: pre-wrap;">${escaped}</div>
        </div>`;
    },
    initialize: (container: HTMLElement, context: PluginContext) => {
        container.querySelectorAll('.inspect-briefing-btn').forEach(btn => {
            (btn as HTMLElement).onclick = (e: MouseEvent) => {
                e.stopPropagation();
                context.vscode.postMessage({ command: 'requestMissionBriefingUI' });
            };
        });
    }
};