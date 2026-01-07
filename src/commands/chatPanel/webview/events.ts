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

    // Note: Agent checkbox logic updated to read from menu structure or state
    if (dom.agentModeCheckbox.checked) {
        vscode.postMessage({ command: 'runAgent', objective: messageText, message: userMessage });
    } else {
        // Send Auto-Context state
        const autoContext = dom.autoContextCheckbox ? dom.autoContextCheckbox.checked : false;
        vscode.postMessage({ command: 'sendMessage', message: userMessage, autoContext: autoContext });
    }
    
    messageInput.value = '';
    messageInput.style.height = 'auto'; // Reset height
}

function closeMenu() {
    if(dom.moreActionsMenu) {
        dom.moreActionsMenu.classList.remove('visible');
        // Reset to main view
        dom.moreActionsMenu.querySelectorAll('.menu-view').forEach(v => v.classList.add('hidden'));
        const main = document.getElementById('menu-main');
        if(main) main.classList.remove('hidden');
    }
}

function updateBadges() {
    const container = dom.activeBadges;
    if (!container) return;
    container.innerHTML = '';

    // Model Badge (Always show)
    if (dom.modelSelector && dom.modelSelector.value) {
        const model = dom.modelSelector.value;
        container.innerHTML += `<span class="mode-badge model" title="Current Model">${model}</span>`;
    }

    // Agent Mode
    if (dom.agentModeCheckbox && dom.agentModeCheckbox.checked) {
        container.innerHTML += `<span class="mode-badge agent" title="Agent Mode Active">🤖 Agent</span>`;
    }

    // Auto Context
    if (dom.autoContextCheckbox && dom.autoContextCheckbox.checked) {
        container.innerHTML += `<span class="mode-badge autocontext" title="Auto Context Active">🧠 AutoCtx</span>`;
    }

    // Herd Mode
    if (dom.herdModeCheckbox && dom.herdModeCheckbox.checked) {
        container.innerHTML += `<span class="mode-badge herd" title="Herd Mode Active">🐂 Herd</span>`;
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
    
    if (dom.stopButton) dom.stopButton.addEventListener('click', () => vscode.postMessage({ command: 'stopGeneration' }));
    if (dom.attachButton) dom.attachButton.addEventListener('click', () => { closeMenu(); dom.fileInput.click(); });
    if (dom.importSkillsButton) dom.importSkillsButton.addEventListener('click', () => { closeMenu(); vscode.postMessage({ command: 'importSkills' }); });
    if (dom.copyFullPromptButton) dom.copyFullPromptButton.addEventListener('click', () => { closeMenu(); const draftMessage = dom.messageInput ? dom.messageInput.value : ""; vscode.postMessage({ command: 'copyFullPrompt', draftMessage: draftMessage }); });
    if (dom.copyContextButton) dom.copyContextButton.addEventListener('click', () => { const draftMessage = dom.messageInput ? dom.messageInput.value : ""; vscode.postMessage({ command: 'copyFullPrompt', draftMessage: draftMessage }); });
    if (dom.showDebugLogButton) dom.showDebugLogButton.addEventListener('click', () => { closeMenu(); vscode.postMessage({ command: 'requestLog' }); });
    if (dom.executeButton) dom.executeButton.addEventListener('click', () => { closeMenu(); vscode.postMessage({ command: 'executeProject' }); });
    if (dom.setEntryPointButton) dom.setEntryPointButton.addEventListener('click', () => { closeMenu(); vscode.postMessage({ command: 'setEntryPoint' }); });
    if (dom.debugRestartButton) dom.debugRestartButton.addEventListener('click', () => { closeMenu(); vscode.postMessage({ command: 'debugRestart' }); });
    
    // --- MODE TOGGLES (Menu Version) ---
    if (dom.agentModeCheckbox) dom.agentModeCheckbox.addEventListener('change', () => {
        vscode.postMessage({ command: 'toggleAgentMode' });
        // Disable auto-context if agent mode is on
        if(dom.autoContextCheckbox) dom.autoContextCheckbox.disabled = dom.agentModeCheckbox.checked;
        updateBadges();
    });

    if (dom.autoContextCheckbox) dom.autoContextCheckbox.addEventListener('change', () => {
        updateBadges();
    });

    // Handle Herd Mode Checkbox in Menu
    if (dom.herdModeCheckbox) dom.herdModeCheckbox.addEventListener('change', () => {
        // We need to sync this with capabilities update
        // We trigger an update capabilities message with current UI state
        // Since we don't have all modal fields here, we might need a specific command or just rely on the modal logic.
        // However, user requested it in the menu.
        // The modal logic reads ALL fields. This simple toggle just needs to flip 'herdMode'.
        // But we need to preserve other capability fields.
        // A simpler way: just flip the UI state and badges, the actual execution checks capability.
        // But we need to PERSIST it.
        // Let's create a 'toggleHerdMode' command or generic 'updateCapability'
        
        // For simplicity, let's just trigger updateBadges() and assume the user configures details in Settings if needed.
        // But wait, it needs to actually TURN ON.
        // Let's reuse the modal saving logic but only for this field? No, that's complex.
        // Let's send a specific partial update message.
        vscode.postMessage({ command: 'updateDiscussionCapabilitiesPartial', partial: { herdMode: dom.herdModeCheckbox.checked } });
        updateBadges();
    });
    
    if (dom.modelSelector) dom.modelSelector.addEventListener('change', (event) => {
        vscode.postMessage({ command: 'updateDiscussionModel', model: (event.target as HTMLSelectElement).value });
        updateBadges();
    });
    
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
    
    // --- Submenu Navigation ---
    if (dom.subMenuTriggers) {
        dom.subMenuTriggers.forEach(trigger => {
            trigger.addEventListener('click', (e) => {
                e.stopPropagation();
                const targetId = (trigger as HTMLElement).dataset.target;
                if (targetId) {
                    const targetView = document.getElementById(targetId);
                    const mainView = document.getElementById('menu-main');
                    if (targetView && mainView) {
                        mainView.classList.add('hidden');
                        targetView.classList.remove('hidden');
                    }
                }
            });
        });
    }

    if (dom.backButtons) {
        dom.backButtons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const currentView = btn.closest('.menu-view');
                const mainView = document.getElementById('menu-main');
                if (currentView && mainView) {
                    currentView.classList.add('hidden');
                    mainView.classList.remove('hidden');
                }
            });
        });
    }

    window.addEventListener('click', (event: MouseEvent) => {
        const target = event.target as Node;
        const isInsideMenu = dom.moreActionsMenu && dom.moreActionsMenu.contains(target);
        const isInsideButton = dom.moreActionsButton && dom.moreActionsButton.contains(target);
        if (!isInsideMenu && !isInsideButton) { 
            closeMenu();
        }
        if (dom.toolsModal && event.target === dom.toolsModal) dom.toolsModal.classList.remove('visible');
        if (dom.discussionToolsModal && event.target === dom.discussionToolsModal) dom.discussionToolsModal.classList.remove('visible');
    });
    
    if (dom.agentToolsButton) dom.agentToolsButton.addEventListener('click', () => { closeMenu(); vscode.postMessage({ command: 'requestAvailableTools' }); });
    if (dom.discussionToolsButton) dom.discussionToolsButton.addEventListener('click', () => { closeMenu(); if (dom.discussionToolsModal) dom.discussionToolsModal.classList.add('visible'); });
    if (dom.closeToolsModal) dom.closeToolsModal.addEventListener('click', () => { if (dom.toolsModal) dom.toolsModal.classList.remove('visible'); });
    if (dom.closeDiscussionToolsModal) dom.closeDiscussionToolsModal.addEventListener('click', () => { if (dom.discussionToolsModal) dom.discussionToolsModal.classList.remove('visible'); });
    if (dom.saveToolsBtn) dom.saveToolsBtn.addEventListener('click', () => { if (dom.toolsListDiv) { const enabledTools = Array.from(dom.toolsListDiv.querySelectorAll('input:checked')).map(cb => (cb as HTMLInputElement).value); vscode.postMessage({ command: 'updateEnabledTools', tools: enabledTools }); if (dom.toolsModal) dom.toolsModal.classList.remove('visible'); } });
    
    if (dom.refreshModelsBtn) dom.refreshModelsBtn.addEventListener('click', () => { const icon = dom.refreshModelsBtn.querySelector('.codicon'); if(icon) icon.classList.add('spin'); vscode.postMessage({ command: 'refreshModels' }); });
    if (dom.addUserMessageBtn) dom.addUserMessageBtn.addEventListener('click', () => insertNewMessageEditor('user'));
    if (dom.addAiMessageBtn) dom.addAiMessageBtn.addEventListener('click', () => insertNewMessageEditor('assistant'));
    
    // Herd Mode Config Visibility (In Modal)
    if (dom.capHerdMode) {
        dom.capHerdMode.addEventListener('change', () => {
            if (dom.herdConfigSection) {
                dom.herdConfigSection.style.display = dom.capHerdMode.checked ? 'block' : 'none';
            }
        });
    }

    // UPDATED: Save Discussion Tools Button Handler
    if (dom.saveDiscussionToolsBtn) {
        dom.saveDiscussionToolsBtn.addEventListener('click', () => {
            const codeGenType = document.querySelector('input[name="codeGenType"]:checked') as HTMLInputElement;
            
            // Collect Herd Models logic handled in modal (if applicable)
            // But we need to ensure the menu checkbox matches the modal checkbox if opened
            if (dom.herdModeCheckbox) dom.herdModeCheckbox.checked = dom.capHerdMode ? dom.capHerdMode.checked : false;
            updateBadges();

            const capabilities = {
                codeGenType: codeGenType ? codeGenType.value : 'full',
                allowedFormats: {
                    fullFile: dom.fmtFullFile ? dom.fmtFullFile.checked : true,
                    insert: dom.fmtInsert ? dom.fmtInsert.checked : false,
                    replace: dom.fmtReplace ? dom.fmtReplace.checked : false,
                    delete: dom.fmtDelete ? dom.fmtDelete.checked : false
                },
                fileRename: dom.capFileRename ? dom.capFileRename.checked : true,
                fileDelete: dom.capFileDelete ? dom.capFileDelete.checked : true,
                fileSelect: dom.capFileSelect ? dom.capFileSelect.checked : true,
                fileReset: dom.capFileReset ? dom.capFileReset.checked : true,
                imageGen: dom.capImageGen ? dom.capImageGen.checked : true,
                webSearch: dom.capWebSearch ? dom.capWebSearch.checked : false,
                arxivSearch: dom.capArxivSearch ? dom.capArxivSearch.checked : false,
                funMode: dom.modeFunMode ? dom.modeFunMode.checked : false,
                thinkingMode: dom.capThinkingMode ? dom.capThinkingMode.value : 'none',
                gitCommit: dom.capGitCommit ? dom.capGitCommit.checked : false,
                
                // Herd Mode
                herdMode: dom.capHerdMode ? dom.capHerdMode.checked : false,
                herdRounds: dom.capHerdRounds ? parseInt(dom.capHerdRounds.value) : 2,
                // herdModels handled in configView mostly, but if we need per-discussion override, add here
            };
            vscode.postMessage({ command: 'updateDiscussionCapabilities', capabilities });
            if (dom.discussionToolsModal) dom.discussionToolsModal.classList.remove('visible');
        });
    }

    const handleScroll = () => { if (!isScrolledToBottom(dom.messagesDiv)) { dom.scrollToBottomBtn.style.display = 'flex'; } else { dom.scrollToBottomBtn.style.display = 'none'; } };
    if (dom.messagesDiv) dom.messagesDiv.addEventListener('scroll', handleScroll);
    if (dom.scrollToBottomBtn) dom.scrollToBottomBtn.addEventListener('click', () => { dom.messagesDiv.scrollTo({ top: dom.messagesDiv.scrollHeight, behavior: 'smooth' }); });
}
