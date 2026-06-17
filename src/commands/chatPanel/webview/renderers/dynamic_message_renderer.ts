import { vscode, state } from '../dom.js';
import { renderMessageContent } from '../messageRenderer.js';

export function renderDynamicMessage(messageId: string, rawContent: any, isFinal: boolean) {
    const wrapper = document.querySelector(`.message-wrapper[data-message-id='${messageId}']`) as HTMLElement;
    if (!wrapper) return;

    const bodyDiv = wrapper.querySelector('.message-body') as HTMLElement;
    if (!bodyDiv) return;

    let layout = bodyDiv.querySelector('.dynamic-layout');
    if (!layout) {
        bodyDiv.innerHTML = ''; // Clear prior

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
    }

    renderMessageContent(messageId, rawContent, isFinal);
}
