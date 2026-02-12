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

function createButton(text: string, icon: string, onClick: () => void, className = 'code-action-btn', tooltip?: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = className;
    btn.title = tooltip || text;
    
    btn.innerHTML = `<span class="codicon ${icon}"></span>`;
    
    btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
            onClick();
        } catch (err) {
            console.error(`Error executing action for ${text || tooltip}:`, err);
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
    
    svg.style.display = 'block';

    const updateTransform = () => {
        svg.style.transform = `translate(${panX}px, ${panY}px) scale(${zoomScale})`;
    };

    container.addEventListener('wheel', (e) => {
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
        svg.style.transition = 'none';
    });

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
// Helper to render skill creation blocks
function renderSkillBlock(content: string, titleAttr: string | undefined, messageId: string): string {
    let title = titleAttr || "New Skill";
    
    // If no attribute, try extraction (legacy fallback)
    if (!titleAttr) {
        const lines = content.split('\n');
        const titleLine = lines.find(l => l.startsWith('#'));
        if (titleLine) title = titleLine.replace(/^#+\s*/, '').trim();
    }
    
    const safeContent = encodeURIComponent(content);
    const safeTitle = encodeURIComponent(title);

    return `
    <div class="skill-creation-block">
        <div class="skill-header"><span class="codicon codicon-lightbulb"></span> Skill Generated: ${title}</div>
        <div class="skill-preview markdown-body">${sanitizer.sanitize(marked.parse(content))}</div>
        <div class="skill-actions">
            <button class="code-action-btn" onclick="saveSkill('${safeContent}', 'local', '${safeTitle}')">
                <span class="codicon codicon-save"></span> Save to Project
            </button>
            <button class="code-action-btn" onclick="saveSkill('${safeContent}', 'global', '${safeTitle}')">
                <span class="codicon codicon-globe"></span> Save Global
            </button>
        </div>
    </div>`;
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
        diagramContainer.innerHTML = sanitizer.sanitize(codeElement.textContent || '', { USE_PROFILES: { svg: true } });
        container.appendChild(diagramContainer);
        
        enablePanZoom(diagramContainer);

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
    actionsDiv.style.opacity = '0';
    actionsDiv.style.pointerEvents = 'none';
    
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
        actionsDiv.style.opacity = '';
        actionsDiv.style.pointerEvents = '';
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
        actionsDiv.style.opacity = '';
        actionsDiv.style.pointerEvents = '';
    };
}

function extractFilePaths(content: string): { type: 'file' | 'diff' | 'insert' | 'replace' | 'delete' | 'search_replace' | 'rename' | 'select' | 'file_delete' | null, path: string, stripFirstLine: boolean, isClosed: boolean }[] {
    const infos: { type: 'file' | 'diff' | 'insert' | 'replace' | 'delete' | 'search_replace' | 'rename' | 'select' | 'file_delete' | null, path: string, stripFirstLine: boolean, isClosed: boolean }[] = [];
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
                infos.push({ type: 'rename', path: `${xmlRename[1]} -> ${xmlRename[2]}`, stripFirstLine: false, isClosed: true });
                continue;
            }
            if (xmlDelete) {
                infos.push({ type: 'file_delete', path: xmlDelete[1], stripFirstLine: false, isClosed: true });
                continue;
            }
            if (xmlRemove) {
                infos.push({ type: 'file_delete', path: xmlRemove[1], stripFirstLine: false, isClosed: true });
                continue;
            }
            if (xmlSelect) {
                infos.push({ type: 'select', path: xmlSelect[1], stripFirstLine: false, isClosed: true });
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

                    // Check if content is actually an Aider block first (priority)
                    let isAider = false;
                    for (let j = i + 1; j < Math.min(lines.length, i + 10); j++) {
                        if (lines[j].includes('<<<<<<< SEARCH')) {
                            isAider = true;
                            break;
                        }
                    }

                    if (isAider) {
                        type = 'replace';
                    } else if (prefix === 'insert') {
                        type = 'insert';
                    } else if (prefix === 'replace') {
                        type = 'replace';
                    } else if (prefix === 'diff') {
                        type = 'diff';
                    } else if (prefix === 'delete_code') {
                        type = 'delete';
                    } else if (prefix === 'rename') {
                        type = 'rename';
                    } else if (prefix === 'select') {
                        type = 'select';
                    } else {
                        type = 'file'; // Interpreted as Full File
                    }
                    
                    pathStr = p;
                }

                if (!pathStr && i + 1 < lines.length) {
                    const nextLine = lines[i+1].trim();
                    const langPathMatch = nextLine.match(/^([a-zA-Z0-9_+-]+):([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+)$/);

                    if (langPathMatch) {
                        pathStr = langPathMatch[2];
                        stripFirstLine = true;
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

                infos.push({ type, path: pathStr, stripFirstLine, isClosed: false });
            } else {
                if (currentFenceLength >= fenceLength) {
                    inBlock = false;
                    fenceLength = 0;
                    if (infos.length > 0) {
                        infos[infos.length - 1].isClosed = true;
                    }
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

function enhanceCodeBlocks(container: HTMLElement, contentSource?: any, isFinal: boolean = false) {
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
        
        if (!isDiff && (language === 'diff' || looksLikeDiff(codeText))) {
            isDiff = true;
            const headerMatch = codeText.match(/(?:---|\+\+)\s+(?:[ab]\/)?([^\s\n\r]+)/);
            if (headerMatch && headerMatch[1]) {
                diffFilePath = headerMatch[1].trim();
            }
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

        const isDisabled = !isFinal && (info ? !info.isClosed : false);

        const copyBtn = createButton('Copy', 'codicon-copy', () => {
            vscode.postMessage({ command: 'copyToClipboard', text: codeText });
            const icon = copyBtn.querySelector('.codicon');
            if(icon) icon.className = 'codicon codicon-check';
            setTimeout(() => { if(icon) icon.className = 'codicon codicon-copy'; }, 2000);
        });
        copyBtn.disabled = isDisabled;
        actions.appendChild(copyBtn);

        const saveBtn = createButton('Save As...', 'codicon-save', () => {
            vscode.postMessage({ command: 'saveCodeToFile', content: codeText, language: language });
        });
        saveBtn.disabled = isDisabled;
        actions.appendChild(saveBtn);

        if (state.isInspectorEnabled && language !== 'skill') {
            const inspectBtn = createButton('Inspect', 'codicon-search', () => {
                vscode.postMessage({ command: 'inspectCode', code: codeText, language: language });
            });
            inspectBtn.disabled = isDisabled;
            actions.appendChild(inspectBtn);
        }

        if (isFileBlock && filePath) {
            actionableBlockCount++;
            langLabel.textContent = `${language} : ${filePath}`;

            const gotoBtn = createButton('', 'codicon-go-to-file', () => {
                vscode.postMessage({ command: 'openFile', path: filePath });
            }, 'code-action-btn', 'Go to File');
            gotoBtn.disabled = isDisabled;
            actions.appendChild(gotoBtn);

            const applyBtn = createButton('Apply to File', 'codicon-tools', () => {
                vscode.postMessage({ command: 'applyFileContent', filePath: filePath, content: codeText });
            }, 'code-action-btn apply-btn');
            applyBtn.disabled = isDisabled;
            if (actions.firstChild) actions.insertBefore(applyBtn, actions.firstChild);
            else actions.appendChild(applyBtn);
        } else if (isDiff) {
            actionableBlockCount++;
            const path = diffFilePath || filePath || 'patch';
            langLabel.textContent = `${language} : Diff: ${path}`;

            if (path !== 'patch') {
                const gotoBtn = createButton('', 'codicon-go-to-file', () => {
                    vscode.postMessage({ command: 'openFile', path: path });
                }, 'code-action-btn', 'Go to File');
                gotoBtn.disabled = isDisabled;
                actions.appendChild(gotoBtn);
            }

            const applyPatchBtn = createButton('Apply Patch', 'codicon-tools', () => {
                vscode.postMessage({ command: 'applyPatchContent', filePath: path, content: codeText });
            }, 'code-action-btn apply-btn');
            applyPatchBtn.disabled = isDisabled;
            if (actions.firstChild) actions.insertBefore(applyPatchBtn, actions.firstChild);
            else actions.appendChild(applyPatchBtn);
        } else if (isInsert) {
            actionableBlockCount++;
            langLabel.textContent = `Insert into ${filePath}`;

            const gotoBtn = createButton('', 'codicon-go-to-file', () => {
                vscode.postMessage({ command: 'openFile', path: filePath });
            }, 'code-action-btn', 'Go to File');
            gotoBtn.disabled = isDisabled;
            actions.appendChild(gotoBtn);

            const insertBtn = createButton('Insert Code', 'codicon-arrow-right', () => {
                vscode.postMessage({ command: 'insertCode', filePath: filePath, content: codeText });
            }, 'code-action-btn apply-btn');
            insertBtn.disabled = isDisabled;
            if (actions.firstChild) actions.insertBefore(insertBtn, actions.firstChild);
            else actions.appendChild(insertBtn);
        } else if (isReplace) {
            actionableBlockCount++;
            langLabel.textContent = `Replace in ${filePath}`;

            const gotoBtn = createButton('', 'codicon-go-to-file', () => {
                vscode.postMessage({ command: 'openFile', path: filePath });
            }, 'code-action-btn', 'Go to File');
            gotoBtn.disabled = isDisabled;
            actions.appendChild(gotoBtn);

            const replaceBtn = createButton('Replace Code', 'codicon-arrow-swap', () => {
                vscode.postMessage({ command: 'replaceCode', filePath: filePath, content: codeText });
            }, 'code-action-btn apply-btn');
            replaceBtn.disabled = isDisabled;
            if (actions.firstChild) actions.insertBefore(replaceBtn, actions.firstChild);
            else actions.appendChild(replaceBtn);
        } else {
             const runnableLanguages = ['python', 'py', 'javascript', 'js', 'typescript', 'ts', 'bash', 'sh', 'shell', 'powershell', 'pwsh', 'batch', 'cmd', 'bat'];
             if (runnableLanguages.includes(language.toLowerCase())) {
                 const executeBtn = createButton('Execute', 'codicon-play', () => {
                     vscode.postMessage({ command: 'runScript', code: codeText, language: language });
                 }, 'code-action-btn apply-btn');
                 executeBtn.disabled = isDisabled;
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
            btn.disabled = !isFinal; 
            btn.onclick = () => {
                const changes: any[] = [];
                const pres = container.querySelectorAll('pre');
                pres.forEach((pre, index) => {
                    const code = pre.querySelector('code');
                    if (!code) return;
                    const info = codeBlockInfos[index];
                    if (info && info.path && ['file', 'diff', 'insert', 'replace', 'delete', 'file_delete'].includes(info.type || '')) {
                        changes.push({ type: info.type, path: info.path, content: code.innerText });
                    }
                });
                if(changes.length > 0) {
                    vscode.postMessage({ command: 'applyAllChanges', changes });
                    const originalContent = btn.innerHTML;
                    btn.innerHTML = '<span class="codicon codicon-sync spin"></span> Applying...';
                    btn.disabled = true;
                    setTimeout(() => {
                        btn.innerHTML = '<span class="codicon codicon-check"></span> Applied';
                        setTimeout(() => { btn.innerHTML = originalContent; btn.disabled = false; }, 3000);
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

function renderImageGenBlock(prompt: string, path: string, width?: string, height?: string): string {
    const safePrompt = encodeURIComponent(prompt);
    const safePath = encodeURIComponent(path);
    const buttonId = `gen-btn-${Date.now()}${Math.random().toString(36).substr(2, 5)}`;
    
    return `
    <div class="generation-block">
        <div class="generation-header">
            <span class="summary-lang-label"><span class="codicon codicon-device-camera"></span> Propose Image Generation ${path ? ': ' + path : ''}</span>
            <div class="code-actions">
                <button id="${buttonId}" class="code-action-btn apply-btn" onclick="generateImageFromTag('${safePrompt}', '${safePath}', '${width || ''}', '${height || ''}', '${buttonId}')" title="Generate Image with AI">
                    <span class="codicon codicon-sparkle"></span> Generate
                </button>
            </div>
        </div>
        <div class="generation-body">
            <p><strong>Prompt:</strong> ${sanitizer.sanitize(prompt)}</p>
            ${width || height ? `<p style="font-size: 0.85em; opacity: 0.8;"><span class="codicon codicon-screen-full" style="font-size: 10px;"></span> Requested Size: ${width || 'auto'} x ${height || 'auto'}</p>` : ''}
            <div class="image-preview-zone" style="margin-top: 10px;"></div>
        </div>
    </div>`;
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
                })
                .replace(/<generateImage\s+([^>]*)\/>/gi, (match, attrs) => {
                    const prompt = (attrs.match(/prompt=["']([^"']+)["']/) || [])[1] || "";
                    const path = (attrs.match(/path=["']([^"']+)["']/) || [])[1] || "";
                    const width = (attrs.match(/width=["']([^"']+)["']/) || [])[1];
                    const height = (attrs.match(/height=["']([^"']+)["']/) || [])[1];
                    return renderImageGenBlock(prompt, path, width, height);
                });
            
            // --- NEW: Process <skill> tags ---
            let finalHtml = xmlProcessedContent;
            
            // Regex captures optional title attribute
            const skillRegex = /<skill(?:\s+title=["']([^"']*)["'])?>([\s\S]*?)<\/skill>/g;
            
            // Replace <skill> blocks with HTML UI
            finalHtml = finalHtml.replace(skillRegex, (match, title, skillContent) => {
                return renderSkillBlock(skillContent, title, messageId);
            });

            // Parse Markdown for the rest
            finalHtml = sanitizer.sanitize(marked.parse(finalHtml) as string, SANITIZE_CONFIG);

            contentDiv.innerHTML = finalHtml;
        }

        enhanceWithCommandButtons(wrapper as HTMLElement);
        enhanceCodeBlocks(wrapper as HTMLElement, rawContent, isFinal);

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
        // Avatar is handled by CSS background-image
    } else {
        avatarDiv.innerHTML = '<span class="codicon codicon-gear"></span>';
    }
    
    messageDiv.appendChild(avatarDiv);

    const bodyDiv = document.createElement('div');
    bodyDiv.className = 'message-body';
    messageDiv.appendChild(bodyDiv);

    // BUBBLE TOOLBAR
    const actions = document.createElement('div');
    actions.className = 'message-actions';
    
    const isMultipart = Array.isArray(rawContent);
    const textForClipboard = isMultipart 
        ? (rawContent.find((p: any) => p.type === 'text')?.text || '') 
        : (typeof rawContent === 'string' ? rawContent : '');

    if (role !== 'system') {
        if (!isMultipart) {
            actions.appendChild(createButton('', 'codicon-edit', () => startEdit(messageDiv, id, role), 'msg-action-btn', 'Edit Message'));
        }
        if (role === 'user') {
            actions.appendChild(createButton('', 'codicon-sync', () => vscode.postMessage({ command: 'regenerateFromMessage', messageId: id }), 'msg-action-btn', 'Regenerate Response'));
        }
    }
    
    const copyBtn = createButton('', 'codicon-copy', () => {
        vscode.postMessage({ command: 'copyToClipboard', text: textForClipboard });
        copyBtn.innerHTML = '<span class="codicon codicon-check"></span>';
        setTimeout(() => { copyBtn.innerHTML = '<span class="codicon codicon-copy"></span>'; }, 2000);
    }, 'msg-action-btn', 'Copy Message');
    actions.appendChild(copyBtn);

    if (role === 'assistant') {
        actions.appendChild(createButton('', 'codicon-save', () => vscode.postMessage({ command: 'saveMessageAsPrompt', content: textForClipboard }), 'msg-action-btn', 'Save as Prompt'));
        actions.appendChild(createButton('', 'codicon-book', () => vscode.postMessage({ command: 'requestLog' }), 'msg-action-btn', 'Show Debug Log'));
    }
    
    actions.appendChild(createButton('', 'codicon-trash', () => vscode.postMessage({ command: 'requestDeleteMessage', messageId: id }), 'msg-action-btn', 'Delete Message'));

    // Insert actions before content
    bodyDiv.appendChild(actions);

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



export function updateContext(contextText: string, files: string[] = [], skills: any[] = []) {
    if(!dom.contextContainer) return;
    
    const renderedMarkdown = sanitizer.sanitize(marked.parse(contextText) as string, SANITIZE_CONFIG);

    const filesList = files && files.length > 0 
        ? `<ul class="context-file-list">
            ${files.map(f => `
                <li class="context-item">
                    <span class="codicon codicon-file"></span> 
                    <span class="context-item-label" title="${f}">${f}</span>
                    <div style="display:flex; gap:2px;">
                        <button class="open-context-btn" data-value="${f}" title="Inspect / Edit File">
                            <span class="codicon codicon-edit"></span>
                        </button>
                        <button class="remove-context-btn" data-type="file" data-value="${f}" title="Remove from context">
                            <span class="codicon codicon-close"></span>
                        </button>
                    </div>
                </li>`).join('')}
           </ul>`
        : '<div class="empty-context-msg">No files selected.</div>';

    const skillsList = skills && skills.length > 0
        ? `<div class="context-skill-list">
            ${skills.map(s => `
                <div class="context-item skill-item">
                    <details class="info-collapsible" style="flex: 1; border: none; padding: 0;">
                        <summary style="padding: 4px 0; cursor: pointer;">${s.name}</summary>
                        <div class="skill-content">${sanitizer.sanitize(s.content)}</div>
                    </details>
                    <button class="remove-context-btn" data-type="skill" data-value="${s.id}" title="Remove skill">
                        <span class="codicon codicon-close"></span>
                    </button>
                </div>
            `).join('')}
           </div>`
        : '<div class="empty-context-msg">No skills learned.</div>';

    const innerHTML = `
    <div class="message special-zone-message context-message">
        <div class="message-avatar">
            <span class="codicon codicon-library"></span>
        </div>
        <div class="message-body">
            <div class="message-header" style="display: flex; justify-content: space-between; align-items: center; width: 100%; margin-bottom: 10px;">
                <span class="role-name">Project Context</span>
                <div style="display: flex; gap: 5px;">
                    <button id="add-file-context-btn" class="code-action-btn apply-btn" style="height: 22px; padding: 0 10px; font-size: 11px; margin: 0;" title="Add File to Context">
                        <span class="codicon codicon-add"></span> File
                    </button>
                    <button id="add-skill-context-btn" class="code-action-btn apply-btn" style="height: 22px; padding: 0 10px; font-size: 11px; margin: 0;" title="Add Skill to Context">
                        <span class="codicon codicon-lightbulb"></span> Skill
                    </button>
                    <button id="add-url-context-btn" class="code-action-btn apply-btn" style="height: 22px; padding: 0 10px; font-size: 11px; margin: 0;" title="Add URL content to Context">
                        <span class="codicon codicon-globe"></span> URL
                    </button>
                    <div style="width: 1px; background: var(--vscode-widget-border); margin: 0 4px;"></div>
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
                    <summary>Active Skills (${skills.length})</summary>
                    <div class="collapsible-content">
                        ${skillsList}
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

    const markdownView = dom.contextContainer.querySelector('.markdown-context-view');
    if (markdownView) {
        enhanceCodeBlocks(markdownView as HTMLElement, contextText, true);
    }

    dom.contextContainer.querySelectorAll('.remove-context-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const target = e.currentTarget as HTMLElement;
            const type = target.dataset.type;
            const value = target.dataset.value;
            
            if (type === 'file') {
                vscode.postMessage({ command: 'removeFileFromContext', path: value });
            } else if (type === 'skill') {
                vscode.postMessage({ command: 'removeSkillFromContext', skillId: value });
            }
        });
    });

    dom.contextContainer.querySelectorAll('.open-context-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const target = e.currentTarget as HTMLElement;
            const value = target.dataset.value;
            if (value) {
                vscode.postMessage({ command: 'openFile', path: value });
            }
        });
    });

    const addFileBtn = document.getElementById('add-file-context-btn');
    if (addFileBtn) {
        addFileBtn.addEventListener('click', () => {
            vscode.postMessage({ command: 'requestAddFileToContext' });
        });
    }

    const addSkillBtn = document.getElementById('add-skill-context-btn');
    if (addSkillBtn) {
        addSkillBtn.addEventListener('click', () => {
            vscode.postMessage({ command: 'importSkills' });
        });
    }

    const addUrlBtn = document.getElementById('add-url-context-btn');
    if (addUrlBtn) {
        addUrlBtn.addEventListener('click', () => {
            vscode.postMessage({ command: 'requestAddUrlToContext' });
        });
    }

    const saveBtn = document.getElementById('save-context-btn');
    if (saveBtn) {
        saveBtn.addEventListener('click', () => {
            vscode.postMessage({ command: 'executeLollmsCommand', details: { command: 'saveContext', params: {} } });
        });
    }

    const loadBtn = document.getElementById('load-context-btn');
    if (loadBtn) {
        loadBtn.addEventListener('click', () => {
            vscode.postMessage({ command: 'executeLollmsCommand', details: { command: 'loadContext', params: {} } });
        });
    }

    const resetBtn = document.getElementById('reset-context-bubble-btn');
    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            vscode.postMessage({ command: 'executeLollmsCommand', details: { command: 'resetContext', params: {} } });
        });
    }
}

/**
 * Renders a single plan structure.
 */
function renderPlanAttempt(plan: any, isPrevious: boolean = false) {
    let investigationHtml = '';
    if (plan.investigation && plan.investigation.length > 0) {
        const invItems = plan.investigation.map((item: any) => {
            let statusIcon = '';
            if (item.status === 'completed') statusIcon = '<span class="codicon codicon-check" style="color:var(--vscode-charts-green)"></span>';
            else if (item.status === 'failed') statusIcon = '<span class="codicon codicon-error" style="color:var(--vscode-charts-red)"></span>';
            else statusIcon = '<span class="codicon codicon-sync spin" style="color:var(--vscode-charts-yellow)"></span>';
            
            return `
            <div class="investigation-item" style="padding: 8px; border-bottom: 1px solid var(--vscode-widget-border); font-size: 12px;">
                <div style="display:flex; justify-content:space-between; align-items:center; font-weight:600;">
                    <span>${statusIcon} ${item.action}</span>
                </div>
                <details style="margin-top:4px;">
                    <summary style="opacity:0.7; cursor:pointer; font-size: 10px;">Details</summary>
                    <div style="background:var(--vscode-textCodeBlock-background); padding:6px; margin-top:4px; border-radius:4px; overflow-x:auto; font-family:var(--vscode-editor-font-family); border: 1px solid var(--vscode-widget-border);">
                        <div style="margin-bottom:4px;"><strong style="color:var(--vscode-descriptionForeground)">Parameters:</strong> ${JSON.stringify(item.parameters)}</div>
                        ${item.result ? `<div><strong style="color:var(--vscode-descriptionForeground)">Result:</strong> ${sanitizer.sanitize(item.result.substring(0, 1000))}${item.result.length > 1000 ? '...' : ''}</div>` : ''}
                    </div>
                </details>
            </div>`;
        }).join('');

        investigationHtml = `
        <div class="plan-scratchpad" style="margin-top:10px; border-left: 4px solid var(--vscode-charts-blue);">
            <details ${isPrevious ? '' : 'open'}>
                <summary class="scratchpad-header"><span class="codicon codicon-search"></span> Architect Investigation Steps</summary>
                <div class="scratchpad-content" style="padding:0;">${invItems}</div>
            </details>
        </div>`;
    }

    let scratchpadHtml = plan.scratchpad ? `
        <div class="plan-scratchpad" style="margin-top:10px;">
            <details ${isPrevious ? '' : 'open'}>
                <summary class="scratchpad-header"><span class="codicon codicon-lightbulb"></span> Process / Thoughts</summary>
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

    let tasksHtml = '';
    if (plan.tasks && plan.tasks.length > 0) {
        tasksHtml = plan.tasks.map((task: any) => {
            let statusClass = `status-${task.status}`;
            let icon = getStatusIcon(task.status);
            let toolBadge = task.action ? `<span class="tool-badge"><span class="codicon codicon-tools"></span> ${task.action}</span>` : '';
            
            let retryButtonHtml = '';
            if (task.status === 'failed' && task.can_retry && !isPrevious) {
                retryButtonHtml = `<button class="retry-btn" data-task-id="${task.id}" title="Retry this task"><span class="codicon codicon-debug-restart"></span> Retry</button>`;
            }
            
            let resultHtml = '';
            if (task.result) {
                const isFailure = task.status === 'failed';
                const label = isFailure ? 'Failure Details' : 'Output';
                const resultBoxClass = isFailure ? 'failure' : 'success';
                const summaryClass = isFailure ? 'failure-text' : 'success-text';

                resultHtml = `
                    <div class="task-result">
                        <details ${isFailure ? 'open' : ''}>
                            <summary class="task-result-summary ${summaryClass}">${label}</summary>
                            <div class="task-result-box ${resultBoxClass}">${sanitizer.sanitize(task.result)}</div>
                        </details>
                    </div>`;
            }

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
    }

    const attemptDiv = document.createElement('div');
    attemptDiv.className = `plan-block ${isPrevious ? 'stale' : 'active'}`;
    
    attemptDiv.innerHTML = `
        <details class="plan-details" ${isPrevious ? '' : 'open'}>
            <summary class="plan-header">
                <span class="codicon ${isPrevious ? 'codicon-history' : 'codicon-list-ordered'}"></span>
                <span>${isPrevious ? 'Previous Attempt' : 'Active Plan'}</span>
            </summary>
            <div class="plan-content">
                <div class="plan-objective"><strong>Objective:</strong> ${sanitizer.sanitize(plan.objective)}</div>
                ${investigationHtml}
                ${scratchpadHtml}
                <ul class="plan-tasks">${tasksHtml}</ul>
            </div>
        </details>`;

    attemptDiv.querySelectorAll('.retry-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation(); 
            vscode.postMessage({ command: 'retryAgentTask', taskId: (btn as HTMLElement).dataset.taskId });
        });
    });

    return attemptDiv;
}

export function displayPlan(plan: any) {
    if(!dom.agentPlanZone) return; 
    
    if (!plan) {
        dom.agentPlanZone.innerHTML = '';
        dom.agentPlanZone.classList.remove('visible');
        dom.planResizer.classList.remove('visible');
        return;
    }

    dom.agentPlanZone.innerHTML = '';
    dom.agentPlanZone.classList.add('visible');
    dom.planResizer.classList.add('visible');

    // 1. CREATE THE STICKY TOOLBAR FIRST
    const globalActions = document.createElement('div');
    globalActions.className = 'plan-global-actions';
    
    const copyLogBtn = createButton('Copy Full Experience Log', 'codicon-copy', () => {
        const text = formatPlanForCopy(plan);
        vscode.postMessage({ command: 'copyToClipboard', text: text });
        
        copyLogBtn.innerHTML = '<span class="codicon codicon-check"></span> <span class="btn-text">Experience Log Copied!</span>';
        copyLogBtn.style.backgroundColor = 'var(--vscode-charts-green)';
        
        setTimeout(() => {
            copyLogBtn.innerHTML = '<span class="codicon codicon-copy"></span> <span class="btn-text">Copy Full Experience Log</span>';
            copyLogBtn.style.backgroundColor = '';
        }, 2000);
    }, 'code-action-btn copy-log-btn');
    
    globalActions.appendChild(copyLogBtn);
    
    // Add the toolbar to the zone
    dom.agentPlanZone.appendChild(globalActions);

    // 2. CREATE SCROLLABLE WRAPPER FOR THE CONTENT
    const wrapper = document.createElement('div');
    wrapper.className = 'plan-wrapper';

    // Render History (Blocks of Experience)
    if (plan.attempts && plan.attempts.length > 0) {
        plan.attempts.forEach((oldPlan: any) => {
            wrapper.appendChild(renderPlanAttempt(oldPlan, true));
        });
    }

    // Render Current Active Plan
    wrapper.appendChild(renderPlanAttempt(plan, false));

    dom.agentPlanZone.appendChild(wrapper);
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

/**
 * Formats the entire plan history into a single Markdown string for debugging.
 */
function formatPlanForCopy(plan: any): string {
    let log = `# AGENT EXPERIENCE LOG\n\n`;
    log += `**OBJECTIVE:** ${plan.objective}\n\n`;

    const allAttempts = [...(plan.attempts || []), plan];

    allAttempts.forEach((attempt: any, index: number) => {
        const isCurrent = index === allAttempts.length - 1;
        log += `## ATTEMPT ${index + 1} ${isCurrent ? '(CURRENT)' : '(ARCHIVED)'}\n`;
        log += `> ${attempt.scratchpad}\n\n`;

        if (attempt.investigation && attempt.investigation.length > 0) {
            log += `### Investigation Steps\n`;
            attempt.investigation.forEach((inv: any) => {
                log += `- **${inv.action}** [${inv.status}]\n`;
                log += `  - Params: ${JSON.stringify(inv.parameters)}\n`;
                if (inv.result) log += `  - Result: ${inv.result}\n`;
            });
            log += `\n`;
        }

        if (attempt.tasks && attempt.tasks.length > 0) {
            log += `### Task Execution\n`;
            attempt.tasks.forEach((task: any) => {
                log += `#### Task ${task.id}: ${task.description}\n`;
                log += `- Action: \`${task.action}\` | Status: **${task.status}**\n`;
                if (task.parameters) log += `- Parameters: \`${JSON.stringify(task.parameters)}\` \n`;
                if (task.result) {
                    log += `\`\`\`\n${task.result}\n\`\`\`\n`;
                }
                log += `\n`;
            });
        }
        log += `--- \n\n`;
    });

    return log;
}

