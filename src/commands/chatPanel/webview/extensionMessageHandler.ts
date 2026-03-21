import { dom, vscode, state } from './dom.js';
import { addMessage, renderMessageContent, updateContext, displayPlan, scheduleRender } from './messageRenderer.js';
import { 
    setGeneratingState, 
    updateBadges, 
    renderProfilesInModal, 
    renderSkillsTree, 
    renderFileSearchTree, 
    renderDiscussionSearchResults, 
    renderFileSearchResults,
    renderWebSearchResults,
    renderContextUsage,
    updateProgressBar,
    updateContextFileUsage
} from './ui.js';

export async function handleExtensionMessage(event: MessageEvent) {
    try {
        const message = event.data;
        switch (message.command) {
            case 'addMessage':
                addMessage(message.message);
                break;
            case 'appendMessageChunk':
                {
                    const stream = state.streamingMessages[message.id];
                    if (!stream) break;
                    const wrapper = document.querySelector(`.message-wrapper[data-message-id='${message.id}']`) as HTMLElement;
                    if (!wrapper) break;
                    if (!wrapper.dataset.firstTokenReceived) {
                        wrapper.dataset.firstTokenReceived = 'true';
                        wrapper.dataset.firstTokenTime = String(Date.now());
                        const waitingAnim = wrapper.querySelector('.waiting-animation');
                        if (waitingAnim) waitingAnim.remove();
                        const startTime = parseInt(wrapper.dataset.startTime || '0', 10);
                        const ttft = ((Date.now() - startTime) / 1000).toFixed(1);
                        const modelName = wrapper.dataset.model || 'Default';
                        const header = wrapper.querySelector('.message-header');
                        if(header){
                            let annotationSpan = header.querySelector('.generation-stats');
                            if (!annotationSpan) {
                                annotationSpan = document.createElement('span');
                                annotationSpan.className = 'generation-stats';
                                header.appendChild(annotationSpan);
                            }
                            annotationSpan.textContent = `(${modelName} | TTFT: ${ttft}s)`;
                        }
                    }
                    stream.buffer += message.chunk;
                    const messageDiv = wrapper.querySelector('.message') as HTMLElement;
                    if(messageDiv) {
                        messageDiv.dataset.originalContent = JSON.stringify(stream.buffer);
                    }
                    scheduleRender(message.id);
                }
                break;
            case 'finalizeMessage':
                {
                    const stream = state.streamingMessages[message.id];
                    if (stream) {
                        if (stream.timer) clearTimeout(stream.timer);
                        delete state.streamingMessages[message.id];
                    }
                    
                    // Safety: Force hide the spinner when a message is completed
                    setGeneratingState(false);
                    const metricsEl = document.getElementById('generating-metrics');
                    if (metricsEl) metricsEl.style.display = 'none';

                    // Update header with final TPS
                    const wrapper = document.querySelector(`.message-wrapper[data-message-id='${message.id}']`) as HTMLElement;
                    if (wrapper && message.tps) {
                        const header = wrapper.querySelector('.message-header');
                        const stats = header?.querySelector('.generation-stats');
                        if (stats) {
                            stats.textContent = stats.textContent?.replace(')', ` | TPS: ${message.tps} t/s)`);
                        }
                    }

                    renderMessageContent(message.id, message.fullContent, true);
                }
                break;
            case 'updateMessage':
                {
                    if (typeof message.newContent === 'string' && message.newContent.startsWith('LOG_UPDATE:')) {
                        try {
                            const logData = JSON.parse(message.newContent.substring(11));
                            const logContainer = document.getElementById('web-search-log');
                            if (logContainer) {
                                const entry = document.createElement('div');
                                entry.className = 'search-entry';
                                entry.innerHTML = `<span class="engine">[${logData.engine}]</span> <span class="query">${logData.query}</span>`;
                                logContainer.appendChild(entry);
                            }
                        } catch (e) {}
                        return; // Don't render log updates as chat messages
                    }

                    const wrapper = document.querySelector(`.message-wrapper[data-message-id='${message.messageId}']`);
                    if (wrapper) {
                        const msgDiv = wrapper.querySelector('.message') as HTMLElement;
                        if (msgDiv) {
                            msgDiv.dataset.originalContent = JSON.stringify(message.newContent);
                        }
                    }
                    renderMessageContent(message.messageId, message.newContent, true);
                }
                break;
            case 'setGeneratingState':
                // If we are stopping, explicitly ensure overlays are hidden
                if (!message.isGenerating) {
                    const overlay = document.getElementById('generating-overlay');
                    if (overlay) overlay.style.display = 'none';
                    const input = document.querySelector('.input-area-wrapper') as HTMLElement;
                    if (input) input.style.display = 'block';
                }
                setGeneratingState(message.isGenerating, message.statusText);
                break;
            case 'updateGenerationMetrics':
                const metricsEl = document.getElementById('generating-metrics');
                const tpsEl = document.getElementById('metrics-tps');
                const countEl = document.getElementById('metrics-count');
                if (message.reset) {
                    if (metricsEl) metricsEl.style.display = 'none';
                    if (tpsEl) tpsEl.textContent = '0.0';
                    if (countEl) countEl.textContent = '0';
                    return;
                }
                if (metricsEl) metricsEl.style.display = 'flex';
                if (tpsEl && message.tps) tpsEl.textContent = message.tps;
                if (countEl && message.count) countEl.textContent = message.count;
                break;
            case 'updateContext':
                updateContext(message.context, message.files, message.skills, message.diagrams);
                break;
            case 'displayPlan':
                displayPlan(message.plan);
                break;
            case 'loadDiscussion':
                {
                    if (dom.attachmentsContainer) dom.attachmentsContainer.innerHTML = '';
                    if (dom.chatMessagesContainer) {
                        Array.from(dom.chatMessagesContainer.children).forEach(child => {
                            if (child.id !== 'message-insertion-controls') {
                                child.remove();
                            }
                        });
                    }
                    if(message.isInspectorEnabled !== undefined) {
                        state.isInspectorEnabled = message.isInspectorEnabled;
                    }
                    state.appliedState = message.appliedState || {};
                    let hasChatContent = false;
                    if (Array.isArray(message.messages)) {
                        message.messages.forEach((msg: any) => {
                            try {
                                addMessage(msg, true);
                                if ((msg.role === 'user' || msg.role === 'assistant') && (!msg.id || !msg.id.startsWith('attachment_'))) {
                                    hasChatContent = true;
                                }
                            } catch (e) {
                                console.error("Error adding message:", e);
                            }
                        });
                    }
                    if (dom.welcomeMessage) {
                        dom.welcomeMessage.style.display = hasChatContent ? 'none' : 'block';
                    }
                    setGeneratingState(false);
                    if(dom.messagesDiv) dom.messagesDiv.scrollTop = dom.messagesDiv.scrollHeight;
                }
                break;

            case 'updateDiscussionCapabilities':
                const caps = message.capabilities;
                if (caps) {
                    state.capabilities = caps;
                    
                    if (message.profiles) {
                        state.profiles = message.profiles;
                        renderProfilesInModal(); // Refresh the list in the modal
                    } else if (!state.profiles) {
                        state.profiles = [];
                    }

                    if (dom.capForceFullCode) dom.capForceFullCode.checked = !!caps.forceFullCode;
                    if (dom.capAllowFullFallback) dom.capAllowFullFallback.checked = caps.generationFormats?.fullFile !== false;
                    if (dom.capExplainCode) dom.capExplainCode.checked = caps.explainCode !== false;
                    if (dom.capAddPedagogicalInstruction) dom.capAddPedagogicalInstruction.checked = !!caps.addPedagogicalInstruction;
                    if (dom.capForceFullCodePath) dom.capForceFullCodePath.checked = !!caps.forceFullCodePath;

                    if (caps.generationFormats?.partialFormat) {
                        const radio = document.querySelector(`input[name="cap-partialFormat"][value="${caps.generationFormats.partialFormat}"]`) as HTMLInputElement;
                        if (radio) radio.checked = true;
                    }

                    if (dom.allowedFormats) {
                        if (dom.fmtFullFile) dom.fmtFullFile.checked = caps.allowedFormats.fullFile !== false;
                        if (dom.fmtInsert) dom.fmtInsert.checked = caps.allowedFormats.insert !== false;
                        if (dom.fmtReplace) dom.fmtReplace.checked = caps.allowedFormats.replace !== false;
                        if (dom.fmtDelete) dom.fmtDelete.checked = caps.allowedFormats.delete !== false;
                    }

                    if(dom.capFileRename) dom.capFileRename.checked = caps.fileRename;
                    if(dom.capFileDelete) dom.capFileDelete.checked = caps.fileDelete;
                    if(dom.capFileSelect) dom.capFileSelect.checked = caps.fileSelect;
                    if(dom.capFileReset) dom.capFileReset.checked = caps.fileReset;

                    if(dom.capImageGen) dom.capImageGen.checked = caps.imageGen;
                    if(dom.capEnableImages) dom.capEnableImages.checked = caps.enableImages !== false;
                    if(dom.capUseImageModeForDocs) dom.capUseImageModeForDocs.checked = !!caps.useImageModeForDocs;
                    if(dom.capWebSearch) dom.capWebSearch.checked = caps.webSearch;
                    if(dom.capDistillWebResults) dom.capDistillWebResults.checked = caps.distillWebResults;
                    if(dom.capAntiPromptInjection) dom.capAntiPromptInjection.checked = caps.antiPromptInjection;
                    if(dom.capSearchInCacheFirst) dom.capSearchInCacheFirst.checked = caps.searchInCacheFirst;
                    
                    if (caps.searchSources) {
                        const sources = ['google', 'arxiv', 'wikipedia', 'stackoverflow', 'youtube', 'github'];
                        sources.forEach(s => {
                            const el = document.getElementById(`src-${s}`) as HTMLInputElement;
                            if (el) el.checked = !!caps.searchSources[s];
                        });
                    }
                    
                    if(dom.capGitWorkflow) dom.capGitWorkflow.checked = caps.gitWorkflow;
                    
                    if(dom.modeFunMode) dom.modeFunMode.checked = caps.funMode;
                    
                    if (dom.capHerdMode) dom.capHerdMode.checked = caps.herdMode || false;
                    if (dom.capHerdRounds) dom.capHerdRounds.value = caps.herdRounds || 2;

                    const guiState = caps.guiState || { agentBadge: true, autoContextBadge: true, herdBadge: true };
                    
                    if (dom.agentModeCheckbox) dom.agentModeCheckbox.checked = caps.agentMode;
                    if (dom.autoContextCheckbox) dom.autoContextCheckbox.checked = caps.autoContextMode;
                    if (dom.contextAggressionSelect) dom.contextAggressionSelect.value = caps.contextAggression || 'respect';
                    if (dom.herdModeCheckbox) dom.herdModeCheckbox.checked = caps.herdMode;

                    if (dom.herdConfigSection) {
                        dom.herdConfigSection.style.display = caps.herdMode ? 'block' : 'none';
                    }
                    
                    const debugConfig = document.getElementById('debug-config-section');
                    if (debugConfig) {
                        debugConfig.style.display = caps.debugMode ? 'block' : 'none';
                    }

                    if (dom.capDebugMode) dom.capDebugMode.checked = !!caps.debugMode;
                    if (dom.capMaxDebugSteps) dom.capMaxDebugSteps.value = caps.maxDebugSteps || 10;

                    if (dom.activeToolsIndicator) {
                        dom.activeToolsIndicator.innerHTML = '';
                        if (caps.arxivSearch) {
                            dom.activeToolsIndicator.innerHTML += `<div class="active-tool-icon active" title="ArXiv Search Enabled"><i class="codicon codicon-book"></i></div>`;
                        }
                    }

                    if (dom.webSearchIndicator) {
                        dom.webSearchIndicator.style.display = caps.webSearch ? 'flex' : 'none';
                    }
                    
                    updateBadges();
                    renderProfilesInModal();

                    // RE-RENDER Context Bubble border/buttons if context data exists
                    if (state.lastContextData) {
                        updateContext(state.lastContextData.context, state.lastContextData.files, state.lastContextData.skills);
                    }
                }
                break;
            case 'updateGitRepoStatus':
                const isRepo = message.isRepo;
                if (dom.capGitWorkflow) {
                    dom.capGitWorkflow.disabled = !isRepo;
                    if (!isRepo && dom.capGitWorkflowContainer) {
                        dom.capGitWorkflowContainer.style.opacity = "0.5";
                        dom.capGitWorkflowContainer.title = "No Git repository detected";
                    } else if (dom.capGitWorkflowContainer) {
                        dom.capGitWorkflowContainer.style.opacity = "1";
                        dom.capGitWorkflowContainer.title = "Git Workflow (Auto-Branching)";
                    }
                }
                break;
            case 'updateThinkingMode':
                if (dom.thinkingIndicator) {
                    dom.thinkingIndicator.style.display = 'none';
                }
                break;

            case 'updateModels':
                if(dom.refreshModelsBtn) {
                    const icon = dom.refreshModelsBtn.querySelector('.codicon');
                    if(icon) icon.classList.remove('spin');
                }
                if(dom.modelSelector) {
                    dom.modelSelector.innerHTML = '<option value="">Default Model</option>';
                    const models = message.models || [];
                    models.forEach((model: {id: string}) => {
                        const option = document.createElement('option');
                        option.value = model.id;
                        option.textContent = model.id;
                        dom.modelSelector.appendChild(option);
                    });
                    dom.modelSelector.value = message.currentModel || '';
                    
                    updateBadges();
                }
                break;
            case 'updatePersonalities':
                state.personalities = message.personalities || [];
                state.currentPersonalityId = message.currentPersonalityId || 'default_coder';
                if (dom.personalitySelector) {
                    dom.personalitySelector.innerHTML = '';
                    state.personalities.forEach((p: any) => {
                        const option = document.createElement('option');
                        option.value = p.id;
                        option.textContent = p.name;
                        dom.personalitySelector.appendChild(option);
                    });
                    dom.personalitySelector.value = state.currentPersonalityId;
                }
                updateBadges();
                break;
            case 'tokenCalculationStarted':
                if (dom.contextLoadingSpinner) {
                    dom.contextLoadingSpinner.style.display = 'flex';
                    const text = dom.contextLoadingSpinner.querySelector('span');
                    if (text) text.textContent = message.text || 'Updating context...';
                    
                    const barContainer = document.getElementById('file-tree-progress-container');
                    if (barContainer) barContainer.style.display = 'none';
                }
                if (dom.tokenCountLabel) dom.tokenCountLabel.style.opacity = '0.5';
                break;
            case 'tokenCalculationProgress':
                {
                    const barContainer = document.getElementById('file-tree-progress-container');
                    const bar = document.getElementById('file-tree-progress-bar');
                    if (barContainer && bar) {
                        barContainer.style.display = 'block';
                        bar.style.width = `${message.progress}%`;
                    }
                }
                break;

            case 'tokenCalculationFinished':
                if (dom.contextLoadingSpinner) {
                    dom.contextLoadingSpinner.style.display = 'none';
                }
                if (dom.tokenCountLabel) dom.tokenCountLabel.style.opacity = '1';
                break;
            case 'updateTokenProgress':
                if (dom.tokenCountLabel) {
                    const { totalTokens, contextSize, error, isApproximate } = message;

                    if (error) {
                        dom.tokenCountLabel.textContent = `Tokens: ${error}`;
                        if (dom.tokenProgressBar) {
                            dom.tokenProgressBar.style.width = '100%';
                            dom.tokenProgressBar.className = 'token-progress-bar range-danger';
                        }
                    } else if (typeof totalTokens === 'number') {
                        const size = (contextSize > 0) ? contextSize : 128000;
                        dom.tokenCountLabel.textContent = `${isApproximate ? 'Est. ' : ''}Tokens: ${totalTokens.toLocaleString()} / ${size.toLocaleString()}`;
                        
                        updateProgressBar(dom.tokenProgressBar, totalTokens, size);

                        // Visual indicator on label for overflow
                        if (totalTokens > size) {
                            dom.tokenCountLabel.style.color = 'var(--vscode-charts-red)';
                            dom.tokenCountLabel.style.fontWeight = 'bold';
                        } else {
                            dom.tokenCountLabel.style.color = '';
                            dom.tokenCountLabel.style.fontWeight = 'normal';
                        }
                    }
                }
                break;
            case 'updateAgentMode':
                if (state.capabilities) {
                    state.capabilities.agentMode = message.isActive;
                }
                updateBadges();
                
                if (dom.agentModeCheckbox) dom.agentModeCheckbox.checked = message.isActive;
                
                if (!message.isActive) setGeneratingState(false);
                break;
            case 'error':
                setGeneratingState(false);
                // Also reset the git button if it was loading
                if (dom.stagingNextBtn) {
                    dom.stagingNextBtn.disabled = false;
                    dom.stagingNextBtn.innerHTML = dom.stagingNextBtn.dataset.originalText || 'Next (Generate Message)';
                }
                addMessage({ id: 'error_' + Date.now(), role: 'system', content: '❌ Error: ' + message.content }, true);
                break;
            case 'setInputText':
                if (dom.messageInput) {
                    dom.messageInput.value = message.text;
                    dom.messageInput.dispatchEvent(new Event('input'));
                    dom.messageInput.focus();
                }
                break;
            case 'forceScrollToBottom':
                if(dom.messagesDiv) dom.messagesDiv.scrollTop = dom.messagesDiv.scrollHeight;
                break;
            case 'imageGenerationResult':
                const btn = document.getElementById(message.buttonId) as HTMLButtonElement;
                if (btn) {
                    if (message.success) {
                        btn.innerHTML = `<span class="codicon codicon-check"></span> Saved!`;
                        btn.disabled = true;
                        const body = btn.closest('.generation-block')?.querySelector('.generation-body');
                        if (body) body.innerHTML = `<img src="${message.webviewUri}" style="max-width: 100%; border-radius: 4px;" />`;
                    } else {
                        btn.innerHTML = `<span class="codicon codicon-error"></span> Failed`;
                        btn.disabled = false;
                    }
                }
                break;
            case 'showAvailableTools':
                if (dom.toolsListDiv) {
                    dom.toolsListDiv.innerHTML = '';
                    message.allTools.forEach((tool: any) => {
                        const isChecked = message.enabledTools.includes(tool.name);
                        const toolItem = document.createElement('div');
                        toolItem.className = 'tool-item';
                        let settingsHtml = '';
                        if (tool.hasSettings) {
                            settingsHtml = `<button class="icon-btn tool-settings-btn" title="Configure Tool" data-tool="${tool.name}"><i class="codicon codicon-settings-gear"></i></button>`;
                        }
                        toolItem.innerHTML = `
                            <div class="checkbox-container" style="justify-content: space-between;">
                                <div style="display: flex; align-items: center;">
                                    <label class="switch">
                                        <input type="checkbox" class="tool-item-checkbox" id="tool-${tool.name}" value="${tool.name}" ${isChecked ? 'checked' : ''}>
                                        <span class="slider"></span>
                                    </label>
                                    <label for="tool-${tool.name}" class="tool-item-details">
                                        <strong>${tool.name}</strong><br>
                                        <span style="font-weight:normal; font-size: 0.9em; opacity: 0.8;">${tool.description}</span>
                                    </label>
                                </div>
                                ${settingsHtml}
                            </div>
                        `;
                        dom.toolsListDiv.appendChild(toolItem);
                    });
                    const settingsBtns = dom.toolsListDiv.querySelectorAll('.tool-settings-btn');
                    settingsBtns.forEach(btn => {
                        btn.addEventListener('click', (e) => {
                            e.stopPropagation();
                            vscode.postMessage({ command: 'openSettings' });
                        });
                    });
                }
                if (dom.toolsModal) {
                    dom.toolsModal.classList.add('visible');
                }
                break;
            case 'updateStatus':
                if (dom.statusLabel && dom.statusText) {
                    dom.statusText.textContent = message.status;
                    if (message.type === 'error') {
                        dom.statusLabel.classList.add('error');
                        if(dom.statusSpinner) dom.statusSpinner.style.display = 'none';
                    } else {
                        dom.statusLabel.classList.remove('error');
                        if(dom.statusSpinner) dom.statusSpinner.style.display = (message.status === 'Ready' || message.status.includes('Error')) ? 'none' : 'block';
                    }
                    dom.statusLabel.classList.add('visible');
                    if (message.status === 'Ready') {
                        setTimeout(() => {
                            dom.statusLabel.classList.remove('visible');
                        }, 3000);
                    }
                }
                break;
            case 'filesAddedToContext': {
                const { results, blockId } = message;
                const btnId = `btn-${blockId}`;
                const actionBtn = document.getElementById(btnId) as HTMLButtonElement;
                if (actionBtn) {
                    actionBtn.innerHTML = `<span class="codicon codicon-check"></span> Added to Context`;
                    actionBtn.classList.remove('apply-btn');
                    actionBtn.classList.add('applied'); // Turns Green
                    actionBtn.disabled = true;
                }

                // Update the file list visualization within the expansion block
                const listContainer = document.getElementById(`list-${blockId}`);
                if (listContainer) {
                    const items = listContainer.querySelectorAll('.expansion-file-item');
                    items.forEach((item: any) => {
                        const pathSpan = item.querySelector('span:last-child');
                        const path = pathSpan?.textContent?.trim();
                        if (path && results[path] === true) {
                            item.style.borderColor = 'var(--vscode-charts-green)';
                            item.style.background = 'rgba(15, 157, 88, 0.1)';
                            const icon = item.querySelector('.codicon');
                            if (icon) {
                                icon.classList.remove('codicon-file-add');
                                icon.classList.add('codicon-check');
                                icon.style.color = 'var(--vscode-charts-green)';
                            }
                        } else if (path && results[path] === false) {
                            item.style.borderColor = 'var(--vscode-charts-red)';
                            const icon = item.querySelector('.codicon');
                            if (icon) {
                                icon.classList.remove('codicon-file-add');
                                icon.classList.add('codicon-error');
                                icon.style.color = 'var(--vscode-charts-red)';
                            }
                        }
                    });
                }
                break;
            }
            case 'updateGitState': {
                state.currentBranch = message.branch;
                if (message.lastHash) {
                    state.lastCommitHash = message.lastHash;
                }
                updateBadges();
                break;
            }
            case 'setCommitMessage': {
                // Reset the staging button state
                if (dom.stagingNextBtn) {
                    dom.stagingNextBtn.disabled = false;
                    dom.stagingNextBtn.innerHTML = dom.stagingNextBtn.dataset.originalText || 'Next (Generate Message)';
                }
                // Close the staging modal now that we are moving to commit
                if (dom.stagingModal) {
                    dom.stagingModal.classList.remove('visible');
                }

                if (dom.commitMessageInput) {
                    dom.commitMessageInput.value = message.message;
                }
                if (dom.commitModal) {
                    dom.commitModal.classList.add('visible');
                }
                break;
            }
            case 'showGitHistory': {
                if (dom.historyList) {
                    dom.historyList.innerHTML = '';
                    const currentHash = message.currentHash || '';
                    
                    message.commits.forEach((c: any) => {
                        const div = document.createElement('div');
                        const isCurrent = currentHash === c.hash;
                        
                        div.className = `custom-menu-item ${isCurrent ? 'current-head' : ''}`;
                        div.innerHTML = `
                            <div style="display:flex; flex-direction:column; width:100%;">
                                <div style="font-weight:bold; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${c.message}</div>
                                <div style="font-size:0.85em; opacity:0.8;">${c.hash.substring(0,7)} - ${c.date}</div>
                            </div>
                        `;
                        
                        div.onclick = () => {
                            if (isCurrent) return;
                            vscode.postMessage({ command: 'performRevert', hash: c.hash });
                            if (dom.historyModal) dom.historyModal.classList.remove('visible');
                        };
                        dom.historyList.appendChild(div);
                    });
                }
                if (dom.historyModal) dom.historyModal.classList.add('visible');
                break;
            }
            case 'showStagingModal': {
                const { staged, unstaged, untracked } = message.status;
                if (dom.stagingList) {
                    dom.stagingList.innerHTML = '';
                    
                    const createSection = (title: string, files: string[], checked: boolean) => {
                        if (files.length === 0) return;
                        const header = document.createElement('h3');
                        header.textContent = title;
                        header.style.marginTop = '10px';
                        header.style.marginBottom = '5px';
                        header.style.fontSize = '12px';
                        header.style.color = 'var(--vscode-descriptionForeground)';
                        dom.stagingList.appendChild(header);
                        
                        files.forEach(f => {
                            const div = document.createElement('div');
                            div.className = 'checkbox-container';
                            div.style.marginTop = '4px';
                            div.innerHTML = `
                                <label class="switch" style="width:24px; height:14px; margin-right:8px;">
                                    <input type="checkbox" value="${f}" ${checked ? 'checked' : ''}>
                                    <span class="slider" style="border-radius:14px;"></span>
                                </label>
                                <span style="font-size:12px;">${f}</span>
                            `;
                            dom.stagingList.appendChild(div);
                        });
                    };

                    const defaults = (staged.length > 0);
                    createSection('Staged Changes', staged, true);
                    createSection('Modified Changes', unstaged, !defaults);
                    createSection('Untracked Files', untracked, !defaults);
                }
                if (dom.stagingModal) dom.stagingModal.classList.remove('visible');
                break;
            }
            case 'updateDiscussionPersonality':
                state.currentPersonalityId = message.personalityId;
                if (dom.personalitySelector) {
                    dom.personalitySelector.value = message.personalityId;
                }
                updateBadges();
                break;
            case 'fileSearchResults':
                if (dom.fileSearchResults) {
                    const masterContainer = document.getElementById('file-search-master-container');
                    if (masterContainer) {
                        masterContainer.style.display = message.results.length > 0 ? 'flex' : 'none';
                        const masterCheck = masterContainer.querySelector('input');
                        if (masterCheck) masterCheck.checked = false;
                    }
                    // REPLACED: Use updated list renderer with snippets
                    renderFileSearchResults(dom.fileSearchResults, message.results, message.query);
                }
                break;
            case 'showDiscussionSearchModal':
                if (dom.discussionSearchModal) {
                    dom.discussionSearchModal.classList.add('visible');
                    dom.discussionSearchInput.focus();
                }
                break;
            case 'discussionSearchResults':
                renderDiscussionSearchResults(message.results, dom.discussionSearchInput.value);
                break;
            case 'contextUsageData':
                renderContextUsage(message.usage);
                break;
            case 'updateContextFileUsage':
                updateContextFileUsage(message.path, message.tokens);
                break;
            case 'webSearchResults':
                renderWebSearchResults(message.action, message.results);
                break;
            case 'showSkillsModal':
                if (dom.skillsModal) {
                    dom.skillsModal.classList.add('visible');
                    if (message.loading) {
                        dom.skillsTreeContainer.innerHTML = '<div class="big-spinner"></div>';
                        dom.skillsTreeContainer.classList.add('loading');
                        dom.skillsImportBtn.disabled = true;
                    } else {
                        dom.skillsTreeContainer.classList.remove('loading');
                        dom.skillsTreeContainer.innerHTML = '';
                        renderSkillsTree(dom.skillsTreeContainer, message.skillsTree, message.activeSkillIds);
                        dom.skillsImportBtn.disabled = false;
                    }
                }
                break;
            case 'closeSkillsModal':
                if (dom.skillsModal) dom.skillsModal.classList.remove('visible');
                break;                
            case 'applyAllStart': {
                const wrapper = document.querySelector(`.message-wrapper[data-message-id='${message.messageId}']`);
                const hunkAttr = message.hunkIndex !== undefined ? `[data-hunk-index='${message.hunkIndex}']` : ':not([data-hunk-index])';
                const row = wrapper?.querySelector(`.apply-row[data-block-index='${message.blockIndex}']${hunkAttr}`);
                if (row) {
                    const iconEl = row.querySelector('.status-icon');
                    if (iconEl) iconEl.innerHTML = '<div class="spinner"></div>';
                    row.style.background = 'rgba(255, 255, 255, 0.05)';
                }
                break;
            }
            case 'verifyAllResult':
                {
                    const wrapper = document.querySelector(`.message-wrapper[data-message-id='${message.messageId}']`);
                    const verifyBtn = wrapper?.querySelector('.apply-all-btn.secondary-btn') as HTMLButtonElement;
                    if (verifyBtn) {
                        verifyBtn.disabled = false;
                        verifyBtn.innerHTML = '<span class="codicon codicon-search"></span> Verify Status';
                    }

                    const results = message.results; // { "block-hunk": "status" }
                    const rows = wrapper?.querySelectorAll('.apply-row');
                    rows?.forEach((row: any) => {
                        const bIdx = row.dataset.blockIndex;
                        const hIdx = row.dataset.hunkIndex || 'full';
                        const status = results[`${bIdx}-${hIdx}`];
                        const iconEl = row.querySelector('.status-icon');

                        if (status === 'applied') {
                            row.style.background = 'rgba(15, 157, 88, 0.1)';
                            iconEl.innerHTML = '<span class="codicon codicon-check" style="color:var(--vscode-charts-green)"></span>';
                        } else if (status === 'ready') {
                            row.style.background = 'rgba(0, 122, 204, 0.1)';
                            iconEl.innerHTML = '<span class="codicon codicon-clock" style="color:var(--vscode-charts-blue)"></span>';
                        } else {
                            row.style.background = 'rgba(244, 71, 71, 0.1)';
                            iconEl.innerHTML = '<span class="codicon codicon-error" style="color:var(--vscode-charts-red)"></span>';
                        }
                    });
                    break;
                }
            case 'applyAllResult':
                {
                    const wrapper = document.querySelector(`.message-wrapper[data-message-id='${message.messageId}']`);
                    if (!wrapper) break;

                    // 1. Update the individual code block UI (even if it wasn't part of an "Apply All" run)
                    const targetBlockId = `block-${message.messageId}-${message.blockIndex}`;
                    const blockEl = document.getElementById(targetBlockId) as HTMLDetailsElement;

                    if (blockEl && message.success) {
                        // Handle specific hunk button or main block button
                        if (message.hunkIndex !== undefined) {
                            const hunkBubbles = blockEl.querySelectorAll('.aider-hunk-bubble');
                            const targetHunk = hunkBubbles[message.hunkIndex];
                            if (targetHunk) {
                                const hunkBtn = targetHunk.querySelector('.apply-btn');
                                if (hunkBtn) {
                                    hunkBtn.classList.add('applied');
                                    hunkBtn.innerHTML = '<span class="codicon codicon-check"></span>';
                                }
                                targetHunk.classList.add('collapsed');
                            }
                            
                            // If all hunks in this block are now applied, mark the main block button too
                            const totalHunks = hunkBubbles.length;
                            const appliedHunks = blockEl.querySelectorAll('.aider-hunk-actions .apply-btn.applied').length;
                            if (appliedHunks === totalHunks) {
                                const mainApplyBtn = blockEl.querySelector('.code-actions .apply-btn');
                                if (mainApplyBtn) {
                                    mainApplyBtn.classList.add('applied');
                                    mainApplyBtn.innerHTML = '<span class="codicon codicon-check"></span>';
                                }
                                blockEl.open = false; // Collapse only when fully finished
                            }
                        } else {
                            // Full block applied successfully
                            const mainApplyBtn = blockEl.querySelector('.code-actions .apply-btn');
                            if (mainApplyBtn) {
                                mainApplyBtn.classList.add('applied');
                                mainApplyBtn.innerHTML = '<span class="codicon codicon-check"></span>';
                            }
                            // Also mark all internal hunks as applied
                            blockEl.querySelectorAll('.aider-hunk-actions .apply-btn').forEach(btn => {
                                btn.classList.add('applied');
                                btn.innerHTML = '<span class="codicon codicon-check"></span>';
                            });
                            blockEl.querySelectorAll('.aider-hunk-bubble').forEach(h => h.classList.add('collapsed'));
                            blockEl.open = false;
                        }
                    } else if (blockEl && !message.success) {
                        // FAILURE CASE: Restore the button so the user can try again
                        const mainApplyBtn = blockEl.querySelector('.code-actions .apply-btn') as HTMLButtonElement;
                        if (mainApplyBtn && mainApplyBtn.dataset.originalHtml) {
                            mainApplyBtn.disabled = false;
                            mainApplyBtn.innerHTML = mainApplyBtn.dataset.originalHtml;
                        }
                    }

                    // 2. Update the "Apply All" list row if it exists
                    const hunkAttr = message.hunkIndex !== undefined ? `[data-hunk-index='${message.hunkIndex}']` : ':not([data-hunk-index])';
                    const row = wrapper.querySelector(`.apply-row[data-block-index='${message.blockIndex}']${hunkAttr}`) as HTMLElement;
                    
                    if (row && message.success) {
                        const iconEl = row.querySelector('.status-icon');
                        row.style.background = 'rgba(15, 157, 88, 0.1)'; 
                        
                        if (message.alreadyApplied) {
                            row.style.opacity = '0.6';
                            if (iconEl) iconEl.innerHTML = '<span class="codicon codicon-check" style="color:var(--vscode-charts-green)" title="Already matches file on disk"></span>';
                        } else {
                            if (iconEl) iconEl.innerHTML = '<span class="codicon codicon-check" style="color:var(--vscode-charts-green)"></span>';
                        }
                    } else if (row) {
                        row.style.background = 'rgba(244, 71, 71, 0.15)'; // Error tint
                        const iconEl = row.querySelector('.status-icon');
                        const actionsEl = row.querySelector('.row-actions') as HTMLElement;

                        if (iconEl) {
                            iconEl.innerHTML = '<span class="codicon codicon-error" style="color:var(--vscode-charts-red)" title="' + (message.error || 'Failed') + '"></span>';
                        }

                        if (actionsEl) {
                            actionsEl.style.display = 'flex';
                            
                            // If the extension tells us it's already repairing, show spinner immediately
                            if (message.repaired === 'in_progress') {
                                actionsEl.innerHTML = '<button class="code-action-btn apply-btn retry-row-btn" disabled style="height:20px; font-size:9px; padding:0 6px;"><div class="spinner"></div> Repairing...</button>';
                            } else {
                                actionsEl.innerHTML = '<button class="code-action-btn apply-btn retry-row-btn" style="height:20px; font-size:9px; padding:0 6px;">Fix with AI</button>';
                                const retryBtn = actionsEl.querySelector('.retry-row-btn') as HTMLButtonElement;
                                retryBtn.onclick = () => {
                                    retryBtn.disabled = true;
                                    retryBtn.innerHTML = '<div class="spinner"></div> Repairing...';
                                    
                                    // Ensure main button doesn't turn green while we fix this hunk
                                    const btnContainer = resultsList?.previousElementSibling;
                                    const mainBtn = btnContainer?.querySelector('.apply-all-btn:not(.secondary-btn)') as HTMLButtonElement;
                                    if (mainBtn) {
                                        mainBtn.classList.add('stop-btn-red');
                                        mainBtn.innerHTML = '<span class="codicon codicon-sync spin"></span> Repairing Hunks...';
                                    }

                                    vscode.postMessage({ 
                                        command: 'replaceCode', 
                                        filePath: message.filePath, 
                                        content: "REPAIR_REQUESTED", 
                                        messageId: message.messageId,
                                        blockIndex: message.blockIndex,
                                        hunkIndex: message.hunkIndex,
                                        options: { silent: true }
                                    });
                                };
                            }
                        }
                    }


                    // Update main "Apply All" button state if everything is finished
                    const resultsList = row?.closest('.apply-results-list');
                    if (resultsList) {
                        const stillPending = resultsList.querySelectorAll('.spinner').length;
                        if (stillPending === 0) {
                            const btnContainer = resultsList.previousElementSibling;
                            const mainBtn = btnContainer?.querySelector('.apply-all-btn:not(.secondary-btn)') as HTMLButtonElement;
                            
                            if (mainBtn && (mainBtn.classList.contains('stop-btn-red') || mainBtn.classList.contains('sequential-applying'))) {
                                mainBtn.classList.remove('stop-btn-red');
                                mainBtn.classList.remove('sequential-applying');
                                
                                const failedCount = resultsList.querySelectorAll('.codicon-error').length;
                                if (failedCount === 0) {
                                    const autoRepairing = resultsList.querySelectorAll('.retry-row-btn:disabled').length;
                                    if (autoRepairing === 0) {
                                        mainBtn.innerHTML = '<span class="codicon codicon-check"></span> All Modifications Applied';
                                        mainBtn.classList.add('applied');
                                        mainBtn.style.setProperty('background-color', 'var(--vscode-charts-green)', 'important');
                                        mainBtn.style.setProperty('color', 'white', 'important');
                                        mainBtn.disabled = true;
                                    }
                                } else {
                                    mainBtn.innerHTML = `<span class="codicon codicon-warning"></span> Retry Failed (${failedCount})`;
                                    mainBtn.style.setProperty('background-color', 'var(--vscode-charts-red)', 'important');
                                    mainBtn.disabled = false;
                                }
                            }
                        }
                    }
                }
                break;

            // Handle direct replaceCode command from the extension
            case 'replaceCode':
                {
                    const { filePath, content, options } = message;
                    vscode.commands.executeCommand('lollms-vs-coder.replaceCode', filePath, content, this, message.id, options ?? {});
                }
                break;
            }
    } catch(e: any) {
        console.error("Lollms Webview Error: Failed to process message from extension.", e);
        vscode.postMessage({ command: 'showError', message: 'Webview error: ' + e.message });
    }
}

