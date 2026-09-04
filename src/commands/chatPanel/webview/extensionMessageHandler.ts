import { dom, vscode, state } from './dom.js';
import DOMPurify from 'dompurify';
import { addMessage, renderMessageContent, updateContext, displayPlan, scheduleRender, checkAndSyncMessageAppliedState } from './messageRenderer.js';
import { collapseBlockWithScrollPreservation, isScrolledToBottom } from './utils.js';
import { 
    setCalculatingTokens,
    showProjectLoader,
    hideProjectLoader,
    updateLoaderStatus
} from './ui.js';
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
    renderWorkspaceMatrix,
    openNewDiscussionWizard,
    syncExpansionBlocks
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
            case 'startCountdown':
                {
                    const wrapper = document.querySelector(`.message-wrapper[data-message-id='${message.id}']`) as HTMLElement;
                    if (!wrapper) break;

                    const waitingAnim = wrapper.querySelector('.waiting-animation');
                    if (waitingAnim) {
                        const countdownSpan = document.createElement('span');
                        countdownSpan.className = 'countdown-timer-hud';
                        countdownSpan.style.cssText = "font-weight: bold; margin-left: 8px; color: var(--vscode-charts-orange); font-family: monospace;";
                        waitingAnim.appendChild(countdownSpan);

                        let remainingSecs = Math.max(1, Math.round(message.timeoutMs / 1000));
                        countdownSpan.textContent = `(${remainingSecs}s remaining before timeout)`;

                        const intervalId = setInterval(() => {
                            if (wrapper.dataset.firstTokenReceived === 'true' || !document.body.contains(wrapper)) {
                                clearInterval(intervalId);
                                countdownSpan.remove();
                                return;
                            }

                            remainingSecs--;
                            if (remainingSecs <= 0) {
                                clearInterval(intervalId);
                                countdownSpan.textContent = `(Timeout reached)`;
                                countdownSpan.style.color = "var(--vscode-charts-red)";
                                const thinkingText = waitingAnim.querySelector('.thinking-text');
                                if (thinkingText) {
                                    thinkingText.textContent = "The LLM server failed to respond within the timeout limit. Please verify connection or optimize context size.";
                                    thinkingText.style.color = "var(--vscode-charts-red)";
                                }
                                const spinner = waitingAnim.querySelector('.lollms-spinner') as HTMLElement;
                                if (spinner) {
                                    spinner.style.animation = 'none';
                                    spinner.style.borderColor = 'var(--vscode-charts-red)';
                                }
                            } else {
                                countdownSpan.textContent = `(${remainingSecs}s remaining before timeout)`;
                            }
                        }, 1000);

                        // Attach interval to wrapper dataset for reference cleanup
                        (wrapper as any)._countdownIntervalId = intervalId;
                    }
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

                        // Clear background countdown timer interval
                        if ((wrapper as any)._countdownIntervalId) {
                            clearInterval((wrapper as any)._countdownIntervalId);
                        }

                        // Hide the pre-allocated spinner smoothly without wiping the inner content, preventing a layout flash
                        const waitingAnim = wrapper.querySelector('.waiting-animation') as HTMLElement;
                        if (waitingAnim) {
                            waitingAnim.style.display = 'none';
                        }

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

                    // Final single sync pass for all context expansion blocks
                    import('./ui.js').then(ui => ui.syncExpansionBlocks());

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
                if (Array.isArray(message.files)) {
                    if (!state.fileTokensMap) state.fileTokensMap = {};
                    message.files.forEach((f: any) => {
                        if (f && typeof f === 'object' && f.path) {
                            if (f.tokens) state.fileTokensMap[f.path] = f.tokens;
                            else if (f.bytes) state.fileTokensMap[f.path] = Math.ceil(f.bytes / 3.5);
                        }
                    });
                }
                updateContext(message.context, message.files, message.skills, message.tools, message.diagrams, message.briefing, message.selections);
                updateBadges();
                // Only schedule background sync if generation is not actively streaming
                if (!state.isGenerating) {
                    if ((window as any)._syncTimer) clearTimeout((window as any)._syncTimer);
                    (window as any)._syncTimer = setTimeout(() => syncExpansionBlocks(), 800);
                }
                break;
            case 'updateContextDelta':
                {
                    const { action, files, skills, tools, briefing, selections, filePath, content } = message;

                    if (action === 'sync_all') {
                        // Fast local sync preserving file descriptors with weights
                        state.lastContextData = {
                            context: "",
                            files: files || [],
                            skills: skills,
                            tools: tools,
                            diagrams: [],
                            briefing: briefing,
                            selections: selections
                        };

                        if (!state.fileTokensMap) state.fileTokensMap = {};
                        if (Array.isArray(files)) {
                            files.forEach((f: any) => {
                                if (f && typeof f === 'object' && f.path) {
                                    if (f.tokens) state.fileTokensMap[f.path] = f.tokens;
                                    else if (f.bytes) state.fileTokensMap[f.path] = Math.ceil(f.bytes / 3.5);
                                }
                            });
                        }

                        // Store descriptors in our local view cache
                        (window as any).lazyFilesRegistry = new Map(files.map((f: any) => [typeof f === 'string' ? f : f.path, f]));

                        // Use the decoupled updater pathway
                        import('./messageRenderer.js').then(mRenderer => {
                            mRenderer.updateContext();
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

            case 'openNewDiscussionWizard':
                openNewDiscussionWizard(message.selections || []);
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

                    if (message.initialPrompt !== undefined && message.initialPrompt !== null) {
                        if (dom.messageInput) {
                            dom.messageInput.value = message.initialPrompt;
                            dom.messageInput.dispatchEvent(new Event('input'));
                            dom.messageInput.focus();
                        }
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

                    // Webview-safe finish indicators: Always release the progress overlay once the discussion loads
                    setCalculatingTokens(false);
                    hideProjectLoader();

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
                    (state as any).workspaceFolders = message.workspaceFolders;
                }
                // Dynamic refresh of Wizard folders list if open
                if (dom.wizardModal.classList.contains('visible')) {
                    renderWizardMatrix();
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

                    const userPrefInput = document.getElementById('cap-userPreferences') as HTMLTextAreaElement;
                    if (userPrefInput) {
                        userPrefInput.value = caps.userPreferences || '';
                    }

                    if (dom.capForceFullCode) dom.capForceFullCode.checked = !!caps.forceFullCode;
                    const symbolModeCheck = document.getElementById('cap-enableSymbolMode') as HTMLInputElement;
                    if (symbolModeCheck) {
                        symbolModeCheck.checked = caps.enableSymbolMode !== false;
                    }
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

                    const preciseTokenizationCheck = document.getElementById('cap-preciseTokenization') as HTMLInputElement;
                    if (preciseTokenizationCheck) {
                        preciseTokenizationCheck.checked = caps.preciseTokenization === true;
                    }

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

                    const sparqlCheck = document.getElementById('cap-sparqlEnabled') as HTMLInputElement;
                    if (sparqlCheck) sparqlCheck.checked = caps.sparqlEnabled !== false;

                    const grepCheck = document.getElementById('cap-grepEnabled') as HTMLInputElement;
                    if (grepCheck) grepCheck.checked = caps.grepEnabled !== false;

                    const projMemCheck = document.getElementById('cap-projectMemoryEnabled') as HTMLInputElement;
                    if (projMemCheck) projMemCheck.checked = caps.projectMemoryEnabled !== false;

                    const tokenEconCheck = document.getElementById('cap-tokenEconomyMode') as HTMLInputElement;
                    if (tokenEconCheck) tokenEconCheck.checked = !!caps.tokenEconomyMode;

                    const autoFixCheck = document.getElementById('cap-autoFix') as HTMLInputElement;
                    if (autoFixCheck) autoFixCheck.checked = caps.autoFix !== false;

                    const autoApplyCheck = document.getElementById('cap-autoApply') as HTMLInputElement;
                    if (autoApplyCheck) autoApplyCheck.checked = !!caps.autoApply;

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

                    const govRange = document.getElementById('modal-governor-threshold') as HTMLInputElement;
                    const govLabel = document.getElementById('modal-governor-threshold-val');
                    if (govRange && govLabel) {
                        const threshold = caps.contextGovernorThreshold !== undefined ? caps.contextGovernorThreshold : 95;
                        govRange.value = threshold.toString();
                        govLabel.textContent = threshold + '%';
                        govRange.oninput = () => { govLabel.textContent = govRange.value + '%'; };
                    }

                    const govCheck = document.getElementById('cap-contextGovernorEnabled') as HTMLInputElement;
                    const govSection = document.getElementById('governor-config-section');
                    if (govCheck && govSection) {
                        govCheck.addEventListener('change', () => {
                            govSection.style.display = govCheck.checked ? 'block' : 'none';
                        });
                    }

                    const permanentPruningCheck = document.getElementById('cap-contextGovernorPermanentPruning') as HTMLInputElement;
                    if (permanentPruningCheck) {
                        permanentPruningCheck.checked = !!caps.contextGovernorPermanentPruning;
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
                    dom.personalitySelector.value = message.currentPersonalityId;
                }
                // Refresh wizard select if modal is open
                if (dom.wizardModal.classList.contains('visible') && dom.wizardPersonality) {
                    dom.wizardPersonality.innerHTML = state.personalities.map(p => 
                        `<option value="${p.id}" ${p.id === state.currentPersonalityId ? 'selected' : ''}>${p.name}</option>`
                    ).join('');
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

                    // --- ACTIVE PROCESS STATUS OVERLAY (LOWER PANEL) ---
                    const scoutBarContainer = document.getElementById('fused-scout-loader-bar');
                    const scoutBarFill = document.getElementById('scout-progress-fill');
                    const scoutDetails = document.getElementById('scout-progress-details');
                    const scoutPercent = document.getElementById('scout-progress-percent');

                    if (scoutBarContainer && scoutBarFill && scoutDetails && scoutPercent) {
                        scoutBarContainer.style.display = 'flex';
                        scoutBarFill.style.width = `${message.progress}%`;
                        scoutPercent.textContent = `${Math.round(message.progress)}%`;

                        if (message.current && message.total) {
                            scoutDetails.textContent = `Scouting: ${message.current} / ${message.total} files [${message.fileName}]`;
                        } else if (message.status) {
                            scoutDetails.textContent = message.status;
                        }
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
                state.lastTokenMetrics = {
                    totalTokens: message.totalTokens,
                    contextSize: message.contextSize,
                    isApproximate: message.isApproximate,
                    segments: message.segments
                };

                if (dom.tokenCountLabel) {
                    const { totalTokens, contextSize, error, isApproximate, folderStats, files } = message;

                    // LATE HYDRATION: Update global file list and sync existing UI blocks only if idle
                    if (files && state.lastContextData) {
                        state.lastContextData.files = files;
                        if (!state.fileTokensMap) state.fileTokensMap = {};
                        files.forEach((f: any) => {
                            if (f && typeof f === 'object' && f.path) {
                                if (f.tokens) state.fileTokensMap[f.path] = f.tokens;
                                else if (f.bytes) state.fileTokensMap[f.path] = Math.ceil(f.bytes / 3.5);
                            }
                        });
                        if (!state.isGenerating) {
                            import('./ui.js').then(ui => ui.syncExpansionBlocks());
                        }
                    }

                    if (folderStats) {
                        state.matrixStats = folderStats;
                        // Reactive matrix update if open
                        if (dom.matrixModal.classList.contains('visible')) {
                            renderWorkspaceMatrix();
                        }
                    }

                    if (error) {
                        console.log("[Lollms Debug:Token] Setting token label to error state.");
                        dom.tokenCountLabel.textContent = `Tokens: ${error}`;
                        if (dom.tokenProgressBar) {
                            dom.tokenProgressBar.style.width = '100%';
                            dom.tokenProgressBar.className = 'token-progress-bar range-danger';
                        }
                    } else {
                        // Coerce null/undefined/NaN values to 0 to prevent interface rendering hangs
                        const normalizedTotal = (typeof totalTokens === 'number' && !isNaN(totalTokens)) ? totalTokens : 0;
                        const size = (contextSize > 0) ? contextSize : 128000;
                        const finalLabel = `${isApproximate ? 'Est. ' : ''}Tokens: ${normalizedTotal.toLocaleString()} / ${size.toLocaleString()}`;
                        console.log("[Lollms Debug:Token] Setting label text successfully to:", finalLabel);
                        dom.tokenCountLabel.textContent = finalLabel;

                        // Clean calculating class on new data load
                        if (dom.tokenProgressBar && dom.tokenProgressBar.classList.contains('calculating')) {
                            dom.tokenProgressBar.classList.remove('calculating');
                        }

                        // Pass segments to the progress bar
                        console.log("[Lollms Debug:Token] Injecting segments to updateProgressBar:", message.segments);
                        updateProgressBar(dom.tokenProgressContainer, normalizedTotal, size, message.segments);

                        // Visual indicator on label for overflow
                        if (normalizedTotal > size) {
                            dom.tokenCountLabel.style.color = 'var(--vscode-charts-red)';
                            dom.tokenCountLabel.style.fontWeight = 'bold';
                        } else {
                            dom.tokenCountLabel.style.color = '';
                            dom.tokenCountLabel.style.fontWeight = 'normal';
                        }
                    }
                } else {
                    console.error("[Lollms Debug:Token] CRITICAL: Label container #token-count-label was null in the DOM!");
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
            case 'filesStatusResult': {
                const { blockId, statuses } = message;
                if (!statuses) break;

                const blockEl = document.getElementById(blockId) || document.querySelector(`.context-expansion-block[data-block-id='${blockId}']`);
                const listContainer = document.getElementById(`list-${blockId}`) || blockEl?.querySelector('.expansion-file-list');

                if (listContainer) {
                    const items = listContainer.querySelectorAll('.expansion-file-item');
                    let allInContext = true;

                    items.forEach((item: any) => {
                        const pathSpan = item.querySelector('.file-label') || item.querySelector('span:last-child') || item;
                        const filePath = item.dataset.path?.trim() || pathSpan?.textContent?.trim();
                        if (!filePath) return;

                        const status = statuses[filePath];
                        item.classList.remove('status-in-context', 'status-not-in-context', 'status-not-exist');

                        const icon = item.querySelector('.codicon');

                        if (status === 'in_context') {
                            item.classList.add('status-in-context');
                            item.style.color = 'var(--vscode-charts-green, #388e3c)';
                            item.style.borderColor = 'var(--vscode-charts-green, #388e3c)';
                            item.style.borderLeft = '4px solid var(--vscode-charts-green, #388e3c)';
                            item.style.background = 'rgba(15, 157, 88, 0.1)';
                            if (icon) {
                                icon.className = 'codicon codicon-check';
                                icon.style.color = 'var(--vscode-charts-green, #388e3c)';
                            }
                        } else if (status === 'not_found') {
                            allInContext = false;
                            item.classList.add('status-not-exist');
                            item.style.color = 'var(--vscode-charts-red, #e53935)';
                            item.style.borderColor = 'var(--vscode-charts-red, #e53935)';
                            item.style.borderLeft = '4px solid var(--vscode-charts-red, #e53935)';
                            item.style.background = 'rgba(244, 71, 71, 0.08)';
                            if (icon) {
                                icon.className = 'codicon codicon-error';
                                icon.style.color = 'var(--vscode-charts-red, #e53935)';
                            }
                        } else {
                            allInContext = false;
                            item.classList.add('status-not-in-context');
                            item.style.color = 'var(--vscode-editor-foreground, #000000)';
                            item.style.borderColor = 'var(--vscode-widget-border)';
                            item.style.borderLeft = '1px solid var(--vscode-widget-border)';
                            item.style.background = 'var(--vscode-editor-background)';
                            if (icon) {
                                icon.className = 'codicon codicon-file-add';
                                icon.style.color = 'var(--vscode-editor-foreground, #000000)';
                            }
                        }
                    });

                    if (blockEl) {
                        const addBtn = blockEl.querySelector('.add-btn') as HTMLButtonElement;
                        if (addBtn) {
                            if (allInContext && items.length > 0) {
                                addBtn.innerHTML = '<span class="codicon codicon-check"></span> Added to Context';
                                addBtn.className = 'code-action-btn applied add-btn';
                                addBtn.disabled = true;
                            } else {
                                addBtn.innerHTML = '<span class="codicon codicon-add"></span> Add all to Context';
                                addBtn.className = 'code-action-btn apply-btn add-btn';
                                addBtn.disabled = false;
                            }
                        }
                    }
                }
                break;
            }
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
                            item.classList.remove('status-not-in-context', 'status-not-exist');
                            item.classList.add('status-in-context');
                            item.style.color = 'var(--vscode-charts-green, #388e3c)';
                            item.style.borderColor = 'var(--vscode-charts-green, #388e3c)';
                            item.style.background = 'rgba(15, 157, 88, 0.1)';
                            const icon = item.querySelector('.codicon');
                            if (icon) {
                                icon.className = 'codicon codicon-check';
                                icon.style.color = 'var(--vscode-charts-green, #388e3c)';
                            }
                        } else if (path && results[path] === false) {
                            item.classList.remove('status-in-context', 'status-not-in-context');
                            item.classList.add('status-not-exist');
                            item.style.color = 'var(--vscode-charts-red, #e53935)';
                            item.style.borderColor = 'var(--vscode-charts-red, #e53935)';
                            item.style.background = 'rgba(244, 71, 71, 0.08)';
                            const icon = item.querySelector('.codicon');
                            if (icon) {
                                icon.className = 'codicon codicon-error';
                                icon.style.color = 'var(--vscode-charts-red, #e53935)';
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
                if (message.path) {
                    if (!state.fileTokensMap) state.fileTokensMap = {};
                    state.fileTokensMap[message.path] = message.tokens;
                }
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
                    const { filePath, messageId, blockIndex, hunkIndex, blockId } = message;
                    if (!filePath) break;

                    // 1. Update persistent in-memory applied state
                    if (messageId && blockIndex !== undefined) {
                        if (!state.appliedState[messageId]) state.appliedState[messageId] = {};
                        if (!state.appliedState[messageId][blockIndex]) state.appliedState[messageId][blockIndex] = [];

                        const hunkVal = hunkIndex !== undefined ? hunkIndex : -1;
                        if (!state.appliedState[messageId][blockIndex].includes(hunkVal)) {
                            state.appliedState[messageId][blockIndex].push(hunkVal);
                        }
                    }

                    // 2. Target the specific block matching blockIndex/blockId or data-path
                    const targetBlock = (blockId ? document.getElementById(blockId) : null)
                        || (messageId && blockIndex !== undefined ? document.getElementById(`block-${messageId}-${blockIndex}`) : null)
                        || (document.querySelector(`.file-mutation-card[data-path='${filePath}']`));

                    if (targetBlock) {
                        const applyBtn = targetBlock.querySelector('.apply-btn, .apply-mutation-btn') as HTMLButtonElement;
                        if (applyBtn) {
                            applyBtn.disabled = false;
                            applyBtn.classList.remove('delete-btn', 'apply-failed-btn');
                            applyBtn.classList.add('applied');
                            applyBtn.innerHTML = '<i class="codicon codicon-check"></i>';
                            applyBtn.title = "Successfully applied. Click to re-apply.";
                        }
                        targetBlock.classList.remove('malformed', 'apply-failed');
                        (targetBlock as HTMLElement).style.border = '';
                        (targetBlock as HTMLElement).style.backgroundColor = '';

                        if ((targetBlock as HTMLDetailsElement).open) {
                            collapseBlockWithScrollPreservation(targetBlock as HTMLDetailsElement, dom.messagesDiv);
                        }
                    }

                    if (messageId) {
                        checkAndSyncMessageAppliedState(messageId);
                    }
                }
                break;
            case 'applyAllResult':
                {
                    const wrapper = message.messageId ? document.querySelector(`.message-wrapper[data-message-id='${message.messageId}']`) as HTMLElement : null;
                    const isUndo = message.undo === true;
                    const mainApplyBtn = (message.messageId && message.blockIndex !== undefined) 
                        ? document.getElementById(`apply-btn-${message.messageId}-${message.blockIndex}`) as HTMLButtonElement 
                        : null;

                    // Locate all relevant rows in the apply-all list for this block/hunk
                    const targetRows: HTMLElement[] = [];
                    if (wrapper && message.blockIndex !== undefined) {
                        if (message.hunkIndex === -1 || message.hunkIndex === undefined) {
                            targetRows.push(...Array.from(wrapper.querySelectorAll(`.apply-row[data-block-index='${message.blockIndex}']`)) as HTMLElement[]);
                        } else {
                            const specificRow = wrapper.querySelector(`.apply-row[data-block-index='${message.blockIndex}'][data-hunk-index='${message.hunkIndex}']`) as HTMLElement;
                            if (specificRow) {
                                targetRows.push(specificRow);
                            } else {
                                const fallbackRow = wrapper.querySelector(`.apply-row[data-block-index='${message.blockIndex}']`) as HTMLElement;
                                if (fallbackRow) targetRows.push(fallbackRow);
                            }
                        }
                    }

                    targetRows.forEach(row => {
                        const iconEl = row.querySelector('.status-icon');
                        if (message.success) {
                            row.classList.remove('status-failed', 'status-applying');
                            row.classList.add('status-success');
                            if (iconEl) {
                                iconEl.innerHTML = '<span class="codicon codicon-check" style="color:var(--vscode-charts-green)"></span>';
                            }
                            row.style.background = '';
                            row.style.opacity = '1';

                            const labelInline = row.querySelector('.status-label-inline');
                            if (labelInline) labelInline.remove();

                            const rowActions = row.querySelector('.row-actions') as HTMLElement;
                            if (rowActions) rowActions.remove();
                        } else {
                            row.classList.remove('status-applying', 'status-success');
                            row.classList.add('status-failed');
                            if (iconEl) {
                                iconEl.innerHTML = '<span class="codicon codicon-error" style="color:var(--vscode-charts-red)"></span>';
                            }
                            row.style.background = '';
                            row.style.opacity = '1';

                            const labelInline = row.querySelector('.status-label-inline');
                            if (labelInline) labelInline.remove();

                            const rowActions = row.querySelector('.row-actions') as HTMLElement;
                            const isSystemId = message.messageId?.startsWith('self_correction') || message.messageId?.startsWith('guardian') || message.messageId?.startsWith('system') || message.messageId?.startsWith('inspection');
                            if (!isSystemId) {
                                let activeActions = rowActions;
                                if (!activeActions) {
                                    activeActions = document.createElement('div');
                                    activeActions.className = 'row-actions';
                                    row.appendChild(activeActions);
                                }
                                activeActions.style.display = 'flex';
                                activeActions.style.gap = '6px';
                                activeActions.style.marginLeft = 'auto';

                                const blockEl = document.getElementById(`block-${message.messageId}-${message.blockIndex}`) as HTMLDetailsElement;
                                const rawCode = blockEl ? blockEl.dataset.rawCode || "" : "";

                                activeActions.innerHTML = `
                                    <button class="code-action-btn apply-btn row-fix-ai-btn" style="height:20px; font-size:9px; padding:0 6px;" title="Ask AI to repair this specific change">
                                        <i class="codicon codicon-sparkle"></i> Fix with AI
                                    </button>
                                    <button class="code-action-btn secondary-btn row-manual-stitch-btn" style="height:20px; font-size:9px; padding:0 6px;" title="Open manual stitching modal">
                                        <i class="codicon codicon-tools"></i> Raw Block
                                    </button>
                                `;

                                const fixAiBtn = activeActions.querySelector('.row-fix-ai-btn') as HTMLButtonElement;
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

                                const manualStitchBtn = activeActions.querySelector('.row-manual-stitch-btn') as HTMLButtonElement;
                                if (manualStitchBtn) {
                                    manualStitchBtn.onclick = (e) => {
                                        e.stopPropagation();
                                        openRawCodeModal(
                                            message.messageId, 
                                            message.blockIndex, 
                                            message.filePath, 
                                            rawCode,
                                            message.hunkIndex !== undefined ? message.hunkIndex : 0,
                                            blockEl?.id
                                        );
                                    };
                                }
                            }
                        }
                    });

                    // 1. Resilient Card Lookup across XML file mutation cards and standard code blocks
                    let blockEl: HTMLDetailsElement | null = null;
                    if (message.blockId) {
                        blockEl = document.getElementById(message.blockId) as HTMLDetailsElement;
                    }
                    if (!blockEl && wrapper && message.blockIndex !== undefined) {
                        blockEl = wrapper.querySelector(`.file-mutation-card[data-block-index='${message.blockIndex}'], details[id='block-${message.messageId}-${message.blockIndex}'], details[data-block-index='${message.blockIndex}']`) as HTMLDetailsElement;
                    }
                    if (!blockEl && message.filePath) {
                        if (wrapper) {
                            blockEl = wrapper.querySelector(`.file-mutation-card[data-path='${message.filePath}'], details[data-path='${message.filePath}']`) as HTMLDetailsElement;
                        }
                        if (!blockEl) {
                            blockEl = document.querySelector(`.file-mutation-card[data-path='${message.filePath}'], details[data-path='${message.filePath}']`) as HTMLDetailsElement;
                        }
                    }
                    if (!blockEl && message.messageId && message.blockIndex !== undefined) {
                        blockEl = document.getElementById(`block-${message.messageId}-${message.blockIndex}`) as HTMLDetailsElement;
                    }

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
                        // 1. Remove failure / malformed alert styles
                        blockEl.classList.remove('malformed', 'apply-failed');
                        blockEl.style.removeProperty('border');
                        blockEl.style.removeProperty('background-color');
                        (blockEl as HTMLElement).style.border = '';
                        (blockEl as HTMLElement).style.backgroundColor = '';

                        // 2. Remove any injected Auto Repair / Manual Stitch buttons from block actions
                        blockEl.querySelectorAll('.fix-ai-btn, .manual-fix-btn, .repairBtn, .row-fix-ai-btn, .row-manual-stitch-btn').forEach(el => el.remove());

                        const hunkVal = message.hunkIndex !== undefined ? message.hunkIndex : -1;

                        if (message.messageId && message.blockIndex !== undefined) {
                            if (!state.appliedState[message.messageId]) state.appliedState[message.messageId] = {};
                            if (!state.appliedState[message.messageId][message.blockIndex]) state.appliedState[message.messageId][message.blockIndex] = [];

                            if (isUndo) {
                                state.appliedState[message.messageId][message.blockIndex] = state.appliedState[message.messageId][message.blockIndex].filter(v => v !== hunkVal);
                                if (hunkVal === -1) state.appliedState[message.messageId][message.blockIndex] = [];
                            } else {
                                if (!state.appliedState[message.messageId][message.blockIndex].includes(hunkVal)) {
                                    state.appliedState[message.messageId][message.blockIndex].push(hunkVal);
                                }
                            }
                        }

                        const restoreBtn = (btn: HTMLButtonElement) => {
                            if (!btn) return;
                            const bubble = btn.closest('.aider-hunk-bubble, .code-collapsible, .file-mutation-card');
                            const undoBtn = bubble?.querySelector('.undo-hunk-btn, .undo-block-btn, .undo-mutation-btn') as HTMLElement;
                            const isPatch = bubble?.getAttribute('data-action') === 'patch' || bubble?.classList.contains('aider-diff-container') || bubble?.querySelector('.aider-hunk-group') !== null;

                            btn.disabled = false; // Always keep clickable to re-apply

                            const isMainBtn = btn.id && btn.id.startsWith('apply-btn-');

                            if (isUndo) {
                                btn.classList.remove('applied');
                                const icon = isMainBtn 
                                    ? (btn.classList.contains('apply-all-btn') ? 'codicon-check-all' : (isPatch ? 'codicon-diff-modified' : 'codicon-tools'))
                                    : (isPatch ? 'codicon-arrow-swap' : 'codicon-tools');
                                btn.innerHTML = `<i class="codicon ${icon}"></i>`;
                                btn.title = "Review Diff & Apply";
                                if (undoBtn) {
                                    undoBtn.style.display = 'none';
                                    undoBtn.disabled = false;
                                    undoBtn.innerHTML = '<i class="codicon codicon-discard"></i>';
                                }
                            } else if (message.alreadyApplied) {
                                btn.classList.add('applied');
                                btn.innerHTML = '<i class="codicon codicon-check"></i>';
                                btn.title = "Successfully applied. Click to re-apply.";
                                
                                // Reveal or instantiate the red Undo button for patches
                                if (isPatch) {
                                    let activeUndoBtn = undoBtn as HTMLButtonElement;
                                    if (!activeUndoBtn) {
                                        activeUndoBtn = document.createElement('button');
                                        activeUndoBtn.className = 'code-action-btn delete-btn undo-mutation-btn';
                                        activeUndoBtn.title = 'Undo this patch (apply inverse)';
                                        activeUndoBtn.innerHTML = '<i class="codicon codicon-discard"></i>';
                                        const actions = bubble?.querySelector('.code-actions');
                                        if (actions) actions.insertBefore(activeUndoBtn, btn);
                                    }
                                    activeUndoBtn.style.display = 'inline-flex';
                                    activeUndoBtn.disabled = false;
                                    activeUndoBtn.innerHTML = '<i class="codicon codicon-discard"></i>';
                                    
                                    const rawCodeAttr = bubble?.getAttribute('data-raw-code');
                                    const rawCode = rawCodeAttr ? decodeURIComponent(rawCodeAttr) : (bubble?.querySelector('pre code')?.textContent || "");
                                    const path = bubble?.getAttribute('data-path');
                                    const bIdx = parseInt(bubble?.getAttribute('data-block-index') || "0", 10);
                                    activeUndoBtn.onclick = (e: MouseEvent) => {
                                        e.stopPropagation();
                                        activeUndoBtn.disabled = true;
                                        activeUndoBtn.innerHTML = '<div class="spinner"></div>';
                                        vscode.postMessage({
                                            command: 'replaceCode',
                                            filePath: path,
                                            content: rawCode,
                                            messageId: message.messageId,
                                            blockIndex: bIdx,
                                            blockId: bubble?.id,
                                            options: { undo: true, silent: true, autoSave: true, blockId: bubble?.id, blockIndex: bIdx }
                                        });
                                    };
                                }
                            } else if (message.reviewingDiff) {
                                btn.disabled = false;
                                btn.classList.remove('applied');
                                btn.innerHTML = '<i class="codicon codicon-diff"></i>';
                                btn.title = "Reviewing diff in tab. Validate changes to complete application.";
                            } else {
                                btn.classList.remove('applied');
                                const icon = isMainBtn 
                                    ? (isPatch ? 'codicon-diff-modified' : 'codicon-tools')
                                    : (isPatch ? 'codicon-arrow-swap' : 'codicon-tools');
                                btn.innerHTML = `<i class="codicon ${icon}"></i>`;
                                btn.title = isMainBtn 
                                    ? "Interactive diff opened. Edit right side and validate to apply."
                                    : "Apply this hunk surgically.";
                            }
                        };

                        // Update specific Apply button for this block (including .apply-mutation-btn)
                        const mainBtn = document.getElementById(`apply-btn-${message.messageId}-${message.blockIndex}`) as HTMLButtonElement;
                        if (mainBtn) restoreBtn(mainBtn);

                        const mutationApplyBtn = blockEl?.querySelector('.apply-mutation-btn') as HTMLButtonElement;
                        if (mutationApplyBtn) restoreBtn(mutationApplyBtn);

                        // Clear and restore repair buttons on success
                        const activeRepairBtn = blockEl?.querySelector('.fix-ai-btn, .repairBtn, .row-fix-ai-btn') as HTMLButtonElement;
                        if (activeRepairBtn) {
                            activeRepairBtn.disabled = false;
                            activeRepairBtn.innerHTML = '<span class="codicon codicon-sparkle"></span> Fix with AI';
                            activeRepairBtn.style.display = 'none'; // Hide repair button once successfully applied
                        }
                        if (message.hunkIndex !== undefined && message.hunkIndex !== -1) {
                            // TAB SYNC: Find the specific tab and pane
                            const tab = blockEl.querySelector(`.hunk-tab-${message.hunkIndex}`) as HTMLElement;
                            const pane = blockEl.querySelector(`.hunk-pane-${message.hunkIndex}`) as HTMLElement;

                            if (tab) {
                                if (message.alreadyApplied) {
                                    tab.classList.add('status-completed');
                                    tab.classList.remove('status-failed');
                                    tab.querySelector('.hunk-status-icon i')!.className = 'codicon codicon-check';
                                } else {
                                    tab.classList.remove('status-completed');
                                    tab.querySelector('.hunk-status-icon i')!.className = 'codicon codicon-primitive-dot';
                                }
                            }

                            if (pane) {
                                const hunkBtn = pane.querySelector('.apply-btn') as HTMLButtonElement;
                                if (hunkBtn) restoreBtn(hunkBtn);
                            }

                            // If all hunk tabs in this block are now completed, mark the block's main button as applied too
                            const allHunkTabs = blockEl.querySelectorAll('.hunk-tab');
                            const completedTabs = blockEl.querySelectorAll('.hunk-tab.status-completed');
                            if (allHunkTabs.length > 0 && allHunkTabs.length === completedTabs.length) {
                                const mainBtn = blockEl.querySelector('.code-actions .apply-btn, .apply-mutation-btn') as HTMLButtonElement;
                                if (mainBtn) restoreBtn(mainBtn);
                                if (!state.appliedState[message.messageId][message.blockIndex].includes(-1)) {
                                    state.appliedState[message.messageId][message.blockIndex].push(-1);
                                }
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

                        // Re-sync main button state and results list for the entire message
                        if (message.messageId) {
                            import('./messageRenderer.js').then(m => {
                                m.syncResultsListRows(message.messageId);
                                m.checkAndSyncMessageAppliedState(message.messageId);
                            });
                        }

                        // Collapse block automatically upon application
                        if (message.alreadyApplied && !isUndo && blockEl && blockEl.open) {
                            import('./utils.js').then(utils => {
                                utils.collapseBlockWithScrollPreservation(blockEl, document.getElementById('messages'));
                            });
                        }
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
                        // 1. STOP ALL SPINNERS & RESTORE BUTTON STATES
                        const targetApplyBtn = blockEl.querySelector('.apply-btn, .apply-mutation-btn') as HTMLButtonElement;
                        if (targetApplyBtn) {
                            targetApplyBtn.disabled = false;
                            targetApplyBtn.classList.remove('applied');
                            targetApplyBtn.classList.add('delete-btn', 'apply-failed-btn');
                            targetApplyBtn.innerHTML = '<i class="codicon codicon-error"></i> Failed';
                            targetApplyBtn.title = message.error || "Patch failed to match file content on disk. Click to retry.";
                        }

                        // Reset any active repair buttons in this block
                        const activeRepairBtn = blockEl.querySelector('.fix-ai-btn, .repairBtn, .row-fix-ai-btn') as HTMLButtonElement;
                        if (activeRepairBtn) {
                            activeRepairBtn.disabled = false;
                            activeRepairBtn.innerHTML = '<span class="codicon codicon-sparkle"></span> Fix with AI';
                        }

                        if (mainApplyBtn) {
                            mainApplyBtn.disabled = false;
                            mainApplyBtn.classList.remove('applied', 'sequential-applying');
                            mainApplyBtn.classList.add('delete-btn', 'apply-failed-btn');
                            mainApplyBtn.innerHTML = '<i class="codicon codicon-error"></i>';
                        }

                        // 2. TAB SYNC: Highlight the failing tab
                        if (message.hunkIndex !== undefined) {
                            const tab = blockEl.querySelector(`.hunk-tab-${message.hunkIndex}`) as HTMLElement;
                            if (tab) {
                                tab.classList.add('status-failed', 'active');
                                tab.querySelector('.hunk-status-icon i')!.className = 'codicon codicon-error';

                                blockEl.querySelectorAll('.hunk-tab, .hunk-tab-content').forEach(el => {
                                    if (el !== tab && !el.classList.contains(`hunk-pane-${message.hunkIndex}`)) {
                                        el.classList.remove('active');
                                    }
                                });
                                blockEl.querySelector(`.hunk-pane-${message.hunkIndex}`)?.classList.add('active');
                            }
                        }

                        // 3. VISUAL RED ALERT: Highlight card in red and expand it so the user can inspect
                        blockEl.classList.add('malformed', 'apply-failed');
                        (blockEl as HTMLElement).style.border = '2px solid var(--vscode-charts-red)';
                        (blockEl as HTMLElement).style.backgroundColor = 'rgba(244, 71, 71, 0.08)';
                        (blockEl as HTMLDetailsElement).open = true;

                        // 4. INSERT "Auto Repair" & "Manual Stitch" BUTTONS DIRECTLY INTO CARD ACTIONS
                        const actions = blockEl.querySelector('.code-actions');
                        if (actions) {
                            const rawCode = blockEl.dataset.rawCode ? decodeURIComponent(blockEl.dataset.rawCode) : (blockEl.querySelector('pre code')?.textContent || "");

                            if (!actions.querySelector('.fix-ai-btn')) {
                                const fixAiBtn = document.createElement('button');
                                fixAiBtn.className = 'code-action-btn apply-btn fix-ai-btn';
                                fixAiBtn.style.cssText = 'background-color: var(--vscode-charts-purple) !important; color: white !important;';
                                fixAiBtn.innerHTML = '<span class="codicon codicon-sparkle"></span> Auto Repair';
                                fixAiBtn.title = "Ask AI to repair this specific patch against current disk content";
                                fixAiBtn.onclick = (e: MouseEvent) => {
                                    e.stopPropagation();
                                    fixAiBtn.disabled = true;
                                    fixAiBtn.innerHTML = '<div class="spinner"></div> Repairing...';
                                    vscode.postMessage({ 
                                        command: 'replaceCode', 
                                        filePath: message.filePath, 
                                        content: "REPAIR_REQUESTED", 
                                        messageId: message.messageId, 
                                        blockIndex: message.blockIndex,
                                        hunkIndex: message.hunkIndex,
                                        options: { silent: true, blockIndex: message.blockIndex, hunkIndex: message.hunkIndex }
                                    });
                                };
                                actions.insertBefore(fixAiBtn, actions.firstChild);
                            }

                            if (!actions.querySelector('.manual-fix-btn')) {
                                const manualFixBtn = document.createElement('button');
                                manualFixBtn.className = 'code-action-btn secondary-btn manual-fix-btn';
                                manualFixBtn.style.cssText = 'border-color: var(--vscode-charts-orange); color: var(--vscode-charts-orange);';
                                manualFixBtn.innerHTML = '<span class="codicon codicon-tools"></span> Manual Stitch';
                                manualFixBtn.title = "Open side-by-side manual stitching view";
                                manualFixBtn.onclick = (e: MouseEvent) => {
                                    e.stopPropagation();
                                    openRawCodeModal(
                                        message.messageId, 
                                        message.blockIndex, 
                                        message.filePath, 
                                        rawCode, 
                                        message.hunkIndex !== undefined ? message.hunkIndex : 0
                                    );
                                };
                                actions.insertBefore(manualFixBtn, actions.children[1] || actions.firstChild);
                            }
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

                    // Update master button state via authoritative calculation
                    if (message.messageId) {
                        checkAndSyncMessageAppliedState(message.messageId);

                        const resultsList = document.getElementById(`results-${message.messageId}`) || wrapper?.querySelector('.apply-results-list');
                        if (resultsList && isUndo) {
                            const stillPending = resultsList.querySelectorAll('.spinner, .codicon-loading').length;
                            if (stillPending === 0) {
                                const progressBar = document.getElementById(`progress-container-${message.messageId}`);
                                if (progressBar) progressBar.style.display = 'none';
                                (resultsList as HTMLElement).style.display = 'none';
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

