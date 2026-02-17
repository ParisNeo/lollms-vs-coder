import { dom, vscode, state } from './dom.js';
import { performSearch, navigateSearch, clearSearch } from './search.js';
import { insertNewMessageEditor } from './messageRenderer.js';
import { setGeneratingState, updateBadges } from './ui.js';
import { isScrolledToBottom } from './utils.js';

export function initEventHandlers() {
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
            const rect = wrapper.getBoundingClientRect();
            const newWidth = rect.right - e.clientX;
            if (newWidth > 150 && newWidth < rect.width * 0.85) {
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

    if (dom.sendButton) dom.sendButton.addEventListener('click', () => {
        const text = dom.messageInput.value.trim();
        if (text) {
            vscode.postMessage({ command: 'sendMessage', message: { role: 'user', content: text } });
            dom.messageInput.value = '';
            dom.messageInput.style.height = 'auto';
        }
    });

    const wrapText = (type: string) => {
        const input = dom.messageInput;
        const start = input.selectionStart;
        const end = input.selectionEnd;
        const text = input.value;
        const selected = text.substring(start, end);

        let before = "";
        let after = "";

        switch (type) {
            case 'python': before = "```python\n"; after = "\n```"; break;
            case 'code': before = "```\n"; after = "\n```"; break;
            case 'text': before = "```text\n"; after = "\n```"; break;
            case 'bold': before = "**"; after = "**"; break;
            case 'italic': before = "*"; after = "*"; break;
        }

        const newText = text.substring(0, start) + before + selected + after + text.substring(end);
        input.value = newText;
        
        // Restore focus and selection
        input.focus();
        const newCursorPos = start + before.length + selected.length + after.length;
        input.setSelectionRange(newCursorPos, newCursorPos);
        
        // Trigger resize
        input.dispatchEvent(new Event('input'));
    };

    document.querySelectorAll('.toolbar-tool').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const type = (btn as HTMLElement).dataset.wrapType;
            if (type) wrapText(type);
        });
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
        dom.messageInput.addEventListener('paste', (e: ClipboardEvent) => {
            const items = e.clipboardData?.items;
            if (!items) return;

            // 1. Handle Images
            for (const item of items) {
                if (item.type.indexOf('image') !== -1) {
                    const blob = item.getAsFile();
                    if (blob) {
                        const reader = new FileReader();
                        reader.onload = (event) => {
                            const base64 = event.target?.result as string;
                            vscode.postMessage({ command: 'loadFile', file: { name: `pasted_image_${Date.now()}.png`, content: base64, isImage: true } });
                        };
                        reader.readAsDataURL(blob);
                        e.preventDefault();
                        return;
                    }
                }
            }

            
        });
    }

    if (dom.stopButton) {
        dom.stopButton.addEventListener('click', () => {
            vscode.postMessage({ command: 'stopGeneration' });
            setGeneratingState(false);
        });
    }

    if (dom.moreActionsButton) dom.moreActionsButton.addEventListener('click', (e) => {
        e.stopPropagation();
        dom.moreActionsMenu.classList.toggle('visible');
    });

    window.addEventListener('click', () => {
        if (dom.moreActionsMenu) dom.moreActionsMenu.classList.remove('visible');
        document.querySelectorAll('.custom-menu').forEach(el => el.classList.remove('visible'));
    });

    if (dom.moreActionsMenu) {
        dom.moreActionsMenu.addEventListener('click', (e) => {
            e.stopPropagation();
        });
    }

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

    if (dom.searchButton) {
        dom.searchButton.addEventListener('click', () => {
            if (dom.searchBar) {
                dom.searchBar.style.display = 'flex';
                dom.searchInput.focus();
            }
            dom.moreActionsMenu.classList.remove('visible');
        });
    }

    bindClick(dom.attachButton, 'requestAddFileToContext'); 
    bindClick(dom.importSkillsButton, 'importSkills');
    
    if (dom.copyFullPromptButton) {
        dom.copyFullPromptButton.addEventListener('click', () => {
            const draft = dom.messageInput ? dom.messageInput.value : '';
            vscode.postMessage({ 
                command: 'copyFullPrompt', 
                draftMessage: draft 
            });
            dom.moreActionsMenu.classList.remove('visible');
        });
    }

    bindClick(dom.setEntryPointButton, 'setEntryPoint');
    bindClick(dom.executeButton, 'executeProject');
    bindClick(dom.debugRestartButton, 'debugRestart');
    bindClick(dom.showDebugLogButton, 'requestLog');

    if (dom.addUserMessageBtn) {
        dom.addUserMessageBtn.addEventListener('click', () => {
            insertNewMessageEditor('user');
        });
    }

    if (dom.addAiMessageBtn) {
        dom.addAiMessageBtn.addEventListener('click', () => {
            insertNewMessageEditor('assistant');
        });
    }

    const bindChange = (el: HTMLInputElement | HTMLSelectElement | null, handler: (e: Event) => void) => {
        if (el) el.addEventListener('change', handler);
    };

    bindChange(dom.agentModeCheckbox, (e) => {
        vscode.postMessage({ command: 'toggleAgentMode' });
    });
    bindChange(dom.autoContextCheckbox, (e) => {
        vscode.postMessage({ command: 'toggleAutoContext', enabled: (e.target as HTMLInputElement).checked });
    });
    bindChange(dom.herdModeCheckbox, (e) => {
        vscode.postMessage({ command: 'updateDiscussionCapabilitiesPartial', partial: { herdMode: (e.target as HTMLInputElement).checked } });
    });

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

    if (dom.closeToolsModal) dom.closeToolsModal.addEventListener('click', () => dom.toolsModal.classList.remove('visible'));
    if (dom.saveToolsBtn) dom.saveToolsBtn.addEventListener('click', () => {
        const selected = Array.from(dom.toolsListDiv.querySelectorAll('input:checked')).map((el: any) => el.value);
        vscode.postMessage({ command: 'updateEnabledTools', tools: selected });
        dom.toolsModal.classList.remove('visible');
    });

    if (dom.closeDiscussionToolsModal) dom.closeDiscussionToolsModal.addEventListener('click', () => dom.discussionToolsModal.classList.remove('visible'));
    
    if (dom.saveDiscussionToolsBtn) {
        dom.saveDiscussionToolsBtn.addEventListener('click', () => {
            const partialFormat = (document.querySelector('input[name="cap-partialFormat"]:checked') as HTMLInputElement)?.value || 'aider';
            
            const caps = {
                generationFormats: {
                    fullFile: dom.capAllowFullFallback?.checked ?? true,
                    partialFormat: partialFormat
                },
                forceFullCode: dom.capForceFullCode?.checked ?? false,
                allowedFormats: {
                    fullFile: dom.fmtFullFile?.checked ?? true,
                    insert: dom.fmtInsert?.checked ?? true,
                    replace: dom.fmtReplace?.checked ?? true,
                    delete: dom.fmtDelete?.checked ?? true
                },
                responseProfileId: state.capabilities?.responseProfileId || 'balanced', 
                explainCode: dom.capExplainCode?.checked ?? true,
                addPedagogicalInstruction: dom.capAddPedagogicalInstruction?.checked ?? false,
                forceFullCodePath: dom.capForceFullCodePath?.checked ?? false,
                fileRename: dom.capFileRename?.checked ?? true,
                fileDelete: dom.capFileDelete?.checked ?? true,
                fileSelect: dom.capFileSelect?.checked ?? true,
                fileReset: dom.capFileReset?.checked ?? true,
                imageGen: dom.capImageGen?.checked ?? true,
                webSearch: dom.capWebSearch?.checked ?? false,
                searchSources: {
                    google: (document.getElementById('src-google') as HTMLInputElement)?.checked ?? true,
                    arxiv: (document.getElementById('src-arxiv') as HTMLInputElement)?.checked ?? true,
                    wikipedia: (document.getElementById('src-wikipedia') as HTMLInputElement)?.checked ?? true,
                    stackoverflow: (document.getElementById('src-stackoverflow') as HTMLInputElement)?.checked ?? true,
                    youtube: (document.getElementById('src-youtube') as HTMLInputElement)?.checked ?? true,
                    github: (document.getElementById('src-github') as HTMLInputElement)?.checked ?? false
                },
                gitWorkflow: dom.capGitWorkflow?.checked ?? false,
                herdMode: dom.capHerdMode?.checked ?? false,
                herdRounds: parseInt(dom.capHerdRounds?.value || "2", 10)
            };
            vscode.postMessage({ command: 'updateDiscussionCapabilities', capabilities: caps });
            dom.discussionToolsModal.classList.remove('visible');
        });
    }

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

    // --- Skills Modal Events ---
    if (dom.skillsCloseBtn) {
        dom.skillsCloseBtn.addEventListener('click', () => {
            dom.skillsModal.classList.remove('visible');
        });
    }

    if (dom.skillsImportBtn) {
        dom.skillsImportBtn.addEventListener('click', () => {
            const selectedSkills = Array.from(dom.skillsTreeContainer.querySelectorAll('.skill-checkbox:checked')).map((el: any) => el.value);
            vscode.postMessage({ command: 'importSelectedSkills', skillIds: selectedSkills });
            dom.skillsModal.classList.remove('visible');
        });
    }

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
    
    if (dom.refreshContextBtn) dom.refreshContextBtn.addEventListener('click', () => {
        vscode.postMessage({ command: 'calculateTokens' });
    });
    if (dom.cancelTokensBtn) dom.cancelTokensBtn.addEventListener('click', () => {
        vscode.postMessage({ command: 'stopTokenCalculation' });
    });

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
        
    if (dom.fileInput) {
        dom.fileInput.addEventListener('change', async (e) => {
            const files = (e.target as HTMLInputElement).files;
            if (files && files.length > 0) {
            }
        });
    }

    // Handle Skill Save buttons via delegation
    if (dom.messagesDiv) {
        dom.messagesDiv.addEventListener('click', (e) => {
            const btn = (e.target as HTMLElement).closest('.save-skill-btn') as HTMLButtonElement;
            if (btn) {
                const content = btn.dataset.content || '';
                const scope = btn.dataset.scope as 'global' | 'local';
                const title = btn.dataset.title || '';
                const desc = btn.dataset.description || '';
                const cat = btn.dataset.category || '';
                
                // Call the globally defined handler in main.ts
                if (typeof (window as any).saveSkill === 'function') {
                    (window as any).saveSkill(content, scope, title, desc, cat);
                    
                    // Provide immediate visual feedback
                    const originalHtml = btn.innerHTML;
                    btn.disabled = true;
                    btn.classList.add('success');
                    btn.innerHTML = '<span class="codicon codicon-check"></span> Saved';
                    
                    setTimeout(() => {
                        btn.innerHTML = originalHtml;
                        btn.classList.remove('success');
                        btn.disabled = false;
                    }, 2000);
                }
            }
        });
    }
}
