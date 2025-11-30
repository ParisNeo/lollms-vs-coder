import { dom, vscode, state } from './dom.js';
import { isScrolledToBottom } from './utils.js';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import mermaid from 'mermaid';
import Prism from 'prismjs';

const RENDER_THROTTLE_MS = 200;

// --- Language Map for Prism ---
const langMap: { [key: string]: string } = {
    'js': 'javascript',
    'ts': 'typescript',
    'py': 'python',
    'sh': 'bash',
    'shell': 'bash',
    'cs': 'csharp',
    'cpp': 'cpp',
    'c++': 'cpp',
    'h': 'c',
    'hpp': 'cpp',
    'txt': 'plaintext',
    'md': 'markdown',
    'yml': 'yaml',
    'json': 'json',
    'skill': 'json'
};

// Configure Marked
try {
    marked.setOptions({
        breaks: true,
        gfm: true,
        highlight: (code, lang) => {
            const language = langMap[lang.toLowerCase()] || lang.toLowerCase();
            if (Prism.languages[language]) {
                try {
                    return Prism.highlight(code, Prism.languages[language], language);
                } catch (e) {
                    console.warn(`Prism highlight failed for ${language}:`, e);
                    return code;
                }
            }
            return code;
        },
    });
} catch (e) {
    console.error("Failed to configure marked:", e);
}

// Initialize DOMPurify
const sanitizer = typeof DOMPurify === 'function' ? (DOMPurify as any)(window) : DOMPurify;

const SANITIZE_CONFIG = {
    ALLOWED_TAGS: [
        'a', 'b', 'blockquote', 'br', 'code', 'dd', 'del', 'details', 'div', 'dl', 'dt', 'em', 
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'ol', 'p', 
        'pre', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'span', 'strike', 'strong', 'sub', 
        'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'tt', 'ul', 'var'
    ],
    ALLOWED_ATTR: [
        'align', 'alt', 'class', 'height', 'href', 'id', 'src', 'style', 'target', 'title', 
        'type', 'width', 'data-language', 'start'
    ]
};

function createButton(text: string, icon: string, onClick: () => void, className = 'code-action-btn'): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = className;
    btn.title = text;
    btn.innerHTML = `<span class="codicon ${icon}"></span> <span class="btn-text">${text}</span>`;
    
    btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        console.log(`[Button Click] Action: ${text}`);
        try {
            onClick();
        } catch (err) {
            console.error(`Error executing action for ${text}:`, err);
            vscode.postMessage({ command: 'showError', message: `Action failed: ${err}` });
        }
    };
    return btn;
}

function createGenerationBlock(type: string, filePath: string, prompt: string): HTMLElement {
    const block = document.createElement('div');
    block.className = 'generation-block';
    
    const header = document.createElement('div');
    header.className = 'generation-header';
    header.innerHTML = `<span class="summary-lang-label">${type}: ${filePath}</span>`;
    
    const actions = document.createElement('div');
    actions.className = 'code-actions';
    header.appendChild(actions);

    const buttonId = `gen-btn-${Date.now()}${Math.random()}`;
    const generateBtn = createButton('Generate', 'codicon-sparkle', () => {
        generateBtn.innerHTML = `<div class="spinner"></div> Generating...`;
        generateBtn.disabled = true;
        vscode.postMessage({
            command: 'generateImage',
            prompt: prompt,
            filePath: filePath,
            buttonId: buttonId
        });
    }, 'code-action-btn apply-btn');
    generateBtn.id = buttonId;

    actions.appendChild(generateBtn);
    
    const body = document.createElement('div');
    body.className = 'generation-body';
    body.innerHTML = `<p><strong>Prompt:</strong> ${sanitizer.sanitize(prompt)}</p>`;
    
    block.appendChild(header);
    block.appendChild(body);
    
    return block;
}

function renderDiagram(codeElement: HTMLElement, language: string, container: HTMLElement) {
    const diagramContainer = document.createElement('div');
    diagramContainer.className = 'diagram-container';

    if (language === 'mermaid') {
        try {
            mermaid.render(`mermaid-${Date.now()}`, codeElement.textContent || '', (svgCode: string) => {
                diagramContainer.innerHTML = sanitizer.sanitize(svgCode, { USE_PROFILES: { svg: true } });
                container.appendChild(diagramContainer);
            });
            if(codeElement.parentElement) codeElement.parentElement.style.display = 'none';
        } catch (e) {
            console.error("Mermaid render error:", e);
            diagramContainer.innerText = "Error rendering Mermaid diagram.";
            container.appendChild(diagramContainer);
        }
    } else if (language === 'svg') {
        diagramContainer.innerHTML = sanitizer.sanitize(codeElement.textContent || '', { USE_PROFILES: { svg: true } });
        container.appendChild(diagramContainer);
        if(codeElement.parentElement) codeElement.parentElement.style.display = 'none';
    }
}

function startEdit(messageDiv: HTMLElement, messageId: string, role: string) {
    let originalContent: any;
    try {
        originalContent = JSON.parse(messageDiv.dataset.originalContent || '""');
    } catch (e) {
        console.warn("Failed to parse original content for editing, falling back to empty string.", e);
        originalContent = "";
    }

    let textContent = "";
    if (typeof originalContent === 'string') {
        textContent = originalContent;
    } else if (Array.isArray(originalContent)) {
        textContent = originalContent.map(part => {
            if (part.type === 'text') return part.text;
            return ''; 
        }).join('\n');
    }

    const contentDiv = messageDiv.querySelector('.message-content') as HTMLElement;
    const actionsDiv = messageDiv.querySelector('.message-actions') as HTMLElement;

    if (!contentDiv || !actionsDiv) return;

    // Save original HTML to restore on cancel
    const originalHtml = contentDiv.innerHTML;

    const editOverlay = document.createElement('div');
    editOverlay.className = 'edit-overlay';
    
    const textarea = document.createElement('textarea');
    textarea.className = 'edit-textarea';
    textarea.value = textContent;
    // Auto-resize
    textarea.style.height = '200px';
    textarea.style.minHeight = '100px';
    
    const buttonsDiv = document.createElement('div');
    buttonsDiv.className = 'edit-buttons';
    
    const saveBtn = document.createElement('button');
    saveBtn.className = 'edit-save-btn';
    saveBtn.textContent = 'Save';
    
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'edit-cancel-btn';
    cancelBtn.textContent = 'Cancel';

    buttonsDiv.appendChild(cancelBtn);
    buttonsDiv.appendChild(saveBtn);
    
    editOverlay.appendChild(textarea);
    editOverlay.appendChild(buttonsDiv);
    
    contentDiv.innerHTML = '';
    contentDiv.appendChild(editOverlay);
    actionsDiv.style.display = 'none';
    
    textarea.focus();

    cancelBtn.onclick = () => {
        contentDiv.innerHTML = originalHtml;
        actionsDiv.style.display = '';
    };

    saveBtn.onclick = () => {
        const newContent = textarea.value;
        if (newContent.trim() !== textContent.trim()) {
            messageDiv.dataset.originalContent = JSON.stringify(newContent);
            vscode.postMessage({
                command: 'updateMessage',
                messageId: messageId,
                newContent: newContent
            });
        }
        contentDiv.innerHTML = originalHtml;
        actionsDiv.style.display = '';
    };
}

// Helper to extract file paths from raw markdown content
function extractFilePaths(content: string): { type: 'file' | 'diff' | null, path: string }[] {
    const infos: { type: 'file' | 'diff' | null, path: string }[] = [];
    const lines = content.split('\n');
    let inBlock = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim(); // Use trimmed line for checking start
        if (line.startsWith('```')) {
            if (!inBlock) {
                // Starting a block. Check previous lines for metadata.
                let j = i - 1;
                while (j >= 0 && lines[j].trim() === '') j--; // Skip empty lines
                
                let type: 'file' | 'diff' | null = null;
                let pathStr = '';

                if (j >= 0) {
                    const prevLine = lines[j].trim();
                    // improved regex to handle bold/italics and loose spacing
                    const fileMatch = prevLine.match(/^(?:(?:\*\*|__)?File(?:\*\*|__)?[:\s])\s*(.+)$/i);
                    const diffMatch = prevLine.match(/^(?:(?:\*\*|__)?Diff(?:\*\*|__)?[:\s])\s*(.+)$/i);

                    if (fileMatch) {
                        type = 'file';
                        pathStr = fileMatch[1].trim();
                    } else if (diffMatch) {
                        type = 'diff';
                        pathStr = diffMatch[1].trim();
                    }
                }
                
                if (pathStr) {
                    pathStr = pathStr.replace(/^`|`$/g, '');
                    pathStr = pathStr.replace(/^\*\*|\*\*$/g, '');
                    pathStr = pathStr.replace(/^\*|\*$/g, '');
                    // Remove any trailing punctuation if it looks like a sentence end (unlikely for paths but safe)
                    pathStr = pathStr.replace(/[.:]+$/, ''); 
                }

                infos.push({ type, path: pathStr });
                inBlock = true;
            } else {
                inBlock = false;
            }
        }
    }
    return infos;
}

function enhanceCodeBlocks(container: HTMLElement, contentSource?: any) {
    const pres = container.querySelectorAll('pre');
    if (pres.length === 0) return;

    let originalContentText = '';
    
    if (contentSource !== undefined) {
        if (Array.isArray(contentSource)) {
            originalContentText = contentSource.map(p => p.type === 'text' ? p.text : '').join('\n');
        } else {
            originalContentText = String(contentSource);
        }
    } else {
        const messageDiv = container.querySelector('.message') as HTMLElement;
        if (messageDiv && messageDiv.dataset.originalContent) {
            try {
                const raw = JSON.parse(messageDiv.dataset.originalContent);
                if (Array.isArray(raw)) {
                    originalContentText = raw.map(p => p.type === 'text' ? p.text : '').join('\n');
                } else {
                    originalContentText = raw;
                }
            } catch(e) {}
        }
    }

    const codeBlockInfos = extractFilePaths(originalContentText);
    
    // We assume the order of pres in DOM matches the order of code blocks in original text.
    // Marked.js usually guarantees this order.
    
    pres.forEach((pre, index) => {
        const code = pre.querySelector('code');
        if (!code) return;
        if (pre.parentElement?.classList.contains('code-collapsible')) return;

        const langMatch = code.className.match(/language-(\S+)/);
        const language = langMatch ? langMatch[1] : 'plaintext';
        const codeText = code.innerText;

        const details = document.createElement('details');
        details.className = 'code-collapsible';
        details.open = true;

        const summary = document.createElement('summary');
        summary.className = 'code-summary';
        const langLabel = document.createElement('span');
        langLabel.className = 'summary-lang-label';
        
        // Initial label
        langLabel.textContent = language;

        const actions = document.createElement('div');
        actions.className = 'code-actions';
        summary.appendChild(langLabel);
        summary.appendChild(actions);

        // --- Standard Buttons ---
        const copyBtn = createButton('Copy', 'codicon-copy', () => {
            vscode.postMessage({ command: 'copyToClipboard', text: codeText });
            const icon = copyBtn.querySelector('.codicon');
            if(icon) icon.className = 'codicon codicon-check';
            setTimeout(() => { if(icon) icon.className = 'codicon codicon-copy'; }, 2000);
        });
        actions.appendChild(copyBtn);

        const saveBtn = createButton('Save As...', 'codicon-save', () => {
            vscode.postMessage({ command: 'saveCodeToFile', content: codeText, language: language });
        });
        actions.appendChild(saveBtn);

        if (state.isInspectorEnabled && language !== 'skill') {
            const inspectBtn = createButton('Inspect', 'codicon-search', () => {
                vscode.postMessage({ command: 'inspectCode', code: codeText, language: language });
            });
            actions.appendChild(inspectBtn);
        }

        // --- Special Logic Detection using extracted infos ---
        const info = codeBlockInfos[index];
        let filePath = '';
        let isFileBlock = false;
        let isDiff = false;
        let diffFilePath = '';

        if (info) {
            if (info.type === 'file') {
                filePath = info.path;
                isFileBlock = true;
            } else if (info.type === 'diff') {
                diffFilePath = info.path;
                isDiff = true;
            }
        } else {
            // Fallback to auto-detection from diff content if no header found
            if (language === 'diff') {
                const diffHeaderMatch = codeText.match(/---\s+a\/(.+)\n\+\+\+\s+b\/(.+)/);
                if (diffHeaderMatch && diffHeaderMatch[1]) {
                    diffFilePath = diffHeaderMatch[1].trim();
                    isDiff = true;
                } else {
                    isDiff = true; // Still a diff, but unknown file
                }
            }
        }

        // Hide the "File: ..." paragraph from the DOM if we handled it
        const prevEl = pre.previousElementSibling as HTMLElement;
        if (prevEl && (prevEl.tagName === 'P' || prevEl.tagName === 'DIV')) {
             const text = prevEl.textContent || "";
             // Check if this paragraph likely contained the File/Diff marker we just consumed
             if ((isFileBlock && /File/i.test(text)) || (isDiff && /Diff/i.test(text))) {
                 prevEl.style.display = 'none';
             }
        }

        // --- Add Contextual Buttons ---

        if (isFileBlock && filePath) {
            langLabel.textContent = `${language} : ${filePath}`;
            
            const applyBtn = createButton('Apply to File', 'codicon-tools', () => {
                vscode.postMessage({ command: 'applyFileContent', filePath: filePath, content: codeText });
            }, 'code-action-btn apply-btn');
            
            if (actions.firstChild) actions.insertBefore(applyBtn, actions.firstChild);
            else actions.appendChild(applyBtn);

        } else if (isDiff) {
            const path = diffFilePath || 'patch';
            langLabel.textContent = `${language} : Diff: ${path}`;
            
            const applyPatchBtn = createButton('Apply Patch', 'codicon-tools', () => {
                vscode.postMessage({ command: 'applyPatchContent', filePath: diffFilePath, content: codeText });
            }, 'code-action-btn apply-btn');
            
            if (actions.firstChild) actions.insertBefore(applyPatchBtn, actions.firstChild);
            else actions.appendChild(applyPatchBtn);

        } else if (language === 'rename') {
            const renameBtn = createButton('Move/Rename', 'codicon-git-compare', () => {
                const lines = codeText.trim().split('\n');
                lines.forEach(line => {
                    const parts = line.split('->');
                    if(parts.length === 2) {
                        vscode.postMessage({ command: 'renameFile', originalPath: parts[0].trim(), newPath: parts[1].trim() });
                    }
                });
            }, 'code-action-btn apply-btn');
            if (actions.firstChild) actions.insertBefore(renameBtn, actions.firstChild);
            else actions.appendChild(renameBtn);

        } else if (language === 'delete') {
            const deleteBtn = createButton('Delete Files', 'codicon-trash', () => {
                vscode.postMessage({ command: 'deleteFile', filePaths: codeText });
            }, 'code-action-btn delete-btn');
            if (actions.firstChild) actions.insertBefore(deleteBtn, actions.firstChild);
            else actions.appendChild(deleteBtn);

        } else if (language === 'select') {
            const selectBtn = createButton('Add to Context', 'codicon-add', () => {
                const files = codeText.trim().split('\n').map(f => f.trim()).filter(f => f);
                vscode.postMessage({ command: 'addFilesToContext', files });
            });
            if (actions.firstChild) actions.insertBefore(selectBtn, actions.firstChild);
            else actions.appendChild(selectBtn);

        } else if (language === 'image_prompt' && isFileBlock) {
             const genBlock = createGenerationBlock('Image', filePath, codeText);
             if (pre.parentNode) pre.parentNode.replaceChild(genBlock, pre);
             return;
        } else if (language === 'skill') {
            langLabel.textContent = `New Skill`;
            const saveSkillBtn = createButton('Save Skill', 'codicon-lightbulb', () => {
                vscode.postMessage({ command: 'saveSkill', content: codeText });
            }, 'code-action-btn apply-btn');
            if (actions.firstChild) actions.insertBefore(saveSkillBtn, actions.firstChild);
            else actions.appendChild(saveSkillBtn);
        } else {
             const runnableLanguages = ['python', 'py', 'javascript', 'js', 'typescript', 'ts', 'bash', 'sh', 'shell', 'powershell', 'pwsh', 'batch', 'cmd', 'bat'];
             if (runnableLanguages.includes(language.toLowerCase())) {
                 const executeBtn = createButton('Execute', 'codicon-play', () => {
                     vscode.postMessage({ command: 'runScript', code: codeText, language: language });
                 }, 'code-action-btn apply-btn');
                 
                 if (actions.firstChild) actions.insertBefore(executeBtn, actions.firstChild);
                 else actions.appendChild(executeBtn);
             }
        }

        // --- Safe DOM Insertion ---
        const parent = pre.parentNode;
        if (parent) {
            details.appendChild(summary);
            parent.insertBefore(details, pre); 
            details.appendChild(pre); 
        }

        if (language === 'mermaid' || language === 'svg') {
            renderDiagram(code, language, details);
        } else {
            // Re-enabled highlighting as client-side fallback
            Prism.highlightElement(code);
        }
    });
}

function enhanceWithCommandButtons(container: HTMLElement) {
    const content = container.querySelector('.message-content');
    if (!content) return;
    const commandRegex = /\[command:(\w+)\|label:([^|]+)\|params:({[^}]+})\]/g;
    
    let newHtml = content.innerHTML;
    newHtml = newHtml.replace(commandRegex, (match, commandId, label, paramsStr) => {
        try {
            const params = JSON.parse(paramsStr.replace(/&quot;/g, '"'));
            const buttonId = `cmd-btn-${Date.now()}${Math.random()}`;
            setTimeout(() => {
                const btn = document.getElementById(buttonId);
                if (btn) {
                    btn.addEventListener('click', () => {
                        vscode.postMessage({
                            command: 'executeLollmsCommand',
                            details: { command: commandId, params: params }
                        });
                    });
                }
            }, 0);
            return `<button id="${buttonId}" class="lollms-command-btn"><span class="codicon codicon-symbol-event"></span> ${label}</button>`;
        } catch (e) {
            console.error("Failed to parse command button params:", e);
            return match;
        }
    });
    content.innerHTML = newHtml;
}


export function processThinkTags(content: string): { thoughts: string[], processedContent: string } {
    const thoughts: string[] = [];
    if (typeof content !== 'string') return { thoughts, processedContent: '' };
    const thinkRegex = /<(think|thinking)>([\s\S]*?)<\/\1>/g;
    const processedContent = content.replace(thinkRegex, (match, tag, thoughtContent) => {
        thoughts.push(thoughtContent);
        return '';
    });
    return { thoughts, processedContent: processedContent.trim() };
}

export function scheduleRender(messageId: string) {
    const stream = state.streamingMessages[messageId];
    if (!stream || stream.timer) return;
    stream.timer = setTimeout(() => {
        if (state.streamingMessages[messageId]) {
            renderMessageContent(messageId, state.streamingMessages[messageId].buffer);
            state.streamingMessages[messageId].timer = null;
        }
    }, RENDER_THROTTLE_MS);
}

export function renderMessageContent(messageId: string, rawContent: any, isFinal: boolean = false) {
    const wrapper = document.querySelector(`.message-wrapper[data-message-id='${messageId}']`);
    if (!wrapper) return;
    const contentDiv = wrapper.querySelector('.message-content') as HTMLElement;
    const messageDiv = wrapper.querySelector('.message') as HTMLElement;
    if (!contentDiv || !messageDiv) return;

    const shouldScroll = isScrolledToBottom(dom.messagesDiv);

    try {
        if (Array.isArray(rawContent)) {
            let htmlContent = '';
            rawContent.forEach(part => {
                if (part.type === 'text') {
                    htmlContent += `<div>${sanitizer.sanitize(marked.parse(part.text) as string, SANITIZE_CONFIG)}</div>`;
                } else if (part.type === 'image_url') {
                    htmlContent += `<img src="${part.image_url.url}" style="max-width: 100%; border-radius: 4px; margin-top: 8px;" />`;
                }
            });
            contentDiv.innerHTML = htmlContent;
        } else if (typeof rawContent === 'string') {
            const { thoughts, processedContent } = processThinkTags(rawContent);
            messageDiv.querySelectorAll('.plan-scratchpad').forEach(el => el.remove());
            
            thoughts.forEach(thought => {
                const thinkDiv = document.createElement('div');
                thinkDiv.className = 'plan-scratchpad'; 
                thinkDiv.innerHTML = `
                    <details ${isFinal ? '' : 'open'}>
                        <summary class="scratchpad-header"><span class="codicon codicon-lightbulb"></span> Thought Process</summary>
                        <div class="scratchpad-content">${sanitizer.sanitize(marked.parse(thought) as string, SANITIZE_CONFIG)}</div>
                    </details>`;
                messageDiv.insertBefore(thinkDiv, contentDiv);
            });
            
            contentDiv.innerHTML = sanitizer.sanitize(marked.parse(processedContent) as string, SANITIZE_CONFIG);
        }

        // Apply enhancements (buttons, etc.) ALWAYS to support real-time rendering
        enhanceWithCommandButtons(wrapper as HTMLElement);
        enhanceCodeBlocks(wrapper as HTMLElement, rawContent);

    } catch (e) {
        console.error("Error rendering message content:", e);
        contentDiv.innerText = "Error rendering content: " + e;
    }

    if (shouldScroll && dom.messagesDiv) {
        dom.messagesDiv.scrollTop = dom.messagesDiv.scrollHeight;
    } else if (dom.stopButton && dom.stopButton.style.display !== 'none' && dom.scrollToBottomBtn) {
        dom.scrollToBottomBtn.style.display = 'flex';
    }
}

export function addMessage(message: any, isFinal: boolean = true) {
    if (message.role === 'system' && message.content && typeof message.content === 'string' && message.content.startsWith('Attached file:')) {
        addAttachment(message);
    } else {
        addChatMessage(message, isFinal);
    }
}

function addAttachment(message: any) {
    if (!dom.attachmentsContainer) return;
    const wrapper = dom.attachmentsContainer.closest('.special-zone-message');
    
    if (wrapper) (wrapper as HTMLElement).style.display = 'flex';

    let fileName = 'file';
    let contentHtml = '';
    const nameMatch = message.content.match(/\*\*([^*]+)\*\*/);
    const codeMatch = message.content.match(/```(?:\w*)\n([\s\S]+?)\n```/);
    if (nameMatch) fileName = nameMatch[1];
    if (codeMatch) contentHtml = `<pre>${sanitizer.sanitize(codeMatch[1])}</pre>`;
    
    const details = document.createElement('details');
    details.className = 'attachment-item-details';
    details.dataset.messageId = message.id;

    const summaryEl = document.createElement('summary');
    summaryEl.className = 'attachment-item-summary';
    summaryEl.innerHTML = `
        <div class="attachment-info">
            <span class="codicon codicon-file-text"></span> 
            <span>${fileName}</span>
        </div>
        <button class="remove-attachment-btn" title="Remove Attachment"><i class="codicon codicon-trash"></i></button>
    `;
    
    (summaryEl.querySelector('.remove-attachment-btn') as HTMLElement).addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        vscode.postMessage({ command: 'requestDeleteMessage', messageId: message.id });
    });
    
    details.appendChild(summaryEl);
    const contentDiv = document.createElement('div');
    contentDiv.className = 'attachment-content';
    contentDiv.innerHTML = contentHtml;
    details.appendChild(contentDiv);

    dom.attachmentsContainer.appendChild(details);
    
    const count = dom.attachmentsContainer.children.length;
    const headerTitle = wrapper?.querySelector('.role-name');
    if(headerTitle) headerTitle.textContent = `Attached Files (${count})`;
}

function addChatMessage(message: any, isFinal: boolean = true) {
    const { role, id, content: rawContent, startTime, model } = message;
    
    if (!dom.chatMessagesContainer) return;

    const existingWrapper = dom.chatMessagesContainer.querySelector(`.message-wrapper[data-message-id='${id}']`);
    if (existingWrapper) {
        renderMessageContent(id, rawContent, isFinal);
        return;
    }

    const messageWrapper = document.createElement('div');
    messageWrapper.className = 'message-wrapper';
    messageWrapper.dataset.messageId = id;
    if (startTime) messageWrapper.dataset.startTime = startTime;
    if (model) messageWrapper.dataset.model = model;

    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${role}-message`;
    messageDiv.dataset.originalContent = JSON.stringify(rawContent);

    const avatarDiv = document.createElement('div');
    avatarDiv.className = 'message-avatar';
    
    if (role === 'user') {
        avatarDiv.innerHTML = '<span class="codicon codicon-account"></span>';
    } else if (role === 'assistant') {
        // Empty, handled by CSS background-image
    } else {
        avatarDiv.innerHTML = '<span class="codicon codicon-gear"></span>';
    }
    
    messageDiv.appendChild(avatarDiv);

    const bodyDiv = document.createElement('div');
    bodyDiv.className = 'message-body';
    messageDiv.appendChild(bodyDiv);

    const headerDiv = document.createElement('div');
    headerDiv.className = 'message-header';
    let roleDisplay = 'System';
    if (role === 'user') roleDisplay = 'You';
    else if (role === 'assistant') roleDisplay = 'Lollms';
    
    headerDiv.innerHTML = `<span class="role-name">${roleDisplay}</span>`;
    bodyDiv.appendChild(headerDiv);

    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    contentDiv.id = `content-${id}`;
    
    let isWaiting = false;
    if (role === 'assistant' && !rawContent && startTime) {
        contentDiv.innerHTML = `<div class="waiting-animation"><div class="lollms-spinner"></div><span class="thinking-text">Thinking...</span></div>`;
        state.streamingMessages[id] = { buffer: '', timer: null };
        isWaiting = true;
    }
    
    bodyDiv.appendChild(contentDiv);

    const actions = document.createElement('div');
    actions.className = 'message-actions';
    const isMultipart = Array.isArray(rawContent);
    const textForClipboard = isMultipart 
        ? (rawContent.find(p => p.type === 'text')?.text || '') 
        : (typeof rawContent === 'string' ? rawContent : '');

    // Buttons for User and Assistant
    if (role !== 'system') {
        if (!isMultipart) {
            actions.appendChild(createButton('', 'codicon-edit', () => startEdit(messageDiv, id, role), 'msg-action-btn'));
        }
        if (role === 'user') {
            actions.appendChild(createButton('', 'codicon-sync', () => vscode.postMessage({ command: 'regenerateFromMessage', messageId: id }), 'msg-action-btn'));
        }
        
    }
    
    // Copy button for ALL (User, Assistant, System)
    const copyBtn = createButton('', 'codicon-copy', () => {
        vscode.postMessage({ command: 'copyToClipboard', text: textForClipboard });
        copyBtn.innerHTML = '<span class="codicon codicon-check"></span>';
        setTimeout(() => { copyBtn.innerHTML = '<span class="codicon codicon-copy"></span>'; }, 2000);
    }, 'msg-action-btn');
    actions.appendChild(copyBtn);

    if (role === 'assistant') {
        actions.appendChild(createButton('', 'codicon-save', () => vscode.postMessage({ command: 'saveMessageAsPrompt', content: textForClipboard }), 'msg-action-btn'));
        actions.appendChild(createButton('', 'codicon-book', () => vscode.postMessage({ command: 'requestLog' }), 'msg-action-btn'));
    }
    
    // Delete button for ALL (User, Assistant, System)
    actions.appendChild(createButton('', 'codicon-trash', () => vscode.postMessage({ command: 'requestDeleteMessage', messageId: id }), 'msg-action-btn'));

    messageDiv.appendChild(actions);
    messageWrapper.appendChild(messageDiv);
    
    const insertionControls = document.getElementById('message-insertion-controls');
    if (insertionControls) {
        dom.chatMessagesContainer.insertBefore(messageWrapper, insertionControls);
    } else {
        dom.chatMessagesContainer.appendChild(messageWrapper);
    }

    if (!isWaiting) {
        renderMessageContent(id, rawContent, isFinal);
    }
}

export function updateContext(contextText: string) {
    if(!dom.contextContainer) return;
    
    const innerHTML = `
    <div class="message special-zone-message context-message">
        <div class="message-avatar">
            <span class="codicon codicon-library"></span>
        </div>
        <div class="message-body">
            <div class="message-header"><span class="role-name">Project Context</span></div>
            <div class="message-content">
                <details class="info-collapsible">
                    <summary>View Loaded Files</summary>
                    <div class="collapsible-content">
                        <pre>${sanitizer.sanitize(contextText)}</pre>
                    </div>
                </details>
            </div>
        </div>
    </div>`;
    
    dom.contextContainer.innerHTML = contextText ? innerHTML : '';
}

function getStatusIcon(status: string) {
    switch(status) {
        case 'pending': return '<span class="codicon codicon-circle-large"></span>';
        case 'in_progress': return '<span class="codicon codicon-sync spin"></span>';
        case 'completed': return '<span class="codicon codicon-check"></span>';
        case 'failed': return '<span class="codicon codicon-error"></span>';
        default: return '<span class="codicon codicon-circle-slash"></span>';
    }
}

function getToolBadge(toolName: string) {
    return `<span class="tool-badge"><span class="codicon codicon-tools"></span> ${toolName}</span>`;
}

export function displayPlan(plan: any) {
    if(!dom.chatMessagesContainer) return;
    const existingPlan = dom.chatMessagesContainer.querySelector('.plan-wrapper');
    if (existingPlan) existingPlan.remove();
    if (!plan) return;

    let scratchpadHtml = plan.scratchpad ? `
        <div class="plan-scratchpad">
            <details open>
                <summary class="scratchpad-header"><span class="codicon codicon-lightbulb"></span> Thought Process</summary>
                <div class="scratchpad-content">${sanitizer.sanitize(marked.parse(plan.scratchpad) as string, SANITIZE_CONFIG)}</div>
            </details>
        </div>` : '';

    let tasksHtml = plan.tasks.map((task: any) => {
        let statusClass = `status-${task.status}`;
        let icon = getStatusIcon(task.status);
        let toolBadge = task.action ? getToolBadge(task.action) : '';
        
        let retryButtonHtml = '';
        if (task.status === 'failed' && task.can_retry) {
            retryButtonHtml = `<button class="retry-btn" data-task-id="${task.id}" title="Retry this task"><span class="codicon codicon-debug-restart"></span> Retry</button>`;
        }
        
        let resultHtml = task.result ? `
            <div class="task-result">
                <details ${task.status === 'failed' ? 'open' : ''}>
                    <summary class="task-result-summary">View Result</summary>
                    <div class="task-result-box">${sanitizer.sanitize(task.result)}</div>
                </details>
            </div>` : '';

        return `
            <li class="plan-task" data-task-id="${task.id}">
                <div class="task-header">
                    <div class="task-status-icon ${statusClass}">${icon}</div>
                    <div class="task-details">
                        <div class="task-description">${sanitizer.sanitize(task.description)}</div>
                        ${toolBadge}
                        ${retryButtonHtml}
                    </div>
                </div>
                ${resultHtml}
            </li>`;
    }).join('');

    const planWrapper = document.createElement('div');
    planWrapper.className = 'plan-wrapper';
    
    planWrapper.innerHTML = `
        <div class="plan-block">
            <details class="plan-details" open>
                <summary class="plan-header">
                    <span class="codicon codicon-list-ordered"></span>
                    <span>Agent Plan</span>
                </summary>
                <div class="plan-content">
                    <div class="plan-objective"><strong>Objective:</strong> ${sanitizer.sanitize(plan.objective)}</div>
                    <ul class="plan-tasks">${tasksHtml}</ul>
                    ${scratchpadHtml}
                </div>
            </details>
        </div>`;

    // Add event listeners for retry buttons
    planWrapper.querySelectorAll('.retry-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation(); // Prevent toggling details
            vscode.postMessage({ command: 'retryAgentTask', taskId: (btn as HTMLElement).dataset.taskId });
        });
    });

    dom.chatMessagesContainer.appendChild(planWrapper);
    if(dom.messagesDiv) dom.messagesDiv.scrollTop = dom.messagesDiv.scrollHeight;
}

export function insertNewMessageEditor(role: 'user' | 'assistant') {
    if(!dom.chatMessagesContainer) return;
    const existingEditor = document.querySelector('.new-message-editor-wrapper');
    if (existingEditor) existingEditor.remove();

    const editorWrapper = document.createElement('div');
    editorWrapper.className = 'message-wrapper new-message-editor-wrapper';
    // Updated structure for new layout
    editorWrapper.innerHTML = `
        <div class="message ${role}-message" style="border: 1px dashed var(--vscode-focusBorder);">
            <div class="message-avatar">
                <span class="codicon ${role === 'user' ? 'codicon-account' : 'codicon-hubot'}"></span>
            </div>
            <div class="message-body">
                <div class="message-header">${role === 'user' ? 'You' : 'Lollms'} (New)</div>
                <div class="edit-overlay">
                    <textarea class="edit-textarea" placeholder="Enter content..."></textarea>
                    <div class="edit-buttons">
                        <button class="edit-cancel-btn">Cancel</button>
                        <button class="edit-save-btn">Save</button>
                    </div>
                </div>
            </div>
        </div>
    `;
    
    const controls = dom.chatMessagesContainer.querySelector('#message-insertion-controls');
    if (controls) {
        dom.chatMessagesContainer.insertBefore(editorWrapper, controls);
    } else {
        dom.chatMessagesContainer.appendChild(editorWrapper);
    }

    const textarea = editorWrapper.querySelector('.edit-textarea') as HTMLTextAreaElement;
    if(textarea) textarea.focus();

    const saveBtn = editorWrapper.querySelector('.edit-save-btn');
    if(saveBtn) {
        (saveBtn as HTMLElement).addEventListener('click', () => {
            if(textarea) {
                const newContent = textarea.value;
                if (!newContent.trim()) return;
                const lastMessage = [...document.querySelectorAll('.message-wrapper:not(.new-message-editor-wrapper)')].pop() as HTMLElement;
                vscode.postMessage({
                    command: 'insertMessage',
                    afterMessageId: lastMessage?.dataset.messageId || null,
                    role: role,
                    content: newContent
                });
            }
            editorWrapper.remove();
        });
    }

    const cancelBtn = editorWrapper.querySelector('.edit-cancel-btn');
    if(cancelBtn) {
        (cancelBtn as HTMLElement).addEventListener('click', () => editorWrapper.remove());
    }
}
