import { dom } from './dom.js';
import { state, vscode } from './main.js';
import { addMessage, renderMessageContent, updateContext, displayPlan, scheduleRender } from './messageRenderer.js';
import { setGeneratingState } from './ui.js';

export function handleExtensionMessage(event: MessageEvent) {
    try {
        const message = event.data;
        console.log("Webview received message from extension:", message.command, message);
        switch (message.command) {
            case 'addMessage':
                addMessage(message.message);
                break;
            case 'appendMessageChunk': {
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
                break;
            }
            case 'finalizeMessage': {
                const stream = state.streamingMessages[message.id];
                if (stream) {
                    if (stream.timer) clearTimeout(stream.timer);
                    delete state.streamingMessages[message.id];
                }

                const wrapper = document.querySelector(`.message-wrapper[data-message-id='${message.id}']`) as HTMLElement;
                if(wrapper) {
                    const firstTokenTime = parseInt(wrapper.dataset.firstTokenTime || '0', 10);
                    if (firstTokenTime) {
                        const duration = (Date.now() - firstTokenTime) / 1000;
                        const tokenCount = message.tokenCount;
                        if (duration > 0.05 && tokenCount > 1) {
                            const tps = (tokenCount / duration).toFixed(1);
                            const annotationSpan = wrapper.querySelector('.generation-stats');
                            if (annotationSpan) annotationSpan.textContent += ` | ${tps} t/s`;
                        }
                    }

                    const contentDiv = wrapper.querySelector('.message-content');
                    const messageDiv = wrapper.querySelector('.message');
                    if (contentDiv && messageDiv) {
                        if (message.isHtml) {
                            contentDiv.innerHTML = DOMPurify.sanitize(message.fullContent);
                            messageDiv.classList.replace('assistant-message', 'system-message');
                        } else {
                            (messageDiv as HTMLElement).dataset.originalContent = JSON.stringify(message.fullContent);
                            renderMessageContent(message.id, message.fullContent);
                        }
                        dom.messagesDiv.scrollTop = dom.messagesDiv.scrollHeight;
                    }
                }
                break;
            }
            case 'setGeneratingState':
                setGeneratingState(message.isGenerating);
                break;
            case 'startContextLoading':
                dom.contextStatusContainer.style.display = 'none';
                dom.contextLoadingSpinner.style.display = 'flex';
                break;
            case 'displayPlan':
                const isFinished = !message.plan || message.plan.tasks.every((t: any) => t.status === 'completed' || t.status === 'failed');
                setGeneratingState(!isFinished);
                displayPlan(message.plan);
                break;
            case 'loadDiscussion':
                dom.attachmentsContainer.innerHTML = '';

                const messagesToRemove: Element[] = [];
                for (const child of Array.from(dom.chatMessagesContainer.children)) {
                    if (child.id !== 'message-insertion-controls') {
                        messagesToRemove.push(child);
                    }
                }
                messagesToRemove.forEach(child => child.remove());

                const attachmentsCollapsible = dom.attachmentsContainer.closest('.info-collapsible');
                if (attachmentsCollapsible) {
                    (attachmentsCollapsible as HTMLElement).style.display = 'none';
                }
                
                state.isInspectorEnabled = message.isInspectorEnabled;
                
                let hasChatContent = false;
                if (Array.isArray(message.messages)) {
                    message.messages.forEach((msg: any) => {
                        addMessage(msg);
                        if ((msg.role === 'user' || msg.role === 'assistant') && (!msg.id || !msg.id.startsWith('attachment_'))) {
                            hasChatContent = true;
                        }
                    });
                }
                
                const attachmentCount = dom.attachmentsContainer.children.length;
                if (attachmentCount > 0 && attachmentsCollapsible) {
                    (attachmentsCollapsible as HTMLElement).style.display = 'block';
                    const summary = attachmentsCollapsible.querySelector('summary');
                    if(summary) summary.textContent = `📎 Added Files (${attachmentCount})`;
                }

                dom.welcomeMessage.style.display = (attachmentCount > 0 || hasChatContent) ? 'none' : 'block';
                setGeneratingState(false);
                dom.messagesDiv.scrollTop = dom.messagesDiv.scrollHeight;
                break;
            case 'updateModels':
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
                break;
            case 'updateContext':
                updateContext(message.context);
                break;
            case 'updateTokenProgress':
                dom.contextStatusContainer.style.display = 'flex';
                dom.contextLoadingSpinner.style.display = 'none';
                const { totalTokens, contextSize, error } = message;

                if (error) {
                    dom.tokenCountLabel.textContent = `Tokens: ${error}`;
                    dom.tokenProgressBar.style.width = '100%';
                    dom.tokenProgressBar.classList.remove('green', 'yellow');
                    dom.tokenProgressBar.classList.add('red');
                } else if (typeof totalTokens === 'number' && typeof contextSize === 'number' && contextSize > 0) {
                    const percentage = Math.min((totalTokens / contextSize) * 100, 100);
                    dom.tokenProgressBar.style.width = `${percentage}%`;
                    
                    dom.tokenProgressBar.classList.remove('green', 'yellow', 'red');
                    if (percentage > 90) dom.tokenProgressBar.classList.add('red');
                    else if (percentage > 75) dom.tokenProgressBar.classList.add('yellow');
                    else dom.tokenProgressBar.classList.add('green');
                    
                    dom.tokenCountLabel.textContent = `Tokens: ${totalTokens} / ${contextSize}`;
                } else {
                    dom.tokenCountLabel.textContent = `Tokens: Press 🔃 to calculate`;
                    dom.tokenProgressBar.style.width = '0%';
                }
                break;
            case 'updateAgentMode':
                dom.agentModeCheckbox.checked = message.isActive;
                if (!message.isActive) setGeneratingState(false);
                break;
            case 'error':
                setGeneratingState(false);
                addMessage({ id: 'error_' + Date.now(), role: 'system', content: '❌ Error: ' + message.content });
                break;
            case 'setInputText':
                dom.messageInput.value = message.text;
                dom.messageInput.focus();
                break;
            case 'forceScrollToBottom':
                dom.messagesDiv.scrollTop = dom.messagesDiv.scrollHeight;
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
                dom.toolsListDiv.innerHTML = '';
                message.allTools.forEach((tool: {name: string, description: string}) => {
                    const isChecked = message.enabledTools.includes(tool.name);
                    const toolItem = document.createElement('div');
                    toolItem.className = 'tool-item';
                    toolItem.innerHTML = `
                        <input type="checkbox" class="tool-item-checkbox" id="tool-${tool.name}" value="${tool.name}" ${isChecked ? 'checked' : ''}>
                        <label for="tool-${tool.name}" class="tool-item-details">
                            <h4>${tool.name}</h4>
                            <p>${tool.description}</p>
                        </label>
                    `;
                    dom.toolsListDiv.appendChild(toolItem);
                });
                break;
        }
    } catch(e: any) {
        console.error("Lollms Webview Error: Failed to process message from extension.", e);
        vscode.postMessage({ command: 'showError', message: 'Webview error: ' + e.message });
    }
}
