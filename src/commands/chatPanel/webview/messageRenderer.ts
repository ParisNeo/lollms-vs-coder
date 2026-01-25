import { dom, vscode, state } from './dom.js';
import { isScrolledToBottom } from './utils.js';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import mermaid from 'mermaid';
import Prism from 'prismjs';

// CodeMirror imports
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { searchKeymap, openSearchPanel, search } from "@codemirror/search";
import { markdown } from "@codemirror/lang-markdown";
import { oneDark } from "@codemirror/theme-one-dark";

const RENDER_THROTTLE_MS = 200;

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
    'yaml': 'yaml',
    'json': 'json',
    'skill': 'json',
    'vue': 'html',
    'svelte': 'html',
    'ejs': 'html',
    'erb': 'html',
    'hbs': 'html',
    'handlebars': 'html',
    'xml': 'xml',
    'htm': 'html',
    'html': 'html'
};

try {
    marked.setOptions({
        breaks: true,
        gfm: true,
        highlight: (code, lang) => {
            return code;
        },
    });
} catch (e) {
    console.error("Failed to configure marked:", e);
}

const sanitizer = typeof DOMPurify === 'function' ? (DOMPurify as any)(window) : DOMPurify;
const SANITIZE_CONFIG = {
    ADD_TAGS: ['iframe', 'script', 'style'],
    ADD_ATTR: ['target', 'allow', 'allowfullscreen', 'frameborder', 'scrolling']
};

function createButton(text: string, icon: string, onClick: () => void, className = 'code-action-btn'): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = className;
    btn.title = text;
    btn.innerHTML = `<span class="codicon ${icon}"></span> <span class="btn-text">${text}</span>`;
    
    btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
            onClick();
        } catch (err) {
            console.error(`Error executing action for ${text}:`, err);
            vscode.postMessage({ command: 'showError', message: `Action failed: ${err}` });
        }
    };
    return btn;
}

// ... (createGenerationBlock, createSearchBlock, enablePanZoom, renderDiagram unchanged) ...
function createGenerationBlock(type: string, filePath: string, prompt: string): HTMLElement {
    const block = document.createElement('div');
    block.className = 'generation-block';
    
    const header = document.createElement('div');
    header.className = 'generation-header';
    header.innerHTML = `<span class="summary-lang-label">${type}${filePath ? ': ' + filePath : ''}</span>`;
    
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
            filePath: filePath, // filePath might be empty string
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

function createSearchBlock(type: string, query: string): HTMLElement {
    const block = document.createElement('div');
    block.className = 'generation-block';
    
    const header = document.createElement('div');
    header.className = 'generation-header';
    header.innerHTML = `<span class="summary-lang-label">${type}</span>`;
    
    const actions = document.createElement('div');
    actions.className = 'code-actions';
    header.appendChild(actions);

    const buttonId = `search-btn-${Date.now()}${Math.random()}`;
    const searchBtn = createButton('Search', 'codicon-search', () => {
        searchBtn.innerHTML = `<div class="spinner"></div> Searching...`;
        searchBtn.disabled = true;
        
        vscode.postMessage({
            command: 'runTool',
            tool: type === 'ArXiv Search' ? 'search_arxiv' : 'search_web',
            params: { query: query }
        });
        
        }, 'code-action-btn apply-btn');
    searchBtn.id = buttonId;

    actions.appendChild(searchBtn);
    
    const body = document.createElement('div');
    body.className = 'generation-body';
    body.innerHTML = `<p><strong>Query:</strong> ${sanitizer.sanitize(query)}</p>`;
    
    block.appendChild(header);
    block.appendChild(body);
    
    return block;
}

function enablePanZoom(container: HTMLElement) {
    let zoomScale = 1;
    let panX = 0;
    let panY = 0;
    let isDragging = false;
    let startX = 0;
    let startY = 0;

    const svg = container.querySelector('svg') as HTMLElement;
    if (!svg) return;

    // Make container clip overflow but show grab cursor
    container.style.overflow = 'hidden';
    container.style.cursor = 'grab';
    container.style.border = '1px solid var(--vscode-widget-border)';
    container.style.borderRadius = '4px';
    container.style.background = 'var(--vscode-editor-background)';
    container.style.minHeight = '400px'; 
    container.style.position = 'relative';

    svg.style.transformOrigin = '0 0';
    svg.style.transition = 'transform 0.1s ease-out';
    svg.style.width = '100%'; 
    svg.style.height = '100%';
    
    // Ensure SVG is block level to avoid extra spacing
    svg.style.display = 'block';

    const updateTransform = () => {
        svg.style.transform = `translate(${panX}px, ${panY}px) scale(${zoomScale})`;
    };

    container.addEventListener('wheel', (e) => {
        // Only zoom if over the diagram
        e.preventDefault();
        e.stopPropagation();
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        zoomScale *= delta;
        updateTransform();
    });

    container.addEventListener('mousedown', (e) => {
        isDragging = true;
        startX = e.clientX - panX;
        startY = e.clientY - panY;
        container.style.cursor = 'grabbing';
        svg.style.transition = 'none'; // Disable transition for dragging
    });

    // Listen on window to catch drags outside container
    window.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        e.preventDefault();
        panX = e.clientX - startX;
        panY = e.clientY - startY;
        updateTransform();
    });

    const stopDrag = () => {
        if(isDragging) {
            isDragging = false;
            container.style.cursor = 'grab';
            svg.style.transition = 'transform 0.1s ease-out';
        }
    };

    window.addEventListener('mouseup', stopDrag);
}

function renderDiagram(codeElement: HTMLElement, language: string, container: HTMLElement) {
    const diagramContainer = document.createElement('div');
    diagramContainer.className = 'diagram-container';
    
    const helpNote = document.createElement('div');
    helpNote.style.fontSize = '10px';
    helpNote.style.color = 'var(--vscode-descriptionForeground)';
    helpNote.style.marginBottom = '5px';
    helpNote.style.textAlign = 'right';
    helpNote.innerText = 'Scroll to Zoom & Drag to Pan';
    container.appendChild(helpNote);

    if (language === 'mermaid') {
        const id = `mermaid-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        const text = codeElement.textContent || '';
        
        try {
            mermaid.render(id, text).then((result: any) => {
                const svg = typeof result === 'string' ? result : result.svg;
                // Bypassing sanitizer for Mermaid to preserve styles, defs, and ids
                diagramContainer.innerHTML = svg;
                container.appendChild(diagramContainer);
                
                enablePanZoom(diagramContainer);

                if(codeElement.parentElement) codeElement.parentElement.style.display = 'none';
            }).catch((e: any) => {
                console.error("Mermaid render error:", e);
                const errorDiv = document.createElement('div');
                errorDiv.style.color = 'var(--vscode-errorForeground)';
                errorDiv.innerText = "Error rendering Mermaid diagram: " + e.message;
                diagramContainer.appendChild(errorDiv);
                if(codeElement.parentElement) codeElement.parentElement.style.display = 'block';
                container.appendChild(diagramContainer);
            });
        } catch (e: any) {
             console.error("Mermaid sync error:", e);
             diagramContainer.innerText = "Error rendering Mermaid diagram.";
             container.appendChild(diagramContainer);
        }
    } else if (language === 'svg') {
        // SVG from text is still sanitized
        diagramContainer.innerHTML = sanitizer.sanitize(codeElement.textContent || '', { USE_PROFILES: { svg: true } });
        container.appendChild(diagramContainer);
        
        enablePanZoom(diagramContainer);

        if(codeElement.parentElement) codeElement.parentElement.style.display = 'none';
    }
}

// ... (startEdit, extractFilePaths, looksLikeDiff, enhanceCodeBlocks, enhanceWithCommandButtons, processThinkTags unchanged) ...
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

    const editOverlay = document.createElement('div');
    editOverlay.className = 'edit-overlay';
    
    const editorContainer = document.createElement('div');
    editorContainer.className = 'edit-editor-container';
    
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
    
    editOverlay.appendChild(editorContainer);
    editOverlay.appendChild(buttonsDiv);
    
    contentDiv.innerHTML = '';
    contentDiv.appendChild(editOverlay);
    actionsDiv.style.display = 'none';
    
    const editState = EditorState.create({
        doc: textContent,
        extensions: [
            keymap.of([
                ...defaultKeymap,
                ...historyKeymap,
                ...searchKeymap,
                {
                    key: "Mod-s",
                    run: (view) => {
                        saveBtn.click();
                        return true;
                    }
                },
                {
                    key: "Mod-f",
                    run: openSearchPanel
                }
            ]),
            search({ top: true }), 
            history(),
            markdown(),
            oneDark,
            EditorView.lineWrapping,
        ]
    });

    const editView = new EditorView({
        state: editState,
        parent: editorContainer
    });
    editView.focus();

    cancelBtn.onclick = () => {
        renderMessageContent(messageId, textContent, true);
        actionsDiv.style.display = '';
    };

    saveBtn.onclick = () => {
        const newContent = editView.state.doc.toString();
        if (newContent.trim() !== textContent.trim()) {
            messageDiv.dataset.originalContent = JSON.stringify(newContent);
            vscode.postMessage({
                command: 'updateMessage',
                messageId: messageId,
                newContent: newContent
            });
            renderMessageContent(messageId, newContent, true);
        } else {
            renderMessageContent(messageId, textContent, true);
        }
        actionsDiv.style.display = '';
    };
}

function extractFilePaths(content: string): { type: 'file' | 'diff' | 'insert' | 'replace' | 'delete' | 'search_replace' | 'rename' | 'select' | 'file_delete' | null, path: string, stripFirstLine: boolean }[] {
    const infos: { type: 'file' | 'diff' | 'insert' | 'replace' | 'delete' | 'search_replace' | 'rename' | 'select' | 'file_delete' | null, path: string, stripFirstLine: boolean }[] = [];
    const lines = content.split('\n');
    let inBlock = false;
    let fenceLength = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim(); 
        
        if (!inBlock) {
            const xmlRename = line.match(/<rename\s+old=["']([^"']+)["']\s+new=["']([^"']+)["']\s*\/>/i);
            const xmlDelete = line.match(/<delete\s+path=["']([^"']+)["']\s*\/>/i);
            const xmlRemove = line.match(/<remove\s+path=["']([^"']+)["']\s*\/>/i);
            const xmlSelect = line.match(/<select\s+path=["']([^"']+)["']\s*\/>/i);
            
            if (xmlRename) {
                infos.push({ type: 'rename', path: `${xmlRename[1]} -> ${xmlRename[2]}`, stripFirstLine: false });
                continue;
            }
            if (xmlDelete) {
                infos.push({ type: 'file_delete', path: xmlDelete[1], stripFirstLine: false });
                continue;
            }
            if (xmlRemove) {
                infos.push({ type: 'file_delete', path: xmlRemove[1], stripFirstLine: false });
                continue;
            }
            if (xmlSelect) {
                infos.push({ type: 'select', path: xmlSelect[1], stripFirstLine: false });
                continue;
            }
        }

        const match = line.match(/^(\s{0,3})(`{3,})/); 

        if (match) {
            const currentFenceLength = match[2].length;

            if (!inBlock) {
                inBlock = true;
                fenceLength = currentFenceLength;
                
                let type: 'file' | 'diff' | 'insert' | 'replace' | 'delete' | 'search_replace' | 'rename' | 'select' | 'file_delete' | null = null;
                let pathStr = '';
                let stripFirstLine = false;

                const blockHeader = line.substring(match[0].length).trim();
                
                if (blockHeader.includes(':')) {
                    const parts = blockHeader.split(':');
                    const prefix = parts[0].toLowerCase();
                    const p = parts.slice(1).join(':').trim();

                    if (prefix === 'insert') type = 'insert';
                    else if (prefix === 'replace') type = 'replace';
                    else if (prefix === 'diff') type = 'diff';
                    else if (prefix === 'delete_code') type = 'delete';
                    else if (prefix === 'rename') type = 'rename';
                    else if (prefix === 'select') type = 'select';
                    else type = 'file';
                    
                    pathStr = p;
                }

                if (!pathStr && i + 1 < lines.length) {
                    const nextLine = lines[i+1].trim();
                    const langPathMatch = nextLine.match(/^([a-zA-Z0-9_+-]+):([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+)$/);

                    if (langPathMatch) {
                        pathStr = langPathMatch[2];
                        stripFirstLine = true;
                        // Determine type based on prefix provided in line
                        const prefix = langPathMatch[1].toLowerCase();
                        if (prefix === 'diff') type = 'diff';
                        else if (prefix === 'insert') type = 'insert';
                        else if (prefix === 'replace') type = 'replace';
                        else if (prefix === 'delete_code') type = 'delete';
                        else type = 'file';
                    } else if (!nextLine.startsWith('#!')) {
                        const pathLineRegex = /^((?:\/\/|#|<!--|;|\/\*|\*)\s*)?([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+)(\s*\S*)?$/;
                        const matchPath = nextLine.match(pathLineRegex);
                        
                        if (matchPath) {
                            const commentPrefix = matchPath[1];
                            const potentialPath = matchPath[2];
                            
                            if (potentialPath.includes('/') || potentialPath.includes('\\') || (commentPrefix && potentialPath.includes('.'))) {
                                pathStr = potentialPath;
                                stripFirstLine = true;
                                type = 'file';
                            }
                        }
                    }
                }

                if (!pathStr) {
                    let j = i - 1;
                    while (j >= 0 && lines[j].trim() === '') j--; 

                    if (j >= 0) {
                        const prevLine = lines[j].trim();
                        const fileMatch = prevLine.match(/^(?:(?:\*\*|__)?File(?:\*\*|__)?[:\s])\s*(.+)$/i);
                        const diffMatch = prevLine.match(/^(?:(?:\*\*|__)?Diff(?:\*\*|__)?[:\s])\s*(.+)$/i);
                        const insertMatch = prevLine.match(/^(?:(?:\*\*|__)?Insert(?:\*\*|__)?[:\s])\s*(.+)$/i);
                        const replaceMatch = prevLine.match(/^(?:(?:\*\*|__)?Replace(?:\*\*|__)?[:\s])\s*(.+)$/i);
                        const deleteMatch = prevLine.match(/^(?:(?:\*\*|__)?DeleteCode(?:\*\*|__)?[:\s])\s*(.+)$/i);
                        
                        const looksLikePath = /^[\w-./\\]+\.\w+$/.test(prevLine);

                        if (fileMatch) {
                            type = 'file';
                            pathStr = fileMatch[1].trim();
                        } else if (diffMatch) {
                            type = 'diff';
                            pathStr = diffMatch[1].trim();
                        } else if (insertMatch) {
                            type = 'insert';
                            pathStr = insertMatch[1].trim();
                        } else if (replaceMatch) {
                            type = 'replace';
                            pathStr = replaceMatch[1].trim();
                        } else if (deleteMatch) {
                            type = 'delete';
                            pathStr = deleteMatch[1].trim();
                        } else if (looksLikePath) {
                            let k = i + 1;
                            let contentPreview = "";
                            while(k < lines.length && k < i + 5) { 
                                contentPreview += lines[k] + "\n";
                                k++;
                            }
                            if (contentPreview.includes("<<<<<<< SEARCH")) {
                                type = 'replace'; 
                                pathStr = prevLine.trim();
                            }
                        }
                    }
                }
                
                if (pathStr) {
                    pathStr = pathStr.replace(/^`|`$/g, '');
                    pathStr = pathStr.replace(/^\*\*|\*\*$/g, '');
                    pathStr = pathStr.replace(/^\*|\*$/g, '');
                    pathStr = pathStr.replace(/[.:]+$/, ''); 
                }

                infos.push({ type, path: pathStr, stripFirstLine });
            } else {
                if (currentFenceLength >= fenceLength) {
                    inBlock = false;
                    fenceLength = 0;
                }
            }
        }
    }
    return infos;
}

function looksLikeDiff(text: string): boolean {
    const lines = text.split('\n');
    let headerLines = 0;
    let chunkMarkers = 0;
    
    // Check first 20 lines for unified diff indicators
    for (let i = 0; i < Math.min(lines.length, 20); i++) {
        const line = lines[i].trim();
        if (line.startsWith('--- ') || line.startsWith('+++ ')) {
            headerLines++;
        }
        if (line.startsWith('@@')) {
            chunkMarkers++;
        }
    }
    
    return headerLines >= 2 || chunkMarkers >= 1;
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
    let actionableBlockCount = 0;
    
    pres.forEach((pre, index) => {
        const code = pre.querySelector('code');
        if (!code) return;
        if (pre.parentElement?.classList.contains('code-collapsible')) return;

        const langMatch = code.className.match(/language-(\S+)/);
        let language = langMatch ? langMatch[1] : 'plaintext';
        
        let isFileBlock = false;
        let isDiff = false;
        let diffFilePath = '';
        let isInsert = false;
        let isReplace = false;
        let isDeleteCode = false;
        let isFileDelete = false; 
        let filePath = '';

        if (language.includes(':')) {
            const parts = language.split(':');
            language = parts[0];
            filePath = parts.slice(1).join(':').trim();
            if (language.toLowerCase() === 'diff') {
                isDiff = true;
                diffFilePath = filePath;
            } else {
                isFileBlock = true;
            }
            code.className = `language-${language}`;
            pre.className = `language-${language}`;
        }

        if (langMap[language.toLowerCase()]) {
            language = langMap[language.toLowerCase()];
            code.className = `language-${language}`;
            pre.className = `language-${language}`;
        }

        let codeText = code.innerText;
        const blockId = `code-block-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        code.id = blockId;

        const info = codeBlockInfos[index];

        if (info) {
            if (info.type === 'file') {
                filePath = info.path;
                isFileBlock = true;
            } else if (info.type === 'diff') {
                diffFilePath = info.path;
                isDiff = true;
            } else if (info.type === 'insert') {
                filePath = info.path;
                isInsert = true;
            } else if (info.type === 'replace') {
                filePath = info.path;
                isReplace = true;
            } else if (info.type === 'delete') {
                filePath = info.path;
                isDeleteCode = true;
            } else if (info.type === 'file_delete') {
                isFileDelete = true;
            }

            if (info.stripFirstLine) {
                const lines = codeText.split('\n');
                if (lines.length > 0) {
                    lines.shift();
                    codeText = lines.join('\n');
                    code.textContent = codeText; 
                }
            }
        } 
        
        // --- SECONDARY AUTO-DETECTION ---
        if (!isDiff && (language === 'diff' || looksLikeDiff(codeText))) {
            isDiff = true;
            const headerMatch = codeText.match(/(?:---|\+\+\+)\s+(?:[ab]\/)?([^\s\n\r]+)/);
            if (headerMatch && headerMatch[1]) {
                diffFilePath = headerMatch[1].trim();
            }
        } else if (!isReplace && codeText.includes("<<<<<<< SEARCH")) {
            const lines = codeText.split('\n');
            if (lines[0].includes("<<<<<<< SEARCH")) {
                isReplace = true;
            }
        }

        // Special Autodetection: If it's supposed to be a file but looks like a diff
        if (isFileBlock && !isDiff && looksLikeDiff(codeText)) {
            const warningDiv = document.createElement('div');
            warningDiv.style.backgroundColor = 'var(--vscode-inputValidation-warningBackground)';
            warningDiv.style.border = '1px solid var(--vscode-inputValidation-warningBorder)';
            warningDiv.style.padding = '4px 8px';
            warningDiv.style.fontSize = '11px';
            warningDiv.style.marginBottom = '4px';
            warningDiv.innerHTML = `<span class="codicon codicon-warning"></span> This block looks like a diff. Apply as patch instead?`;
            pre.parentNode?.insertBefore(warningDiv, pre);
            
            isDiff = true;
            diffFilePath = filePath;
            isFileBlock = false;
        }

        const prevEl = pre.previousElementSibling as HTMLElement;
        if (prevEl && (prevEl.tagName === 'P' || prevEl.tagName === 'DIV')) {
             const text = prevEl.textContent || "";
             if ((isFileBlock && /File/i.test(text)) || 
                 (isDiff && /Diff/i.test(text)) || 
                 (isInsert && /Insert/i.test(text)) ||
                 (isReplace && /Replace/i.test(text)) ||
                 (isDeleteCode && /DeleteCode/i.test(text))) {
                 prevEl.style.display = 'none';
             }
        }

        if (language === 'image_prompt') {
             const genBlock = createGenerationBlock('Image', filePath, codeText);
             if (pre.parentNode) pre.parentNode.replaceChild(genBlock, pre);
             return;
        } 
        
        if (language === 'search_web') {
             const searchBlock = createSearchBlock('Web Search', codeText);
             if (pre.parentNode) pre.parentNode.replaceChild(searchBlock, pre);
             return;
        } 
        
        if (language === 'search_arxiv') {
             const searchBlock = createSearchBlock('ArXiv Search', codeText);
             if (pre.parentNode) pre.parentNode.replaceChild(searchBlock, pre);
             return;
        }

        const details = document.createElement('details');
        details.className = 'code-collapsible';
        details.open = true;

        const summary = document.createElement('summary');
        summary.className = 'code-summary';
        const langLabel = document.createElement('span');
        langLabel.className = 'summary-lang-label';
        
        langLabel.textContent = language;

        const actions = document.createElement('div');
        actions.className = 'code-actions';
        summary.appendChild(langLabel);
        summary.appendChild(actions);

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

        if (isFileBlock && filePath) {
            actionableBlockCount++;
            langLabel.textContent = `${language} : ${filePath}`;
            
            const applyBtn = createButton('Apply to File', 'codicon-tools', () => {
                vscode.postMessage({ command: 'applyFileContent', filePath: filePath, content: codeText });
            }, 'code-action-btn apply-btn');
            
            if (actions.firstChild) actions.insertBefore(applyBtn, actions.firstChild);
            else actions.appendChild(applyBtn);

        } else if (isDiff) {
            actionableBlockCount++;
            const path = diffFilePath || filePath || 'patch';
            langLabel.textContent = `${language} : Diff: ${path}`;
            
            const applyPatchBtn = createButton('Apply Patch', 'codicon-tools', () => {
                vscode.postMessage({ command: 'applyPatchContent', filePath: path, content: codeText });
            }, 'code-action-btn apply-btn');
            
            if (actions.firstChild) actions.insertBefore(applyPatchBtn, actions.firstChild);
            else actions.appendChild(applyPatchBtn);

        } else if (isInsert) {
            actionableBlockCount++;
            langLabel.textContent = `Insert into ${filePath}`;
            const insertBtn = createButton('Insert Code', 'codicon-arrow-right', () => {
                vscode.postMessage({ command: 'insertCode', filePath: filePath, content: codeText });
            }, 'code-action-btn apply-btn');
            
            if (actions.firstChild) actions.insertBefore(insertBtn, actions.firstChild);
            else actions.appendChild(insertBtn);

        } else if (isReplace) {
            actionableBlockCount++;
            langLabel.textContent = `Replace in ${filePath}`;
            const replaceBtn = createButton('Replace Code', 'codicon-arrow-swap', () => {
                vscode.postMessage({ command: 'replaceCode', filePath: filePath, content: codeText });
            }, 'code-action-btn apply-btn');
            
            if (actions.firstChild) actions.insertBefore(replaceBtn, actions.firstChild);
            else actions.appendChild(replaceBtn);

        } else if (isDeleteCode) {
            actionableBlockCount++;
            langLabel.textContent = `Delete from ${filePath}`;
            const deleteCodeBtn = createButton('Delete Code', 'codicon-trash', () => {
                vscode.postMessage({ command: 'deleteCodeBlock', filePath: filePath, content: codeText });
            }, 'code-action-btn delete-btn');
            
            if (actions.firstChild) actions.insertBefore(deleteCodeBtn, actions.firstChild);
            else actions.appendChild(deleteCodeBtn);

        } else if (language === 'rename' || (info && info.type === 'rename')) {
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

        } else if (language === 'delete' || (info && info.type === 'delete') || isFileDelete) {
            const deleteBtn = createButton('Delete Files', 'codicon-trash', () => {
                vscode.postMessage({ command: 'deleteFile', filePaths: codeText });
            }, 'code-action-btn delete-btn');
            if (actions.firstChild) actions.insertBefore(deleteBtn, actions.firstChild);
            else actions.appendChild(deleteBtn);

        } else if (language === 'select' || (info && info.type === 'select')) {
            const selectBtn = createButton('Add to Context', 'codicon-add', () => {
                selectBtn.innerHTML = `<span class="codicon codicon-sync spin"></span> Adding...`;
                selectBtn.disabled = true;
                
                const files = codeText.trim().split('\n').map(f => f.trim()).filter(f => f);
                vscode.postMessage({ 
                    command: 'addFilesToContext', 
                    files: files,
                    blockId: blockId 
                });
            });
            selectBtn.id = `btn-${blockId}`;
            
            if (actions.firstChild) actions.insertBefore(selectBtn, actions.firstChild);
            else actions.appendChild(selectBtn);

        } else if (language === 'context_reset' || language === 'reset_context') {
            const resetBtn = createButton('Reset Context', 'codicon-clear-all', () => {
                vscode.postMessage({ command: 'executeLollmsCommand', details: { command: 'resetContext', params: {} } });
            }, 'code-action-btn delete-btn');
            if (actions.firstChild) actions.insertBefore(resetBtn, actions.firstChild);
            else actions.appendChild(resetBtn);

        } else if (language === 'skill') {
            langLabel.textContent = `New Skill`;
            const saveSkillBtn = createButton('Save Skill', 'codicon-lightbulb', () => {
                vscode.postMessage({ command: 'saveSkill', content: codeText });
            }, 'code-action-btn apply-btn');
            if (actions.firstChild) actions.insertBefore(saveSkillBtn, actions.firstChild);
            else actions.appendChild(saveSkillBtn);
        } else if (language === 'git_commit') {
            langLabel.textContent = "Git Commit Message";
            const commitBtn = createButton('Git Commit', 'codicon-git-commit', () => {
                vscode.postMessage({ command: 'executeLollmsCommand', details: { command: 'gitCommit', params: { message: codeText } } });
            }, 'code-action-btn apply-btn');
            if (actions.firstChild) actions.insertBefore(commitBtn, actions.firstChild);
            else actions.appendChild(commitBtn);
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

        const parent = pre.parentNode;
        if (parent) {
            details.appendChild(summary);
            parent.insertBefore(details, pre); 
            details.appendChild(pre); 
        }

        if (language === 'mermaid' || language === 'svg') {
            renderDiagram(code, language, details);
        } else {
            Prism.highlightElement(code);
        }
    });

    if (actionableBlockCount > 0) {
        const contentDiv = container.querySelector('.message-content');
        if (contentDiv && !contentDiv.querySelector('.apply-all-btn')) {
            const btn = document.createElement('button');
            btn.className = 'code-action-btn apply-btn apply-all-btn';
            btn.innerHTML = '<span class="codicon codicon-check-all"></span> Apply All Changes';
            btn.style.marginTop = '12px';
            btn.style.width = '100%';
            btn.style.justifyContent = 'center';
            btn.style.padding = '6px';
            btn.style.fontSize = '12px';
            btn.style.fontWeight = '600';
            
            btn.onclick = () => {
                const changes: any[] = [];
                const pres = container.querySelectorAll('pre');
                pres.forEach((pre, index) => {
                    const code = pre.querySelector('code');
                    if (!code) return;
                    const info = codeBlockInfos[index];
                    if (info && info.path && ['file', 'diff', 'insert', 'replace', 'delete', 'file_delete'].includes(info.type || '')) {
                        let typeToPush = info.type;
                        changes.push({
                            type: typeToPush,
                            path: info.path,
                            content: code.innerText
                        });
                    }
                });
                
                if(changes.length > 0) {
                    vscode.postMessage({ command: 'applyAllChanges', changes });
                    
                    const originalContent = btn.innerHTML;
                    btn.innerHTML = '<span class="codicon codicon-sync spin"></span> Applying...';
                    btn.disabled = true;
                    
                    setTimeout(() => {
                        btn.innerHTML = '<span class="codicon codicon-check"></span> Applied';
                        setTimeout(() => {
                            btn.innerHTML = originalContent;
                            btn.disabled = false;
                        }, 3000);
                    }, 1000);
                }
            };
            contentDiv.appendChild(btn);
        }
    }
}

function enhanceWithCommandButtons(container: HTMLElement) {
    const content = container.querySelector('.message-content');
    if (!content) return;
    
    const commandRegex = /\[command:([\w.-]+)\|label:([^|]+)\|params:(\{.*?\})\]/g;
    
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

export function processThinkTags(content: string): { thoughts: { tag: string, content: string }[], processedContent: string } {
    const thoughts: { tag: string, content: string }[] = [];
    if (typeof content !== 'string') return { thoughts, processedContent: '' };
    
    const thinkRegex = /<(think|thinking|analysis)>([\s\S]*?)<\/\1>/g;
    const processedContent = content.replace(thinkRegex, (match, tag, thoughtContent) => {
        thoughts.push({ tag, content: thoughtContent });
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
                
                let title = "AI Reasoning Process";
                let icon = "codicon-beaker";

                if (thought.tag === 'analysis') {
                    title = "AI Analysis & Insights";
                    icon = "codicon-search";
                }

                thinkDiv.innerHTML = `
                    <details ${isFinal ? '' : 'open'}>
                        <summary class="scratchpad-header"><span class="codicon ${icon}"></span> ${title}</summary>
                        <div class="scratchpad-content">${sanitizer.sanitize(marked.parse(thought.content) as string, SANITIZE_CONFIG)}</div>
                    </details>`;
                if (contentDiv.parentNode) {
                    contentDiv.parentNode.insertBefore(thinkDiv, contentDiv);
                }
            });
            
            let cleanXml = processedContent.replace(/```(?:xml(?!!--)(?::\w+)?)?\s*((?:<(?!!--)(?:file|rename|delete|select|remove|insert|replace)\b[\s\S]*?>[\s\S]*?)+)\s*```/gi, '$1');

            let xmlProcessedContent = cleanXml
                .replace(/<file\s+path=["']([^"']+)["']>\s*([\s\S]*?)\s*<\/file>/g, (match, path, code) => {
                    return `File: ${path}\n\`\`\`\n${code}\n\`\`\``;
                })
                .replace(/<rename\s+old=["']([^"']+)["']\s+new=["']([^"']+)["']\s*\/>/g, (match, old, n) => {
                    return `\`\`\`rename\n${old} -> ${n}\n\`\`\``;
                })
                .replace(/<delete\s+path=["']([^"']+)["']\s*\/>/g, (match, path) => {
                    return `\`\`\`delete\n${path}\n\`\`\``;
                })
                .replace(/<remove\s+path=["']([^"']+)["']\s*\/>/g, (match, path) => { 
                    return `\`\`\`delete\n${path}\n\`\`\``;
                })
                .replace(/<select\s+path=["']([^"']+)["']\s*\/>/g, (match, path) => {
                    return `\`\`\`select\n${path}\n\`\`\``;
                });

            contentDiv.innerHTML = sanitizer.sanitize(marked.parse(xmlProcessedContent) as string, SANITIZE_CONFIG);
        }

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
        // Handled by CSS
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

    if (role !== 'system') {
        if (!isMultipart) {
            actions.appendChild(createButton('', 'codicon-edit', () => startEdit(messageDiv, id, role), 'msg-action-btn'));
        }
        if (role === 'user') {
            actions.appendChild(createButton('', 'codicon-sync', () => vscode.postMessage({ command: 'regenerateFromMessage', messageId: id }), 'msg-action-btn'));
        }
    }
    
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

export function updateContext(contextText: string, files: string[] = []) {
    if(!dom.contextContainer) return;
    
    const filesList = files && files.length > 0 
        ? `<ul style="margin: 0; padding: 8px 12px; list-style-type: none; background: var(--vscode-editor-background); border: 1px solid var(--vscode-widget-border); border-radius: 4px;">
            ${files.map(f => `<li style="display: flex; align-items: center; gap: 6px; margin-bottom: 2px;"><span class="codicon codicon-file"></span> <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${f}</span></li>`).join('')}
           </ul>`
        : '<div style="padding: 8px; opacity: 0.7;">No files selected.</div>';

    // Parse project context as markdown for rich display
    const renderedMarkdown = sanitizer.sanitize(marked.parse(contextText) as string, SANITIZE_CONFIG);

    const innerHTML = `
    <div class="message special-zone-message context-message">
        <div class="message-avatar">
            <span class="codicon codicon-library"></span>
        </div>
        <div class="message-body">
            <div class="message-header" style="display: flex; justify-content: space-between; align-items: center; width: 100%; margin-bottom: 10px;">
                <span class="role-name">Project Context</span>
                <div style="display: flex; gap: 5px;">
                    <button id="save-context-btn" class="code-action-btn apply-btn" style="height: 22px; padding: 0 10px; font-size: 11px; margin: 0;" title="Save current file selection">
                        <span class="codicon codicon-save"></span>
                    </button>
                    <button id="load-context-btn" class="code-action-btn apply-btn" style="height: 22px; padding: 0 10px; font-size: 11px; margin: 0;" title="Load file selection">
                        <span class="codicon codicon-folder-opened"></span>
                    </button>
                    <button id="reset-context-bubble-btn" class="code-action-btn delete-btn" style="height: 22px; padding: 0 10px; font-size: 11px; margin: 0;" title="Reset context">
                        <span class="codicon codicon-clear-all"></span> Reset
                    </button>
                </div>
            </div>
            <div class="message-content">
                <details class="info-collapsible" style="margin-bottom: 6px;">
                    <summary>Selected Files (${files.length})</summary>
                    <div class="collapsible-content" style="padding-top: 8px;">
                        ${filesList}
                    </div>
                </details>
                <details class="info-collapsible">
                    <summary>View Loaded Content & Tree</summary>
                    <div class="collapsible-content markdown-context-view" style="max-height: 400px; overflow-y: auto; padding: 10px; background: var(--vscode-editor-background); border: 1px solid var(--vscode-widget-border); border-radius: 4px; font-size: 0.95em;">
                        ${renderedMarkdown}
                    </div>
                </details>
            </div>
        </div>
    </div>`;
    
    dom.contextContainer.innerHTML = contextText ? innerHTML : '';

    // Enhance code blocks and tree in the context bubble
    const markdownView = dom.contextContainer.querySelector('.markdown-context-view');
    if (markdownView) {
        enhanceCodeBlocks(markdownView as HTMLElement, contextText);
    }

    // Attach listeners programmatically to bypass CSP restrictions on inline onclick
    const saveBtn = document.getElementById('save-context-btn');
    if (saveBtn) {
        saveBtn.addEventListener('click', () => {
            vscode.postMessage({ 
                command: 'executeLollmsCommand', 
                details: { command: 'saveContext', params: {} } 
            });
        });
    }

    const loadBtn = document.getElementById('load-context-btn');
    if (loadBtn) {
        loadBtn.addEventListener('click', () => {
            vscode.postMessage({ 
                command: 'executeLollmsCommand', 
                details: { command: 'loadContext', params: {} } 
            });
        });
    }

    const resetBtn = document.getElementById('reset-context-bubble-btn');
    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            vscode.postMessage({ 
                command: 'executeLollmsCommand', 
                details: { command: 'resetContext', params: {} } 
            });
        });
    }
}

export function displayPlan(plan: any) {
    if(!dom.agentPlanZone) return; // Must have plan zone
    
    if (!plan) {
        dom.agentPlanZone.innerHTML = '';
        dom.agentPlanZone.classList.remove('visible');
        return;
    }

    dom.agentPlanZone.innerHTML = '';
    dom.agentPlanZone.classList.add('visible');

    let scratchpadHtml = plan.scratchpad ? `
        <div class="plan-scratchpad" style="margin-top:10px;">
            <details open>
                <summary class="scratchpad-header"><span class="codicon codicon-lightbulb"></span> Thought Process</summary>
                <div class="scratchpad-content">${sanitizer.sanitize(marked.parse(plan.scratchpad) as string, SANITIZE_CONFIG)}</div>
            </details>
        </div>` : '';

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

    planWrapper.querySelectorAll('.retry-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation(); 
            vscode.postMessage({ command: 'retryAgentTask', taskId: (btn as HTMLElement).dataset.taskId });
        });
    });

    dom.agentPlanZone.appendChild(planWrapper);
}

export function insertNewMessageEditor(role: 'user' | 'assistant') {
    if(!dom.chatMessagesContainer) return;
    const existingEditor = document.querySelector('.new-message-editor-wrapper');
    if (existingEditor) existingEditor.remove();

    const editorWrapper = document.createElement('div');
    editorWrapper.className = 'message-wrapper new-message-editor-wrapper';
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
