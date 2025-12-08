import { dom, vscode, state } from './dom.js';
import { performSearch, navigateSearch, clearSearch } from './search.js';
import { insertNewMessageEditor } from './messageRenderer.js';
import { setGeneratingState } from './ui.js';
import { isScrolledToBottom } from './utils.js';

// ... (previous helper functions like sendMessage, closeMenu etc.) ...
export function sendMessage() {
    const messageInput = dom.messageInput;
    if (!messageInput) return;
    const messageText = messageInput.value.trim();
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
    
    messageInput.value = '';
    messageInput.style.height = 'auto'; // Reset height
}

function closeMenu() {
    if(dom.moreActionsMenu) {
        dom.moreActionsMenu.classList.remove('visible');
    }
}

export function initEventHandlers() {
    // ... (keep existing handlers) ...
    if (dom.sendButton) dom.sendButton.addEventListener('click', sendMessage);
    if (dom.messageInput) {
        dom.messageInput.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });
        dom.messageInput.addEventListener('input', () => {
            const textarea = dom.messageInput;
            textarea.style.height = 'auto';
            textarea.style.height = (textarea.scrollHeight) + 'px';
        });
        dom.messageInput.addEventListener('paste', (e: ClipboardEvent) => {
            const items = e.clipboardData?.items;
            if (!items) return;
            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                if (item.type.indexOf('image') !== -1) {
                    const file = item.getAsFile();
                    if (file) {
                        e.preventDefault();
                        const reader = new FileReader();
                        reader.onload = (event) => {
                            if (event.target?.result) {
                                vscode.postMessage({ command: 'loadFile', file: { name: file.name || `pasted_image_${Date.now()}.png`, content: event.target.result, isImage: true } });
                            }
                        };
                        reader.readAsDataURL(file);
                    }
                }
            }
        });
    }
    
    // ... (other handlers: stopButton, attachButton, importSkillsButton, copyFullPromptButton, copyContextButton, showDebugLogButton, executeButton, setEntryPointButton, debugRestartButton, agentModeCheckbox, modelSelector, refreshContextBtn, fileInput, search handlers ...) ...
    if (dom.stopButton) dom.stopButton.addEventListener('click', () => vscode.postMessage({ command: 'stopGeneration' }));
    if (dom.attachButton) dom.attachButton.addEventListener('click', () => { closeMenu(); dom.fileInput.click(); });
    if (dom.importSkillsButton) dom.importSkillsButton.addEventListener('click', () => { closeMenu(); vscode.postMessage({ command: 'importSkills' }); });
    if (dom.copyFullPromptButton) dom.copyFullPromptButton.addEventListener('click', () => { closeMenu(); const draftMessage = dom.messageInput ? dom.messageInput.value : ""; vscode.postMessage({ command: 'copyFullPrompt', draftMessage: draftMessage }); });
    if (dom.copyContextButton) dom.copyContextButton.addEventListener('click', () => { const draftMessage = dom.messageInput ? dom.messageInput.value : ""; vscode.postMessage({ command: 'copyFullPrompt', draftMessage: draftMessage }); });
    if (dom.showDebugLogButton) dom.showDebugLogButton.addEventListener('click', () => { closeMenu(); vscode.postMessage({ command: 'requestLog' }); });
    if (dom.executeButton) dom.executeButton.addEventListener('click', () => { closeMenu(); vscode.postMessage({ command: 'executeProject' }); });
    if (dom.setEntryPointButton) dom.setEntryPointButton.addEventListener('click', () => { closeMenu(); vscode.postMessage({ command: 'setEntryPoint' }); });
    if (dom.debugRestartButton) dom.debugRestartButton.addEventListener('click', () => { closeMenu(); vscode.postMessage({ command: 'debugRestart' }); });
    if (dom.agentModeCheckbox) dom.agentModeCheckbox.addEventListener('change', () => vscode.postMessage({ command: 'toggleAgentMode' }));
    if (dom.modelSelector) dom.modelSelector.addEventListener('change', (event) => vscode.postMessage({ command: 'updateDiscussionModel', model: (event.target as HTMLSelectElement).value }));
    if (dom.personalitySelector) {
        dom.personalitySelector.addEventListener('change', (e) => {
            const pid = (e.target as HTMLSelectElement).value;
            vscode.postMessage({ command: 'updateDiscussionPersonality', personalityId: pid });
        });
    }
    if (dom.refreshContextBtn) dom.refreshContextBtn.addEventListener('click', () => vscode.postMessage({ command: 'calculateTokens' }));
    if (dom.fileInput) {
        dom.fileInput.addEventListener('change', () => {
            if (!dom.fileInput.files) return;
            for (const file of dom.fileInput.files) {
                const reader = new FileReader();
                const isImage = file.type.startsWith('image/');
                reader.onload = (e) => { if(e.target?.result) { vscode.postMessage({ command: 'loadFile', file: { name: file.name, content: e.target.result, isImage } }); } };
                reader.readAsDataURL(file);
            }
            dom.fileInput.value = '';
        });
    }
    if (dom.searchInput) dom.searchInput.addEventListener('input', performSearch);
    if (dom.searchNextBtn) dom.searchNextBtn.addEventListener('click', () => navigateSearch(1));
    if (dom.searchPrevBtn) dom.searchPrevBtn.addEventListener('click', () => navigateSearch(-1));
    if (dom.searchCloseBtn) dom.searchCloseBtn.addEventListener('click', () => { if (dom.searchBar) dom.searchBar.style.display = 'none'; clearSearch(); if (dom.messageInput) dom.messageInput.focus(); });
    document.addEventListener('keydown', (e: KeyboardEvent) => {
        if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
            const activeElement = document.activeElement;
            const isMainInput = activeElement === dom.messageInput;
            const isCodeMirror = activeElement?.closest('.cm-editor') || activeElement?.classList.contains('cm-content');
            if (!isMainInput && !isCodeMirror) { e.preventDefault(); if (dom.searchBar) dom.searchBar.style.display = 'flex'; if (dom.searchInput) { dom.searchInput.focus(); dom.searchInput.select(); } }
        }
        if (dom.searchBar && dom.searchBar.style.display !== 'none') {
            if (e.key === 'Escape') { dom.searchBar.style.display = 'none'; clearSearch(); if (dom.messageInput) dom.messageInput.focus(); } else if (e.key === 'Enter') { navigateSearch(e.shiftKey ? -1 : 1); }
        }
    });
    if (dom.moreActionsButton) dom.moreActionsButton.addEventListener('click', (event: MouseEvent) => { event.preventDefault(); event.stopPropagation(); if (dom.moreActionsMenu) dom.moreActionsMenu.classList.toggle('visible'); });
    window.addEventListener('click', (event: MouseEvent) => {
        const target = event.target as Node;
        const isInsideMenu = dom.moreActionsMenu && dom.moreActionsMenu.contains(target);
        const isInsideButton = dom.moreActionsButton && dom.moreActionsButton.contains(target);
        if (!isInsideMenu && !isInsideButton) { if (dom.moreActionsMenu && dom.moreActionsMenu.classList.contains('visible')) dom.moreActionsMenu.classList.remove('visible'); }
        if (dom.toolsModal && event.target === dom.toolsModal) dom.toolsModal.classList.remove('visible');
        if (dom.discussionToolsModal && event.target === dom.discussionToolsModal) dom.discussionToolsModal.classList.remove('visible');
    });
    if (dom.agentToolsButton) dom.agentToolsButton.addEventListener('click', () => { closeMenu(); vscode.postMessage({ command: 'requestAvailableTools' }); });
    if (dom.discussionToolsButton) dom.discussionToolsButton.addEventListener('click', () => { closeMenu(); if (dom.discussionToolsModal) dom.discussionToolsModal.classList.add('visible'); });
    if (dom.closeToolsModal) dom.closeToolsModal.addEventListener('click', () => { if (dom.toolsModal) dom.toolsModal.classList.remove('visible'); });
    if (dom.closeDiscussionToolsModal) dom.closeDiscussionToolsModal.addEventListener('click', () => { if (dom.discussionToolsModal) dom.discussionToolsModal.classList.remove('visible'); });
    if (dom.saveToolsBtn) dom.saveToolsBtn.addEventListener('click', () => { if (dom.toolsListDiv) { const enabledTools = Array.from(dom.toolsListDiv.querySelectorAll('input:checked')).map(cb => (cb as HTMLInputElement).value); vscode.postMessage({ command: 'updateEnabledTools', tools: enabledTools }); if (dom.toolsModal) dom.toolsModal.classList.remove('visible'); } });
    if (dom.modelSelector) dom.modelSelector.addEventListener('change', (event) => vscode.postMessage({ command: 'updateDiscussionModel', model: (event.target as HTMLSelectElement).value }));
    if (dom.refreshModelsBtn) dom.refreshModelsBtn.addEventListener('click', () => { const icon = dom.refreshModelsBtn.querySelector('.codicon'); if(icon) icon.classList.add('spin'); vscode.postMessage({ command: 'refreshModels' }); });
    if (dom.addUserMessageBtn) dom.addUserMessageBtn.addEventListener('click', () => insertNewMessageEditor('user'));
    if (dom.addAiMessageBtn) dom.addAiMessageBtn.addEventListener('click', () => insertNewMessageEditor('assistant'));
    
    // UPDATED: Save Discussion Tools Button Handler
    if (dom.saveDiscussionToolsBtn) {
        dom.saveDiscussionToolsBtn.addEventListener('click', () => {
            const codeGenType = document.querySelector('input[name="codeGenType"]:checked') as HTMLInputElement;
            
            const capabilities = {
                codeGenType: codeGenType ? codeGenType.value : 'full',
                fileRename: dom.capFileRename ? dom.capFileRename.checked : true,
                fileDelete: dom.capFileDelete ? dom.capFileDelete.checked : true,
                fileSelect: dom.capFileSelect ? dom.capFileSelect.checked : true,
                fileReset: dom.capFileReset ? dom.capFileReset.checked : true,
                imageGen: dom.capImageGen ? dom.capImageGen.checked : true,
                webSearch: dom.capWebSearch ? dom.capWebSearch.checked : false,
                arxivSearch: dom.capArxivSearch ? dom.capArxivSearch.checked : false,
                funMode: dom.modeFunMode ? dom.modeFunMode.checked : false,
                heavyCot: dom.modeHeavyCot ? dom.modeHeavyCot.checked : false,
                thinkingMode: dom.capThinkingMode ? dom.capThinkingMode.value : 'none',
                gitCommit: dom.capGitCommit ? dom.capGitCommit.checked : false
            };
            vscode.postMessage({ command: 'updateDiscussionCapabilities', capabilities });
            if (dom.discussionToolsModal) dom.discussionToolsModal.classList.remove('visible');
        });
    }

    const handleScroll = () => { if (!isScrolledToBottom(dom.messagesDiv)) { dom.scrollToBottomBtn.style.display = 'flex'; } else { dom.scrollToBottomBtn.style.display = 'none'; } };
    if (dom.messagesDiv) dom.messagesDiv.addEventListener('scroll', handleScroll);
    if (dom.scrollToBottomBtn) dom.scrollToBottomBtn.addEventListener('click', () => { dom.messagesDiv.scrollTo({ top: dom.messagesDiv.scrollHeight, behavior: 'smooth' }); });
}
