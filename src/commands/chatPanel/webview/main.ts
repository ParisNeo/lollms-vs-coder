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

// CodeMirror imports
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { searchKeymap, openSearchPanel } from "@codemirror/search";
import { markdown } from "@codemirror/lang-markdown";
import { oneDark } from "@codemirror/theme-one-dark";

// --- PrismJS Dependencies (Order Matters) ---
import 'prismjs/components/prism-clike';
import 'prismjs/components/prism-markup';
import 'prismjs/components/prism-markup-templating';
import 'prismjs/components/prism-css';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-typescript';
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
import 'prismjs/components/prism-markdown';
import 'prismjs/components/prism-powershell';
import 'prismjs/components/prism-batch';
import 'prismjs/components/prism-lua';
import 'prismjs/components/prism-php';
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
import 'prismjs/components/prism-sass';
import 'prismjs/components/prism-scss';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-tsx';

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
    scheduleRender
} from './messageRenderer.js';
import { isScrolledToBottom } from './utils.js';
import { initEventHandlers, sendMessage } from './events.js'; 

// Export editable compartment for ui.ts to use
export const editableCompartment = new Compartment();

// =================================== UI Functions ===================================
function localSetGeneratingState(isGenerating: boolean) {
    // CodeMirror editable state
    if (state.editor) {
        state.editor.dispatch({
            effects: editableCompartment.reconfigure(EditorView.editable.of(!isGenerating))
        });
    }

    if(dom.agentModeCheckbox) dom.agentModeCheckbox.disabled = isGenerating;
    if(dom.agentModeToggle) dom.agentModeToggle.classList.toggle('disabled', isGenerating);
    if(dom.modelSelector) dom.modelSelector.disabled = isGenerating;
    if(dom.attachButton) dom.attachButton.disabled = isGenerating;
    if(dom.executeButton) dom.executeButton.disabled = isGenerating;
    
    // Toggle main input / generating overlay
    // If generating, overlay is shown, input area hidden/disabled
    if (dom.inputArea) dom.inputArea.classList.toggle('disabled', isGenerating);
    if (dom.generatingOverlay) dom.generatingOverlay.style.display = isGenerating ? 'flex' : 'none';

    if (!isGenerating) {
        if (!isScrolledToBottom(dom.messagesDiv)) {
            dom.scrollToBottomBtn.style.display = 'flex';
        } else {
            dom.scrollToBottomBtn.style.display = 'none';
        }
        // Refocus editor
        if (state.editor) state.editor.focus();
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
                            <div class="checkbox-container">
                                <label class="switch">
                                    <input type="checkbox" class="tool-item-checkbox" id="tool-${tool.name}" value="${tool.name}" ${isChecked ? 'checked' : ''}>
                                    <span class="slider"></span>
                                </label>
                                <label for="tool-${tool.name}" class="tool-item-details">
                                    <strong>${tool.name}</strong><br>
                                    <span style="font-weight:normal; font-size: 0.9em; opacity: 0.8;">${tool.description}</span>
                                </label>
                            </div>
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
                 if(dom.refreshModelsBtn) {
                     const icon = dom.refreshModelsBtn.querySelector('.codicon');
                     if(icon) icon.classList.remove('spin');
                 }
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
            
            case 'filesAddedToContext':
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
                
            case 'setInputText':
                if (state.editor) {
                    const transaction = state.editor.state.update({
                        changes: { from: 0, to: state.editor.state.doc.length, insert: message.text }
                    });
                    state.editor.dispatch(transaction);
                    state.editor.focus();
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
                // ... l10n logic ...
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
                 mermaid.initialize({ 
                     startOnLoad: false,
                     theme: 'base',
                     themeVariables: {
                         darkMode: true,
                         background: 'var(--vscode-editor-background)',
                         primaryColor: 'var(--vscode-button-background)',
                         primaryTextColor: 'var(--vscode-editor-foreground)',
                         primaryBorderColor: 'var(--vscode-widget-border)',
                         lineColor: 'var(--vscode-editor-foreground)',
                         secondaryColor: 'var(--vscode-editorWidget-background)',
                         tertiaryColor: 'var(--vscode-sideBar-background)',
                         noteBkgColor: 'var(--vscode-editorWidget-background)',
                         noteTextColor: 'var(--vscode-editor-foreground)'
                     },
                     fontFamily: 'var(--vscode-font-family)',
                     securityLevel: 'loose'
                 });
            } catch(e) { console.warn("Mermaid init:", e); }

            // Initialize CodeMirror Editor
            if (dom.messageInputContainer) {
                const startState = EditorState.create({
                    doc: "",
                    extensions: [
                        keymap.of([
                            ...defaultKeymap,
                            ...searchKeymap,
                            ...historyKeymap,
                            {
                                key: "Enter",
                                run: (view) => {
                                    sendMessage();
                                    return true;
                                }
                            },
                            {
                                key: "Shift-Enter",
                                run: (view) => {
                                    view.dispatch(view.state.replaceSelection("\n"));
                                    return true;
                                }
                            },
                            {
                                key: "Mod-f",
                                run: openSearchPanel
                            }
                        ]),
                        history(),
                        markdown(),
                        oneDark,
                        EditorView.lineWrapping,
                        placeholder("Enter your message (Shift+Enter for new line)..."),
                        editableCompartment.of(EditorView.editable.of(true)),
                        EditorView.updateListener.of((update) => {
                            if (update.docChanged) {
                                // Can add logic here if needed
                            }
                        })
                    ]
                });

                state.editor = new EditorView({
                    state: startState,
                    parent: dom.messageInputContainer
                });
            } else {
                console.error("Critical: messageInputContainer not found in DOM");
            }

            // Call the imported initEventHandlers, ensuring we don't have a local shadowed version.
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
