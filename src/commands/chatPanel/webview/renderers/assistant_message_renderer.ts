import { vscode, state } from '../dom.js';
import { renderMessageContent } from '../messageRenderer.js';

export function renderAssistantMessage(messageId: string, rawContent: any, isFinal: boolean) {
    const safeMessageId = String(messageId || '');
    if (!safeMessageId) return;

    const wrapper = document.querySelector(`.message-wrapper[data-message-id='${safeMessageId}']`) as HTMLElement;
    if (!wrapper) return;

    const bodyDiv = wrapper.querySelector('.message-body') as HTMLElement;
    if (!bodyDiv) return;

    // Detect message role accurately
    const isUser = safeMessageId.startsWith('user_') || wrapper.querySelector('.message')?.classList.contains('user-message');
    const isGovernor = safeMessageId.startsWith('governor_') || wrapper.dataset.personalityName?.includes('Governor');
    const isSystem = !isGovernor && (safeMessageId.startsWith('error_') || safeMessageId.startsWith('system_') || wrapper.querySelector('.message')?.classList.contains('system-message'));

    // Update avatar icon for Governor
    if (isGovernor) {
        const avatarDiv = wrapper.querySelector('.message-avatar') as HTMLElement;
        const msgDiv = wrapper.querySelector('.message') as HTMLElement;
        if (avatarDiv) {
            avatarDiv.innerHTML = '<span class="codicon codicon-law" style="color:var(--vscode-charts-orange)"></span>';
            avatarDiv.style.backgroundColor = 'rgba(214, 122, 13, 0.1)';
            avatarDiv.style.border = '1px solid var(--vscode-charts-orange)';
        }
        if (msgDiv) {
            msgDiv.style.borderLeftColor = 'var(--vscode-charts-orange)';
        }
    }

    // Check if we need to initialize the layout
    let layout = bodyDiv.querySelector('.assistant-layout');
    if (!layout) {
        bodyDiv.innerHTML = ''; // Clear prior shells

        // Build dynamic action buttons depending on the message role
        const editButton = `<button class="msg-action-btn edit-msg-btn" title="Edit Message"><i class="codicon codicon-edit"></i></button>`;
        const copyButton = `<button class="msg-action-btn copy-msg-btn" title="Copy Message"><i class="codicon codicon-copy"></i></button>`;
        const deleteButton = `<button class="msg-action-btn delete-msg-btn" title="Delete Message"><i class="codicon codicon-trash"></i></button>`;

        const middleButton = isUser 
            ? `<button class="msg-action-btn regenerate-msg-btn" title="Regenerate Response"><i class="codicon codicon-sync"></i></button>`
            : ((isSystem || isGovernor) ? '' : `<button class="msg-action-btn run-monitor-btn" title="Run App & Monitor Logs"><i class="codicon codicon-play"></i></button>`);

        // Floating Message Actions HUD
        const actions = document.createElement('div');
        actions.className = 'message-actions';
        actions.innerHTML = (isSystem || isGovernor) ? `${copyButton}${deleteButton}` : `${editButton}${copyButton}${middleButton}${deleteButton}`;
        bodyDiv.appendChild(actions);

        // Header Metadata
        const header = document.createElement('div');
        header.className = 'message-header';

        const roleSpan = document.createElement('span');
        roleSpan.className = 'role-name';
        if (isUser) {
            roleSpan.textContent = 'You';
        } else if (isGovernor) {
            roleSpan.textContent = '⚖️ Context Governor';
            roleSpan.style.color = 'var(--vscode-charts-orange)';
            roleSpan.style.fontWeight = 'bold';
        } else if (isSystem) {
            roleSpan.textContent = 'System Alert';
            roleSpan.style.color = 'var(--vscode-charts-red)';
            roleSpan.style.fontWeight = 'bold';
        } else {
            const personaLabel = wrapper.dataset.personalityName || 'Lollms Coder';
            roleSpan.textContent = `${personaLabel} (Assistant)`;
        }
        header.appendChild(roleSpan);
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
            let textToCopy = "";
            const msgDiv = wrapper.querySelector('.message') as HTMLElement;
            if (msgDiv && msgDiv.dataset.originalContent) {
                try {
                    const parsed = JSON.parse(msgDiv.dataset.originalContent);
                    if (typeof parsed === 'string') textToCopy = parsed;
                    else if (Array.isArray(parsed)) textToCopy = parsed.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n');
                    else textToCopy = String(parsed);
                } catch {
                    textToCopy = msgDiv.dataset.originalContent;
                }
            }
            if (!textToCopy) {
                const contentEl = wrapper.querySelector('.message-content');
                textToCopy = contentEl ? (contentEl.textContent || '') : '';
            }

            vscode.postMessage({ command: 'copyToClipboard', text: textToCopy });

            const copyIcon = actions.querySelector('.copy-msg-btn i, .copy-msg-btn .codicon');
            if (copyIcon) {
                const origClass = copyIcon.className;
                copyIcon.className = 'codicon codicon-check';
                setTimeout(() => { copyIcon.className = origClass; }, 2000);
            }
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
