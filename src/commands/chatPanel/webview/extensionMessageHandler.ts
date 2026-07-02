import { dom, vscode, state } from './dom.js';
import DOMPurify from 'dompurify';
import { addMessage, renderMessageContent, updateContext, displayPlan, scheduleRender, checkAndSyncMessageAppliedState } from './messageRenderer.js';
import { collapseBlockWithScrollPreservation, isScrolledToBottom } from './utils.js';
import { setCalculatingTokens,
    showProjectLoader,
    hideProjectLoader,
    updateLoaderStatus}from './ui.js';
const sanitizer = typeof DOMPurify === 'function' ? (DOMPurify as any)(window) : DOMPurify;
import { 
    setGeneratingState, 
    updateBadges, 
    renderProfilesInModal, 
    renderSkillsTree, 
    renderDiscussionSearchResults, 
    renderFileSearchResults,
    renderWebSearchResults,
    renderContextUsage,
    updateProgressBar,
    updateContextFileUsage,
    renderAdvancedToolsList,
    renderWorkspaceMatrix
} from './ui.js';

export async function handleExtensionMessage(event: MessageEvent) {
    try {
        const message = event.data;
        switch (message.command) {
            case 'addMessage':
                addMessage(message.message);
                if (dom.messagesDiv) {
                    dom.messagesDiv.scrollTop = dom.messagesDiv.scrollHeight;
                    requestAnimationFrame(() => {
                        if (dom.messagesDiv) dom.messagesDiv.scrollTop = dom.messagesDiv.scrollHeight;
                    });
                    setTimeout(() => {
                        if (dom.messagesDiv) dom.messagesDiv.scrollTop = dom.messagesDiv.scrollHeight;
                    }, 50);
                    setTimeout(() => {
                        if (dom.messagesDiv) dom.messagesDiv.scrollTop = dom.messagesDiv.scrollHeight;
                    }, 200);
                }
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

                    // Track thinking start/end timestamps for duration calculation
                    const containsOpenTag = stream.buffer.includes('<think') || stream.buffer.includes('<thinking') || stream.buffer.includes('<analysis') || stream.buffer.includes('<reasoning');
                    const containsCloseTag = stream.buffer.includes('</think>') || stream.buffer.includes('</thinking>') || stream.buffer.includes('</analysis>') || stream.buffer.includes('</reasoning>');

                    if (containsOpenTag && !wrapper.dataset.thinkStartTime) {
                        wrapper.dataset.thinkStartTime = String(Date.now());
                    }
                    if (containsCloseTag && !wrapper.dataset.thinkEndTime) {
                        wrapper.dataset.thinkEndTime = String(Date.now());
                    }

                    const messageDiv = wrapper.querySelector('.message') as HTMLElement;
                    if(messageDiv) {
                        messageDiv.dataset.originalContent = JSON.stringify(stream.buffer);
                    }
                    const wasAtBottom = dom.messagesDiv && isScrolledToBottom(dom.messagesDiv);
                    scheduleRender(message.id);
                    if (wasAtBottom && dom.messagesDiv) {
                        // Defer to let the throttled render finish painting
                        requestAnimationFrame(() => {
                            if (dom.messagesDiv) dom.messagesDiv.scrollTop = dom.messagesDiv.scrollHeight;
                        });
                    }
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
                    if (wrapper) {
                        if (message.tps) {
                            const header = wrapper.querySelector('.message-header');
                            const stats = header?.querySelector('.generation-stats');
                            if (stats) {
                                stats.textContent = stats.textContent?.replace(')', ` | TPS: ${message.tps} t/s)`);
                            }
                        }
                        // Lock the final think duration
                        if (wrapper.dataset.thinkStartTime && !wrapper.dataset.thinkEndTime) {
                            wrapper.dataset.thinkEndTime = String(Date.now());
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
                        const img = new Image();
                        img.onload = () => {
                            // Automatically update the parent block's Width/Height inputs
                            const block = container.closest('.generation-block');
                            if (block) {
                                const wInp = block.querySelector('.asset-width-input') as HTMLInputElement;
                                const hInp = block.querySelector('.asset-height-input') as HTMLInputElement;
                                if (wInp) wInp.value = img.naturalWidth.toString();
                                if (hInp) hInp.value = img.naturalHeight.toString();
                            }
                        };
                        img.src = message.uri;
                        container.innerHTML = '';
                        container.appendChild(img);
                        img.style.cssText = "max-width: 100%; border-radius: 4px; box-shadow: 0 4px 10px rgba(0,0,0,0.5); cursor: zoom-in;";
                        img.onclick = () => {
                            import('./ui.js').then(ui => ui.openImageZoom(message.uri));
                        };

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
                // Forward flags to the UI renderer
                setGeneratingState(
                    message.isGenerating, 
                    message.statusText, 
                    message.showRaiseHand, 
                    message.buttonLabel
                );
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
                updateContext(message.context, message.files, message.skills, message.tools, message.diagrams, message.briefing, message.selections);
                // Optimized sync: Wait for DOM to stabilize before matching UI blocks
                import('./ui.js').then(ui => {
                    ui.updateBadges();
                    if ((window as any)._syncTimer) clearTimeout((window as any)._syncTimer);
                    (window as any)._syncTimer = setTimeout(() => ui.syncExpansionBlocks(), 800);
                });
                break;
            case 'updateContextDelta':
                {
                    const { action, files, skills, tools, briefing, selections, filePath, content } = message;

                    if (action === 'sync_all') {
                        // Fast local sync without full re-render of code block contents
                        state.lastContextData = {
                            context: "",
                            files: files.map((f: any) => f.path),
                            skills: skills,
                            tools: tools,
                            diagrams: [],
                            briefing: briefing,
                            selections: selections
                        };

                        // Store descriptors in our local view cache
                        (window as any).lazyFilesRegistry = new Map(files.map((f: any) => [f.path, f]));

                        import('./ui.js').then(ui => {
                            ui.updateBadges();
                            ui.renderContextDashboard(); // Renders lightweight UI skeleton
                        });
                    } else if (action === 'lazy_load_file') {
                        const registry = (window as any).lazyFilesRegistry;
                        if (registry && registry.has(filePath)) {
                            const cachedFile = registry.get(filePath);
                            cachedFile.content = content;
                            cachedFile.hasContent = true;

                            // Dynamically update the specific accordion pane with the resolved text
                            const pane = document.getElementById(`lazy-pane-${filePath.replace(/[^a-zA-Z0-9]/g, '_')}`);
                            if (pane) {
                                pane.innerHTML = `<pre class="markdown-body" style="padding:12px; margin:0; overflow:auto; max-height:400px; font-family:var(--vscode-editor-font-family); font-size:12px; background:var(--vscode-editor-background); border:1px solid var(--vscode-widget-border); border-radius:4px;">${(window as any).DOMPurify.sanitize((window as any).marked.parse(content))}</pre>`;
                                pane.querySelectorAll('pre code').forEach(block => {
                                    (window as any).Prism.highlightElement(block);
                                });
                            }
                        }
                    }
                }
                break;
            case 'updateDiscussionSkillsMetadata':
                if (state.lastContextData) {
                    state.lastContextData.skillIds = message.skillIds;
                    // Trigger a re-render of the context header specifically
                    import('./messageRenderer.js').then(m => m.updateContext(
                        state.lastContextData!.context, 
                        state.lastContextData!.files, 
                        state.lastContextData!.skills,
                        state.lastContextData!.diagrams,
                        state.lastContextData!.briefing
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
                        (state as any).workspaceFolders = message.workspaceFolders;
                    }
                    if (message.currentModel) {
                        state.currentModelName = message.currentModel;
                    }
                    if (message.currentTemperature !== undefined && message.currentTemperature !== null) {
                        if (dom.tempSlider) {
                            dom.tempSlider.value = message.currentTemperature.toString();
                            if (dom.tempValDisplay) dom.tempValDisplay.textContent = dom.tempSlider.value;
                        }
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
                    if (message.agentProfiles) {
                        state.agentProfiles = message.agentProfiles;
                    }

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

                    // CRITICAL: Refresh badges after the fused container is rendered in the message stream
                    setTimeout(() => updateBadges(), 50);

                    setGeneratingState(false);

                   // PERSISTENCE FIX: After loading history, try to sync UI blocks. 
                    setTimeout(async () => {
                        const { syncExpansionBlocks } = await import('./ui.js');
                        syncExpansionBlocks();
                    }, 100);

                    // Only request a fresh scan if we have no cached metrics
                    if (this._currentDiscussion && !this._currentDiscussion.lastTokenMetrics) {
                        this._panel.webview.postMessage({ command: 'calculateTokens' });
                    } else if (this._currentDiscussion) {
                        // Tell the UI we are done with the hydration phase
                        this._panel.webview.postMessage({ command: 'tokenCalculationFinished' });
                    }

                    if (dom.messagesDiv) {
                        dom.messagesDiv.scrollTop = dom.messagesDiv.scrollHeight;
                        requestAnimationFrame(() => {
                            if (dom.messagesDiv) dom.messagesDiv.scrollTop = dom.messagesDiv.scrollHeight;
                        });
                        setTimeout(() => {
                            if (dom.messagesDiv) dom.messagesDiv.scrollTop = dom.messagesDiv.scrollHeight;
                        }, 50);
                        setTimeout(() => {
                            if (dom.messagesDiv) dom.messagesDiv.scrollTop = dom.messagesDiv.scrollHeight;
                        }, 200);
                    }
                    }
                    break;

            case 'updateDiscussionCapabilities':
                const caps = message.capabilities;
                if (message.agentProfiles) {
                    state.agentProfiles = message.agentProfiles;
                }
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
                            renderWorkspaceMatrix();
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
                    if(dom.capIncludeGitInfo) dom.capIncludeGitInfo.checked = !!caps.includeGitInfo;

                    if(dom.modeFunMode) dom.modeFunMode.checked = caps.funMode;
                    
                    if (dom.capHerdMode) dom.capHerdMode.checked = caps.herdMode || false;
                    if (dom.capHerdRounds) dom.capHerdRounds.value = caps.herdRounds || 2;

                    const guiState = caps.guiState || { agentBadge: true, autoContextBadge: true, herdBadge: true };

                    if (dom.agentModeCheckbox) dom.agentModeCheckbox.checked = caps.agentMode;
                    if (dom.dynamicModeCheckbox) dom.dynamicModeCheckbox.checked = !!caps.dynamicMode;

                    const isAgent = caps.agentMode === true;
                    const isDynamic = caps.dynamicMode === true && !isAgent;
                    const isAssistant = !isAgent && !isDynamic;

                    const assistRadio = document.getElementById('modeAssistantRadio') as HTMLInputElement;
                    const dynRadio = document.getElementById('modeDynamicRadio') as HTMLInputElement;
                    const agRadio = document.getElementById('modeAgentRadio') as HTMLInputElement;

                    if (assistRadio) assistRadio.checked = isAssistant;
                    if (dynRadio) dynRadio.checked = isDynamic;
                    if (agRadio) agRadio.checked = isAgent;

                    // Sync separate protocol checkboxes
                    const debugCheck = document.getElementById('protoDebugCheckbox') as HTMLInputElement;
                    const verifierCheck = document.getElementById('protoVerifierCheckbox') as HTMLInputElement;
                    const testCheck = document.getElementById('protoTestCheckbox') as HTMLInputElement;
                    const docsCheck = document.getElementById('protoDocsCheckbox') as HTMLInputElement;
                    const gitCheck = document.getElementById('protoGitCheckbox') as HTMLInputElement;
                    const herdCheck = document.getElementById('protoHerdCheckbox') as HTMLInputElement;

                    if (debugCheck) debugCheck.checked = !!caps.debugMode;
                    if (verifierCheck) verifierCheck.checked = !!caps.verifierMode;
                    if (testCheck) testCheck.checked = !!caps.testMode;
                    if (docsCheck) docsCheck.checked = !!caps.documentationMode;
                    if (gitCheck) gitCheck.checked = !!caps.gitAutoWorkflow;
                    if (herdCheck) herdCheck.checked = !!caps.herdMode;

                    if (dom.tempSlider) {
                        const tempValue = (caps.temperature !== undefined && caps.temperature !== null) 
                            ? caps.temperature 
                            : 0.7;
                        dom.tempSlider.value = tempValue.toString();
                        if (dom.tempValDisplay) dom.tempValDisplay.textContent = dom.tempSlider.value;
                    }

                    if (dom.inputTempContainer && dom.toggleTempSliderBtn) {
                        const isTempEnabled = !!caps.enableTemperature;
                        dom.inputTempContainer.style.display = isTempEnabled ? 'flex' : 'none';
                        dom.toggleTempSliderBtn.classList.toggle('active', isTempEnabled);
                        
                        // Also update modal toggle check if it is active
                        const modalTempCheck = document.getElementById('cap-enableTemperature') as HTMLInputElement;
                        if (modalTempCheck) {
                            modalTempCheck.checked = isTempEnabled;
                        }
                    }
                    if (dom.testModeCheckbox) dom.testModeCheckbox.checked = !!caps.testMode;
                    if (dom.docsModeCheckbox) dom.docsModeCheckbox.checked = !!caps.documentationMode;
                    if (dom.capClipboardRole) dom.capClipboardRole.value = caps.clipboardInsertRole || 'user';
                    const logPathsInput = document.getElementById('cap-monitoredLogPaths') as HTMLTextAreaElement;
                    if (logPathsInput) {
                        logPathsInput.value = (caps.monitoredLogPaths || []).join('\n');
                    }
                    
                    // Synchronize the generating overlay state if it exists
                    if (dom.generatingOverlay) {
                        dom.generatingOverlay.style.display = state.isGenerating ? 'flex' : 'none';
                        const raiseHandBtn = document.getElementById('raiseHandButton');
                        if (raiseHandBtn) {
                            // During a capability update, we hide the button unless the generating state is already active
                            raiseHandBtn.style.display = (state.isGenerating && caps.agentMode) ? 'flex' : 'none';
                        }
                    }

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

                    const modalTempCheck = document.getElementById('cap-enableTemperature') as HTMLInputElement;
                    const modalTempContainer = document.getElementById('modal-temperature-container');
                    if (modalTempCheck && modalTempContainer) {
                        modalTempCheck.checked = !!caps.enableTemperature;
                        modalTempContainer.style.display = caps.enableTemperature ? 'block' : 'none';
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

                    // --- DEVELOPER DEBUG MENU ---
                    const config = (window as any).lollmsConfig; // We'll need to pass this in
                    if (config?.developer?.debugTools) {
                        const devGroup = document.createElement('div');
                        devGroup.className = 'badge-group';
                        devGroup.innerHTML = '<span class="dev-tool-badge">DEV</span>';
                        
                        const testBtn = document.createElement('button');
                        testBtn.className = 'mode-badge active clickable';
                        testBtn.style.background = 'var(--vscode-editorWidget-background)';
                        testBtn.innerHTML = '<i class="codicon codicon-beaker"></i> Tool Tester';
                        testBtn.onclick = () => {
                            vscode.postMessage({ command: 'requestAgentSettings' }); // To get tool list
                            // Logic to open a sub-modal for raw testing would go here
                        };

                        const bugBtn = document.createElement('button');
                        bugBtn.className = 'mode-badge active clickable';
                        bugBtn.style.background = 'var(--vscode-editorWidget-background)';
                        bugBtn.innerHTML = '<i class="codicon codicon-bug"></i> Report Bug';
                        bugBtn.onclick = () => {
                            vscode.postMessage({ command: 'requestDiagnosticReport' });
                        };

                        devGroup.appendChild(testBtn);
                        devGroup.appendChild(bugBtn);
                        container.appendChild(devGroup);
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

                // Add calculation animation class to the progress bar
                if (dom.tokenProgressBar) {
                    dom.tokenProgressBar.className = 'token-progress-bar calculating';
                    dom.tokenProgressBar.style.width = '100%';
                }
                break;
            case 'tokenCalculationProgress':
                {
                    const barContainer = document.getElementById('file-tree-progress-container');
                    const bar = document.getElementById('file-tree-progress-bar');
                    if (barContainer && bar) {
                        barContainer.style.display = 'block';
                        bar.style.width = `${message.progress}%`;
                    }

                    // Dynamically update the active text labels during calculation with precise metrics
                    const label = document.getElementById('token-count-label');
                    const loaderText = document.getElementById('loading-files-text');
                    
                    if (message.current && message.total) {
                        const progressStatus = `Processing: ${message.current} / ${message.total} files (${message.progress}%) [${message.fileName}]`;
                        if (label) {
                            label.textContent = progressStatus;
                            label.style.opacity = '1';
                        }
                        if (loaderText) {
                            loaderText.textContent = progressStatus;
                        }
                    } else if (message.status) {
                        const progressStatus = `${message.status} (${message.progress}%)`;
                        if (label) {
                            label.textContent = progressStatus;
                            label.style.opacity = '1';
                        }
                        if (loaderText) {
                            loaderText.textContent = progressStatus;
                        }
                    }
                }
                break;
            case 'tokenCalculationFinished':
                setCalculatingTokens(false);
                hideProjectLoader(); // Remove the big overlay when context is ready
                if (dom.tokenProgressBar && dom.tokenProgressBar.classList.contains('calculating')) {
                    dom.tokenProgressBar.classList.remove('calculating');
                }
                break;
            case 'showProjectLoader':
                showProjectLoader(message.projectName);
                break;
            case 'updateLoaderStatus':
                updateLoaderStatus(message.status, message.stats);
                break;
            case 'updateTokenProgress':
                if (dom.tokenCountLabel) {
                    const { totalTokens, contextSize, error, isApproximate, folderStats, files } = message;

                    // LATE HYDRATION: Update global file list and sync existing UI blocks
                    if (files && state.lastContextData) {
                        state.lastContextData.files = files;
                        import('./ui.js').then(ui => ui.syncExpansionBlocks());
                    }

                    if (folderStats) {
                        state.matrixStats = folderStats;
                        // Reactive matrix update if open
                        if (dom.matrixModal.classList.contains('visible')) {
                            renderWorkspaceMatrix();
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

                        // Clean calculating class on new data load
                        if (dom.tokenProgressBar && dom.tokenProgressBar.classList.contains('calculating')) {
                            dom.tokenProgressBar.classList.remove('calculating');
                        }

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
                // Clear all active spinners in buttons
                document.querySelectorAll('.apply-btn .spinner').forEach(s => {
                    const btn = s.closest('button');
                    if (btn) {
                        btn.disabled = false;
                        btn.innerHTML = btn.dataset.originalHtml || '<i class="codicon codicon-tools"></i>';
                    }
                });
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
                if (dom.messagesDiv) {
                    dom.messagesDiv.scrollTop = dom.messagesDiv.scrollHeight;
                    requestAnimationFrame(() => {
                        if (dom.messagesDiv) dom.messagesDiv.scrollTop = dom.messagesDiv.scrollHeight;
                    });
                    setTimeout(() => {
                        if (dom.messagesDiv) dom.messagesDiv.scrollTop = dom.messagesDiv.scrollHeight;
                    }, 50);
                    setTimeout(() => {
                        if (dom.messagesDiv) dom.messagesDiv.scrollTop = dom.messagesDiv.scrollHeight;
                    }, 200);
                }
                break;
            case 'imageGenerationResult':
                const genBtn = document.getElementById(message.buttonId) as HTMLButtonElement;
                // Find block by looking up from button if it exists, or searching by derived ID
                const block = genBtn ? genBtn.closest('.generation-block') as HTMLElement : null;
                const gallery = block?.querySelector('.image-results-gallery') as HTMLElement;

                if (genBtn) {
                    genBtn.disabled = false;
                    genBtn.innerHTML = '<span class="codicon codicon-sparkle"></span> Generate Version';
                    genBtn.classList.remove('processing');
                }

                const blockId = genBtn?.dataset.blockId;

                if (genBtn && gallery) {
                    // Reset button state for re-generation
                    genBtn.disabled = false;
                    genBtn.innerHTML = genBtn.dataset.paths !== undefined ? `<span class="codicon codicon-sparkle"></span> Generate New Version` : `<span class="codicon codicon-sparkle"></span> Generate`;


                    if (message.success) {
                        const block = genBtn ? genBtn.closest('.generation-block') as HTMLElement : document.getElementById(blockId);
                        const folder = (block?.querySelector('.asset-folder-input') as HTMLInputElement)?.value || "";
                        const name = (block?.querySelector('.asset-name-input') as HTMLInputElement)?.value || "";
                        const suggestedPath = (folder === '.' || !folder) ? name : `${folder}/${name}`;

                        const card = document.createElement('div');
                        card.className = 'staged-image-card version-card';
                        card.style.cssText = "width: 100%; height: 200px; position: relative; border: 2px solid var(--vscode-widget-border); border-radius: 8px; overflow: hidden; background: #000; transition: transform 0.2s;";

                        card.innerHTML = `
                            <div style="position: absolute; top: 5px; left: 5px; z-index: 10; background: rgba(0,0,0,0.6); color: white; padding: 2px 6px; border-radius: 4px; font-size: 9px; font-weight: bold;">
                                v${gallery.children.length + 1}
                            </div>
                            <img src="${message.webviewUri}" style="width: 100%; height: 100%; object-fit: contain; cursor: pointer;" title="Click to view full screen">
                            <div style="position: absolute; bottom: 0; left: 0; right: 0; background: linear-gradient(transparent, rgba(0,0,0,0.9)); padding: 8px 5px 5px 5px; display: flex; gap: 4px; transform: translateY(100%); transition: transform 0.2s;" class="card-controls">
                                <button class="code-action-btn apply-btn save-draft-btn" style="flex: 1; font-size: 10px; height: 22px;">
                                    <i class="codicon codicon-save"></i> Save
                                </button>
                                <button class="code-action-btn secondary-btn view-full-btn" style="width: 22px; height: 22px; padding: 0;">
                                    <i class="codicon codicon-screen-full"></i>
                                </button>
                                <button class="code-action-btn delete-btn discard-draft-btn" style="width: 22px; height: 22px; padding: 0; color: #ff4444;">
                                    <i class="codicon codicon-trash"></i>
                                </button>
                            </div>
                        `;

                        // Hover logic to show/hide controls
                        card.onmouseenter = () => card.querySelector('.card-controls')!.style.transform = 'translateY(0)';
                        card.onmouseleave = () => card.querySelector('.card-controls')!.style.transform = 'translateY(100%)';

                        // Full Screen View (Sovereign Zoom)
                        const viewFn = (e) => {
                            e.stopPropagation();
                            import('./ui.js').then(ui => {
                                ui.openSovereignZoom(message.webviewUri);
                            });
                        };
                        card.querySelector('img')!.onclick = viewFn;
                        const fullBtn = card.querySelector('.view-full-btn') as HTMLElement;
                        if (fullBtn) fullBtn.onclick = viewFn;

                        // Discard
                        (card.querySelector('.discard-draft-btn') as HTMLElement).onclick = () => card.remove();

                        // Save with LATEST UI PATHS
                        (card.querySelector('.save-draft-btn') as HTMLElement).onclick = () => {
                            const currentPath = (block?.querySelector('.asset-name-input') as HTMLInputElement)?.value;
                            const currentFolder = (block?.querySelector('.asset-folder-input') as HTMLInputElement)?.value;
                            const finalPath = (currentFolder === '.' || !currentFolder) ? currentPath : `${currentFolder}/${currentPath}`;
                            
                            vscode.postMessage({
                                command: 'saveDraftAsset',
                                params: { dataUri: message.webviewUri, suggestedPath: finalPath }
                            });
                        };

                        gallery.prepend(card);

                        // --- FIX: PERSISTENCE TRIGGER ---
                        // Notify the extension that a new draft version exists for this message
                        // so it can append an <image_result> tag to the persistent JSON.
                        vscode.postMessage({
                            command: 'updateMessage',
                            messageId: genBtn.dataset.messageId,
                            newContent: "APPEND_TAG:<image_result path=\"" + suggestedPath + "\" />"
                        });

                        card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                        } else {
                        // Error/Retry State
                        genBtn.innerHTML = `<span class="codicon codicon-refresh"></span> Retry Edit`;
                        genBtn.classList.add('delete-btn'); // Turn red
                        genBtn.classList.remove('apply-btn');
                        genBtn.disabled = false;
                        genBtn.title = `Error: ${message.error || 'Unknown server error'}`;
                        }
                        }
                        break;
            case 'showAgentSettings':
                {
                    const policies = state.capabilities?.toolPolicies || {};

                    // 1. Populate standard settings inputs
                    const maxStepsInp = document.getElementById('setting-maxSteps') as HTMLInputElement;
                    const maxRetriesInp = document.getElementById('setting-maxEditRetries') as HTMLInputElement;
                    if (maxStepsInp) maxStepsInp.value = message.settings.maxSteps;
                    if (maxRetriesInp) maxRetriesInp.value = message.settings.maxEditRetries;
                    const autoSwitchInp = document.getElementById('setting-autoProfileSwitch') as HTMLInputElement;
                    if (autoSwitchInp) autoSwitchInp.checked = !!message.settings.autoProfileSwitch;

                    // 2. Populate Mission Profile Dropdown
                    const profileSelect = document.getElementById('setting-activeProfile') as HTMLSelectElement;
                    if (profileSelect && message.allProfiles) {
                        profileSelect.innerHTML = message.allProfiles.map((p: any) => 
                            `<option value="${p.id}" ${p.id === message.settings.activeProfile ? 'selected' : ''}>${p.name}</option>`
                        ).join('');
                    }

                    // 3. Render the tools grid
                    renderAdvancedToolsList(message.allTools, policies);

                    // 4. Show the modal
                    if (dom.agentSettingsModal) {
                        dom.agentSettingsModal.classList.add('visible');
                    }
                }
                break;
            case 'showDiscussionSettings':
                {
                    console.log("[DEBUG:Handler] RECEIVED showDiscussionSettings", message);
                    state.capabilities = message.capabilities;
                    state.profiles = message.profiles;

                    if (message.workspaceFolders) {
                        (window as any).workspaceFolders = message.workspaceFolders;
                    }

                    // 1. Update the UI fields inside the modal first
                    console.log("[DEBUG:Handler] Triggering updateDiscussionCapabilities sync...");
                    const updateEvent = new MessageEvent('message', {
                        data: {
                            command: 'updateDiscussionCapabilities',
                            capabilities: message.capabilities,
                            profiles: message.profiles
                        }
                    });
                    window.dispatchEvent(updateEvent);

                    // 2. Force Modal Visibility
                    const modalId = 'discussion-tools-modal';
                    const modal = document.getElementById(modalId);
                    console.log("[DEBUG:Handler] Attempting to show modal with ID:", modalId, !!modal);

                    if (modal) {
                        modal.classList.add('visible');
                        modal.style.setProperty('display', 'flex', 'important');
                        modal.style.setProperty('visibility', 'visible', 'important');
                        modal.style.setProperty('opacity', '1', 'important');
                        console.log("[DEBUG:Handler] Modal visibility classes/styles applied.");

                        // 3. Refresh voices if available
                        if (typeof (window as any).refreshVoiceList === 'function') {
                            (window as any).refreshVoiceList();
                        }
                    } else {
                        console.error("[DEBUG:Handler] FATAL: Discussion settings modal element not found in DOM!");
                        // Fallback: check if the dom.ts getter finds it
                        console.log("[DEBUG:Handler] dom.discussionToolsModal check:", !!dom.discussionToolsModal);
                    }
                }
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

                // 2. RESILIENT BUTTON FINDER (Plugin Aware)
                let buttons: HTMLButtonElement[] = [];
                const specificBlock = document.getElementById(blockId);

                if (specificBlock) {
                    buttons = Array.from(specificBlock.querySelectorAll('.add-btn, .add-reprompt-btn, .replace-btn'));
                } else {
                    // Fallback for streaming race conditions
                    buttons = Array.from(document.querySelectorAll('.add-btn, .add-reprompt-btn, .replace-btn'))
                        .filter(b => b.innerHTML.includes('spinner') || b.textContent?.includes('Adding')) as HTMLButtonElement[];
                }

                const allIncluded = Object.values(results || {}).every(v => v === true);

                // 3. Update all identified buttons
                buttons.forEach(btn => {
                    const isReprompt = btn.classList.contains('add-reprompt-btn');
                    const isReplace = btn.classList.contains('replace-btn');

                    if (allIncluded) {
                        if (isReplace) {
                            btn.disabled = true;
                            btn.style.display = 'none'; // Hide replace if all are included
                        } else {
                            btn.innerHTML = isReprompt 
                                ? `<span class="codicon codicon-check"></span> Added` 
                                : `<span class="codicon codicon-check"></span> Added to Context`;
                            btn.classList.remove('apply-btn');
                            btn.classList.add('applied');
                            btn.disabled = true;
                        }
                    } else {
                        // Some files failed! Restore buttons and stop the spinner so the user can retry
                        btn.disabled = false;
                        if (isReplace) {
                            btn.innerHTML = `<span class="codicon codicon-clear-all"></span> Replace Context`;
                        } else if (isReprompt) {
                            btn.innerHTML = `<span class="codicon codicon-sync"></span> Add & Reprompt`;
                        } else {
                            btn.innerHTML = `<span class="codicon codicon-add"></span> Add to Context`;
                        }
                    }
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
                // --- PROGRESSIVE HUNK MATCHING INTERCEPTOR ---
                // If the state machine is active, delegate results to it directly
                const globalUI = (window as any);
                if (globalUI.progressiveSearchState && dom.rawCodeModal.classList.contains('visible')) {
                    if (typeof globalUI.handleProgressiveSearchResults === 'function') {
                        globalUI.handleProgressiveSearchResults(message.results);
                        return;
                    }
                }

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
            case 'showToolPicker':
                if (typeof (window as any).renderToolPicker === 'function') {
                    (window as any).renderToolPicker(
                        message.allTools, 
                        message.discussionTools, 
                        message.projectTools
                    );
                }
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
                const row = wrapper?.querySelector(`.apply-row[data-block-index='${message.blockIndex}']${hunkAttr}`) as HTMLElement;
                if (row) {
                    const iconEl = row.querySelector('.status-icon');
                    if (iconEl) iconEl.innerHTML = '<span class="codicon codicon-loading spin"></span>';
                    row.style.background = 'rgba(255, 255, 255, 0.05)';
                    row.style.opacity = '0.7';

                    const pathEl = row.querySelector('.row-path');
                    if (pathEl && !pathEl.innerHTML.includes('status-label-inline')) {
                        const labelText = pathEl.textContent || '';
                        pathEl.innerHTML = `${labelText} <span class="status-label-inline" style="color:var(--vscode-charts-orange); font-size:10px; margin-left:8px; opacity:0.85; font-weight:bold;">(Writing to disk...)</span>`;
                    }
                }

                // Update Main Action Button Status Label
                // Keep the button active/clickable so the user can click to Stop the process!
                const mainBtn = document.getElementById(`apply-all-${message.messageId}`) as HTMLButtonElement;
                if (mainBtn) {
                    mainBtn.disabled = false;
                    mainBtn.classList.add('sequential-applying');
                    mainBtn.classList.add('stop-btn-red'); // Style as red stop button
                    mainBtn.innerHTML = `<span class="codicon codicon-primitive-square"></span> Stop Applying [${message.currentIndex + 1}/${message.totalCount}]`;
                }

                // Update Progress Bar
                if (message.totalCount > 0) {
                    const bar = document.getElementById(`progress-bar-${message.messageId}`);
                    if (bar) {
                        const pct = Math.round((message.currentIndex / message.totalCount) * 100);
                        bar.style.width = `${pct}%`;
                    }
                }
                break;
            }

            case 'fileSavedOnDisk':
                {
                    const { filePath } = message;
                    if (!filePath) break;

                    // Scan the entire DOM for any code block that targets this specific file
                    const codeBlocks = document.querySelectorAll('details.code-collapsible');
                    const { collapseBlockWithScrollPreservation } = await import('./utils.js');

                    codeBlocks.forEach((block: any) => {
                        const inputEl = block.querySelector('.path-editor-input') as HTMLInputElement;
                        const currentPath = inputEl ? inputEl.value.trim() : "";

                        // If this block targets the saved file, collapse it gracefully
                        if (currentPath === filePath || currentPath.replace(/\\\\/g, '/').endsWith(filePath.replace(/\\\\/g, '/'))) {
                            collapseBlockWithScrollPreservation(block, dom.messagesDiv);
                        }
                    });
                }
                break;
            case 'applyAllResult':
                {
                    const wrapper = document.querySelector(`.message-wrapper[data-message-id='${message.messageId}']`) as HTMLElement;
                    const mainApplyBtn = document.getElementById(`apply-btn-${message.messageId}-${message.blockIndex}`) as HTMLButtonElement;
                    if (!wrapper) break;

                    const isUndo = message.undo === true;

                    const hunkAttr = message.hunkIndex !== undefined ? `[data-hunk-index='${message.hunkIndex}']` : ':not([data-hunk-index])';
                    const row = wrapper.querySelector(`.apply-row[data-block-index='${message.blockIndex}']${hunkAttr}`) as HTMLElement;

                    if (row) {
                        const iconEl = row.querySelector('.status-icon');
                        if (iconEl) {
                            iconEl.innerHTML = message.success 
                                ? '<span class="codicon codicon-check" style="color:var(--vscode-charts-green)"></span>' 
                                : '<span class="codicon codicon-error" style="color:var(--vscode-charts-red)"></span>';
                        }
                        row.style.background = '';
                        row.style.opacity = '1';

                        const labelInline = row.querySelector('.status-label-inline');
                        if (labelInline) labelInline.remove();

                        // Add "Fix with AI" and "Manual Stitch" buttons if the change failed to apply
                        // (Mute for system-generated messages to prevent recursive loops)
                        const isSystemId = message.messageId.startsWith('self_correction') || message.messageId.startsWith('guardian') || message.messageId.startsWith('system') || message.messageId.startsWith('inspection');
                        if (!message.success && !isSystemId) {
                            let rowActions = row.querySelector('.row-actions') as HTMLElement;
                            if (!rowActions) {
                                rowActions = document.createElement('div');
                                rowActions.className = 'row-actions';
                                row.appendChild(rowActions);
                            }
                            rowActions.style.display = 'flex';
                            rowActions.style.gap = '6px';
                            rowActions.style.marginLeft = 'auto';

                            // Find the raw code block on the page to retrieve data for the modal
                            const blockEl = document.getElementById(`block-${message.messageId}-${message.blockIndex}`) as HTMLDetailsElement;
                            const rawCode = blockEl ? blockEl.dataset.rawCode || "" : "";

                            rowActions.innerHTML = `
                                <button class="code-action-btn apply-btn row-fix-ai-btn" style="height:20px; font-size:9px; padding:0 6px;" title="Ask AI to repair this specific change">
                                    <i class="codicon codicon-sparkle"></i> Fix with AI
                                </button>
                                <button class="code-action-btn secondary-btn row-manual-stitch-btn" style="height:20px; font-size:9px; padding:0 6px;" title="Open manual stitching modal">
                                    <i class="codicon codicon-tools"></i> Raw Block
                                </button>
                            `;

                            // Bind "Fix with AI" action
                            const fixAiBtn = rowActions.querySelector('.row-fix-ai-btn') as HTMLButtonElement;
                            if (fixAiBtn) {
                                fixAiBtn.onclick = (e) => {
                                    e.stopPropagation();
                                    fixAiBtn.disabled = true;
                                    fixAiBtn.innerHTML = '<div class="spinner"></div> Repairing...';
                                    vscode.postMessage({
                                        command: 'replaceCode',
                                        filePath: message.filePath,
                                        content: "REPAIR_REQUESTED",
                                        messageId: message.messageId,
                                        options: { 
                                            silent: true,
                                            blockIndex: message.blockIndex,
                                            hunkIndex: message.hunkIndex
                                        }
                                    });
                                };
                            }

                            // Bind "Raw Block / Manual Stitch" action
                            const manualStitchBtn = rowActions.querySelector('.row-manual-stitch-btn') as HTMLButtonElement;
                            if (manualStitchBtn) {
                                manualStitchBtn.onclick = (e) => {
                                    e.stopPropagation();
                                    openRawCodeModal(
                                        message.messageId, 
                                        message.blockIndex, 
                                        message.filePath, 
                                        rawCode,
                                        message.hunkIndex !== undefined ? message.hunkIndex : 0
                                    );
                                };
                            }
                        }
                    }

                    // 1. Update the individual code block UI (even if it wasn't part of an "Apply All" run)
                    const targetBlockId = `block-${message.messageId}-${message.blockIndex}`;
                    const blockEl = document.getElementById(targetBlockId) as HTMLDetailsElement;

                    // Support SPARQL block spinner and results rendering resolution
                    const sparqlBlock = document.getElementById(message.blockIndex) as HTMLElement;
                    if (sparqlBlock && sparqlBlock.classList.contains('sparql-block')) {
                        // Unlock all action buttons
                        sparqlBlock.querySelectorAll('.run-local-sparql-btn, .run-reprompt-sparql-btn').forEach((btn: any) => {
                            btn.disabled = false;
                            btn.style.opacity = '1';
                        });

                        const localBtn = sparqlBlock.querySelector('.run-local-sparql-btn') as HTMLButtonElement;
                        if (localBtn) {
                            localBtn.innerHTML = '<i class="codicon codicon-terminal"></i> Run';
                        }

                        const repromptBtn = sparqlBlock.querySelector('.run-reprompt-sparql-btn') as HTMLButtonElement;
                        if (repromptBtn) {
                            repromptBtn.innerHTML = '<i class="codicon codicon-play"></i> Run & Reprompt';
                        }

                        // Display the compiled SPARQL table directly in the card body if returned
                        if (message.sparqlResult) {
                            const renderArea = sparqlBlock.querySelector('.sparql-results-render-area') as HTMLElement;
                            if (renderArea) {
                                renderArea.style.display = 'block';
                                const cleanHtml = (window as any).DOMPurify.sanitize((window as any).marked.parse(message.sparqlResult));
                                renderArea.innerHTML = cleanHtml;
                            }
                        }
                    }

                    if (blockEl && message.success) {
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
                            if (!btn) return;
                            const bubble = btn.closest('.aider-hunk-bubble, .code-collapsible');
                            const undoBtn = bubble?.querySelector('.undo-hunk-btn') as HTMLElement;

                            btn.disabled = false; // ALWAYS keep enabled for re-apply

                            if (isUndo) {
                                btn.classList.remove('applied');
                                const isAider = bubble?.classList.contains('aider-diff-container') || bubble?.querySelector('.aider-hunk-group');
                                const icon = btn.classList.contains('apply-all-btn') ? 'codicon-tools' : (isAider ? 'codicon-arrow-swap' : 'codicon-tools');
                                btn.innerHTML = `<i class="codicon ${icon}"></i>`;
                                if (undoBtn) undoBtn.style.display = 'none';
                            } else {
                                btn.classList.add('applied');
                                btn.innerHTML = '<i class="codicon codicon-check"></i>';
                                btn.title = "Successfully applied. Click to apply again.";
                                if (undoBtn) {
                                    undoBtn.style.display = 'flex';
                                    undoBtn.innerHTML = '<i class="codicon codicon-discard"></i>';
                                }
                            }
                        };

                        // Update specific Apply button for this block
                        const mainBtn = document.getElementById(`apply-btn-${message.messageId}-${message.blockIndex}`) as HTMLButtonElement;
                        if (mainBtn) restoreBtn(mainBtn);
                        if (message.hunkIndex !== undefined && message.hunkIndex !== -1) {
                            // TAB SYNC: Find the specific tab and pane
                            const tab = blockEl.querySelector(`.hunk-tab-${message.hunkIndex}`) as HTMLElement;
                            const pane = blockEl.querySelector(`.hunk-pane-${message.hunkIndex}`) as HTMLElement;

                            if (tab) {
                                tab.classList.add('status-completed');
                                tab.querySelector('.hunk-status-icon i')!.className = 'codicon codicon-check';
                            }

                            if (pane) {
                                const hunkBtn = pane.querySelector('.apply-btn') as HTMLButtonElement;
                                if (hunkBtn) restoreBtn(hunkBtn);
                            }
                        } else {
                            if (mainApplyBtn) restoreBtn(mainApplyBtn);

                            blockEl.querySelectorAll('.aider-hunk-actions .apply-btn').forEach(restoreBtn);

                            // Ensure checkmark icon is updated without hiding the code content
                            blockEl.querySelectorAll('.aider-hunk-bubble').forEach(h => {
                                const icon = h.querySelector('.hunk-toggle-icon');
                                if (icon) icon.className = 'codicon codicon-chevron-right hunk-toggle-icon';
                            });
                        }

                        // Re-sync main button state for the entire message
                        checkAndSyncMessageAppliedState(message.messageId);
                    } else if (message.success && message.blockIndex === undefined) {
                        // --- AUTO-APPLY FALLBACK ---
                        // If applied without a blockIndex (e.g. from background automation pipeline),
                        // mark all blocks of this messageId as applied in the state and sync the UI!
                        if (!state.appliedState[message.messageId]) {
                            state.appliedState[message.messageId] = {};
                        }

                        const wrapper = document.querySelector(`.message-wrapper[data-message-id='${message.messageId}']`);
                        if (wrapper) {
                            const blocks = wrapper.querySelectorAll('details.code-collapsible');
                            blocks.forEach((block: any, idx) => {
                                state.appliedState[message.messageId][idx] = [-1];
                                const applyBtn = block.querySelector('.code-actions .apply-btn') as HTMLButtonElement;
                                if (applyBtn) {
                                    applyBtn.classList.add('applied');
                                    applyBtn.innerHTML = '<i class="codicon codicon-check"></i>';
                                }
                            });
                        }
                        checkAndSyncMessageAppliedState(message.messageId);


                    } else if (blockEl && !message.success) {
                        // 1. STOP THE SPINNER
                        if (mainApplyBtn) {
                            mainApplyBtn.disabled = false;
                            const isAider = blockEl.dataset.rawCode?.includes('<<<<<<< SEARCH');
                            mainApplyBtn.innerHTML = `<span class="codicon ${isAider ? 'codicon-arrow-swap' : 'codicon-tools'}"></span>`;
                        }

                        // TAB SYNC: Highlight the failing tab
                        if (message.hunkIndex !== undefined) {
                            const tab = blockEl.querySelector(`.hunk-tab-${message.hunkIndex}`) as HTMLElement;
                            if (tab) {
                                tab.classList.add('status-failed');
                                tab.classList.add('active');
                                tab.querySelector('.hunk-status-icon i')!.className = 'codicon codicon-error';

                                // Auto-switch to the failing pane
                                blockEl.querySelectorAll('.hunk-tab, .hunk-tab-content').forEach(el => {
                                    if (el !== tab && !el.classList.contains(`hunk-pane-${message.hunkIndex}`)) {
                                        el.classList.remove('active');
                                    }
                                });
                                blockEl.querySelector(`.hunk-pane-${message.hunkIndex}`)?.classList.add('active');
                            }
                        }

                        // VISUAL RED ALERT: Set state to error
                        blockEl.classList.add('malformed');
                        blockEl.style.borderColor = 'var(--vscode-errorForeground)';

                        // FAILURE CASE: Insert explicit "Fix with AI" & "Manual Fix" buttons
                        // in place of the generic error message or as floating helper actions
                        const actions = blockEl.querySelector('.code-actions');
                        if (actions && !actions.querySelector('.fix-ai-btn')) {
                            const fixAiBtn = document.createElement('button');
                            fixAiBtn.className = 'code-action-btn apply-btn fix-ai-btn';
                            fixAiBtn.style.borderColor = 'var(--vscode-charts-purple)';
                            fixAiBtn.innerHTML = '<span class="codicon codicon-sparkle"></span> Fix with AI';
                            fixAiBtn.onclick = () => {
                                fixAiBtn.disabled = true;
                                fixAiBtn.innerHTML = '<div class="spinner"></div> Repairing...';
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

                            const manualFixBtn = document.createElement('button');
                            manualFixBtn.className = 'code-action-btn secondary-btn manual-fix-btn';
                            manualFixBtn.style.borderColor = 'var(--vscode-charts-orange)';
                            manualFixBtn.innerHTML = '<span class="codicon codicon-tools"></span> Manual Fix';
                            manualFixBtn.onclick = () => {
                                const codeText = blockEl.dataset.rawCode || "";
                                openRawCodeModal(
                                    message.messageId, 
                                    message.blockIndex, 
                                    message.filePath, 
                                    codeText, 
                                    message.hunkIndex !== undefined ? message.hunkIndex : 0
                                );
                            };

                            actions.appendChild(fixAiBtn);
                            actions.appendChild(manualFixBtn);
                        }
                    }




                    // Update Progress Bar on complete
                    if (message.totalCount > 0) {
                        const bar = document.getElementById(`progress-bar-${message.messageId}`);
                        if (bar) {
                            const pct = Math.round(((message.currentIndex + 1) / message.totalCount) * 100);
                            bar.style.width = `${pct}%`;
                            if (pct === 100) {
                                bar.style.background = 'var(--vscode-charts-green)';
                            }
                        }
                    }

                    // Update main "Apply All" button state if everything is finished
                    const resultsList = row?.closest('.apply-results-list') || document.getElementById(`results-${message.messageId}`);
                    if (resultsList) {
                        const stillPending = resultsList.querySelectorAll('.spinner, .codicon-loading').length;

                        if (stillPending === 0) {
                            const mainBtn = document.getElementById(`apply-all-${message.messageId}`) as HTMLButtonElement;

                            if (mainBtn) {
                                mainBtn.classList.remove('stop-btn-red');
                                mainBtn.classList.remove('sequential-applying');

                                const failedCount = resultsList.querySelectorAll('.codicon-error').length;
                                if (failedCount === 0) {
                                    if (isUndo) {
                                        // SUCCESS: Undo completed! Restore Apply All state.
                                        mainBtn.innerHTML = '<span class="codicon codicon-check-all"></span> Apply All Changes';
                                        mainBtn.className = 'apply-all-btn'; // Reset standard classes
                                        mainBtn.style.removeProperty('background-color');
                                        mainBtn.style.removeProperty('color');
                                        mainBtn.disabled = false;

                                        // Hide progress bar and results list on successful revert
                                        const progressBar = document.getElementById(`progress-container-${message.messageId}`);
                                        if (progressBar) progressBar.style.display = 'none';
                                        resultsList.style.display = 'none';
                                    } else {
                                        // SUCCESS: Apply completed! Transform to Undo All.
                                        mainBtn.innerHTML = '<span class="codicon codicon-discard"></span> Undo All Changes';
                                        mainBtn.classList.add('applied');
                                        mainBtn.classList.add('undo-all-btn');
                                        mainBtn.style.setProperty('background-color', 'var(--vscode-charts-red)', 'important');
                                        mainBtn.style.setProperty('color', 'white', 'important');
                                        mainBtn.disabled = false;
                                    }
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
            case 'provideFileContentForDiff':
                {
                    const { currentContent, changeIndex } = message;
                    const changes = (window as any).currentStagingChanges || [];
                    const change = changes[changeIndex];
                    if (change && typeof (window as any).renderSplitDiff === 'function') {
                        (window as any).renderSplitDiff(currentContent || '', change.content || '');
                    } else {
                        const viewer = document.getElementById('staging-diff-content');
                        if (viewer) {
                            viewer.innerHTML = '<div style="padding:20px; color:var(--vscode-errorForeground);">Failed to load diff.</div>';
                        }
                    }
                }
                break;
            case 'showContextDetails':
                {
                    const { title, content } = message;
                    if (dom.contextViewerModal && dom.contextViewerDisplay && dom.contextViewerTitle) {
                        dom.contextViewerTitle.textContent = title;

                        // We use a custom configuration for the sanitizer to allow data-uri images in the preview
                        const previewHtml = (window as any).marked.parse(content);
                        dom.contextViewerDisplay.innerHTML = (window as any).DOMPurify.sanitize(previewHtml, {
                            ADD_TAGS: ['img', 'span', 'i'],
                            ADD_ATTR: ['src', 'style', 'class'],
                            ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|ftp|tel|file):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i // Default
                        });

                        // Specific fix: allow data: URIs for the base64 images
                        const images = dom.contextViewerDisplay.querySelectorAll('img');
                        images.forEach(img => {
                            // Ensure data URIs are preserved if sanitizer stripped them due to strict default regex
                            const rawMatch = content.match(/src="(data:image\/[^"]+)"/);
                            if (rawMatch && !img.src.startsWith('data:')) {
                                img.src = rawMatch[1];
                            }
                        });

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

