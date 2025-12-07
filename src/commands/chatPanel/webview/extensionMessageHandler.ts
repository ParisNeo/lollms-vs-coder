import { dom, vscode, state } from './dom.js';
import { addMessage, renderMessageContent, updateContext, displayPlan, scheduleRender } from './messageRenderer.js';
import { setGeneratingState } from './ui.js';

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
                    // Pass true for isFinal to enable buttons
                    renderMessageContent(message.id, message.fullContent, true);
                }
                break;
            case 'setGeneratingState':
                setGeneratingState(message.isGenerating);
                break;
            case 'updateContext':
                updateContext(message.context);
                break;
            case 'displayPlan':
                const isFinished = !message.plan || message.plan.tasks.every((t: any) => t.status === 'completed' || t.status === 'failed');
                setGeneratingState(!isFinished);
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
            case 'updateModels':
                if(dom.refreshModelsBtn) {
                    const icon = dom.refreshModelsBtn.querySelector('.codicon');
                    if(icon) icon.classList.remove('spin');
                }
                if(dom.modelSelector) {
                    dom.modelSelector.innerHTML = '<option value="">Default Model</option>';
                    if (Array.isArray(message.models)) {
                        message.models.forEach((model: {id: string}) => {
                            const option = document.createElement('option');
                            option.value = model.id;
                            option.textContent = model.id;
                            dom.modelSelector.appendChild(option);
                        });
                    }
                    dom.modelSelector.value = message.currentModel || '';
                }
                break;
            case 'tokenCalculationStarted':
                if (dom.tokenCountingOverlay) {
                    dom.tokenCountingOverlay.style.display = 'flex';
                    if (dom.tokenCountingText && message.text) {
                        dom.tokenCountingText.textContent = message.text;
                    }
                }
                if (dom.inputAreaWrapper) dom.inputAreaWrapper.style.display = 'none';
                break;
            case 'tokenCalculationFinished':
                if (dom.tokenCountingOverlay) dom.tokenCountingOverlay.style.display = 'none';
                if (dom.inputAreaWrapper) dom.inputAreaWrapper.style.display = 'block';
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

                    // Add event listeners for settings buttons
                    const settingsBtns = dom.toolsListDiv.querySelectorAll('.tool-settings-btn');
                    settingsBtns.forEach(btn => {
                        btn.addEventListener('click', (e) => {
                            e.stopPropagation(); // Prevent modal close or other clicks
                            // Currently we only open global settings, but we could be more specific
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
        }
    } catch(e: any) {
        console.error("Lollms Webview Error: Failed to process message from extension.", e);
        vscode.postMessage({ command: 'showError', message: 'Webview error: ' + e.message });
    }
}
