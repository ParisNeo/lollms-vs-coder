import { dom, vscode, state } from './dom.js';
import DOMPurify from 'dompurify';
import { addMessage, renderMessageContent, updateContext, displayPlan, scheduleRender, checkAndSyncMessageAppliedState } from './messageRenderer.js';

const sanitizer = typeof DOMPurify === 'function' ? (DOMPurify as any)(window) : DOMPurify;
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
                        const personalityName = wrapper.dataset.personalityName;
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
                    
                    // HAL9000: Speak the result only if enabled in capabilities
                    if (state.capabilities?.enableTTS && typeof (window as any).halSpeak === 'function') {
                        // Strip markdown and code blocks for cleaner speech
                        const plainText = message.fullContent.replace(/```[\s\S]*?```/g, '').replace(/[#*`]/g, '');
                        (window as any).halSpeak(plainText);
                    }
                }
                break;
            case 'openMissionBriefingModal':
                if (dom.missionBriefingModal) {
                    if (dom.briefingContentInput) {
                        dom.briefingContentInput.value = message.briefing || '';
                    }
                    if (dom.briefingDnaPreview) {
                        dom.briefingDnaPreview.innerHTML = message.dna ? sanitizer.sanitize(marked.parse(message.dna) as string) : 'No Project DNA found.';
                    }
                    
                    const radios = document.getElementsByName('briefing-scope');
                    radios.forEach((r: any) => {
                        if (r.value === (message.isGlobal ? 'global' : 'local')) {
                            r.checked = true;
                        }
                    });
                    
                    dom.missionBriefingModal.classList.add('visible');
                }
                break;
            case 'updateBriefingContent':
                if (dom.briefingContentInput) {
                    const current = dom.briefingContentInput.value;
                    dom.briefingContentInput.value = current ? current + '\n\n' + message.text : message.text;
                }
                break;
            case 'imageUriResolved':
                {
                    const container = document.getElementById(message.targetId);
                    if (container) {
                        container.innerHTML = `<img src="${message.uri}" style="max-width: 100%; border-radius: 4px; box-shadow: 0 4px 10px rgba(0,0,0,0.5); cursor: zoom-in;" onclick="window.open('${message.uri}')" />`;

                        // If this was an auto-resolution for a generation block, mark the button as done
                        if (message.targetId.startsWith('prev-gen-')) {
                            const btnId = message.targetId.replace('prev-', 'btn-');
                            const btn = document.getElementById(btnId) as HTMLButtonElement;
                            if (btn) {
                                btn.innerHTML = `<span class="codicon codicon-check"></span> Existing Asset`;
                                btn.classList.replace('apply-btn', 'applied');
                                btn.disabled = true;
                            }
                        }
                    }
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
                updateContext(message.context, message.files, message.skills, message.diagrams, message.briefing);
                break;
            case 'updateDiscussionSkillsMetadata':
                if (state.lastContextData) {
                    state.lastContextData.skillIds = message.skillIds;
                    // Trigger a re-render of the context header specifically
                    import('./messageRenderer.js').then(m => m.updateContext(
                        state.lastContextData!.context, 
                        state.lastContextData!.files, 
                        state.lastContextData!.skills
                    ));
                }
                break;
            case 'displayPlan':
                displayPlan(message.plan);
                break;
            case 'loadDiscussion':
                {
                    if (message.workspaceFolders) {
                        (window as any).workspaceFolders = message.workspaceFolders;
                    }
                    if (message.currentModel) {
                        state.currentModelName = message.currentModel;
                    }
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

                    // Restore Agent Mode UI state (Red vs Blue)
                    if (message.agentMode !== undefined && state.capabilities) {
                        state.capabilities.agentMode = message.agentMode;
                        updateBadges(); // This refreshes the HUD and applies theme classes
                    }

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

                    if (dom.attachmentsContainer) {
                        const wrapper = dom.attachmentsContainer.closest('.special-zone-message');
                        if (wrapper) {
                            (wrapper as HTMLElement).style.display = dom.attachmentsContainer.children.length > 0 ? 'flex' : 'none';
                        }
                    }

                    setGeneratingState(false);
                    if(dom.messagesDiv) dom.messagesDiv.scrollTop = dom.messagesDiv.scrollHeight;
                }
                break;

            case 'updateDiscussionCapabilities':
                const caps = message.capabilities;
                if (message.workspaceFolders) {
                    (window as any).workspaceFolders = message.workspaceFolders;
                }
                if (caps) {
                    const oldSettings = JSON.stringify(state.capabilities?.folderSettings || {});
                    state.capabilities = caps;

                    // Reactive matrix update if open
                    if (dom.matrixModal.classList.contains('visible')) {
                        const newSettings = JSON.stringify(caps.folderSettings || {});
                        if (oldSettings !== newSettings) {
                            import('./ui.js').then(ui => ui.renderWorkspaceMatrix());
                        }
                    }
                    
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
                    if (dom.testModeCheckbox) dom.testModeCheckbox.checked = !!caps.testMode;
                    if (dom.docsModeCheckbox) dom.docsModeCheckbox.checked = !!caps.documentationMode;
                    if (dom.capClipboardRole) dom.capClipboardRole.value = caps.clipboardInsertRole || 'user';
                    
                    const langSelect = document.getElementById('modal-language') as HTMLSelectElement;
                    if (langSelect) langSelect.value = caps.language || 'auto';

                    const ttftInput = document.getElementById('modal-ttft-timeout') as HTMLInputElement;
                    if (ttftInput) ttftInput.value = (caps.ttftTimeout ?? 0).toString();

                    const interInput = document.getElementById('modal-inter-token-timeout') as HTMLInputElement;
                    if (interInput) interInput.value = (caps.interTokenTimeout ?? 0).toString();

                    const tempInput = document.getElementById('modal-temperature') as HTMLInputElement;
                    const tempVal = document.getElementById('modal-temperature-val');
                    if (tempInput) {
                        tempInput.value = (caps.temperature ?? 0.7).toString();
                        if (tempVal) tempVal.textContent = tempInput.value;
                    }

                    // Trigger a re-population of voices to ensure selection matches
                    if (typeof window.speechSynthesis.onvoiceschanged === 'function') {
                        (window.speechSynthesis.onvoiceschanged as any)();
                    }
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
                    if (dom.capMaxDebugSteps) dom.capMaxDebugSteps.value = (caps.maxDebugSteps || 10).toString();

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
                        import('./messageRenderer.js').then(module => {
                            module.updateContext(
                                state.lastContextData!.context, 
                                state.lastContextData!.files, 
                                state.lastContextData!.skills
                            );
                        });
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
            case 'updateModelNameOnly':
                state.currentModelName = message.modelName;
                if (state.lastContextData) {
                    import('./messageRenderer.js').then(m => m.updateContext(state.lastContextData!.context, state.lastContextData!.files, state.lastContextData!.skills, state.lastContextData!.diagrams, state.lastContextData!.briefing));
                }
                break;

            case 'updateModels':
                if(dom.refreshModelsBtn) {
                    const icon = dom.refreshModelsBtn.querySelector('.codicon');
                    if(icon) icon.classList.remove('spin');
                }
                if (message.currentModel) {
                    state.currentModelName = message.currentModel;
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
                    // Force refresh context header to sync model name
                    if (state.lastContextData) {
                        import('./messageRenderer.js').then(m => m.updateContext(state.lastContextData!.context, state.lastContextData!.files, state.lastContextData!.skills, state.lastContextData!.diagrams, state.lastContextData!.briefing));
                    }
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
                if (dom.refreshContextBtn) dom.refreshContextBtn.style.display = 'none';
                if (dom.cancelTokensBtn) dom.cancelTokensBtn.style.display = 'inline-block';
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
                if (dom.refreshContextBtn) dom.refreshContextBtn.style.display = 'inline-block';
                if (dom.cancelTokensBtn) dom.cancelTokensBtn.style.display = 'none';
                if (dom.contextLoadingSpinner) {
                    dom.contextLoadingSpinner.style.display = 'none';
                }
                if (dom.tokenCountLabel) dom.tokenCountLabel.style.opacity = '1';
                break;
            case 'updateTokenProgress':
                if (dom.tokenCountLabel) {
                    const { totalTokens, contextSize, error, isApproximate, folderStats } = message;

                    if (folderStats) {
                        state.matrixStats = folderStats;
                        // Reactive matrix update if open
                        if (dom.matrixModal.classList.contains('visible')) {
                            import('./ui.js').then(ui => ui.renderWorkspaceMatrix());
                        }
                    }

                    if (error) {
                        dom.tokenCountLabel.textContent = `Tokens: ${error}`;
                        if (dom.tokenProgressBar) {
                            dom.tokenProgressBar.style.width = '100%';
                            dom.tokenProgressBar.className = 'token-progress-bar range-danger';
                        }
                    } else if (typeof totalTokens === 'number') {
                        const size = (contextSize > 0) ? contextSize : 128000;
                        dom.tokenCountLabel.textContent = `${isApproximate ? 'Est. ' : ''}Tokens: ${totalTokens.toLocaleString()} / ${size.toLocaleString()}`;
                        
                        // Pass segments to the progress bar
                        updateProgressBar(dom.tokenProgressContainer, totalTokens, size, message.segments);

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
                const genBtn = document.getElementById(message.buttonId) as HTMLButtonElement;
                if (genBtn) {
                    if (message.success) {
                        genBtn.innerHTML = `<span class="codicon codicon-check"></span> Generated`;
                        genBtn.classList.replace('apply-btn', 'applied');
                        genBtn.disabled = true;

                        // Target the specific preview zone via dataset
                        const previewId = genBtn.dataset.previewId;
                        const previewZone = document.getElementById(previewId || '');
                        if (previewZone) {
                            previewZone.innerHTML = `<img src="${message.webviewUri}" style="max-width: 100%; border-radius: 4px; box-shadow: 0 4px 10px rgba(0,0,0,0.3); cursor: pointer;" onclick="window.open('${message.uri || message.webviewUri}')" />`;
                        }
                    } else {
                        btn.innerHTML = `<span class="codicon codicon-error"></span> Failed`;
                        btn.disabled = false;
                    }
                }
                break;
            case 'showAvailableTools':
                import('./ui.js').then(ui => {
                    const policies = state.capabilities?.toolPolicies || {};
                    ui.renderAdvancedToolsList(message.allTools, policies);
                    if (dom.toolsModal) {
                        dom.toolsModal.classList.add('visible');
                    }
                });
                break;
            case 'updateStatus':
                if (dom.statusLabel && dom.statusText) {
                    dom.statusText.textContent = message.status;
                    const isReady = message.status.startsWith('Ready');
                    const isError = message.type === 'error' || message.status.includes('Error');

                    if (isError) {
                        dom.statusLabel.classList.add('error');
                    } else {
                        dom.statusLabel.classList.remove('error');
                    }

                    if (dom.statusSpinner) {
                        // Force hide spinner if status is Ready or Error
                        dom.statusSpinner.style.display = (isReady || isError) ? 'none' : 'block';
                    }

                    // Also hide the separate token loading spinner if it exists
                    if (isReady && dom.contextLoadingSpinner) {
                        dom.contextLoadingSpinner.style.display = 'none';
                    }

                    dom.statusLabel.classList.add('visible');
                    if (isReady) {
                        setTimeout(() => {
                            dom.statusLabel.classList.remove('visible');
                        }, 3000);
                    }
                }
                break;
            case 'filesAddedToContext': {
                const { results, blockId } = message;

                // 1. Trigger token refresh immediately
                vscode.postMessage({ command: 'calculateTokens' });

                // 2. RESILIENT BUTTON FINDER: 
                // Try ID first, then fallback to finding ANY active spinner button in the whole document.
                let buttons = [
                    document.getElementById(`btn-${blockId}`),
                    document.getElementById(`btn-reprompt-${blockId}`)
                ].filter(b => b !== null) as HTMLButtonElement[];

                if (buttons.length === 0) {
                    // Fallback: Find any button that says "Adding..." or has a spinner
                    buttons = Array.from(document.querySelectorAll('.add-files-to-context-btn, .add-and-reprompt-btn'))
                        .filter(b => b.innerHTML.includes('spinner') || b.textContent?.includes('Adding')) as HTMLButtonElement[];
                }

                // 3. Update all identified buttons to 'Success' state
                buttons.forEach(btn => {
                    const isReprompt = btn.classList.contains('add-and-reprompt-btn');
                    btn.innerHTML = isReprompt ? `<span class="codicon codicon-check"></span> Added` : `<span class="codicon codicon-check"></span> Added to Context`;
                    btn.classList.remove('apply-btn');
                    btn.classList.add('applied');
                    btn.disabled = true;
                    // Remove loading class if present
                    btn.classList.remove('loading');
                });

                // 4. Update the individual file rows
                const listContainer = document.getElementById(`list-${blockId}`) || 
                                      buttons[0]?.closest('.context-expansion-block')?.querySelector('.expansion-file-list');
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
                // Check if the Raw Code Modal is open, if so, route results there
                if (dom.rawCodeModal.classList.contains('visible') && dom.rawSearchResultsMini) {
                    dom.rawSearchResultsMini.style.display = 'flex';
                    if (message.results.length === 0) {
                        dom.rawSearchResultsMini.innerHTML = '<div style="padding:20px; opacity:0.6; text-align:center;"><i class="codicon codicon-search-stop" style="font-size:20px;"></i><br>No cross-file matches found for this selection.</div>';
                    } else {
                        dom.rawSearchResultsMini.innerHTML = `
                            <div style="font-size: 10px; font-weight: bold; opacity: 0.6; padding: 8px; border-bottom: 1px solid var(--vscode-widget-border); margin-bottom: 5px;">
                                <i class="codicon codicon-info"></i> CLICK TO COPY & OPEN
                            </div>
                            ` + message.results.map((res: any) => {
                            const safeSnippet = sanitizer.sanitize(res.snippet);
                            
                            return `
                            <div class="mini-search-item raw-stitch-result-item" 
                                 style="flex-direction:column; align-items:flex-start; gap:4px; padding: 8px; border-bottom: 1px solid var(--vscode-widget-border); cursor:pointer;" 
                                 data-path="${res.path}" 
                                 data-query="${message.query.replace(/"/g, '&quot;')}"
                                 data-line="${res.line}">
                                <div style="display:flex; justify-content:space-between; width:100%; font-size: 11px; pointer-events:none;">
                                    <span style="font-weight:bold; color: var(--vscode-textLink-foreground);">${res.path.split('/').pop()}</span>
                                    <span style="opacity:0.5; font-size:9px;">L${res.line}</span>
                                </div>
                                <div style="pointer-events:none; font-size:10px; opacity:0.8; font-family:var(--vscode-editor-font-family); white-space:pre; overflow:hidden; text-overflow:ellipsis; width:100%; background:rgba(0,0,0,0.2); padding:2px 4px; border-radius:2px;">${safeSnippet}</div>
                            </div>
                        `}).join('');
                    }
                    return;
                }

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
                        dom.skillsTreeContainer.classList.add('loading');
                        dom.skillsTreeContainer.innerHTML = `
                            <div class="big-spinner"></div>
                            <div class="loading-caption">Indexing Skills Library...</div>
                        `;
                        dom.skillsImportBtn.disabled = true;
                    } else {
                        dom.skillsTreeContainer.classList.remove('loading');
                        dom.skillsTreeContainer.innerHTML = '';
                        renderSkillsTree(dom.skillsTreeContainer, message.skillsTree, message.discussionSkills, message.projectSkills);
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
                        const isUndo = message.options?.undo === true;

                        // 1. Sync Local Memory State
                        if (!state.appliedState[message.messageId]) state.appliedState[message.messageId] = {};
                        if (!state.appliedState[message.messageId][message.blockIndex]) state.appliedState[message.messageId][message.blockIndex] = [];

                        const hunkVal = message.hunkIndex !== undefined ? message.hunkIndex : -1;
                        if (isUndo) {
                            state.appliedState[message.messageId][message.blockIndex] = state.appliedState[message.messageId][message.blockIndex].filter(v => v !== hunkVal);
                            if (hunkVal === -1) state.appliedState[message.messageId][message.blockIndex] = [];
                        } else {
                            if (!state.appliedState[message.messageId][message.blockIndex].includes(hunkVal)) {
                                state.appliedState[message.messageId][message.blockIndex].push(hunkVal);
                            }
                        }

                        const restoreBtn = (btn: HTMLButtonElement) => {
                            const bubble = btn.closest('.aider-hunk-bubble, .code-collapsible');
                            const undoBtn = bubble?.querySelector('.delete-btn') as HTMLButtonElement;

                            if (isUndo) {
                                btn.disabled = false;
                                btn.classList.remove('applied');
                                // Restore original icon based on block type
                                const isSurgical = btn.closest('.aider-hunk-bubble') || btn.innerHTML.includes('arrow');
                                btn.innerHTML = btn.dataset.originalHtml || (isSurgical ? '<span class="codicon codicon-arrow-swap"></span>' : '<span class="codicon codicon-tools"></span>');
                                if (undoBtn) undoBtn.style.display = 'none';
                            } else {
                                // Keep enabled to allow re-application
                                btn.disabled = false; 
                                btn.classList.add('applied');
                                btn.innerHTML = '<span class="codicon codicon-check"></span>';
                                if (undoBtn) undoBtn.style.display = 'flex';
                            }
                        };

                        if (message.hunkIndex !== undefined) {
                            const hunkBubbles = blockEl.querySelectorAll('.aider-hunk-bubble');
                            const targetHunk = hunkBubbles[message.hunkIndex];
                            if (targetHunk) {
                                const hunkBtn = targetHunk.querySelector('.apply-btn');
                                if (hunkBtn) restoreBtn(hunkBtn);
                                targetHunk.classList.add('collapsed');
                            }
                        } else {
                            const mainApplyBtn = document.getElementById(`apply-btn-${message.messageId}-${message.blockIndex}`);
                            if (mainApplyBtn) restoreBtn(mainApplyBtn);
                            
                            blockEl.querySelectorAll('.aider-hunk-actions .apply-btn').forEach(restoreBtn);
                            blockEl.querySelectorAll('.aider-hunk-bubble').forEach(h => h.classList.add('collapsed'));
                        }

                        // RE-SYNC main button state for the entire message
                        checkAndSyncMessageAppliedState(message.messageId);

                    } else if (blockEl && !message.success) {
                        // VISUAL RED ALERT: Set state to error
                        blockEl.classList.add('malformed');
                        blockEl.style.borderColor = 'var(--vscode-errorForeground)';

                        // FAILURE CASE: Restore the button so the user can try again
                        const mainApplyBtn = document.getElementById(`apply-btn-${message.messageId}-${message.blockIndex}`);
                        if (mainApplyBtn && mainApplyBtn.dataset.originalHtml) {
                            mainApplyBtn.disabled = false;
                            mainApplyBtn.innerHTML = mainApplyBtn.dataset.originalHtml;
                        }
                        
                        // Also restore any individual hunk buttons
                        if (message.hunkIndex !== undefined) {
                            const hunkBubbles = blockEl.querySelectorAll('.aider-hunk-bubble');
                            const targetHunk = hunkBubbles[message.hunkIndex];
                            const hunkBtn = targetHunk?.querySelector('.apply-btn');
                            if (hunkBtn && hunkBtn.dataset.originalHtml) {
                                hunkBtn.disabled = false;
                                hunkBtn.innerHTML = hunkBtn.dataset.originalHtml;
                            }
                        }

                        // AUTOMATIC REDIRECTION to Raw Code Modal for manual fix
                        if (!message.repaired && !message.alreadyApplied) {
                            const codeText = blockEl.dataset.rawCode || "";
                            const aiderRegex = /<<<<<<< SEARCH\\r?\\n([\\s\\S]*?)\\r?\\n=======\\r?\\n([\\s\\S]*?)\\r?\\n>>>>>>> REPLACE/g;
                            const matches =[...codeText.matchAll(aiderRegex)];
                            const hunkContent = (message.hunkIndex !== undefined && matches[message.hunkIndex]) 
                                ? matches[message.hunkIndex][0] 
                                : codeText;
                            
                            if (dom.rawCodeDisplay) {
                                dom.rawCodeFilename.textContent = message.filePath;
                                const hunkIdEl = document.getElementById('raw-hunk-id');
                                if (hunkIdEl) hunkIdEl.textContent = message.hunkIndex !== undefined ? `HUNK ${message.hunkIndex + 1}` : 'FULL';
                                dom.rawCodeDisplay.textContent = hunkContent;
                                dom.rawCodeDisplay.dataset.messageId = message.messageId;
                                dom.rawCodeDisplay.dataset.blockIndex = String(message.blockIndex);
                                dom.rawCodeDisplay.dataset.hunkIndex = message.hunkIndex !== undefined ? String(message.hunkIndex) : "";
                                dom.rawCodeModal.classList.add('visible');
                            }
                        }
                    }

                    // 2. Update the "Apply All" list row if it exists
                    const hunkAttr = message.hunkIndex !== undefined ? `[data-hunk-index='${message.hunkIndex}']` : ':not([data-hunk-index])';
                    const row = wrapper.querySelector(`.apply-row[data-block-index='${message.blockIndex}']${hunkAttr}`) as HTMLElement;
                    
                    if (row && message.success) {
                        const iconEl = row.querySelector('.status-icon');
                        const actionsEl = row.querySelector('.row-actions') as HTMLElement;

                        if (message.alreadyApplied) {
                            row.style.background = 'rgba(15, 157, 88, 0.05)'; 
                            row.style.opacity = '0.7';
                            if (iconEl) iconEl.innerHTML = '<span class="codicon codicon-check-all" style="color:var(--vscode-charts-green)" title="Already applied to disk"></span>';
                        } else {
                            row.style.background = 'rgba(15, 157, 88, 0.15)'; 
                            row.style.opacity = '1';
                            if (iconEl) iconEl.innerHTML = '<span class="codicon codicon-check" style="color:var(--vscode-charts-green)" title="Applied successfully"></span>';
                        }

                        if (actionsEl) {
                            actionsEl.style.display = 'flex';
                            actionsEl.innerHTML = `<button class="icon-btn view-diff-row-btn" title="View Changes (Diff)" style="height:20px; width:20px;"><i class="codicon codicon-diff"></i></button>`;
                            const diffBtn = actionsEl.querySelector('.view-diff-row-btn') as HTMLElement;
                            diffBtn.onclick = (e) => {
                                e.stopPropagation();
                                vscode.postMessage({ command: 'executeLollmsCommand', details: { command: 'lollms-vs-coder.showDiff', params: message.filePath }});
                            };
                        }
                    } else if (row) {
                        row.style.background = 'rgba(244, 71, 71, 0.1)'; 
                        const iconEl = row.querySelector('.status-icon');
                        const actionsEl = row.querySelector('.row-actions') as HTMLElement;

                        if (iconEl) {
                            iconEl.innerHTML = '<span class="codicon codicon-error" style="color:var(--vscode-charts-red)" title="' + (message.error || 'Failed') + '"></span>';
                        }

                        if (actionsEl) {
                            actionsEl.style.display = 'flex';
                            actionsEl.innerHTML = `
                                <div class="failure-controls">
                                    <button class="code-action-btn apply-btn ai-fix-btn" style="height:20px; font-size:9px;" title="Ask AI to fix indentation/matching">AI Repair</button>
                                    <button class="code-action-btn secondary-button manual-fix-btn" style="height:20px; font-size:9px;" title="View raw block for manual paste">Manual</button>
                                    <button class="icon-btn ignore-fix-btn" style="height:20px; width:20px;" title="Skip this change"><i class="codicon codicon-circle-slash"></i></button>
                                </div>
                            `;

                            const aiBtn = actionsEl.querySelector('.ai-fix-btn') as HTMLButtonElement;
                            const manualBtn = actionsEl.querySelector('.manual-fix-btn') as HTMLButtonElement;
                            const ignoreBtn = actionsEl.querySelector('.ignore-fix-btn') as HTMLButtonElement;

                            // AUTOMATIC REDIRECTION: If this was a manual triggered apply that failed, 
                            // pop the raw code modal immediately to help the user.
                            if (!message.repaired && !message.alreadyApplied) {
                                manualBtn.click();
                            }

                            aiBtn.onclick = (e) => {
                                e.stopPropagation();
                                aiBtn.disabled = true;
                                aiBtn.innerHTML = '<div class="spinner"></div> Repairing...';
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

                            manualBtn.onclick = (e) => {
                                e.stopPropagation();
                                // Trigger Raw Modal for this specific hunk
                                const targetBlock = document.getElementById(`block-${message.messageId}-${message.blockIndex}`);
                                if (targetBlock) {
                                    const codeText = (targetBlock as any).dataset.rawCode || "";
                                    const aiderRegex = /<<<<<<< SEARCH\\r?\\n([\\s\\S]*?)\\r?\\n=======\\r?\\n([\\s\\S]*?)\\r?\\n>>>>>>> REPLACE/g;
                                    const matches = [...codeText.matchAll(aiderRegex)];
                                    const hunkContent = (message.hunkIndex !== undefined && matches[message.hunkIndex]) 
                                        ? matches[message.hunkIndex][0] 
                                        : codeText;

                                    if (dom.rawCodeDisplay) {
                                        dom.rawCodeFilename.textContent = message.filePath;
                                        document.getElementById('raw-hunk-id')!.textContent = message.hunkIndex !== undefined ? `HUNK ${message.hunkIndex + 1}` : 'FULL';
                                        dom.rawCodeDisplay.textContent = hunkContent;
                                        dom.rawCodeDisplay.dataset.messageId = message.messageId;
                                        dom.rawCodeDisplay.dataset.blockIndex = String(message.blockIndex);
                                        dom.rawCodeDisplay.dataset.hunkIndex = message.hunkIndex !== undefined ? String(message.hunkIndex) : "";
                                        dom.rawCodeModal.classList.add('visible');
                                    }
                                }
                            };

                            ignoreBtn.onclick = (e) => {
                                e.stopPropagation();
                                row.style.background = 'transparent';
                                row.style.opacity = '0.4';
                                iconEl!.innerHTML = '<span class="codicon codicon-circle-slash"></span>';
                                actionsEl.style.display = 'none';
                            };
                        }
                    }


                    // Update main "Apply All" button state if everything is finished
                    const resultsList = row?.closest('.apply-results-list');
                    if (resultsList) {
                        const stillPending = resultsList.querySelectorAll('.spinner').length;
                        const autoRepairing = resultsList.querySelectorAll('.retry-row-btn:disabled').length;
                        
                        // Only finalize the header if no background tasks are running for this block
                        if (stillPending === 0 && autoRepairing === 0) {
                            const btnContainer = resultsList.previousElementSibling;
                            const mainBtn = btnContainer?.querySelector('.apply-all-btn:not(.secondary-btn)') as HTMLButtonElement;
                            
                            if (mainBtn) {
                                mainBtn.classList.remove('stop-btn-red');
                                mainBtn.classList.remove('sequential-applying');
                                
                                const failedCount = resultsList.querySelectorAll('.codicon-error').length;
                                if (failedCount === 0) {
                                    // SUCCESS: No more errors! Flip to Green.
                                    mainBtn.innerHTML = '<span class="codicon codicon-check"></span> All Modifications Applied';
                                    mainBtn.classList.add('applied');
                                    mainBtn.style.removeProperty('background-color');
                                    mainBtn.disabled = true;
                                } else {
                                    // STILL FAILED: Update count in orange bar
                                    mainBtn.innerHTML = `<span class="codicon codicon-warning"></span> Retry Failed (${failedCount})`;
                                    mainBtn.style.setProperty('background-color', 'var(--vscode-charts-orange)', 'important');
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
            case 'showContextDetails':
                {
                    const { title, content } = message;
                    if (dom.contextViewerModal && dom.contextViewerDisplay && dom.contextViewerTitle) {
                        dom.contextViewerTitle.textContent = title;
                        // Use marked to render it nicely in the modal
                        dom.contextViewerDisplay.innerHTML = sanitizer.sanitize((window as any).marked.parse(content));
                        dom.contextViewerModal.classList.add('visible');

                        // Apply syntax highlighting to code blocks in the modal
                        dom.contextViewerDisplay.querySelectorAll('pre code').forEach(block => {
                            (window as any).Prism.highlightElement(block);
                        });
                    }
                }
                break;
            }
    } catch(e: any) {
        console.error("Lollms Webview Error: Failed to process message from extension.", e);
        vscode.postMessage({ command: 'showError', message: 'Webview error: ' + e.message });
    }
}

