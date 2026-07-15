import { vscode, state } from '../dom.js';
import { renderMessageContent } from '../messageRenderer.js';

export function renderDynamicMessage(messageId: string, rawContent: any, isFinal: boolean) {
    const safeMessageId = String(messageId || '');
    if (!safeMessageId) return;

    const wrapper = document.querySelector(`.message-wrapper[data-message-id='${safeMessageId}']`) as HTMLElement;
    if (!wrapper) return;

    const bodyDiv = wrapper.querySelector('.message-body') as HTMLElement;
    if (!bodyDiv) return;

    let layout = bodyDiv.querySelector('.dynamic-layout');
    if (!layout) {
        bodyDiv.innerHTML = ''; // Clear prior

        // Build action buttons
        const editButton = `<button class="msg-action-btn edit-msg-btn" title="Edit Message"><i class="codicon codicon-edit"></i></button>`;
        const copyButton = `<button class="msg-action-btn copy-msg-btn" title="Copy Message"><i class="codicon codicon-copy"></i></button>`;
        const deleteButton = `<button class="msg-action-btn delete-msg-btn" title="Delete Message"><i class="codicon codicon-trash"></i></button>`;
        const monitorButton = `<button class="msg-action-btn run-monitor-btn" title="Run App & Monitor Logs"><i class="codicon codicon-play"></i></button>`;

        // Add Floating Action HUD
        const actions = document.createElement('div');
        actions.className = 'message-actions';
        actions.innerHTML = `${editButton}${copyButton}${monitorButton}${deleteButton}`;
        bodyDiv.appendChild(actions);

        // Header Metadata with dynamic style
        const header = document.createElement('div');
        header.className = 'message-header';
        const personaLabel = wrapper.dataset.personalityName || '🧠 Dynamic Specialist';
        header.innerHTML = `<span class="role-name" style="color: var(--vscode-charts-orange); font-weight:800;">${personaLabel} (Dynamic Turn)</span>`;
        bodyDiv.appendChild(header);

        // Dynamic Stream & Interaction Container
        layout = document.createElement('div');
        layout.className = 'dynamic-layout message-content';
        layout.id = `content-${messageId}`;
        bodyDiv.appendChild(layout);

        // Bind events
        actions.querySelector('.edit-msg-btn')?.addEventListener('click', () => {
            const msgDiv = wrapper.querySelector('.message') as HTMLElement;
            if (msgDiv && (window as any).startEdit) (window as any).startEdit(msgDiv, messageId, 'assistant');
        });
        actions.querySelector('.copy-msg-btn')?.addEventListener('click', () => {
            vscode.postMessage({ command: 'copyToClipboard', text: String(rawContent) });
        });
        actions.querySelector('.run-monitor-btn')?.addEventListener('click', () => {
            vscode.postMessage({ command: 'runAndMonitorApp', messageId });
        });
        actions.querySelector('.delete-msg-btn')?.addEventListener('click', () => {
            vscode.postMessage({ command: 'requestDeleteMessage', messageId });
        });
    }

    renderMessageContent(messageId, rawContent, isFinal);
}
