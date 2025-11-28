// src/commands/chatPanel/webview/main.ts
// Import dom first.
import { dom, vscode, state } from './dom.js';

// Type definitions for globals
declare const l10n: { [key: string]: string };

console.log("DEBUG: Lollms-VS-Coder Webview script starting...");

// Global Error Handler
window.onerror = function (msg, source, lineno, colno, error) {
    console.error("Global Webview Error:", msg, error);
    vscode.postMessage({
        command: 'showError',
        message: `Client Error: ${msg} (${source}:${lineno})`
    });
    return false;
};

// Libraries
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import mermaid from 'mermaid';
import Prism from 'prismjs';

// --- PrismJS Dependencies (Order Matters) ---

// 1. Core & Bases
import 'prismjs/components/prism-clike';
import 'prismjs/components/prism-markup'; // html, xml, svg
import 'prismjs/components/prism-markup-templating'; // Required for PHP, ERB, etc.

// 2. Common Languages
import 'prismjs/components/prism-css';
import 'prismjs/components/prism-javascript'; // Depends on clike
import 'prismjs/components/prism-typescript'; // Depends on javascript
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-c';
import 'prismjs/components/prism-cpp';
import 'prismjs/components/prism-csharp';
import 'prismjs/components/prism-java';
import 'prismjs/components/prism-go';
import 'prismjs/components/prism-rust';
import 'prismjs/components/prism-sql';
import 'prismjs/components/prism-yaml';
import 'prismjs/components/prism-markdown'; // Depends on markup

// 3. Scripting & Config
import 'prismjs/components/prism-powershell';
import 'prismjs/components/prism-batch';
import 'prismjs/components/prism-lua';
import 'prismjs/components/prism-php'; // Depends on markup-templating
import 'prismjs/components/prism-r';
import 'prismjs/components/prism-swift';
import 'prismjs/components/prism-kotlin';
import 'prismjs/components/prism-ruby';
import 'prismjs/components/prism-dart';
import 'prismjs/components/prism-docker';
import 'prismjs/components/prism-makefile';
import 'prismjs/components/prism-nginx';
import 'prismjs/components/prism-http';
import 'prismjs/components/prism-latex';
import 'prismjs/components/prism-perl';

// 4. Web Frameworks & Extensions
import 'prismjs/components/prism-sass';
import 'prismjs/components/prism-scss';
import 'prismjs/components/prism-jsx'; // Depends on javascript, markup
import 'prismjs/components/prism-tsx'; // Depends on jsx, typescript

// Initialize DOMPurify
const sanitizer = typeof DOMPurify === 'function' ? (DOMPurify as any)(window) : DOMPurify;

// Make libraries available globally
(window as any).marked = marked;
(window as any).DOMPurify = sanitizer;
(window as any).mermaid = mermaid;
(window as any).Prism = Prism;

// Logic Imports
import { 
    addMessage, 
    renderMessageContent, 
    updateContext, 
    displayPlan, 
    scheduleRender,
    insertNewMessageEditor 
} from './messageRenderer.js';
import { performSearch, navigateSearch, clearSearch } from './search.js';
import { isScrolledToBottom } from './utils.js';

// =================================== UI Functions ===================================
function localSetGeneratingState(isGenerating: boolean) {
    if(dom.messageInput) dom.messageInput.disabled = isGenerating;
    if(dom.agentModeCheckbox) dom.agentModeCheckbox.disabled = isGenerating;
    if(dom.agentModeToggle) dom.agentModeToggle.classList.toggle('disabled', isGenerating);
    if(dom.modelSelector) dom.modelSelector.disabled = isGenerating;
    if(dom.attachButton) dom.attachButton.disabled = isGenerating;
    if(dom.executeButton) dom.executeButton.disabled = isGenerating;
    
    if(dom.sendButton) dom.sendButton.style.display = isGenerating ? 'none' : 'flex';
    if(dom.stopButton) dom.stopButton.style.display = isGenerating ? 'flex' : 'none';
    
    if (!isGenerating) {
        if (!isScrolledToBottom(dom.messagesDiv)) {
            dom.scrollToBottomBtn.style.display = 'flex';
        } else {
            dom.scrollToBottomBtn.style.display = 'none';
        }
    }
}

// =================================== Message Handling ===================================
function handleExtensionMessage(event: MessageEvent) {
    try {
        const message = event.data;
        
        switch (message.command) {
            case 'addMessage':
                addMessage(message.message);
                break;
            case 'loadDiscussion':
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
                            addMessage(msg);
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
                
                localSetGeneratingState(false);
                if(dom.messagesDiv) dom.messagesDiv.scrollTop = dom.messagesDiv.scrollHeight;
                break;

            case 'setGeneratingState':
                localSetGeneratingState(message.isGenerating);
                break;

            case 'appendMessageChunk': {
                const stream = state.streamingMessages[message.id];
                if (!stream) break;
                stream.buffer += message.chunk;
                scheduleRender(message.id);
                break;
            }

            case 'finalizeMessage': {
                const stream = state.streamingMessages[message.id];
                if (stream) {
                    if (stream.timer) clearTimeout(stream.timer);
                    delete state.streamingMessages[message.id];
                }
                // Pass true for isFinal to enable buttons (Execute, Apply, etc.)
                renderMessageContent(message.id, message.fullContent, true);
                break;
            }

            case 'updateContext':
                updateContext(message.context);
                break;

            case 'displayPlan':
                displayPlan(message.plan);
                break;

            case 'showAvailableTools':
                if (dom.toolsListDiv) {
                    dom.toolsListDiv.innerHTML = '';
                    message.allTools.forEach((tool: any) => {
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
                }
                if (dom.toolsModal) {
                    dom.toolsModal.classList.add('visible');
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
                        dom.tokenProgressBar.classList.add('red');
                        dom.tokenProgressBar.style.width = '100%';
                    } else if (typeof totalTokens === 'number') {
                        const size = (typeof contextSize === 'number' && contextSize > 0) ? contextSize : 0;
                        const labelText = isApproximate 
                            ? `Est. Tokens: ${totalTokens} / ${size} (Approx)` 
                            : `Tokens: ${totalTokens} / ${size}`;
                        
                        dom.tokenCountLabel.textContent = labelText;
                        
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
                            dom.tokenCountLabel.textContent = `Tokens: ${totalTokens} / ?`;
                            dom.tokenProgressBar.style.width = '0%';
                        }
                    } else {
                        dom.tokenCountLabel.textContent = `Tokens: ?`;
                        dom.tokenProgressBar.style.width = '0%';
                    }
                }
                break;

            case 'updateModels':
                 if(dom.modelSelector) {
                    dom.modelSelector.innerHTML = '<option value="">Default Model</option>';
                    if (Array.isArray(message.models)) {
                        message.models.forEach((model: any) => {
                            const option = document.createElement('option');
                            option.value = model.id;
                            option.textContent = model.id;
                            dom.modelSelector.appendChild(option);
                        });
                    }
                    dom.modelSelector.value = message.currentModel || '';
                 }
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
        }
    } catch (e: any) {
        console.error("Error processing extension message:", e);
        if (vscode) {
            vscode.postMessage({ command: 'showError', message: 'Webview Message Error: ' + e.message });
        }
    }
}

// =================================== Event Handlers ===================================
function initEventHandlers() {
    if(!dom.sendButton || !dom.messageInput) {
        console.warn("Critical DOM elements missing. Retrying setup in 100ms...");
        return;
    }

    if(dom.sendButton) dom.sendButton.addEventListener('click', sendMessage);
    
    if(dom.messageInput) {
        dom.messageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });
        dom.messageInput.addEventListener('input', () => {
            dom.messageInput.style.height = 'auto';
            dom.messageInput.style.height = dom.messageInput.scrollHeight + 'px';
        });
    }

    if(dom.refreshContextBtn) dom.refreshContextBtn.addEventListener('click', () => vscode.postMessage({ command: 'calculateTokens' }));
    if(dom.stopButton) dom.stopButton.addEventListener('click', () => vscode.postMessage({ command: 'stopGeneration' }));
    if(dom.addUserMessageBtn) dom.addUserMessageBtn.addEventListener('click', () => insertNewMessageEditor('user'));
    if(dom.addAiMessageBtn) dom.addAiMessageBtn.addEventListener('click', () => insertNewMessageEditor('assistant'));
    
    if(dom.agentModeCheckbox) {
        dom.agentModeCheckbox.addEventListener('change', () => vscode.postMessage({ command: 'toggleAgentMode' }));
    }
    
    if(dom.executeButton) {
        dom.executeButton.addEventListener('click', () => vscode.postMessage({ command: 'executeProject' }));
    }
    
    if(dom.setEntryPointButton) {
        dom.setEntryPointButton.addEventListener('click', () => vscode.postMessage({ command: 'setEntryPoint' }));
    }
    
    if(dom.debugRestartButton) {
        dom.debugRestartButton.addEventListener('click', () => vscode.postMessage({ command: 'debugRestart' }));
    }
    
    if(dom.attachButton) {
        dom.attachButton.addEventListener('click', () => dom.fileInput.click());
    }

    if(dom.fileInput) {
        dom.fileInput.addEventListener('change', () => {
            if (!dom.fileInput.files) return;
            for (const file of dom.fileInput.files) {
                const reader = new FileReader();
                const isImage = file.type.startsWith('image/');
                reader.onload = (e) => {
                    if(e.target?.result) {
                        vscode.postMessage({
                            command: 'loadFile',
                            file: { name: file.name, content: e.target.result, isImage }
                        });
                    }
                };
                reader.readAsDataURL(file);
            }
            dom.fileInput.value = '';
        });
    }

    // Search handlers
    if(dom.searchInput) dom.searchInput.addEventListener('input', performSearch);
    if(dom.searchNextBtn) dom.searchNextBtn.addEventListener('click', () => navigateSearch(1));
    if(dom.searchPrevBtn) dom.searchPrevBtn.addEventListener('click', () => navigateSearch(-1));
    if(dom.searchCloseBtn) dom.searchCloseBtn.addEventListener('click', () => {
        if(dom.searchBar) dom.searchBar.style.display = 'none';
        clearSearch();
        if(dom.messageInput) dom.messageInput.focus();
    });

    document.addEventListener('keydown', (e: KeyboardEvent) => {
        if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
            e.preventDefault();
            if(dom.searchBar) dom.searchBar.style.display = 'flex';
            if(dom.searchInput) {
                dom.searchInput.focus();
                dom.searchInput.select();
            }
        }
        if (dom.searchBar && dom.searchBar.style.display !== 'none') {
            if (e.key === 'Escape') {
                dom.searchBar.style.display = 'none';
                clearSearch();
                if(dom.messageInput) dom.messageInput.focus();
            } else if (e.key === 'Enter') {
                navigateSearch(e.shiftKey ? -1 : 1);
            }
        }
    });

    if(dom.moreActionsButton) {
        dom.moreActionsButton.addEventListener('click', (event: MouseEvent) => {
            event.stopPropagation();
            if(dom.moreActionsMenu) dom.moreActionsMenu.classList.toggle('visible');
        });
    }
    
    if(dom.configureToolsButton) {
        dom.configureToolsButton.addEventListener('click', () => {
            vscode.postMessage({ command: 'requestAvailableTools' });
            // Modal visibility handled in handleExtensionMessage response
        });
    }
    
    if(dom.closeToolsModal) {
        dom.closeToolsModal.addEventListener('click', () => {
            if(dom.toolsModal) dom.toolsModal.classList.remove('visible');
        });
    }
    
    if(dom.saveToolsBtn) {
        dom.saveToolsBtn.addEventListener('click', () => {
            if(dom.toolsListDiv) {
                const enabledTools = Array.from(dom.toolsListDiv.querySelectorAll('input:checked')).map(cb => (cb as HTMLInputElement).value);
                vscode.postMessage({ command: 'updateEnabledTools', tools: enabledTools });
                if(dom.toolsModal) dom.toolsModal.classList.remove('visible');
            }
        });
    }

    if(dom.modelSelector) {
        dom.modelSelector.addEventListener('change', (event) => vscode.postMessage({ command: 'updateDiscussionModel', model: (event.target as HTMLSelectElement).value }));
    }

    // Add handler for the refresh models button
    const refreshModelsBtn = document.getElementById('refresh-models-btn');
    if (refreshModelsBtn) {
        refreshModelsBtn.addEventListener('click', () => {
            vscode.postMessage({ command: 'refreshModels' });
        });
    }

    window.addEventListener('click', (event: MouseEvent) => {
        if (dom.moreActionsMenu && event.target instanceof Node && !dom.moreActionsMenu.contains(event.target) && event.target !== dom.moreActionsButton) {
            dom.moreActionsMenu.classList.remove('visible');
        }
        if (dom.toolsModal && event.target === dom.toolsModal) {
            dom.toolsModal.classList.remove('visible');
        }
    });
}

function sendMessage() {
    if(!dom.messageInput) return;
    const text = dom.messageInput.value.trim();
    if (!text) return;
    
    localSetGeneratingState(true);
    const id = 'user_' + Date.now();
    const message = { id, role: 'user', content: text };
    
    vscode.postMessage({ command: 'addMessage', message });
    
    if (dom.agentModeCheckbox && dom.agentModeCheckbox.checked) {
        vscode.postMessage({ command: 'runAgent', objective: text, message });
    } else {
        vscode.postMessage({ command: 'sendMessage', message });
    }
    
    dom.messageInput.value = '';
    dom.messageInput.style.height = 'auto';
}

// --- Initialization ---
(function() {
    try {
        // Use 'window.vscode' which is guaranteed to exist by our bootstrap script
        if (!(window as any).vscode) {
            throw new Error("VS Code API missing on window object.");
        }

        window.addEventListener('message', handleExtensionMessage);
        
        document.addEventListener('DOMContentLoaded', () => {
            console.log("DEBUG: DOMContentLoaded.");
            
            if (typeof l10n !== 'undefined' && dom.welcomeMessage) {
                const title = dom.welcomeMessage.querySelector('#welcome-title');
                if(title) title.innerHTML = l10n.welcomeTitle || "Welcome";
                
                const item1 = dom.welcomeMessage.querySelector('#welcome-item-1');
                if(item1) item1.innerHTML = l10n.welcomeItem1 || "Item 1";
                
                const item2 = dom.welcomeMessage.querySelector('#welcome-item-2');
                if(item2) item2.innerHTML = l10n.welcomeItem2 || "Item 2";
                
                const item3 = dom.welcomeMessage.querySelector('#welcome-item-3');
                if(item3) item3.innerHTML = l10n.welcomeItem3 || "Item 3";
                
                const item4 = dom.welcomeMessage.querySelector('#welcome-item-4');
                if(item4) item4.innerHTML = l10n.welcomeItem4 || "Item 4";
                
                if(dom.contextLoadingSpinner) {
                     const textSpan = dom.contextLoadingSpinner.querySelector('#loading-files-text');
                     if(textSpan) textSpan.textContent = l10n.progressLoadingFiles || "Loading...";
                }
                
                if(dom.refreshContextBtn) dom.refreshContextBtn.title = l10n.tooltipRefreshContext || "Refresh";
            }

            try {
                marked.setOptions({ breaks: true, gfm: true });
            } catch (e) { console.warn("Marked init:", e); }

            try {
                 mermaid.initialize({ startOnLoad: false });
            } catch(e) { console.warn("Mermaid init:", e); }

            initEventHandlers();

            // Notify extension that we are ready
            vscode.postMessage({ command: 'webview-ready' });
            console.log("DEBUG: Sent 'webview-ready'");
        });

    } catch (e: any) {
        console.error("Main Init Error:", e);
        if((window as any).vscode) {
            (window as any).vscode.postMessage({ command: 'showError', message: 'Init Error: ' + e.message });
        }
    }
})();
