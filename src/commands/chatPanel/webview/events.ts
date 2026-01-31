import { dom, vscode, state } from './dom.js';
import { performSearch, navigateSearch, clearSearch } from './search.js';
import { insertNewMessageEditor } from './messageRenderer.js';
import { setGeneratingState, updateBadges } from './ui.js';
import { isScrolledToBottom } from './utils.js';

export function initEventHandlers() {
    // --- RESIZER LOGIC ---
    const resizer = dom.planResizer;
    const planZone = dom.agentPlanZone;
    const wrapper = dom.chatContentWrapper;

    if (resizer && planZone && wrapper) {
        let isResizing = false;

        resizer.addEventListener('mousedown', (e) => {
            isResizing = true;
            resizer.classList.add('resizing');
            document.body.style.cursor = 'col-resize';
            document.querySelectorAll('iframe, .messages').forEach(el => (el as HTMLElement).style.pointerEvents = 'none');
        });

        window.addEventListener('mousemove', (e) => {
            if (!isResizing) return;
            const containerWidth = wrapper.getBoundingClientRect().width;
            const newWidth = containerWidth - e.clientX;
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

    // --- MAIN INPUT & SEND ---
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

    // --- STOP BUTTON ---
    if (dom.stopButton) {
        dom.stopButton.addEventListener('click', () => {
            console.log("[WEBVIEW] Stop button clicked");
            vscode.postMessage({ command: 'stopGeneration' });
            // Optimistically update UI
            setGeneratingState(false);
        });
    }

    // --- MAIN MENU TOGGLE ---
    if (dom.moreActionsButton) dom.moreActionsButton.addEventListener('click', (e) => {
        e.stopPropagation();
        dom.moreActionsMenu.classList.toggle('visible');
    });

    // Close menus on outside click
    window.addEventListener('click', () => {
        if (dom.moreActionsMenu) dom.moreActionsMenu.classList.remove('visible');
        document.querySelectorAll('.custom-menu').forEach(el => el.classList.remove('visible'));
    });

    // Prevent closing when clicking inside the menu
    if (dom.moreActionsMenu) {
        dom.moreActionsMenu.addEventListener('click', (e) => {
            e.stopPropagation();
        });
    }

    // --- MAIN MENU NAVIGATION (Submenus) ---
    dom.subMenuTriggers.forEach(trigger => {
        trigger.addEventListener('click', (e) => {
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

    dom.backButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const currentView = btn.closest('.menu-view');
            const mainView = document.getElementById('menu-main');
            if (currentView && mainView) {
                currentView.classList.add('hidden');
                mainView.classList.remove('hidden');
            }
        });
    });

    // --- MENU ACTIONS ---
    const bindClick = (el: HTMLElement | null, command: string, params?: any) => {
        if (el) el.addEventListener('click', () => {
            vscode.postMessage({ command, ...params });
            dom.moreActionsMenu.classList.remove('visible');
        });
    };

    bindClick(dom.agentToolsButton, 'requestAvailableTools');
    if (dom.discussionToolsButton) {
        dom.discussionToolsButton.addEventListener('click', () => {
            if (dom.discussionToolsModal) dom.discussionToolsModal.classList.add('visible');
            dom.moreActionsMenu.classList.remove('visible');
        });
    }

    bindClick(dom.attachButton, 'requestAddFileToContext'); // Opens file dialog via extension
    bindClick(dom.importSkillsButton, 'importSkills');
    bindClick(dom.copyFullPromptButton, 'copyFullPrompt', { draftMessage: dom.messageInput ? dom.messageInput.value : '' });
    bindClick(dom.setEntryPointButton, 'setEntryPoint');
    bindClick(dom.executeButton, 'executeProject');
    bindClick(dom.debugRestartButton, 'debugRestart');
    bindClick(dom.showDebugLogButton, 'requestLog');

    // --- TOGGLES & INPUTS ---
    const bindChange = (el: HTMLInputElement | HTMLSelectElement | null, handler: (e: Event) => void) => {
        if (el) el.addEventListener('change', handler);
    };

    // Modes
    bindChange(dom.agentModeCheckbox, (e) => {
        vscode.postMessage({ command: 'toggleAgentMode' });
    });
    bindChange(dom.autoContextCheckbox, (e) => {
        vscode.postMessage({ command: 'toggleAutoContext', enabled: (e.target as HTMLInputElement).checked });
    });
    bindChange(dom.herdModeCheckbox, (e) => {
        vscode.postMessage({ command: 'updateDiscussionCapabilitiesPartial', partial: { herdMode: (e.target as HTMLInputElement).checked } });
    });

    // AI Config
    bindChange(dom.modelSelector, (e) => {
        const val = (e.target as HTMLSelectElement).value;
        vscode.postMessage({ command: 'updateDiscussionModel', model: val });
    });
    
    if (dom.refreshModelsBtn) {
        dom.refreshModelsBtn.addEventListener('click', () => {
            const icon = dom.refreshModelsBtn.querySelector('.codicon');
            if(icon) icon.classList.add('spin');
            vscode.postMessage({ command: 'refreshModels' });
        });
    }

    bindChange(dom.personalitySelector, (e) => {
        const val = (e.target as HTMLSelectElement).value;
        vscode.postMessage({ command: 'updateDiscussionPersonality', personalityId: val });
    });

    // --- MODALS ---
    
    // Tools Modal
    if (dom.closeToolsModal) dom.closeToolsModal.addEventListener('click', () => dom.toolsModal.classList.remove('visible'));
    if (dom.saveToolsBtn) dom.saveToolsBtn.addEventListener('click', () => {
        const selected = Array.from(dom.toolsListDiv.querySelectorAll('input:checked')).map((el: any) => el.value);
        vscode.postMessage({ command: 'updateEnabledTools', tools: selected });
        dom.toolsModal.classList.remove('visible');
    });

    // Discussion Tools Modal
    if (dom.closeDiscussionToolsModal) dom.closeDiscussionToolsModal.addEventListener('click', () => dom.discussionToolsModal.classList.remove('visible'));
    
    if (dom.saveDiscussionToolsBtn) {
        dom.saveDiscussionToolsBtn.addEventListener('click', () => {
            // Gather all capabilities
            const caps = {
                generationFormats: {
                    fullFile: dom.checkGenFull?.checked ?? true,
                    diff: dom.checkGenDiff?.checked ?? false,
                    aider: dom.checkGenAider?.checked ?? false
                },
                allowedFormats: {
                    fullFile: dom.fmtFullFile?.checked ?? true,
                    insert: dom.fmtInsert?.checked ?? false,
                    replace: dom.fmtReplace?.checked ?? false,
                    delete: dom.fmtDelete?.checked ?? false
                },
                explainCode: dom.checkBehaviorExplain?.checked ?? true,
                fileRename: dom.capFileRename?.checked ?? true,
                fileDelete: dom.capFileDelete?.checked ?? true,
                fileSelect: dom.capFileSelect?.checked ?? true,
                fileReset: dom.capFileReset?.checked ?? true,
                imageGen: dom.capImageGen?.checked ?? true,
                webSearch: dom.capWebSearch?.checked ?? false,
                arxivSearch: dom.capArxivSearch?.checked ?? false,
                gitWorkflow: dom.capGitWorkflow?.checked ?? false,
                funMode: dom.modeFunMode?.checked ?? false,
                thinkingMode: dom.capThinkingMode?.value ?? 'none',
                herdMode: dom.capHerdMode?.checked ?? false,
                herdRounds: parseInt(dom.capHerdRounds?.value || "2", 10)
            };
            
            vscode.postMessage({ command: 'updateDiscussionCapabilities', capabilities: caps });
            dom.discussionToolsModal.classList.remove('visible');
        });
    }

    // Git Staging/Commit Modals
    if (dom.stagingCloseBtn) dom.stagingCloseBtn.addEventListener('click', () => dom.stagingModal.classList.remove('visible'));
    if (dom.stagingNextBtn) dom.stagingNextBtn.addEventListener('click', () => {
        const checked = Array.from(dom.stagingList.querySelectorAll('input:checked')).map((el: any) => el.value);
        if (checked.length > 0) {
            vscode.postMessage({ command: 'stageAndGenerateMessage', files: checked });
            dom.stagingModal.classList.remove('visible');
        } else {
            vscode.postMessage({ command: 'showWarning', message: 'No files selected.' });
        }
    });

    if (dom.commitCancelBtn) dom.commitCancelBtn.addEventListener('click', () => dom.commitModal.classList.remove('visible'));
    if (dom.commitConfirmBtn) dom.commitConfirmBtn.addEventListener('click', () => {
        const msg = dom.commitMessageInput.value;
        if (msg) {
            vscode.postMessage({ command: 'performCommit', message: msg });
            dom.commitModal.classList.remove('visible');
        }
    });

    if (dom.historyCloseBtn) dom.historyCloseBtn.addEventListener('click', () => dom.historyModal.classList.remove('visible'));

    // --- SEARCH BAR ---
    if (dom.searchCloseBtn) dom.searchCloseBtn.addEventListener('click', () => {
        if(dom.searchBar) dom.searchBar.style.display = 'none';
        clearSearch();
    });
    if (dom.searchPrevBtn) dom.searchPrevBtn.addEventListener('click', () => navigateSearch(-1));
    if (dom.searchNextBtn) dom.searchNextBtn.addEventListener('click', () => navigateSearch(1));
    if (dom.searchInput) {
        dom.searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                if (e.shiftKey) navigateSearch(-1);
                else performSearch();
            } else if (e.key === 'Escape') {
                if(dom.searchBar) dom.searchBar.style.display = 'none';
                clearSearch();
            }
        });
    }
    
    // --- TOP BAR CONTROLS ---
    if (dom.refreshContextBtn) dom.refreshContextBtn.addEventListener('click', () => {
        vscode.postMessage({ command: 'calculateTokens' });
    });
    if (dom.cancelTokensBtn) dom.cancelTokensBtn.addEventListener('click', () => {
        vscode.postMessage({ command: 'stopTokenCalculation' });
    });

    // Keybindings (Ctrl+F)
    window.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
            if (dom.searchBar) {
                if (dom.searchBar.style.display === 'none' || !dom.searchBar.style.display) {
                    dom.searchBar.style.display = 'flex';
                    dom.searchInput.focus();
                    e.preventDefault();
                } else {
                    dom.searchInput.focus();
                    e.preventDefault();
                }
            }
        }
    });

    // Add File Input Change Listener (Hidden input for loading files)
    if (dom.fileInput) {
        dom.fileInput.addEventListener('change', async (e) => {
            const files = (e.target as HTMLInputElement).files;
            if (files && files.length > 0) {
                // We handle this via VS Code API for simplicity now, but if drag & drop is used:
                // ... logic to read file and send to extension ...
                // Currently attaching is done via 'requestAddFileToContext' or 'requestAddAttachment' commands
            }
        });
    }
}
