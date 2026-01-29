import { dom, vscode, state } from './dom.js';
import { performSearch, navigateSearch, clearSearch } from './search.js';
import { insertNewMessageEditor } from './messageRenderer.js';
import { setGeneratingState, updateBadges } from './ui.js';
import { isScrolledToBottom } from './utils.js';

export function initEventHandlers() {
    // --- MOVABLE SEPARATOR LOGIC ---
    const resizer = dom.planResizer;
    const planZone = dom.agentPlanZone;
    const wrapper = dom.chatContentWrapper;

    if (resizer && planZone && wrapper) {
        let isResizing = false;

        resizer.addEventListener('mousedown', (e) => {
            isResizing = true;
            resizer.classList.add('resizing');
            document.body.style.cursor = 'col-resize';
            // Disable pointer events on the main column to prevent interference
            document.querySelectorAll('iframe, .messages').forEach(el => (el as HTMLElement).style.pointerEvents = 'none');
        });

        window.addEventListener('mousemove', (e) => {
            if (!isResizing) return;
            
            const containerWidth = wrapper.getBoundingClientRect().width;
            const newWidth = containerWidth - e.clientX;
            
            // Constrain width
            if (newWidth > 150 && newWidth < containerWidth * 0.8) {
                planZone.style.width = `${newWidth}px`;
            }
        });

        window.addEventListener('mouseup', () => {
            if (isResizing) {
                isResizing = false;
                resizer.classList.remove('resizing');
                document.body.style.cursor = '';
                document.querySelectorAll('iframe, .messages').forEach(el => (el as HTMLElement).style.pointerEvents = 'auto');
            }
        });
    }

    // --- (Rest of standard event handlers) ---
    if (dom.sendButton) dom.sendButton.addEventListener('click', () => {
        const text = dom.messageInput.value.trim();
        if (text) {
            vscode.postMessage({ command: 'sendMessage', message: { role: 'user', content: text } });
            dom.messageInput.value = '';
            dom.messageInput.style.height = 'auto';
        }
    });

    if (dom.messageInput) {
        dom.messageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                dom.sendButton.click();
            }
        });
        dom.messageInput.addEventListener('input', () => {
            dom.messageInput.style.height = 'auto';
            dom.messageInput.style.height = dom.messageInput.scrollHeight + 'px';
        });
    }

    if (dom.moreActionsButton) dom.moreActionsButton.addEventListener('click', (e) => {
        e.stopPropagation();
        dom.moreActionsMenu.classList.toggle('visible');
    });

    window.addEventListener('click', () => {
        dom.moreActionsMenu.classList.remove('visible');
    });
}
