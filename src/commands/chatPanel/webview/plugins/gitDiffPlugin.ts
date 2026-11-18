import { TagPlugin, PluginContext } from '../pluginSystem';
import DOMPurify from 'dompurify';

const sanitizer = typeof DOMPurify === 'function' ? (DOMPurify as any)(window) : DOMPurify;

export const gitDiffPlugin: TagPlugin = {
    id: 'agent_git_diff',
    tagPattern: /(?:^[ \t]*|(?<=>)[ \t]*)<agent_git_diff\b([^>]*?)\s*(?:\/>|>([\s\S]*?)<\/agent_git_diff>)/gim,
    render: (match) => {
        const attrStr = match[1] || '';
        const getAttr = (name: string): string => {
            const m = attrStr.match(new RegExp(`\\b${name}=["']([^"']*)["']`, 'i'));
            return m ? m[1] : '';
        };

        const baseRef = getAttr('base');
        const baseLabel = getAttr('label') || (baseRef.length > 10 ? baseRef.substring(0, 7) : baseRef) || 'start';
        const branch = getAttr('branch') || 'HEAD';
        const filesCount = parseInt(getAttr('files') || '0', 10) || 0;

        const safeBase = sanitizer.sanitize(baseRef);
        const safeLabel = sanitizer.sanitize(baseLabel);
        const safeBranch = sanitizer.sanitize(branch);
        const filesLabel = filesCount === 1 ? '1 file changed' : `${filesCount} files changed`;

        return `
        <div class="file-operation-block agent-git-diff-card" style="background-color: var(--vscode-editor-inactiveSelectionBackground); border: 1.5px solid var(--vscode-charts-blue); border-radius: 8px; margin: 12px 0; overflow: hidden; box-shadow: 0 2px 10px rgba(0, 0, 0, 0.2);">
            <div class="file-operation-header" style="padding: 8px 12px; background: var(--vscode-sideBarSectionHeader-background); display: flex; align-items: center; justify-content: space-between; font-weight: 700; font-size: 12px; border-bottom: 1px solid var(--vscode-widget-border); flex-wrap: wrap; gap: 8px;">
                <div style="display: flex; align-items: center; gap: 8px; min-width: 0;">
                    <span class="codicon codicon-git-compare" style="color: var(--vscode-charts-blue); font-size: 15px;"></span>
                    <span>Agentic Work Complete &middot; Git Diff Summary</span>
                    <span class="file-token-badge weight-light" style="font-size: 10px; border-color: rgba(0, 122, 204, 0.45); color: var(--vscode-charts-blue);">${filesLabel}</span>
                </div>
                <span style="font-size: 10.5px; opacity: 0.8; font-family: var(--vscode-editor-font-family, monospace);">
                    ${safeLabel} &rarr; ${safeBranch}
                </span>
            </div>
            <div class="expansion-body" style="padding: 10px 12px; display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap;">
                <div style="font-size: 11px; opacity: 0.85; line-height: 1.45; flex: 1; min-width: 220px;">
                    Changes were committed to isolated branch <code>${safeBranch}</code>. Inspect the full diff between starting state (<code>${safeLabel}</code>) and current state in Git Manager.
                </div>
                <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
                    <button class="code-action-btn secondary-btn open-commit-inspector-btn" style="height: 26px; font-size: 11px; padding: 0 10px;" title="Open AI Commit Inspector">
                        <i class="codicon codicon-history"></i> Commit History
                    </button>
                    <button class="code-action-btn apply-btn open-full-git-diff-btn" data-base="${safeBase}" data-label="${safeLabel}" data-branch="${safeBranch}" style="height: 26px; font-size: 11px; padding: 0 12px; font-weight: bold; background: var(--vscode-charts-blue) !important; color: white !important;" title="Open Git Manager showing full diffs between starting state and current state">
                        <i class="codicon codicon-diff"></i> Show Full Diff vs Start
                    </button>
                </div>
            </div>
        </div>`;
    },
    initialize: (container: HTMLElement, context: PluginContext) => {
        container.querySelectorAll('.open-full-git-diff-btn').forEach(btn => {
            if (btn.hasAttribute('data-bound')) return;
            btn.setAttribute('data-bound', 'true');
            btn.addEventListener('click', (e: Event) => {
                e.preventDefault();
                e.stopPropagation();
                const el = btn as HTMLElement;
                const baseRef = el.getAttribute('data-base') || '';
                const label = el.getAttribute('data-label') || '';
                context.vscode.postMessage({
                    command: 'executeLollmsCommand',
                    details: {
                        command: 'lollms-vs-coder.showGitDiffFromStart',
                        params: { baseRef, label }
                    }
                });
            });
        });

        container.querySelectorAll('.open-commit-inspector-btn').forEach(btn => {
            if (btn.hasAttribute('data-bound')) return;
            btn.setAttribute('data-bound', 'true');
            btn.addEventListener('click', (e: Event) => {
                e.preventDefault();
                e.stopPropagation();
                context.vscode.postMessage({
                    command: 'executeLollmsCommand',
                    details: {
                        command: 'lollms-vs-coder.inspectCommit'
                    }
                });
            });
        });
    }
};