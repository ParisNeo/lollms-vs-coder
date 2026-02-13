import { dom, vscode, state } from './dom.js';
import { addMessage, renderMessageContent, updateContext, displayPlan, scheduleRender } from './messageRenderer.js';
import { setGeneratingState, updateBadges, renderSkillsTree } from './ui.js';

export function handleExtensionMessage(event: MessageEvent) {
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
                setGeneratingState(message.isGenerating);
                break;
            case 'updateContext':
                updateContext(message.context, message.files, message.skills);
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
                    } else if (!state.profiles) {
                        state.profiles = [];
                    }

                    if (caps.generationFormats) {
                        if (dom.checkGenFull) dom.checkGenFull.checked = caps.generationFormats.fullFile;
                        if (dom.checkGenDiff) dom.checkGenDiff.checked = caps.generationFormats.diff;
                        if (dom.checkGenAider) dom.checkGenAider.checked = caps.generationFormats.aider;
                    }

                    if (dom.checkBehaviorExplain) {
                        dom.checkBehaviorExplain.checked = caps.explainCode !== false;
                    }

                    if (dom.allowedFormats) {
                        if (dom.fmtFullFile) dom.fmtFullFile.checked = caps.allowedFormats.fullFile;
                        if (dom.fmtInsert) dom.fmtInsert.checked = caps.allowedFormats.insert;
                        if (dom.fmtReplace) dom.fmtReplace.checked = caps.allowedFormats.replace;
                        if (dom.fmtDelete) dom.fmtDelete.checked = caps.allowedFormats.delete;
                    }

                    if(dom.capFileRename) dom.capFileRename.checked = caps.fileRename;
                    if(dom.capFileDelete) dom.capFileDelete.checked = caps.fileDelete;
                    if(dom.capFileSelect) dom.capFileSelect.checked = caps.fileSelect;
                    if(dom.capFileReset) dom.capFileReset.checked = caps.fileReset;

                    if(dom.capImageGen) dom.capImageGen.checked = caps.imageGen;
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
                    if (dom.herdModeCheckbox) dom.herdModeCheckbox.checked = caps.herdMode;

                    if (dom.herdConfigSection) {
                        dom.herdConfigSection.style.display = caps.herdMode ? 'block' : 'none';
                    }

                    if (dom.activeToolsIndicator) {
                        dom.activeToolsIndicator.innerHTML = '';
                        if (caps.arxivSearch) {
                            dom.activeToolsIndicator.innerHTML += `<div class="active-tool-icon active" title="ArXiv Search Enabled"><i class="codicon codicon-book"></i></div>`;
                        }
                    }

                    if (dom.websearchIndicator) {
                        dom.websearchIndicator.style.display = caps.webSearch ? 'flex' : 'none';
                    }
                    
                    updateBadges();
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
                }
                if (dom.tokenCountLabel) dom.tokenCountLabel.style.opacity = '0.5';
                break;

            case 'tokenCalculationFinished':
                if (dom.contextLoadingSpinner) {
                    dom.contextLoadingSpinner.style.display = 'none';
                }
                if (dom.tokenCountLabel) dom.tokenCountLabel.style.opacity = '1';
                break;
            case 'updateTokenProgress':
                if(dom.tokenCountLabel) {
                    const { totalTokens, contextSize, error, isApproximate } = message;
                     if (error) {
                        dom.tokenCountLabel.textContent = `Tokens: ${error}`;
                        if (dom.tokenProgressBar) {
                            dom.tokenProgressBar.style.width = '100%';
                            dom.tokenProgressBar.classList.add('red');
                        }
                    } else if (typeof totalTokens === 'number') {
                        const size = (typeof contextSize === 'number' && contextSize > 0) ? contextSize : 0;
                        const labelText = isApproximate 
                            ? `Est. Tokens: ${totalTokens} / ${size} (Approx)` 
                            : `Tokens: ${totalTokens} / ${size}`;
                        
                        dom.tokenCountLabel.textContent = labelText;
                        
                        if (dom.tokenProgressBar) {
                            if (size > 0) {
                                const percentage = Math.min((totalTokens / size) * 100, 100);
                                dom.tokenProgressBar.style.width = `${percentage}%`;
                                dom.tokenProgressBar.classList.remove('green', 'yellow', 'red', 'approximate');
                                if (isApproximate) {
                                    dom.tokenProgressBar.classList.add('approximate');
                                } else if (percentage > 90) {
                                    dom.tokenProgressBar.classList.add('red');
                                } else if (percentage > 75) {
                                    dom.tokenProgressBar.classList.add('yellow');
                                } else {
                                    dom.tokenProgressBar.classList.add('green');
                                }
                            } else {
                                dom.tokenProgressBar.style.width = '0%';
                            }
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
                    actionBtn.innerHTML = `<span class="codicon codicon-check"></span> Added!`;
                    actionBtn.classList.add('success');
                    setTimeout(() => {
                        actionBtn.innerHTML = `<span class="codicon codicon-add"></span> Add to Context`;
                        actionBtn.classList.remove('success');
                        actionBtn.disabled = false;
                    }, 3000);
                }
                const codeBlock = document.getElementById(blockId);
                if (codeBlock) {
                    const originalText = codeBlock.textContent || '';
                    const lines = originalText.trim().split('\n');
                    let newHtml = '';
                    lines.forEach(line => {
                        const path = line.trim();
                        if (results[path] === true) {
                            newHtml += `<div class="select-line-valid">${path}</div>`;
                        } else if (results[path] === false) {
                            newHtml += `<div class="select-line-invalid">${path} (Not found)</div>`;
                        } else {
                            newHtml += `<div>${path}</div>`;
                        }
                    });
                    codeBlock.classList.remove('language-select');
                    codeBlock.innerHTML = newHtml;
                }
                break;
            }
            case 'updateGitState': {
                state.currentBranch = message.branch;
                updateBadges();
                break;
            }
            case 'setCommitMessage': {
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
            case 'showSkillsModal':
                if (dom.skillsTreeContainer) {
                    dom.skillsTreeContainer.innerHTML = '';
                    renderSkillsTree(dom.skillsTreeContainer, message.skillsTree);
                }
                if (dom.skillsModal) {
                    dom.skillsModal.classList.add('visible');
                }
                break;
        }
    } catch(e: any) {
        console.error("Lollms Webview Error: Failed to process message from extension.", e);
        vscode.postMessage({ command: 'showError', message: 'Webview error: ' + e.message });
    }
}
