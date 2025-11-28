import { dom } from './dom.js';
import { vscode } from './main.js';
import { performSearch, navigateSearch, clearSearch } from './search.js';
import { insertNewMessageEditor } from './messageRenderer.js';
import { setGeneratingState } from './ui.js';
import { isScrolledToBottom } from './utils.js';

function sendMessage() {
    const messageText = dom.messageInput.value.trim();
    if (!messageText) return;

    setGeneratingState(true);

    const messageId = 'user_' + Date.now().toString() + Math.random().toString(36).substring(2);
    const userMessage = { id: messageId, role: 'user', content: messageText };

    vscode.postMessage({ command: 'addMessage', message: userMessage });

    if (dom.agentModeCheckbox.checked) {
        vscode.postMessage({ command: 'runAgent', objective: messageText, message: userMessage });
    } else {
        vscode.postMessage({ command: 'sendMessage', message: userMessage });
    }
    dom.messageInput.value = '';
    dom.messageInput.style.height = 'auto';
}

export function initEventHandlers() {
    dom.sendButton.addEventListener('click', sendMessage);
    dom.stopButton.addEventListener('click', () => vscode.postMessage({ command: 'stopGeneration' }));
    
    dom.messageInput.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    dom.messageInput.addEventListener('input', () => {
        dom.messageInput.style.height = 'auto';
        dom.messageInput.style.height = (dom.messageInput.scrollHeight) + 'px';
    });
    
    dom.attachButton.addEventListener('click', () => dom.fileInput.click());
    dom.copyFullPromptButton.addEventListener('click', () => {
        const draftMessage = dom.messageInput.value;
        vscode.postMessage({ command: 'copyFullPrompt', draftMessage: draftMessage });
    });
    
    if (dom.copyContextButton) {
        dom.copyContextButton.addEventListener('click', () => {
            const draftMessage = dom.messageInput.value;
            vscode.postMessage({ command: 'copyFullPrompt', draftMessage: draftMessage });
        });
    }

    dom.executeButton.addEventListener('click', () => vscode.postMessage({ command: 'executeProject' }));
    dom.setEntryPointButton.addEventListener('click', () => vscode.postMessage({ command: 'setEntryPoint' }));
    dom.debugRestartButton.addEventListener('click', () => vscode.postMessage({ command: 'debugRestart' }));
    dom.agentModeCheckbox.addEventListener('change', () => vscode.postMessage({ command: 'toggleAgentMode' }));
    dom.modelSelector.addEventListener('change', (event) => vscode.postMessage({ command: 'updateDiscussionModel', model: (event.target as HTMLSelectElement).value }));
    dom.refreshContextBtn.addEventListener('click', () => vscode.postMessage({ command: 'calculateTokens' }));

    dom.fileInput.addEventListener('change', () => {
        if (!dom.fileInput.files) return;
        for (const file of dom.fileInput.files) {
            const reader = new FileReader();
            const isImage = file.type.startsWith('image/');
            reader.onload = (e) => {
                if(e.target?.result) {
                    vscode.postMessage({
                        command: 'loadFile',
                        file: { name: file.name, content: e.target.result, isImage }
                    });
                }
            };
            reader.readAsDataURL(file);
        }
        dom.fileInput.value = '';
    });

    dom.searchInput.addEventListener('input', performSearch);
    dom.searchNextBtn.addEventListener('click', () => navigateSearch(1));
    dom.searchPrevBtn.addEventListener('click', () => navigateSearch(-1));
    dom.searchCloseBtn.addEventListener('click', () => {
        dom.searchBar.style.display = 'none';
        clearSearch();
        dom.messageInput.focus();
    });

    document.addEventListener('keydown', (e: KeyboardEvent) => {
        if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
            e.preventDefault();
            dom.searchBar.style.display = 'flex';
            dom.searchInput.focus();
            dom.searchInput.select();
        }
        if (dom.searchBar.style.display !== 'none') {
            if (e.key === 'Escape') {
                dom.searchBar.style.display = 'none';
                clearSearch();
                dom.messageInput.focus();
            } else if (e.key === 'Enter') {
                navigateSearch(e.shiftKey ? -1 : 1);
            }
        }
    });

    dom.moreActionsButton.addEventListener('click', (event: MouseEvent) => {
        event.stopPropagation();
        dom.moreActionsMenu.style.display = dom.moreActionsMenu.style.display === 'block' ? 'none' : 'block';
    });

    window.addEventListener('click', (event: MouseEvent) => {
        if (event.target instanceof Node && !dom.moreActionsMenu.contains(event.target) && event.target !== dom.moreActionsButton) {
            dom.moreActionsMenu.style.display = 'none';
        }
    });

    dom.configureToolsButton.addEventListener('click', () => {
        vscode.postMessage({ command: 'requestAvailableTools' });
        dom.toolsModal.style.display = 'block';
    });
    dom.closeToolsModal.addEventListener('click', () => dom.toolsModal.style.display = 'none');
    dom.saveToolsBtn.addEventListener('click', () => {
        const enabledTools = Array.from(dom.toolsListDiv.querySelectorAll('input:checked')).map(cb => (cb as HTMLInputElement).value);
        vscode.postMessage({ command: 'updateEnabledTools', tools: enabledTools });
        dom.toolsModal.style.display = 'none';
    });
    window.addEventListener('click', (event) => {
        if (event.target === dom.toolsModal) {
            dom.toolsModal.style.display = 'none';
        }
    });

    dom.addUserMessageBtn.addEventListener('click', () => insertNewMessageEditor('user'));
    dom.addAiMessageBtn.addEventListener('click', () => insertNewMessageEditor('assistant'));
    
    // Fixed Scroll Logic
    const handleScroll = () => {
        if (!isScrolledToBottom(dom.messagesDiv)) {
            dom.scrollToBottomBtn.style.display = 'flex';
        } else {
            dom.scrollToBottomBtn.style.display = 'none';
        }
    };

    dom.messagesDiv.addEventListener('scroll', handleScroll);

    dom.scrollToBottomBtn.addEventListener('click', () => {
        dom.messagesDiv.scrollTo({ top: dom.messagesDiv.scrollHeight, behavior: 'smooth' });
    });
}
