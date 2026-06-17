import { vscode, state } from '../dom.js';
import { renderMessageContent } from '../messageRenderer.js';

export function renderAgentMessage(messageId: string, rawContent: any, isFinal: boolean) {
    const wrapper = document.querySelector(`.message-wrapper[data-message-id='${messageId}']`) as HTMLElement;
    if (!wrapper) return;

    const bodyDiv = wrapper.querySelector('.message-body') as HTMLElement;
    if (!bodyDiv) return;

    let layout = bodyDiv.querySelector('.agent-layout') as HTMLElement;
    if (!layout) {
        bodyDiv.innerHTML = ''; // Clear prior shells

        // Add Floating Action HUD (the Hover HUD)
        const actions = document.createElement('div');
        actions.className = 'message-actions';
        actions.innerHTML = `
            <button class="msg-action-btn copy-msg-btn" title="Copy Agent Report"><i class="codicon codicon-copy"></i></button>
            <button class="msg-action-btn delete-msg-btn" title="Delete Message"><i class="codicon codicon-trash"></i></button>
        `;
        bodyDiv.appendChild(actions);

        // Header Metadata with Agentic Style
        const header = document.createElement('div');
        header.className = 'message-header';
        const personaLabel = wrapper.dataset.personalityName || 'Autonomous Agent';
        header.innerHTML = `<span class="role-name" style="color: var(--vscode-charts-red); font-weight:800; letter-spacing:0.5px;">🤖 ${personaLabel} (Agent Mission)</span>`;
        bodyDiv.appendChild(header);

        // Core Layout Container
        layout = document.createElement('div');
        layout.className = 'agent-layout message-content';
        layout.id = `content-${messageId}`;
        bodyDiv.appendChild(layout);

        // Bind events
        actions.querySelector('.copy-msg-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            const text = typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent);
            vscode.postMessage({ command: 'copyToClipboard', text });
        });
        actions.querySelector('.delete-msg-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            vscode.postMessage({ command: 'requestDeleteMessage', messageId });
        });
    }

    // --- AGENT-SPECIFIC CONTENT PARSER ---
    const textContent = typeof rawContent === 'string' ? rawContent : '';
    
    // Check if the message content contains structured agentic task tags
    const containsAgentTask = textContent.includes('<agent_task') || textContent.includes('<builder_report') || textContent.includes('<milestone');

    if (containsAgentTask) {
        // Render as structured progress cards matching the plan/timeline styles
        let processedHtml = textContent;
        
        // Render Milestones
        processedHtml = processedHtml.replace(/<milestone\s+([^>]*?)\s*\/>/gi, (match, attrStr) => {
            const attrs: any = {};
            attrStr.replace(/(\w+)=["']([^"']*)["']/g, (_: any, k: string, v: string) => attrs[k] = v);
            return `
            <div class="milestone-card" style="margin: 10px 0;">
                <div class="milestone-card-header" style="background:#6a1b9a; color:white; padding:8px 12px; display:flex; align-items:center; gap:8px; font-weight:bold; font-size:11px;">
                    <span class="codicon codicon-bookmark"></span> Milestone: ${attrs.title || 'Mission Update'}
                </div>
                <div class="milestone-body" style="padding:10px; background:var(--vscode-editor-inactiveSelectionBackground); font-size:11px;">
                    <div style="margin-bottom:6px;"><strong>Achievements:</strong> ${attrs.achievements || 'None'}</div>
                    <div style="margin-bottom:6px;"><strong>Challenges:</strong> ${attrs.challenges || 'None'}</div>
                    <div><strong>Solutions:</strong> ${attrs.solutions || 'None'}</div>
                </div>
            </div>`;
        });

        // Render Task Logs
        processedHtml = processedHtml.replace(/<agent_task\s+([^>]*?)\s*\/>/gi, (match, attrStr) => {
            const attrs: any = {};
            attrStr.replace(/(\w+)=["']([^"']*)["']/g, (_: any, k: string, v: string) => attrs[k] = v);
            return `
            <div class="agent-card status-completed" style="margin: 10px 0; border: 1px solid var(--vscode-charts-green);">
                <div class="agent-card-header" style="background:var(--vscode-sideBarSectionHeader-background); padding:6px 12px; display:flex; align-items:center; gap:8px; font-size:11px;">
                    <span class="codicon codicon-check" style="color:var(--vscode-charts-green)"></span>
                    <strong>Task: ${attrs.description || 'Execution'}</strong>
                </div>
                <div class="agent-card-body" style="padding:10px; font-size:11px;">
                    <div>Tool used: <code>${attrs.action || 'unknown'}</code></div>
                </div>
            </div>`;
        });

        layout.innerHTML = (window as any).DOMPurify.sanitize(processedHtml);
    } else {
        // Fallback to standard rich markdown renderer
        renderMessageContent(messageId, rawContent, isFinal);
    }
}
