import { dom, vscode, state } from './dom.js';
import { performSearch, navigateSearch, clearSearch } from './search.js';
import { insertNewMessageEditor } from './messageRenderer.js';
import { setGeneratingState, updateBadges, openImageEditor, renderPendingImages, renderWorkspaceMatrix } from './ui.js';
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
        // Handle Space key for Panning mode
    window.addEventListener('keydown', (e) => {
        if (e.code === 'Space') (window as any).isSpaceDown = true;
    });
    window.addEventListener('keyup', (e) => {
        if (e.code === 'Space') (window as any).isSpaceDown = false;
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
        if (text || state.pendingImages.length > 0) {
            let content: any = text;
            
            // If we have images, wrap in multipart format
            if (state.pendingImages.length > 0) {
                const parts: any[] = [];
                if (text) parts.push({ type: 'text', text: text });
                state.pendingImages.forEach(img => {
                    parts.push({ type: 'image_url', image_url: { url: img.data } });
                });
                content = parts;
            }

            vscode.postMessage({ 
                command: 'sendMessage', 
                message: { role: 'user', content: content } 
            });
            
            // Reset
            dom.messageInput.value = '';
            dom.messageInput.style.height = 'auto';
            state.pendingImages = [];
            renderPendingImages();
        }
    });

    const wrapText = (type: string, target?: HTMLTextAreaElement | any) => {
        // 1. Detect if target is CodeMirror (EditorView) or standard Textarea
        const isCodeMirror = target && target.state && target.dispatch;
        const input = target || dom.messageInput;
        if (!input) return;

        let start: number, end: number, text: string, selected: string;

        if (isCodeMirror) {
            const sel = input.state.selection.main;
            start = sel.from;
            end = sel.to;
            selected = input.state.sliceDoc(start, end);
        } else {
            start = input.selectionStart;
            end = input.selectionEnd;
            text = input.value;
            selected = text.substring(start, end);
        }

        let before = "";
        let after = "";
        let replacement = selected;

        switch (type) {
            case 'python': before = "```python\n"; after = "\n```"; break;
            case 'code': before = "```\n"; after = "\n```"; break;
            case 'text': before = "```text\n"; after = "\n```"; break;
            case 'bold': before = "**"; after = "**"; break;
            case 'italic': before = "*"; after = "*"; break;
            case 'h1': before = "# "; break;
            case 'h2': before = "## "; break;
            case 'h3': before = "### "; break;
            case 'aider-search': before = "<<<<<<< SEARCH\n"; break;
            case 'aider-sep': before = "\n=======\n"; break;
            case 'aider-replace': before = "\n>>>>>>> REPLACE\n"; break;
            case 'list': 
                before = "- "; 
                replacement = selected.split('\n').join('\n- ');
                break;
        }

        if (isCodeMirror) {
            input.dispatch({
                changes: { from: start, to: end, insert: before + replacement + after },
                selection: { anchor: start + before.length + replacement.length + after.length },
                scrollIntoView: true
            });
            input.focus();
        } else {
            const newText = input.value.substring(0, start) + before + replacement + after + input.value.substring(end);
            input.value = newText;
            input.focus();
            const newCursorPos = start + before.length + replacement.length + after.length;
            input.setSelectionRange(newCursorPos, newCursorPos);
            input.dispatchEvent(new Event('input'));
        }
    };

    // Expose globally so messageRenderer can use it
    (window as any).wrapText = wrapText;

    document.querySelectorAll('.toolbar-tool').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const btnEl = btn as HTMLElement;
            if (btnEl.id === 'jump-to-context-btn') {
                const container = document.getElementById('chat-messages-container');
                const dashboard = document.getElementById('fused-context-dashboard');
                if (dashboard && container) {
                    // Smoothly scroll the chat container to the top
                    container.parentElement?.scrollTo({ top: 0, behavior: 'smooth' });

                    // Visual feedback
                    dashboard.style.transition = "outline 0.3s ease";
                    dashboard.style.outline = "2px solid var(--vscode-focusBorder)";
                    setTimeout(() => dashboard.style.outline = "none", 800);
                }
                return;
            }
            const type = btnEl.dataset.wrapType;
            if (type) wrapText(type);
        });
    });

    // --- GLOBAL DRAG & DROP HANDLERS ---
    const chatContainer = document.querySelector('.chat-container') as HTMLElement;
    const inputArea = dom.inputArea;
    
    if (chatContainer) {
        // We use { capture: true } and stopImmediatePropagation to prevent VS Code 
        // workbench from intercepting the file drop and opening it in a new tab.
        ['dragenter', 'dragover'].forEach(eventName => {
            window.addEventListener(eventName, (e) => {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                inputArea.classList.add('drag-over');
            }, { capture: true, passive: false });
        });

        ['dragleave'].forEach(eventName => {
            window.addEventListener(eventName, (e) => {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                // Only remove if we actually leave the window
                if ((e as MouseEvent).relatedTarget === null) {
                    inputArea.classList.remove('drag-over');
                }
            }, { capture: true, passive: false });
        });

        window.addEventListener('drop', (e: DragEvent) => {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            inputArea.classList.remove('drag-over');
            handleFileImport(e.dataTransfer?.files || null);
        }, false);
    }

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
            for (const item of Array.from(items)) {
                if (item.type.indexOf('image') !== -1) {
                    const blob = item.getAsFile();
                    if (blob) {
                        const reader = new FileReader();
                        reader.onload = (event) => {
                            const base64 = event.target?.result as string;
                            state.pendingImages.push({ 
                                name: `pasted_${Date.now()}.png`, 
                                data: base64 
                            });
                            renderPendingImages();
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
            // If we are waiting for an input (like the Safety Gate), resolve it with a stop signal
            if ((window as any).inputResolver) {
                vscode.postMessage({
                    command: 'sendMessage',
                    message: { role: 'user', content: 'STOP_REQUESTED', isSilentSignal: true }
                });
            }

            // Force reset generating state UI-side if it's hanging
            if (state.isGenerating) {
                setGeneratingState(false);
            }            
            // Stop any ongoing speech synthesis
            if (window.speechSynthesis) {
                window.speechSynthesis.cancel();
            }
            // Trigger the global cleanup logic defined in main.ts if it was manual speech
            if (typeof (window as any).resetActiveSpeakButton === 'function') {
                (window as any).resetActiveSpeakButton();
            }
            
            vscode.postMessage({ command: 'stopGeneration' });
            setGeneratingState(false);
        });
    }

    const raiseHandBtn = document.getElementById('raiseHandButton');
    if (raiseHandBtn) {
        raiseHandBtn.addEventListener('click', () => {
            vscode.postMessage({ command: 'stopGeneration', isInterruption: true });
            // We don't call setGeneratingState(false) immediately to keep the 
            // overlay slightly visible or transition to an "Awaiting Feedback" state
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

    if (dom.agentToolsButton) {
        dom.agentToolsButton.addEventListener('click', () => {
            vscode.postMessage({ command: 'requestAgentSettings' });
            dom.moreActionsMenu.classList.remove('visible');
        });
    }
    // Removed old attachButton bindClick as it's now handled with processing state
    if (dom.discussionToolsButton) {
        dom.discussionToolsButton.addEventListener('click', () => {
            if (dom.discussionToolsModal) {
                dom.discussionToolsModal.classList.add('visible');
                // Ensure voices are fresh when entering settings
                if (typeof (window as any).refreshVoiceList === 'function') {
                    (window as any).refreshVoiceList();
                }
            }
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

    // This handler is now the single source of truth for both the + File button
    // and the Drag & Drop functionality.
    const handleFileImport = (files: FileList | null) => {
        if (!files || files.length === 0) return;
        
        setGeneratingState(true, "Importing data...");
        
        for (const file of Array.from(files)) {
            const reader = new FileReader();
            const isImage = file.type.startsWith('image/');
            
            reader.onload = (event) => {
                const content = event.target?.result as string;
                if (isImage) {
                    state.pendingImages.push({ name: file.name, data: content });
                    renderPendingImages();
                    setGeneratingState(false);
                } else {
                    // This message triggers _handleFileAttachment in the extension
                    // which creates the "Imported Data" bubble in the chat.
                    vscode.postMessage({
                        command: 'loadFile',
                        file: { name: file.name, content: content, isImage: false }
                    });
                }
            };
            reader.readAsDataURL(file);
        }
    };

    // Listen for file selection from the hidden input (triggered by + File button)
    if (dom.fileInput) {
        dom.fileInput.addEventListener('change', () => {
            handleFileImport(dom.fileInput.files);
            // Reset the input so the same file can be re-imported if needed
            dom.fileInput.value = '';
        });
    }

    // Redirection: The + File button now triggers the browser file picker
    // instead of the VS Code system picker to ensure it follows the "Imported Data" logic.
    if (dom.attachButton) {
        dom.attachButton.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            dom.fileInput.click();
        });
    }

    // Web Discovery Modal
    if (dom.webContextBtn) {
        dom.webContextBtn.addEventListener('click', () => {
            dom.webModal.classList.add('visible');
        });
    }

    if (dom.webModalCloseBtn) {
        dom.webModalCloseBtn.addEventListener('click', () => {
            dom.webModal.classList.remove('visible');
        });
    }

    dom.webTabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const target = (btn as HTMLElement).dataset.tab;
            dom.webTabBtns.forEach(b => b.classList.remove('active'));
            dom.webTabContents.forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById(target!)?.classList.add('active');
        });
    });

    dom.webSubmitBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const action = (btn as HTMLElement).dataset.action;
            const container = (btn as HTMLElement).closest('.web-tab-content');
            let params: any = {};

            if (action === 'scrape' || action === 'youtube') {
                // Direct actions still close the modal
                if (action === 'scrape') {
                    params = {
                        url: (document.getElementById('web-url-input') as HTMLInputElement).value,
                        depth: parseInt((document.getElementById('web-url-depth') as HTMLInputElement).value, 10)
                    };
                } else {
                    params = {
                        url: (document.getElementById('web-yt-url') as HTMLInputElement).value,
                        language: (document.getElementById('web-yt-lang') as HTMLInputElement).value
                    };
                }
                vscode.postMessage({ command: 'requestWebAction', action, params });
                dom.webModal.classList.remove('visible');
            } else {
                // Search actions display results in the tab instead of closing
                const input = container?.querySelector('input[type="text"]') as HTMLInputElement;
                if (!input || !input.value.trim()) {
                    vscode.postMessage({ command: 'showError', message: 'Please enter a search query.' });
                    return;
                }

                let limit = 5;
                if (action === 'arxiv') {
                    const limitInp = document.getElementById('web-arxiv-limit') as HTMLInputElement;
                    limit = parseInt(limitInp.value, 10) || 5;
                }

                const button = btn as HTMLButtonElement;
                button.innerHTML = '<div class="spinner"></div>';
                button.style.width = '80px'; // Maintain layout
                button.disabled = true;
                vscode.postMessage({ command: 'requestWebAction', action, params: { query: input.value, limit: limit } });
            }
        });
    });

    if (dom.fileSearchInput) {
        let searchTimeout: any;
        const triggerSearch = () => {
            const query = dom.fileSearchInput.value.trim();
            const modeEl = document.getElementById('file-search-mode') as HTMLSelectElement;
            const mode = modeEl ? modeEl.value : 'content';
            const matchCase = (document.getElementById('file-search-case') as HTMLInputElement)?.checked || false;
            const wholeWord = (document.getElementById('file-search-word') as HTMLInputElement)?.checked || false;
            const fuzzy = (document.getElementById('file-search-fuzzy') as HTMLInputElement)?.checked || false;
            const include = (document.getElementById('file-search-include') as HTMLInputElement)?.value.trim() || "";
            const exclude = (document.getElementById('file-search-exclude') as HTMLInputElement)?.value.trim() || "";

            if (!query) {
                if (dom.fileSearchResults) {
                    dom.fileSearchResults.innerHTML = '<div style="opacity:0.6; text-align:center; padding: 20px;">Type to start searching...</div>';
                }
                return;
            }

            if (dom.fileSearchResults) {
                dom.fileSearchResults.innerHTML = `
                    <div style="text-align:center; padding: 30px; opacity: 0.8;">
                        <div class="spinner" style="width: 24px; height: 24px; border-width: 3px; margin-bottom: 10px;"></div>
                        <div style="font-size: 11px;">Searching ${mode === 'content' ? 'code content' : 'filenames'}...</div>
                    </div>
                `;
            }
            vscode.postMessage({ 
                command: 'requestFileSearch', 
                query, 
                mode,
                options: { matchCase, wholeWord, fuzzy, include, exclude }
            });
        };

        dom.fileSearchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                clearTimeout(searchTimeout);
                triggerSearch();
            }
        });

        // Trigger search when typing
        dom.fileSearchInput.addEventListener('input', () => {
            clearTimeout(searchTimeout);
            const query = dom.fileSearchInput.value.trim();
            const modeEl = document.getElementById('file-search-mode') as HTMLSelectElement;
            const mode = modeEl ? modeEl.value : 'content';
            
            if (!query) {
                triggerSearch(); // This will clear the results
                return;
            }

            // Real-time search for filenames (faster)
            if (mode === 'path' && query.length >= 2) {
                searchTimeout = setTimeout(triggerSearch, 300);
            }
        });

        // REFRESH when the switches or the mode dropdown are changed
        const searchOptions = [
            'file-search-case', 
            'file-search-word', 
            'file-search-fuzzy',
            'file-search-mode'
        ];
        
        searchOptions.forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('change', () => {
                    clearTimeout(searchTimeout);
                    triggerSearch();
                });
            }
        });
    }

    if (dom.fileSearchAddBtn) {
        dom.fileSearchAddBtn.addEventListener('click', () => {
            const toAdd: string[] = [];
            const toRemove: string[] = [];
            
            const rows = dom.fileSearchResults.querySelectorAll('.file-search-item');
            rows.forEach((row: any) => {
                const cb = row.querySelector('.file-search-check') as HTMLInputElement;
                const path = row.dataset.path;
                const wasIncluded = row.dataset.wasIncluded === 'true';

                if (cb.checked && !wasIncluded) {
                    toAdd.push(path);
                } else if (!cb.checked && wasIncluded) {
                    toRemove.push(path);
                }
            });

            if (toAdd.length > 0 || toRemove.length > 0) {
                vscode.postMessage({ 
                    command: 'syncFilesContext', 
                    add: toAdd, 
                    remove: toRemove 
                });
                dom.fileSearchModal.classList.remove('visible');
            }
        });
    }

    if (dom.fileSearchCloseBtn) dom.fileSearchCloseBtn.addEventListener('click', () => dom.fileSearchModal.classList.remove('visible'));

    if (dom.fileSearchSelectAll) {
        dom.fileSearchSelectAll.addEventListener('change', () => {
            const checked = dom.fileSearchSelectAll.checked;
            dom.fileSearchResults.querySelectorAll('input[type="checkbox"]').forEach((i: any) => i.checked = checked);
        });
    }

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

    if (dom.copySystemPromptButton) {
        dom.copySystemPromptButton.addEventListener('click', () => {
            vscode.postMessage({ command: 'copySystemPrompt' });
            dom.moreActionsMenu.classList.remove('visible');
        });
    }

    if (dom.copyTreeAndContentButton) {
        dom.copyTreeAndContentButton.addEventListener('click', () => {
            vscode.postMessage({ command: 'copyTreeAndContent' });
            dom.moreActionsMenu.classList.remove('visible');
        });
    }

    bindClick(dom.setEntryPointButton, 'setEntryPoint');
    bindClick(dom.executeButton, 'executeProject');
    bindClick(dom.debugRestartButton, 'debugRestart');
    if (dom.showDebugLogButton) dom.showDebugLogButton.addEventListener('click', () => {
        vscode.postMessage({ command: 'requestLog' });
        dom.moreActionsMenu.classList.remove('visible');
    });

    if (dom.addDrawingButton) {
        dom.addDrawingButton.addEventListener('click', () => {
            openImageEditor();
        });
    }

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
    bindChange(dom.testModeCheckbox, (e) => {
        vscode.postMessage({ command: 'updateDiscussionCapabilitiesPartial', partial: { testMode: (e.target as HTMLInputElement).checked } });
    });
    bindChange(dom.docsModeCheckbox, (e) => {
        vscode.postMessage({ command: 'updateDiscussionCapabilitiesPartial', partial: { documentationMode: (e.target as HTMLInputElement).checked } });
    });

    bindChange(dom.modelSelector, (e) => {
        const val = (e.target as HTMLSelectElement).value;
        vscode.postMessage({ command: 'updateDiscussionModel', model: val });
        // Force context header update to show the new model name
        if (state.lastContextData) {
            const { context, files, skills, diagrams, briefing } = state.lastContextData;
            // Use dynamic import to avoid 'require is not defined' in ESM webview
            import('./messageRenderer.js').then(module => {
                module.updateContext(context, files, skills, diagrams, briefing);
            });
        }
    });
    
    if (dom.refreshModelsBtn) {
        dom.refreshModelsBtn.addEventListener('click', () => {
            const iconEl = dom.refreshModelsBtn.querySelector('.codicon');
            if(iconEl) iconEl.classList.add('spin');
            vscode.postMessage({ command: 'refreshModels' });
        });
    }

    bindChange(dom.personalitySelector, (e) => {
        const val = (e.target as HTMLSelectElement).value;
        vscode.postMessage({ command: 'updateDiscussionPersonality', personalityId: val });
    });

    if (dom.closeToolsModal) dom.closeToolsModal.addEventListener('click', () => dom.toolsModal.classList.remove('visible'));
    if (dom.saveToolsBtn) dom.saveToolsBtn.addEventListener('click', () => {
        const policies: Record<string, string> = {};
        dom.toolsListDiv.querySelectorAll('.tool-policy-select').forEach((el: any) => {
            policies[el.dataset.tool] = el.value;
        });

        const maxSteps = parseInt((document.getElementById('setting-maxSteps') as HTMLInputElement).value, 10);
        const maxEditRetries = parseInt((document.getElementById('setting-maxEditRetries') as HTMLInputElement).value, 10);
        const autoProfileSwitch = (document.getElementById('setting-autoProfileSwitch') as HTMLInputElement).checked;
        const activeProfile = (document.getElementById('setting-activeProfile') as HTMLSelectElement).value;

        // 1. Update internal capability state
        if (state.capabilities) {
            state.capabilities.toolPolicies = policies;
            state.capabilities.maxSteps = maxSteps;
            state.capabilities.maxEditRetries = maxEditRetries;
            state.capabilities.activeAgentProfileId = activeProfile;
        }

        // 2. Notify extension
        vscode.postMessage({ 
            command: 'updateDiscussionCapabilitiesPartial', 
            partial: { 
                toolPolicies: policies,
                maxSteps,
                maxEditRetries,
                autoProfileSwitch,
                activeAgentProfileId: activeProfile
            } 
        });

        dom.agentSettingsModal.classList.remove('visible');
    });

    if (dom.closeDiscussionToolsModal) dom.closeDiscussionToolsModal.addEventListener('click', () => {
        dom.discussionToolsModal.classList.remove('visible');
        // Clean up profile editor state if it was open
        const editor = document.getElementById('modal-profile-editor');
        const container = document.getElementById('modal-profiles-container');
        if (editor && container) {
            editor.style.display = 'none';
            container.style.display = 'flex';
        }
    });

    // Register the shared handler on all relevant containers
    if (dom.messagesDiv) dom.messagesDiv.addEventListener('click', handleGlobalClick);
    if (dom.agentPlanZone) dom.agentPlanZone.addEventListener('click', handleGlobalClick);
    if (dom.inputAreaWrapper) dom.inputAreaWrapper.addEventListener('click', handleGlobalClick);

    // --- Discussion Settings (Profiles) Event Listeners ---
    document.getElementById('modal-add-profile-btn')?.addEventListener('click', () => {
        (document.getElementById('modal-profile-editor') as HTMLElement).style.display = 'block';
        (document.getElementById('modal-profiles-container') as HTMLElement).style.display = 'none';
        
        // Reset fields for a new profile
        const nameInp = document.getElementById('modal-p-name') as HTMLInputElement;
        const descInp = document.getElementById('modal-p-desc') as HTMLInputElement;
        const prefInp = document.getElementById('modal-p-prefix') as HTMLInputElement;
        const promInp = document.getElementById('modal-p-prompt') as HTMLTextAreaElement;
        
        if (nameInp) nameInp.value = '';
        if (descInp) descInp.value = '';
        if (prefInp) prefInp.value = '';
        if (promInp) promInp.value = '';
        
        (window as any).currentEditingProfileIdx = -1; 
    });

    document.getElementById('modal-p-cancel')?.addEventListener('click', () => {
        if (typeof (window as any).closeProfileEditor === 'function') {
            (window as any).closeProfileEditor();
        }
    });

    document.getElementById('modal-p-save')?.addEventListener('click', () => {
        if (typeof (window as any).saveProfileFromModal === 'function') {
            (window as any).saveProfileFromModal();
        }
    });

    const addProfileBtn = document.getElementById('modal-add-profile-btn');
    if (addProfileBtn) {
        addProfileBtn.addEventListener('click', () => {
            // Defined in ui.ts via global exposure for simplicity in this port
            (document.getElementById('modal-profile-editor') as any).style.display = 'block';
            (document.getElementById('modal-profiles-container') as any).style.display = 'none';
        });
    }

    const cancelPEBtn = document.getElementById('modal-p-cancel');
    if (cancelPEBtn) {
        cancelPEBtn.addEventListener('click', () => {
            if (typeof (window as any).closeProfileEditor === 'function') (window as any).closeProfileEditor();
        });
    }

    const savePEBtn = document.getElementById('modal-p-save');
    if (savePEBtn) {
        savePEBtn.addEventListener('click', () => {
            if (typeof (window as any).saveProfileFromModal === 'function') (window as any).saveProfileFromModal();
        });
    }
    
    // Live update of temperature label
    const tempRange = document.getElementById('modal-temperature') as HTMLInputElement;
    const tempLabel = document.getElementById('modal-temperature-val');
    if (tempRange && tempLabel) {
        tempRange.oninput = () => { tempLabel.textContent = tempRange.value; };
    }

    if (dom.saveDiscussionToolsBtn) {
        dom.saveDiscussionToolsBtn.addEventListener('click', () => {
            const partialFormat = (document.querySelector('input[name="cap-partialFormat"]:checked') as HTMLInputElement)?.value || 'aider';
            const selectedProfileId = (document.getElementById('modal-default-profile-select') as HTMLSelectElement)?.value;

            // CRITICAL: Sync current list of profiles and the chosen default back to Global Settings
            vscode.postMessage({ 
                command: 'updateProfiles', 
                profiles: state.profiles, 
                defaultId: selectedProfileId 
            });

            const caps = {
                generationFormats: {
                    fullFile: dom.capAllowFullFallback?.checked ?? true,
                    partialFormat: partialFormat
                },
                responseProfileId: selectedProfileId,
                language: (document.getElementById('modal-language') as HTMLSelectElement)?.value || 'auto',
                voice: (document.getElementById('modal-voice') as HTMLSelectElement)?.value || 'default',
                temperature: parseFloat((document.getElementById('modal-temperature') as HTMLInputElement)?.value || '0.7'),
                ttftTimeout: parseInt((document.getElementById('modal-ttft-timeout') as HTMLInputElement)?.value || '0', 10),
                interTokenTimeout: parseInt((document.getElementById('modal-inter-token-timeout') as HTMLInputElement)?.value || '0', 10),
                contextAggression: dom.contextAggressionSelect?.value || 'respect',
                forceFullCode: dom.capForceFullCode?.checked ?? false,
                allowedFormats: {
                    fullFile: dom.fmtFullFile?.checked ?? true,
                    insert: dom.fmtInsert?.checked ?? true,
                    replace: dom.fmtReplace?.checked ?? true,
                    delete: dom.fmtDelete?.checked ?? true
                },
                explainCode: dom.capExplainCode?.checked ?? true,
                projectMemoryEnabled: dom.capProjectMemory?.checked ?? true,
                tokenEconomyMode: (document.getElementById('cap-tokenEconomyMode') as HTMLInputElement)?.checked ?? false,
                clipboardInsertRole: dom.capClipboardRole?.value || 'user',
                autoFix: dom.capAutoFix?.checked ?? true,
                addPedagogicalInstruction: dom.capAddPedagogicalInstruction?.checked ?? false,
                forceFullCodePath: dom.capForceFullCodePath?.checked ?? false,
                fileRename: dom.capFileRename?.checked ?? true,
                fileDelete: dom.capFileDelete?.checked ?? true,
                fileSelect: dom.capFileSelect?.checked ?? true,
                fileReset: dom.capFileReset?.checked ?? true,
                imageGen: dom.capImageGen?.checked ?? true,
                enableImages: dom.capEnableImages?.checked ?? true,
                useImageModeForDocs: dom.capUseImageModeForDocs?.checked ?? false,
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
                enableTTS: (document.getElementById('cap-enableTTS') as HTMLInputElement)?.checked ?? true,
                enableSTT: (document.getElementById('cap-enableSTT') as HTMLInputElement)?.checked ?? true,
                herdMode: dom.capHerdMode?.checked ?? false,
                herdParallelGeneration: dom.capHerdParallelGeneration?.checked ?? false,
                herdOrchestratorModel: dom.capHerdOrchestrator?.value || undefined,
                herdParticipantModels: Array.from(dom.capHerdParticipants?.querySelectorAll('input:checked') || []).map((el: any) => el.value),
                herdCriticEnabled: dom.capHerdCritic?.checked ?? false
            };
            vscode.postMessage({ command: 'updateDiscussionCapabilities', capabilities: caps });
            dom.discussionToolsModal.classList.remove('visible');
        });
    }

    if (dom.stagingCloseBtn) dom.stagingCloseBtn.addEventListener('click', () => dom.stagingModal.classList.remove('visible'));
    if (dom.stagingNextBtn) dom.stagingNextBtn.addEventListener('click', () => {
        const checked = Array.from(dom.stagingList.querySelectorAll('input:checked')).map((el: any) => el.value);
        if (checked.length > 0) {
            // Disable button and show loading state
            dom.stagingNextBtn.disabled = true;
            const originalText = dom.stagingNextBtn.innerHTML;
            dom.stagingNextBtn.dataset.originalText = originalText;
            // Use the CSS spinner class defined in your chatPanel.css
            dom.stagingNextBtn.innerHTML = '<div class="spinner"></div> Generating...';

            vscode.postMessage({ command: 'stageAndGenerateMessage', files: checked });
            
            // Note: We don't remove 'visible' here anymore because we want to see the 
            // result before switching to the commit message modal. 
            // The extension will trigger the next modal.
        } else {
            vscode.postMessage({ command: 'showError', message: 'No files selected.' });
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
            if (dom.skillsSearchInput) dom.skillsSearchInput.value = '';
        });
    }

    if (dom.skillsSearchInput) {
        dom.skillsSearchInput.addEventListener('input', (e) => {
            const query = (e.target as HTMLInputElement).value;
            if (typeof (window as any).filterSkillsTree === 'function') {
                (window as any).filterSkillsTree(query);
            }
        });
    }

    if (dom.skillsImportBtn) {
        dom.skillsImportBtn.addEventListener('click', () => {
            const discussionSkills = Array.from(dom.skillsTreeContainer.querySelectorAll('.skill-discussion-checkbox:checked'))
                .map((el: any) => el.value);
            const projectSkills = Array.from(dom.skillsTreeContainer.querySelectorAll('.skill-project-checkbox:checked'))
                .map((el: any) => el.value);
            
            vscode.postMessage({ command: 'importSelectedSkills', discussionSkills, projectSkills });
            dom.skillsModal.classList.remove('visible');
        });
    }

    // --- Mission Briefing Modal Events ---
    const briefingBtn = document.getElementById('edit-briefing-btn');
    if (briefingBtn) {
        briefingBtn.addEventListener('click', () => {
            vscode.postMessage({ command: 'requestMissionBriefingUI' });
        });
    }

    if (dom.missionBriefingCloseBtn) {
        dom.missionBriefingCloseBtn.addEventListener('click', () => {
            dom.missionBriefingModal.classList.remove('visible');
        });
    }

    if (dom.briefingUploadBtn) {
        dom.briefingUploadBtn.addEventListener('click', () => {
            vscode.postMessage({ command: 'requestBriefingFileUpload' });
        });
    }

    if (dom.briefingClipboardBtn) {
        dom.briefingClipboardBtn.addEventListener('click', () => {
            vscode.postMessage({ command: 'requestBriefingClipboard' });
        });
    }

    if (dom.briefingClearBtn) {
        dom.briefingClearBtn.addEventListener('click', () => {
            if (dom.briefingContentInput) {
                dom.briefingContentInput.value = '';
            }
        });
    }

    if (dom.briefingSaveBtn) {
        dom.briefingSaveBtn.addEventListener('click', () => {
            if (!dom.briefingContentInput) return;
            const content = dom.briefingContentInput.value;
            const scopeElement = document.querySelector('input[name="briefing-scope"]:checked') as HTMLInputElement;
            const scope = scopeElement ? scopeElement.value : 'local';
            
            vscode.postMessage({
                command: 'saveMissionBriefing',
                content: content,
                scope: scope
            });
            dom.missionBriefingModal.classList.remove('visible');
        });
    }

    // --- Global Discussion Search Events ---
    if (dom.discussionSearchRunBtn) {
        const runSearch = () => {
            const query = dom.discussionSearchInput.value.trim();
            if (query) {
                dom.discussionSearchResults.innerHTML = '<div style="text-align:center; padding:20px;"><div class="spinner"></div> Searching discussions...</div>';
                vscode.postMessage({ command: 'performDeepDiscussionSearch', query });
            }
        };
        dom.discussionSearchRunBtn.addEventListener('click', runSearch);
        dom.discussionSearchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') runSearch();
        });
    }

    if (dom.discussionSearchCloseBtn) {
        dom.discussionSearchCloseBtn.addEventListener('click', () => dom.discussionSearchModal.classList.remove('visible'));
    }

    // --- Raw Code Modal Search Logic ---
    let rawMatches: HTMLElement[] = [];
    let currentRawIdx = -1;

    function clearRawSearch() {
        rawMatches = [];
        currentRawIdx = -1;
        if (dom.rawSearchCount) dom.rawSearchCount.textContent = '';
        const display = dom.rawCodeDisplay;
        if (display && display.dataset.rawText) {
            display.textContent = display.dataset.rawText;
        }
    }

    function performRawSearch() {
        const query = dom.rawSearchInput.value;
        const display = dom.rawCodeDisplay;
        if (!query || !display) {
            clearRawSearch();
            return;
        }

        const text = display.dataset.rawText || display.textContent || "";
        if (!display.dataset.rawText) display.dataset.rawText = text;

        const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`(${escaped})`, 'gi');
        
        display.innerHTML = text.replace(regex, '<mark class="raw-match">$1</mark>');
        rawMatches = Array.from(display.querySelectorAll('.raw-match'));
        
        if (rawMatches.length > 0) {
            currentRawIdx = 0;
            updateRawNavigation();
        } else {
            currentRawIdx = -1;
            if (dom.rawSearchCount) dom.rawSearchCount.textContent = '0/0';
        }
    }

    function updateRawNavigation() {
        rawMatches.forEach((m, i) => m.classList.toggle('current-match', i === currentRawIdx));
        if (dom.rawSearchCount) dom.rawSearchCount.textContent = `${currentRawIdx + 1}/${rawMatches.length}`;
        if (rawMatches[currentRawIdx]) {
            rawMatches[currentRawIdx].scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }

    if (dom.rawSearchInput) {
        dom.rawSearchInput.addEventListener('input', performRawSearch);
        dom.rawSearchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                if (e.shiftKey) {
                    currentRawIdx = (currentRawIdx - 1 + rawMatches.length) % rawMatches.length;
                } else {
                    currentRawIdx = (currentRawIdx + 1) % rawMatches.length;
                }
                updateRawNavigation();
            }
            if (e.key === 'Escape') {
                dom.rawCodeModal.classList.remove('visible');
            }
        });
    }

    if (dom.rawSearchNext) dom.rawSearchNext.onclick = () => {
        if (rawMatches.length === 0) return;
        currentRawIdx = (currentRawIdx + 1) % rawMatches.length;
        updateRawNavigation();
    };

    if (dom.rawSearchPrev) dom.rawSearchPrev.onclick = () => {
        if (rawMatches.length === 0) return;
        currentRawIdx = (currentRawIdx - 1 + rawMatches.length) % rawMatches.length;
        updateRawNavigation();
    };

    // --- Raw Code Modal Events ---
    if (dom.rawCodeCloseBtn) {
        dom.rawCodeCloseBtn.addEventListener('click', () => {
            dom.rawCodeModal.classList.remove('visible');
            dom.rawSearchResultsMini.style.display = 'none';
            clearRawSearch();
            if (dom.rawSearchInput) dom.rawSearchInput.value = '';
        });
    }

    // --- MANUAL STITCHING SECURE HANDLERS ---
    const helpBtn = document.getElementById('raw-stitch-help-btn');
    if (helpBtn) {
        helpBtn.onclick = () => {
            vscode.postMessage({
                command:'executeLollmsCommand', 
                details:{command:'lollms-vs-coder.showHelp', params:{section:'manual-stitching'}}
            });
        };
    }

    // Delegated listener for search results in Raw Block Modal
    if (dom.rawSearchResultsMini) {
        dom.rawSearchResultsMini.addEventListener('click', (e) => {
            const item = (e.target as HTMLElement).closest('.mini-search-item') as HTMLElement;
            if (!item) return;

            const path = item.dataset.path;
            const query = item.dataset.query;
            
            // 1. Extract and Copy REPLACE block from the hunk currently displayed in the modal
            const fullText = dom.rawCodeDisplay.textContent || "";
            const replaceMatch = fullText.match(/=======[\r\n]*([\s\S]*?)[\r\n]*>>>>>>> REPLACE/s);
            if (replaceMatch) {
                vscode.postMessage({ command: 'copyToClipboard', text: replaceMatch[1].trim() });
            }

            // 2. Open and Select target using the main lollms command
            if (path && query) {
                vscode.postMessage({
                    command: 'executeLollmsCommand',
                    details: {
                        command: 'lollms-vs-coder.openAndSelect',
                        params: { path, text: query }
                    }
                });
            }
        });
    }

    if (dom.rawFixAiBtn) {
        dom.rawFixAiBtn.onclick = () => {
            const display = dom.rawCodeDisplay;
            if (!display) return;
            
            const messageId = display.dataset.messageId;
            const blockIndex = parseInt(display.dataset.blockIndex || "0", 10);
            const hunkIndexRaw = display.dataset.hunkIndex;
            const hunkIndex = hunkIndexRaw === "" ? undefined : parseInt(hunkIndexRaw || "0", 10);
            const filePath = dom.rawCodeFilename.textContent;

            if (messageId && filePath) {
                dom.rawFixAiBtn.disabled = true;
                dom.rawFixAiBtn.innerHTML = '<div class="spinner"></div> Repairing...';
                
                vscode.postMessage({ 
                    command: 'replaceCode', 
                    filePath: filePath, 
                    content: "REPAIR_REQUESTED", 
                    messageId: messageId,
                    blockIndex: blockIndex,
                    hunkIndex: hunkIndex,
                    options: { silent: true }
                });
                
                // Close modal so user can see progress in chat
                dom.rawCodeModal.classList.remove('visible');
            }
        };
    }

    if (dom.rawCodeFilename) {
        dom.rawCodeFilename.onclick = () => {
            const path = dom.rawCodeFilename.textContent;
            if (path) vscode.postMessage({ command: 'openFile', path });
        };
    }

    if (dom.searchSelectionBtn) {
        dom.searchSelectionBtn.onclick = () => {
            const selection = window.getSelection()?.toString().trim();
            if (!selection) {
                vscode.postMessage({ command: 'showError', message: 'Please select some text in the code block first.' });
                return;
            }

            // 1. Automatically copy the REPLACE part of the current block to clipboard
            const fullText = dom.rawCodeDisplay.textContent || "";
            const replaceMatch = fullText.match(/=======[\r\n]*([\s\S]*?)[\r\n]*>>>>>>> REPLACE/);
            if (replaceMatch) {
                vscode.postMessage({ command: 'copyToClipboard', text: replaceMatch[1].trim() });
            }

            // 2. Perform project-wide search
            dom.rawSearchResultsMini.style.display = 'block';
            dom.rawSearchResultsMini.innerHTML = '<div style="padding:10px; opacity:0.6;"><div class="spinner"></div> Searching workspace...</div>';
            
            vscode.postMessage({ 
                command: 'requestFileSearch', 
                query: selection, 
                mode: 'content',
                options: { matchCase: true, wholeWord: false }
            });
        };
    }

    const handleRawCopy = (btn: HTMLButtonElement, mode: 'full' | 'search' | 'replace') => {
        const text = dom.rawCodeDisplay.textContent || '';
        let textToCopy = text;

        if (mode !== 'full') {
            // Precise regex for Aider markers
            const aiderRegex = /<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>> REPLACE/g;
            const matches = [...text.matchAll(aiderRegex)];
            
            if (matches.length > 0) {
                if (mode === 'search') {
                    textToCopy = matches.map(m => m[1]).join('\n\n');
                } else if (mode === 'replace') {
                    textToCopy = matches.map(m => m[2]).join('\n\n');
                }
                } else {
                // If it's a code block but doesn't have markers, search/replace copy is invalid
                vscode.postMessage({ command: 'showError', message: 'No SEARCH/REPLACE markers found in this block.' });
                return;
                }
        }

        if (textToCopy) {
            vscode.postMessage({ command: 'copyToClipboard', text: textToCopy });
            const originalHtml = btn.innerHTML;
            btn.innerHTML = '<span class="codicon codicon-check"></span> Copied!';
            btn.classList.add('success');
            setTimeout(() => {
                btn.innerHTML = originalHtml;
                btn.classList.remove('success');
            }, 2000);
        }
    };

    if (dom.copyRawBtn) {
        dom.copyRawBtn.addEventListener('click', () => handleRawCopy(dom.copyRawBtn, 'full'));
    }
    if (dom.copySearchBtn) {
        dom.copySearchBtn.addEventListener('click', () => handleRawCopy(dom.copySearchBtn, 'search'));
    }
    if (dom.copyReplaceBtn) {
        dom.copyReplaceBtn.addEventListener('click', () => handleRawCopy(dom.copyReplaceBtn, 'replace'));
    }

    if (dom.markAppliedBtn) {
        dom.markAppliedBtn.addEventListener('click', () => {
            const display = dom.rawCodeDisplay;
            if (!display) return;

            const messageId = display.dataset.messageId;
            const blockIndex = parseInt(display.dataset.blockIndex || "0", 10);
            const hunkIndexRaw = display.dataset.hunkIndex;
            const hunkIndex = hunkIndexRaw === "" ? undefined : parseInt(hunkIndexRaw || "0", 10);

            if (messageId) {
                // Send signal to extension to update persistent state
                vscode.postMessage({
                    command: 'markHunkApplied',
                    messageId,
                    blockIndex,
                    hunkIndex
                });

                // Immediately update local UI to show success
                window.dispatchEvent(new MessageEvent('message', {
                    data: {
                        command: 'applyAllResult',
                        messageId,
                        blockIndex,
                        hunkIndex,
                        success: true,
                        alreadyApplied: true
                    }
                }));

                dom.rawCodeModal.classList.remove('visible');
            }
        });
    }

    if (dom.searchCloseBtn) dom.searchCloseBtn.addEventListener('click', () => {
        if(dom.searchBar) dom.searchBar.style.display = 'none';
        clearSearch();
    });
    if (dom.searchPrevBtn) dom.searchPrevBtn.addEventListener('click', () => navigateSearch(-1));
    if (dom.searchNextBtn) dom.searchNextBtn.addEventListener('click', () => navigateSearch(1));

    // Workspace Matrix Events ---
    if (dom.hudMatrixBtn) {
        dom.hudMatrixBtn.onclick = () => {
            renderWorkspaceMatrix();
            dom.matrixModal.classList.add('visible');
        };
    }
    if (dom.matrixCloseBtn) dom.matrixCloseBtn.onclick = () => dom.matrixModal.classList.remove('visible');
    if (dom.matrixDoneBtn) dom.matrixDoneBtn.onclick = () => dom.matrixModal.classList.remove('visible');

    const matrixAllOn = document.getElementById('matrix-all-on');
    const matrixAllOff = document.getElementById('matrix-all-off');
    if (matrixAllOn) {
        matrixAllOn.onclick = () => {
            const folders = (window as any).workspaceFolders || [];
            const newSettings: Record<string, any> = {};
            folders.forEach((f: any) => newSettings[f.uri.toString()] = { tree: true, content: true });
            vscode.postMessage({ command: 'updateDiscussionCapabilitiesPartial', partial: { folderSettings: newSettings } });
        };
    }
    if (matrixAllOff) {
        matrixAllOff.onclick = () => {
            const folders = (window as any).workspaceFolders || [];
            const newSettings: Record<string, any> = {};
            folders.forEach((f: any) => newSettings[f.uri.toString()] = { tree: false, content: false });
            vscode.postMessage({ command: 'updateDiscussionCapabilitiesPartial', partial: { folderSettings: newSettings } });
        };
    }

    // --- Context Viewer Modal Events ---
    if (dom.contextViewerCloseBtn) dom.contextViewerCloseBtn.onclick = () => dom.contextViewerModal.classList.remove('visible');
    if (dom.contextViewerDoneBtn) dom.contextViewerDoneBtn.onclick = () => dom.contextViewerModal.classList.remove('visible');
    if (dom.contextViewerCopyBtn) {
        dom.contextViewerCopyBtn.onclick = () => {
            const text = dom.contextViewerDisplay.innerText;
            vscode.postMessage({ command: 'copyToClipboard', text });

            const originalHtml = dom.contextViewerCopyBtn.innerHTML;
            dom.contextViewerCopyBtn.innerHTML = '<span class="codicon codicon-check"></span> Copied!';
            setTimeout(() => { dom.contextViewerCopyBtn.innerHTML = originalHtml; }, 2000);
        };
    }
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
    if (dom.capAutoFix && state.capabilities) dom.capAutoFix.checked = state.capabilities.autoFix !== false;
    if (dom.capAutoBranch && state.capabilities) dom.capAutoBranch.checked = !!state.capabilities.autoBranch;

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

    /**
     * Shared Click Delegation Handler.
     * Processes interactions for BOTH Chat Messages and the Agent Plan Zone.
     */
    function handleGlobalClick(e: MouseEvent) {
        const target = e.target as HTMLElement;

        // --- 0. Dashboard Export Handlers (CSP Safe) ---
        const mdBtn = target.closest('.export-audit-md-btn');
        if (mdBtn) {
            e.stopPropagation();
            vscode.postMessage({
                command: 'executeLollmsCommand',
                details: { command: 'lollms-vs-coder.exportAgentAuditMarkdown', params: [] }
            });
            return;
        }

        const htmlBtn = target.closest('.export-audit-html-btn');
        if (htmlBtn) {
            e.stopPropagation();
            vscode.postMessage({
                command: 'executeLollmsCommand',
                details: { command: 'lollms-vs-coder.exportAgentTimeline', params: [] }
            });
            return;
        }

        // --- 0.5. Form Submission (CRITICAL) ---
        const formBtn = target.closest('.lollms-form-submit-btn') as HTMLButtonElement;
        if (formBtn) {
            e.preventDefault();
            e.stopPropagation();
            
            const formBlock = formBtn.closest('.lollms-form-block') as HTMLElement;
            if (!formBlock) return;

            // Collect Data
            const data: Record<string, string> = {};
            const radios = Array.from(formBlock.querySelectorAll('input[type="radio"]')) as HTMLInputElement[];
            radios.forEach((input) => { if (input.checked) data[input.name] = input.value; });

            const textInputs = Array.from(formBlock.querySelectorAll('input[type="text"], input[type="number"], textarea')) as (HTMLInputElement | HTMLTextAreaElement)[];
            textInputs.forEach(input => { if (input.name) data[input.name] = input.value; });

            // Validation check
            if (Object.keys(data).length === 0 && radios.length > 0) {
                formBlock.style.outline = "2px solid var(--vscode-charts-red)";
                setTimeout(() => formBlock.style.outline = "none", 500);
                return;
            }

            // Visual State Update: Remove the form immediately to prevent "Hanging" feel
            const formContainer = formBlock.closest('.message-wrapper');
            if (formContainer) {
                formContainer.remove();
            } else {
                formBlock.remove();
            }

            vscode.postMessage({
                command: 'sendMessage',
                message: { 
                    id: 'form_response_' + Date.now(),
                    role: 'user', 
                    content: `FORM_SUBMISSION:${JSON.stringify(data)}`,
                    skipInPrompt: true,
                    isSilentSignal: true // Flag to tell backend not to add a "You" bubble
                }
            });
            return;
        }

        // 1. Granular Task Memory Bar Clicks (Inside Agent Cards)
        console.log(`[Lollms] Global Click detected on:`, target.className, target.tagName);

        // 1. Granular Task Memory Bar Clicks (Inside Agent Cards)
        const segment = target.closest('.brain-segment') as HTMLElement;
        if (segment) {
            e.stopPropagation();
            const type = segment.dataset.type;
            const card = segment.closest('.agent-card') as HTMLElement;

            // If it's the main Brain HUD (no card parent)
            if (!card && type) {
                vscode.postMessage({
                    command: 'executeLollmsCommand', 
                    details: { command: 'lollms-vs-coder.peekAgentBrain', params: type }
                });
                return;
            }

            const taskId = card?.dataset.taskId;
            if (!taskId) return;

            const renderArea = document.getElementById(`task-mem-render-${taskId}`);
            const body = renderArea?.querySelector('.task-memory-body');

            const plan = (window as any).lastPlan; 
            if (!plan) return;

            const task = plan.tasks.find((t: any) => t.id == taskId);

            if (renderArea && body && task) {
                // Toggle Logic
                if (renderArea.classList.contains('visible') && renderArea.dataset.lastType === type) {
                    renderArea.classList.remove('visible');
                } else {
                    renderArea.classList.add('visible');
                    renderArea.dataset.lastType = type;
                    let content = "";
                    if (type === 'thoughts' || type === 'scratchpad') {
                        content = `### Step Reasoning\n${task.description}`;
                    } else if (type === 'memory') {
                        const vars = JSON.stringify(task.memory_delta?.variables || {}, null, 2);
                        const discs = (task.memory_delta?.discoveries || []).map((d:string) => `• ${d}`).join('\n');
                        content = `### Variables Updated\n\`\`\`json\n${vars}\n\`\`\`\n\n### New Discoveries\n${discs || 'None'}`;
                    } else if (type === 'history') {
                        content = `### Tool Output\n\`\`\`\n${task.result || 'No output recorded.'}\n\`\`\``;
                    }
                    body.innerHTML = (window as any).DOMPurify.sanitize((window as any).marked.parse(content));
                }
            }
            return;
        }

        // 2. Token Progress Bar Segments (Top HUD)
        const tokenSeg = target.closest('.token-bar-segment') as HTMLElement;
        const legendItem = target.closest('.legend-item') as HTMLElement;
        const potentialTarget = tokenSeg || legendItem;

        if (potentialTarget) {
            e.stopPropagation();
            const type = potentialTarget.dataset.type || potentialTarget.getAttribute('data-type');
            if (type) {
                const cmdType = type === 'history' ? 'chat' : type;
                vscode.postMessage({
                    command: 'executeLollmsCommand', 
                    details: { command: 'lollms-vs-coder.viewFullContext', params: cmdType }
                });
            }
            return;
        }

        // 3. Close Button for Task Memory Areas
        const closeMemBtn = target.closest('.task-memory-header .codicon-close');
        if (closeMemBtn) {
            closeMemBtn.closest('.task-memory-render-area')?.classList.remove('visible');
            return;
        }

        // Legacy handler for remaining UI buttons inside messages
        // Toggle Edit Params (Universal Task Editor)
        const editBtn = target.closest('.edit-params-btn') as HTMLButtonElement;
        if (editBtn) {
            e.stopPropagation();
            const card = editBtn.closest('.agent-card');
            const editor = card?.querySelector('.task-param-editor') as HTMLElement;
            if (editor) {
                editor.style.display = (editor.style.display === 'none' || !editor.style.display) ? 'flex' : 'none';
            }
            return;
        }
        // NEW: Handle Image Generation Button (CSP Safe)
        const genImgBtn = target.closest('.generate-image-btn') as HTMLButtonElement;
        if (genImgBtn) {
            e.stopPropagation();

            const block = genImgBtn.closest('.generation-block');
            const folderInp = block?.querySelector('.asset-folder-input') as HTMLInputElement;
            const nameInp = block?.querySelector('.asset-name-input') as HTMLInputElement;

            let finalPath = decodeURIComponent(genImgBtn.dataset.path || '');
            if (folderInp && nameInp) {
                const folder = folderInp.value.trim().replace(/\/+$/, '');
                finalPath = folder + '/' + nameInp.value.trim();
            }

            genImgBtn.disabled = true;
            genImgBtn.innerHTML = '<div class="spinner"></div> Generating...';

            vscode.postMessage({
                command: 'generateImage',
                prompt: decodeURIComponent(genImgBtn.dataset.prompt || ''),
                filePath: finalPath,
                width: genImgBtn.dataset.width || '',
                height: genImgBtn.dataset.height || '',
                buttonId: genImgBtn.id
            });
            return;
        }

        // Handle "Add Files to Context" Button (CSP Safe)
        const addFilesBtn = target.closest('.add-files-to-context-btn') as HTMLButtonElement;
        const repromptBtn = target.closest('.add-and-reprompt-btn') as HTMLButtonElement;

        if (addFilesBtn || repromptBtn) {
            e.stopPropagation();
            const btn = addFilesBtn || repromptBtn;
            const filesRaw = btn.dataset.files || '[]';
            const blockId = btn.dataset.blockId;
            const isReprompt = !!repromptBtn;

            try {
                const files = JSON.parse(filesRaw);
                btn.disabled = true;
                btn.innerHTML = '<div class="spinner"></div> Adding...';

                vscode.postMessage({
                    command: 'addFilesToContext',
                    files: files,
                    blockId: blockId,
                    reprompt: isReprompt
                });
            } catch (err) {
                console.error("Failed to parse file list from button:", err);
            }
            return;
        }

        const copyFilesBtn = target.closest('.copy-files-to-clipboard-btn') as HTMLButtonElement;
        if (copyFilesBtn) {
            e.stopPropagation();
            const filesRaw = copyFilesBtn.dataset.files || '[]';
            try {
                const files = JSON.parse(filesRaw);
                vscode.postMessage({
                    command: 'copyFilesToClipboard',
                    files: files
                });

                // Immediate visual feedback
                const originalHtml = copyFilesBtn.innerHTML;
                copyFilesBtn.innerHTML = '<span class="codicon codicon-check"></span> Copied!';
                copyFilesBtn.classList.add('success');
                setTimeout(() => {
                    copyFilesBtn.innerHTML = originalHtml;
                    copyFilesBtn.classList.remove('success');
                }, 2000);
            } catch (err) {
                console.error("Failed to parse file list for clipboard:", err);
            }
            return;
        }

        // Handle File Deletion (Single)
        const delSingleBtn = target.closest('.delete-single-btn') as HTMLButtonElement;
        if (delSingleBtn) {
            e.stopPropagation();
            const path = delSingleBtn.dataset.path;
            const rowId = delSingleBtn.dataset.rowId;
            
            vscode.postMessage({ command: 'deleteFile', filePaths: path });
            
            delSingleBtn.disabled = true;
            delSingleBtn.textContent = 'Deleted';
            const row = document.getElementById(rowId!);
            if (row) {
                row.style.color = 'var(--vscode-errorForeground)';
                row.style.opacity = '0.7';
            }
            return;
        }

        // Handle clicking a file path in an expansion block to open it
        const expansionItem = target.closest('.expansion-file-item') as HTMLElement;
        if (expansionItem && !target.closest('button')) {
            e.stopPropagation();
            // The path is in the second span
            const pathSpan = expansionItem.querySelector('span:last-child');
            const filePath = pathSpan?.textContent?.trim();
            if (filePath) {
                vscode.postMessage({ command: 'openFile', path: filePath });
            }
            return;
        }

        // Handle File Deletion (All)
        const delAllBtn = target.closest('.delete-all-btn') as HTMLButtonElement;
        if (delAllBtn) {
            e.stopPropagation();
            const paths = delAllBtn.dataset.paths;
            const blockId = delAllBtn.dataset.blockId;

            vscode.postMessage({ command: 'deleteFile', filePaths: paths });

            delAllBtn.disabled = true;
            delAllBtn.innerHTML = '<span class="codicon codicon-check"></span> All Files Deleted';
            
            // Update the visual state of all individual rows in this block
            const container = document.getElementById(blockId!);
            if (container) {
                const items = container.querySelectorAll('.expansion-file-item');
                items.forEach((row: any) => {
                    row.style.color = 'var(--vscode-errorForeground)';
                    row.style.opacity = '0.7';
                    const btn = row.querySelector('button');
                    if (btn) {
                        btn.disabled = true;
                        btn.textContent = 'Deleted';
                    }
                });
            }
            return;
        }

        // Handle File Move / Prune Actions
        const fileOpBtn = target.closest('.file-op-action-btn') as HTMLButtonElement;
        if (fileOpBtn) {
            e.stopPropagation();
            const command = fileOpBtn.dataset.command;
            const payloadRaw = fileOpBtn.dataset.payload || '{}';
            
            try {
                const payload = JSON.parse(payloadRaw);
                vscode.postMessage({ command, ...payload });
                
                fileOpBtn.disabled = true;
                fileOpBtn.innerHTML = '<span class="codicon codicon-check"></span> Applied';
            } catch (err) {
                console.error("Failed to parse file operation payload:", err);
            }
            return;
        }

        // Handle Manual Memory Sync
        const syncMemBtn = target.closest('.sync-memory-btn') as HTMLButtonElement;
        if (syncMemBtn) {
            e.stopPropagation();
            const { action, id, title, content, importance } = syncMemBtn.dataset;
            
            syncMemBtn.disabled = true;
            syncMemBtn.innerHTML = '<i class="codicon codicon-loading spin"></i>';

            vscode.postMessage({
                command: 'executeLollmsCommand',
                details: {
                    command: 'lollms-vs-coder.applyMemoryTag',
                    params: { 
                        action, 
                        id, 
                        title: decodeURIComponent(title || ''), 
                        content: decodeURIComponent(content || ''),
                        importance: parseFloat(importance || "1.0")
                    }
                }
            });

            setTimeout(() => {
                syncMemBtn.disabled = false;
                syncMemBtn.innerHTML = '<i class="codicon codicon-check"></i>';
                setTimeout(() => { syncMemBtn.innerHTML = '<i class="codicon codicon-sync"></i>'; }, 2000);
            }, 1000);
            return;
        }

        // Infer Prompt Button
        const inferPromptBtn = target.closest('.infer-prompt-btn') as HTMLButtonElement;
        if (inferPromptBtn) {
            e.stopPropagation();
            const msgId = inferPromptBtn.dataset.messageId;
            if (msgId) {
                inferPromptBtn.disabled = true;
                inferPromptBtn.innerHTML = '<div class="spinner"></div> Inferring...';
                vscode.postMessage({ command: 'inferPrompt', messageId: msgId });
            }
            return;
        }


        // Copy Asset Path
        const copyPathBtn = target.closest('.copy-asset-path-btn') as HTMLButtonElement;
        if (copyPathBtn) {
            e.stopPropagation();
            vscode.postMessage({ command: 'copyToClipboard', text: copyPathBtn.dataset.path });
            return;
        }

        // Save Asset As (Binary)
        const saveAssetBtn = target.closest('.save-asset-as-btn') as HTMLButtonElement;
        if (saveAssetBtn) {
            e.stopPropagation();
            vscode.postMessage({ command: 'executeLollmsCommand', details: { 
                command: 'lollms-vs-coder.saveAssetAs', 
                params: { path: saveAssetBtn.dataset.path } 
            }});
            return;
        }

        // Edit Asset (Internal Image Editor)
        const editAssetBtn = target.closest('.edit-asset-btn') as HTMLButtonElement;
        if (editAssetBtn) {
            e.stopPropagation();
            const container = document.getElementById(editAssetBtn.dataset.targetId || '');
            const img = container?.querySelector('img');
            if (img && typeof (window as any).openImageEditorFromData === 'function') {
                (window as any).openImageEditorFromData(img.src, editAssetBtn.dataset.path || 'edit.png');
            } else {
                vscode.postMessage({ command: 'showError', message: 'Asset not loaded or ready for editing.' });
            }
            return;
        }

        // Set Breakpoint
        const bpBtn = target.closest('.set-breakpoint-btn') as HTMLButtonElement;
        if (bpBtn) {
            e.stopPropagation();
            const filePath = bpBtn.dataset.path;
            const line = parseInt(bpBtn.dataset.line || "0", 10);

            if (filePath && line > 0) {
                vscode.postMessage({ 
                    command: 'executeLollmsCommand', 
                    details: { command: 'lollms-vs-coder.setBreakpoint', params: [filePath, line] }
                });
                bpBtn.disabled = true;
                bpBtn.innerHTML = '<span class="codicon codicon-check"></span> Active';
                bpBtn.classList.replace('apply-btn', 'applied');
            }
            return;
        }

        // Task Approval
        const approveBtn = target.closest('.approve-task-btn') as HTMLButtonElement;
        if (approveBtn) {
            e.stopPropagation();
            const taskId = approveBtn.dataset.taskId;
            const alwaysAllowCheck = document.getElementById(`always-allow-${taskId}`) as HTMLInputElement;
            const alwaysAllow = alwaysAllowCheck ? alwaysAllowCheck.checked : false;

            approveBtn.disabled = true;
            approveBtn.innerHTML = '<div class="spinner"></div> Running...';
            vscode.postMessage({ 
                command: 'runAgent', 
                taskId: taskId, 
                objective: 'CONTINUE_AFTER_APPROVAL',
                alwaysAllow: alwaysAllow 
            });
            return;
        }

        // Tool Bug Reporting
        const reportBugBtn = target.closest('.report-tool-bug-btn') as HTMLButtonElement;
        if (reportBugBtn) {
            e.stopPropagation();
            const action = reportBugBtn.dataset.action;
            const error = decodeURIComponent(reportBugBtn.dataset.error || "");
            const stack = decodeURIComponent(reportBugBtn.dataset.stack || "");
            const version = state.extensionVersion || "unknown";

            const reportMarkdown = `### 🐞 LoLLMs Tool Bug Report
        **Tool**: \`${action}\`
        **Extension Version**: \`${version}\`
        **Error**: \`${error}\`

        **Stack Trace**:
        \`\`\`
        ${stack}
        \`\`\``;

            // 1. Copy to clipboard for easy Discord pasting
            vscode.postMessage({ command: 'copyToClipboard', text: reportMarkdown });

            // 2. Open GitHub Issue link with pre-filled body
            const body = encodeURIComponent(reportMarkdown);
            const githubUrl = `https://github.com/ParisNeo/lollms-vs-coder/issues/new?title=[Tool Bug] ${action}: ${error.substring(0, 50)}&body=${body}`;

            // Explicitly notify user about clipboard
            vscode.postMessage({ 
                command: 'executeLollmsCommand', 
                details: { 
                    command: 'vscode.open', 
                    params: [githubUrl] 
                } 
            });

            vscode.postMessage({ 
                command: 'showWarning', 
                message: "Bug report data copied to clipboard. You can paste it into Discord or the GitHub issue that just opened." 
            });
            return;
        }

        // Save & Retry Params
        const saveRetryBtn = target.closest('.save-retry-params-btn') as HTMLButtonElement;
        if (saveRetryBtn) {
            e.stopPropagation();
            const taskIdStr = saveRetryBtn.dataset.taskId;
            if (!taskIdStr) return;

            const textArea = document.getElementById(`edit-params-text-${taskIdStr}`) as HTMLTextAreaElement;
            if (textArea) {
                try {
                    const newParams = JSON.parse(textArea.value);
                    vscode.postMessage({ 
                        command: 'editAndRetryAgentTask', 
                        taskId: taskIdStr,
                        params: newParams 
                    });
                    
                    saveRetryBtn.disabled = true;
                    saveRetryBtn.innerHTML = '<span class="codicon codicon-sync spin"></span> Running...';
                } catch (err) {
                    vscode.postMessage({ command: 'showError', message: 'Invalid JSON parameters. Please check your syntax.' });
                }
            }
            return;
        }

        const skillFileBtn = target.closest('.save-skill-file-btn') as HTMLButtonElement;
        if (skillFileBtn) {
            const content = skillFileBtn.dataset.content || '';
            const title = skillFileBtn.dataset.title || '';
            const desc = skillFileBtn.dataset.description || '';
            const cat = skillFileBtn.dataset.category || '';
            
            vscode.postMessage({ 
                command: 'saveSkillToFile', 
                skillData: { 
                    name: decodeURIComponent(title), 
                    description: decodeURIComponent(desc), 
                    content: decodeURIComponent(content), 
                    category: decodeURIComponent(cat) 
                } 
            });
            return;
        }

        const skillBtn = target.closest('.save-skill-btn') as HTMLButtonElement;
        if (skillBtn) {
            const content = skillBtn.dataset.content || '';
            const scope = skillBtn.dataset.scope as 'global' | 'local';
            const title = skillBtn.dataset.title || '';
            const desc = skillBtn.dataset.description || '';
            const cat = skillBtn.dataset.category || '';
            
            // Call the globally defined handler in main.ts
            if (typeof (window as any).saveSkill === 'function') {
                (window as any).saveSkill(content, scope, title, desc, cat);
                
                // Provide immediate visual feedback
                const originalHtml = skillBtn.innerHTML;
                skillBtn.disabled = true;
                skillBtn.classList.add('success');
                skillBtn.innerHTML = '<span class="codicon codicon-check"></span> Saved';
                
                setTimeout(() => {
                    skillBtn.innerHTML = originalHtml;
                    skillBtn.classList.remove('success');
                    skillBtn.disabled = false;
                }, 2000);
            }
        }
    }
}
