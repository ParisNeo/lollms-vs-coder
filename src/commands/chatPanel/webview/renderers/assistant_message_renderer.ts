import { vscode, state } from '../dom.js';
import { renderMessageContent } from '../messageRenderer.js';

export function renderAssistantMessage(messageId: string, rawContent: any, isFinal: boolean) {
    const wrapper = document.querySelector(`.message-wrapper[data-message-id='${messageId}']`) as HTMLElement;
    if (!wrapper) return;

    const bodyDiv = wrapper.querySelector('.message-body') as HTMLElement;
    if (!bodyDiv) return;

    // Detect if the message belongs to the user or the assistant
    const isUser = messageId.startsWith('user_') || messageId.startsWith('msg_') || wrapper.querySelector('.message')?.classList.contains('user-message');

    // Check if we need to initialize the assistant-specific layout
    let layout = bodyDiv.querySelector('.assistant-layout');
    if (!layout) {
        bodyDiv.innerHTML = ''; // Clear prior shells

        // Build dynamic action buttons depending on the message role
        const editButton = `<button class="msg-action-btn edit-msg-btn" title="Edit Message"><i class="codicon codicon-edit"></i></button>`;
        const copyButton = `<button class="msg-action-btn copy-msg-btn" title="Copy Message"><i class="codicon codicon-copy"></i></button>`;
        const deleteButton = `<button class="msg-action-btn delete-msg-btn" title="Delete Message"><i class="codicon codicon-trash"></i></button>`;

        // Standard user messages get the sync/regenerate icon; assistant messages get the run/monitor icon
        const middleButton = isUser 
            ? `<button class="msg-action-btn regenerate-msg-btn" title="Regenerate Response"><i class="codicon codicon-sync"></i></button>`
            : `<button class="msg-action-btn run-monitor-btn" title="Run App & Monitor Logs"><i class="codicon codicon-play"></i></button>`;

        // Add Floating Action HUD
        const actions = document.createElement('div');
        actions.className = 'message-actions';
        actions.innerHTML = `${editButton}${copyButton}${middleButton}${deleteButton}`;
        bodyDiv.appendChild(actions);

        // Header Metadata
        const header = document.createElement('div');
        header.className = 'message-header';

        if (isUser) {
            header.innerHTML = `<span class="role-name">You</span>`;
        } else {
            const personaLabel = wrapper.dataset.personalityName || 'Lollms Coder';
            header.innerHTML = `<span class="role-name">${personaLabel} (Assistant)</span>`;
        }
        bodyDiv.appendChild(header);

        // Target Content Container
        layout = document.createElement('div');
        layout.className = 'assistant-layout message-content';
        layout.id = `content-${messageId}`;
        bodyDiv.appendChild(layout);

        // Bind events
        actions.querySelector('.edit-msg-btn')?.addEventListener('click', () => {
            const msgDiv = wrapper.querySelector('.message') as HTMLElement;
            if (msgDiv && (window as any).startEdit) (window as any).startEdit(msgDiv, messageId, isUser ? 'user' : 'assistant');
        });
        actions.querySelector('.copy-msg-btn')?.addEventListener('click', () => {
            vscode.postMessage({ command: 'copyToClipboard', text: String(rawContent) });
        });
        actions.querySelector('.regenerate-msg-btn')?.addEventListener('click', () => {
            vscode.postMessage({ command: 'regenerateFromMessage', messageId });
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
