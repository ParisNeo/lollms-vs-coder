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
    'html': 'html',
    'svg': 'markup'
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
    ADD_ATTR: ['target', 'allow', 'allowfullscreen', 'frameborder', 'scrolling', 'onclick', 'data-value', 'data-type', 'data-message-id', 'data-pid']
};

function unescapeXml(safe: string): string {
    if (!safe) return '';
    return safe.replace(/&(lt|gt|amp|apos|quot);/g, (match, entity) => {
        const map: { [key: string]: string } = {
            'lt': '<',
            'gt': '>',
            'amp': '&',
            'apos': "'",
            'quot': '"'
        };
        return map[entity] || match;
    });
}

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
            // Removed optimistic 'applied' logic. 
            // Color change is now driven by extension success signal.
        } catch (err) {
            console.error(`Error executing action for ${text || tooltip}:`, err);
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
    }, { passive: false });

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
/**
 * Renders a visual block indicating a fact has been saved to Project Memory.
 * Now collapsible and action-aware.
 */
function renderMemoryTag(action: string, id: string, title: string, content: string): string {
    const isDelete = action === 'delete';
    const actionLabel = isDelete ? 'REMOVED FROM' : (action === 'update' ? 'UPDATED IN' : 'ADDED TO');
    const headerTitle = `AI ${actionLabel} MEMORY: ${sanitizer.sanitize(id)}`;
    const iconClass = isDelete ? 'codicon-trash' : 'codicon-chip';
    const blockClass = isDelete ? 'memory-deleted' : '';

    const safeContent = encodeURIComponent(content);
    const safeTitle = encodeURIComponent(title);

    return `
    <div class="project-memory-block ${blockClass}" data-mem-id="${id}">
        <details>
            <summary class="memory-summary">
                <div style="display:flex; align-items:center; gap:10px; flex:1;">
                    <span class="codicon ${iconClass}"></span>
                    <span class="memory-summary-text">${headerTitle}</span>
                </div>
                <button class="msg-action-btn sync-memory-btn" 
                        data-action="${action}" 
                        data-id="${id}" 
                        data-title="${safeTitle}" 
                        data-content="${safeContent}"
                        title="Manually apply/sync this fact to project memory">
                    <i class="codicon codicon-sync"></i>
                </button>
            </summary>
            <div class="memory-expanded-content">
                <div class="memory-header">
                    <div class="memory-title-info">
                        <div class="memory-label">KNOWLEDGE CONTENT</div>
                        <div class="memory-title">${sanitizer.sanitize(title || id)}</div>
                    </div>
                </div>
                <div class="memory-content">
                    ${sanitizer.sanitize(content)}
                </div>
                <div class="memory-status-line">
                    <span class="codicon codicon-pass-filled"></span>
                    Synced to .lollms/project_memory.json
                </div>
            </div>
        </details>
    </div>`;
}

// Helper to render skill creation blocks
function renderSkillBlock(rawContent: string, attrs: { title?: string, description?: string, category?: string }, messageId: string): string {
    let title = attrs.title || "New Skill";
    let description = attrs.description || "";
    let category = attrs.category || "";
    let finalContent = rawContent;

    // Legacy CDATA/Tag extraction fallback
    const contentTagMatch = rawContent.match(/<content>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/content>/s);
    if (contentTagMatch) finalContent = contentTagMatch[1].trim();
    
    const safeContent = encodeURIComponent(finalContent);
    const safeTitle = encodeURIComponent(title);
    const safeDesc = encodeURIComponent(description);
    const safeCat = encodeURIComponent(category);

    // Sanitize the inner markdown content once
    const previewHtml = sanitizer.sanitize(marked.parse(finalContent) as string, SANITIZE_CONFIG);

    return `
    <div class="skill-creation-block" data-message-id="${messageId}">
        <div class="skill-header">
            <span class="codicon codicon-lightbulb" style="color:var(--vscode-charts-yellow)"></span> 
            <div style="display:flex; flex-direction:column; gap:2px;">
                <span style="font-size: 13px;">Propose New Skill: <strong>${sanitizer.sanitize(title)}</strong></span>
                ${category ? `<span style="font-size: 10px; opacity: 0.7;">📁 ${sanitizer.sanitize(category)}</span>` : ''}
            </div>
        </div>
        ${description ? `<div style="padding: 8px 16px; font-size: 12px; opacity: 0.9; border-bottom: 1px solid var(--vscode-widget-border); font-style: italic;">${sanitizer.sanitize(description)}</div>` : ''}
        <div class="skill-preview markdown-body">${previewHtml}</div>
        <div class="skill-actions">
            <button class="code-action-btn apply-btn save-skill-btn" data-content="${safeContent}" data-scope="local" data-title="${safeTitle}" data-description="${safeDesc}" data-category="${safeCat}">
                <span class="codicon codicon-save"></span> Save to Project
            </button>
            <button class="code-action-btn apply-btn save-skill-btn" data-content="${safeContent}" data-scope="global" data-title="${safeTitle}" data-description="${safeDesc}" data-category="${safeCat}">
                <span class="codicon codicon-globe"></span> Save Global
            </button>
            <button class="code-action-btn apply-btn save-skill-file-btn" data-content="${safeContent}" data-title="${safeTitle}" data-description="${safeDesc}" data-category="${safeCat}">
                <span class="codicon codicon-export"></span> Save to File...
            </button>
        </div>
    </div>`;
}

/**
 * Cleans up Mermaid code to prevent rendering errors.
 * Wraps node labels in quotes and escapes characters that break the parser.
 */
function preprocessMermaid(code: string): string {
    // If it's a class diagram, we trust the generator quoted it correctly
    if (code.includes('classDiagram')) {
        return code;
    }
    return code.split('\n').map(line => {
        const trimmed = line.trim();
        if (trimmed.match(/^(subgraph|end|class|state|note|participant|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|pie|gitGraph|flowchart|graph)/i)) {
            return line;
        }

        return line.replace(/([a-zA-Z0-9_-]+)\s*([\[\(\{]{1,2})\s*([^"'\n\r\t]+?)\s*([\]\)\}]{1,2})/g, (match, id, open, label, close) => {
            const safeLabel = label.replace(/"/g, "'");
            return `${id}${open}"${safeLabel.trim()}"${close}`;
        });
    }).join('\n');
}

function renderDiagram(codeElement: HTMLElement, language: string, container: HTMLElement) {
    const diagramContainer = document.createElement('div');
    diagramContainer.className = 'diagram-container';
    
    const helpNote = document.createElement('div');
    helpNote.style.cssText = 'font-size: 10px; opacity: 0.6; margin-bottom: 5px; text-align: right;';
    helpNote.innerHTML = '<span class="codicon codicon-zoom-in" style="font-size:10px"></span> Scroll to Zoom | <span class="codicon codicon-move" style="font-size:10px"></span> Drag to Pan';
    container.appendChild(helpNote);
    container.appendChild(diagramContainer);

    if (language === 'mermaid') {
        const id = `mermaid-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        const rawText = codeElement.textContent || '';
        const sanitizedText = preprocessMermaid(rawText);
        
        try {
            mermaid.render(id, sanitizedText).then((result: any) => {
                const svg = typeof result === 'string' ? result : result.svg;
                diagramContainer.innerHTML = svg;
                enablePanZoom(diagramContainer);
            }).catch((e: any) => {
                console.error("Mermaid render error:", e);
                diagramContainer.innerHTML = `
                    <div style="color:var(--vscode-errorForeground); padding:10px; font-size:11px; background:var(--vscode-inputValidation-errorBackground); border-radius:4px; border: 1px solid var(--vscode-errorForeground);">
                        <strong>Mermaid Error:</strong> ${sanitizer.sanitize(e.message)}
                    </div>`;
            });
        } catch (e: any) {
             diagramContainer.innerText = "Error rendering Mermaid diagram.";
        }
    } else if (language === 'svg') {
        diagramContainer.innerHTML = sanitizer.sanitize(codeElement.textContent || '', { USE_PROFILES: { svg: true } });
        enablePanZoom(diagramContainer);
    }
}

function startEdit(messageDiv: HTMLElement, messageId: string, role: string) {
    let originalContent: any;
    try {
        originalContent = JSON.parse(messageDiv.dataset.originalContent || '""');
    } catch (e) {
        originalContent = "";
    }

    let textContent = "";
    let localImages: { name: string, data: string }[] = [];

    if (typeof originalContent === 'string') {
        textContent = originalContent;
    } else if (Array.isArray(originalContent)) {
        textContent = originalContent.filter(part => part.type === 'text').map(part => part.text).join('\n');
        localImages = originalContent
            .filter(part => part.type === 'image_url')
            .map((part, idx) => ({ name: `image_${idx}.png`, data: part.image_url.url }));
    }

    const contentDiv = messageDiv.querySelector('.message-content') as HTMLElement;
    const actionsDiv = messageDiv.querySelector('.message-actions') as HTMLElement;
    if (!contentDiv || !actionsDiv) return;

    const editOverlay = document.createElement('div');
    editOverlay.className = 'edit-overlay';

    // 1. Image Staging Area for Editor
    const imageStaging = document.createElement('div');
    imageStaging.className = 'attachment-preview-area';
    imageStaging.style.display = localImages.length > 0 ? 'flex' : 'none';

    const renderLocalImages = () => {
        imageStaging.innerHTML = '';
        localImages.forEach((img, idx) => {
            const card = document.createElement('div');
            card.className = 'staged-image-card';
            card.style.backgroundImage = `url(${img.data})`;
            
            const delBtn = document.createElement('div');
            delBtn.className = 'remove-btn';
            delBtn.innerHTML = '<span class="codicon codicon-close"></span>';
            delBtn.onclick = () => { localImages.splice(idx, 1); renderLocalImages(); };
            
            card.appendChild(delBtn);
            imageStaging.appendChild(card);
        });
        imageStaging.style.display = localImages.length > 0 ? 'flex' : 'none';
    };

    // 2. Toolbar with Image Addition
    const toolbar = document.createElement('div');
    toolbar.className = 'rich-input-toolbar';
    toolbar.style.borderRadius = '4px 4px 0 0';
    toolbar.innerHTML = `
        <button class="toolbar-tool" data-wrap-type="code"><i class="codicon codicon-code"></i></button>
        <button class="toolbar-tool" id="edit-add-image" title="Add Image"><i class="codicon codicon-file-media"></i></button>
        <div class="toolbar-separator"></div>
        <button class="toolbar-tool" data-wrap-type="bold"><i class="codicon codicon-bold"></i></button>
        <button class="toolbar-tool" data-wrap-type="italic"><i class="codicon codicon-italic"></i></button>
    `;

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
    
    editOverlay.appendChild(toolbar);
    editOverlay.appendChild(imageStaging);
    editOverlay.appendChild(editorContainer);
    editOverlay.appendChild(buttonsDiv);

    renderLocalImages();

    // Note: Since Edit Mode uses CodeMirror (EditorView), we need a specific wrapper
    // for CM integration if we want the selection to work exactly like the textarea.
    // For now, if your startEdit uses a standard textarea fallback, the global wrapText works.
    // Connect toolbar buttons to the CodeMirror editView instance
    toolbar.querySelectorAll('.toolbar-tool').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            const type = (btn as HTMLElement).dataset.wrapType;
            if (type && (window as any).wrapText) {
                // Pass the EditorView instance (editView) directly to wrapText
                (window as any).wrapText(type, editView);
            }
        });
    });
    
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
        const newText = editView.state.doc.toString();
        let finalContent: any = newText;

        if (localImages.length > 0) {
            finalContent = [];
            if (newText.trim()) finalContent.push({ type: 'text', text: newText });
            localImages.forEach(img => {
                finalContent.push({ type: 'image_url', image_url: { url: img.data } });
            });
        }

        messageDiv.dataset.originalContent = JSON.stringify(finalContent);
        vscode.postMessage({
            command: 'updateMessage',
            messageId: messageId,
            newContent: finalContent
        });
        renderMessageContent(messageId, finalContent, true);

        actionsDiv.style.opacity = '';
        actionsDiv.style.pointerEvents = '';
    };

    // Handle Image additions in editor
    toolbar.querySelector('#edit-add-image')?.addEventListener('click', () => {
        const input = document.getElementById('fileInput') as HTMLInputElement;
        const listener = async () => {
            const files = input.files;
            if (files) {
                for (const file of Array.from(files)) {
                    const reader = new FileReader();
                    reader.onload = (e) => {
                        localImages.push({ name: file.name, data: e.target?.result as string });
                        renderLocalImages();
                    };
                    reader.readAsDataURL(file);
                }
            }
            input.removeEventListener('change', listener);
        };
        input.addEventListener('change', listener);
        input.click();
    });

    // Handle Paste in Editor
    editorContainer.addEventListener('paste', (e: ClipboardEvent) => {
        const items = e.clipboardData?.items;
        if (!items) return;
        for (const item of Array.from(items)) {
            if (item.type.indexOf('image') !== -1) {
                const blob = item.getAsFile();
                if (blob) {
                    const reader = new FileReader();
                    reader.onload = (ev) => {
                        localImages.push({ name: `pasted_${Date.now()}.png`, data: ev.target?.result as string });
                        renderLocalImages();
                    };
                    reader.readAsDataURL(blob);
                    e.preventDefault();
                }
            }
        }
    });
}

function extractFilePaths(content: string): ({ type: 'file' | 'diff' | 'insert' | 'replace' | 'delete' | 'search_replace' | 'rename' | 'select' | 'file_delete' | null, path: string, stripFirstLine: boolean, isClosed: boolean, start: number, end: number })[] {
    const infos: any[] = [];
    const lines = content.split('\n');
    let inBlock = false;
    let fenceLength = 0;
    let depth = 0;
    let currentOffset = 0;
    let blockStartOffset = 0;

    for (let i = 0; i < lines.length; i++) {
        const lineWithNewline = lines[i] + (i < lines.length - 1 ? '\n' : '');
        const line = lines[i].trim();
        const match = line.match(/^(\s{0,3})(`{3,})/);

        if (!inBlock) {
            // Check for XML operations outside blocks
            const xmlRename = line.match(/<rename\s+old=["']([^"']+)["']\s+new=["']([^"']+)["']\s*\/>/i);
            const xmlDelete = line.match(/<delete\s+path=["']([^"']+)["']\s*\/>/i);
            const xmlSelect = line.match(/<select\s+path=["']([^"']+)["']\s*\/>/i);
            
            if (xmlRename || xmlDelete || xmlSelect) {
                const type = xmlRename ? 'rename' : (xmlDelete ? 'file_delete' : 'select');
                const path = xmlRename ? `${xmlRename[1]} -> ${xmlRename[2]}` : (xmlDelete ? xmlDelete[1] : xmlSelect![1]);
                infos.push({ type, path, start: currentOffset, end: currentOffset + lineWithNewline.length, isClosed: true });
            }

            if (match) {
                inBlock = true;
                // Peek at the block content to avoid rendering empty "plaintext" placeholders
                const nextLine = lines[i+1] ? lines[i+1].trim() : "";
                const isClosingNext = nextLine.startsWith('```');
                if (isClosingNext) {
                    // Skip empty block detection
                    currentOffset += lineWithNewline.length;
                    continue;
                }

                inBlock = true;
                fenceLength = match[2].length;
                depth = 1;
                blockStartOffset = currentOffset;

                let type: any = null;
                let pathStr = '';
                let stripFirstLine = false;
                const headerText = line.substring(match[0].length).trim();

                if (headerText.includes(':')) {
                    const parts = headerText.split(':');
                    const prefix = parts[0].toLowerCase();
                    pathStr = parts.slice(1).join(':').trim();
                    if (prefix === 'insert') type = 'insert';
                    else if (prefix === 'replace') type = 'replace';
                    else if (prefix === 'diff') type = 'diff';
                    else if (prefix === 'delete_code') type = 'delete';
                    else type = 'file';

                    // Cleanup path: remove trailing metadata like (2 hunks) added by some LLMs
                    pathStr = pathStr.replace(/\s*\(\d+\s+hunks?\)$/i, '').trim();
                } else if (headerText.toLowerCase() === 'diff') {
                    type = 'diff';
                }

                // Logic for finding path in content (for diffs)
                if (type === 'diff' && !pathStr) {
                    for (let k = i + 1; k < Math.min(i + 10, lines.length); k++) {
                        const contentLine = lines[k].trim();
                        const diffPathMatch = contentLine.match(/^(?:---|\+\+\+)\s+(?:[ab]\/)?([^\s\n\r]+)/);
                        if (diffPathMatch && diffPathMatch[1] && diffPathMatch[1] !== '/dev/null') {
                            pathStr = diffPathMatch[1];
                            break;
                        }
                    }
                }

                // Logic for finding path in previous lines
                if (!pathStr) {
                    let j = i - 1;
                    while (j >= 0 && lines[j].trim() === '') j--;
                    if (j >= 0) {
                        const prevLine = lines[j].trim();
                        const m = prevLine.match(/^(?:(?:\*\*|__)?(File|Diff|Insert|Replace|DeleteCode)(?:\*\*|__)?[:\s])\s*(.+)$/i);
                        if (m) {
                            const map: any = { 'File': 'file', 'Diff': 'diff', 'Insert': 'insert', 'Replace': 'replace', 'DeleteCode': 'delete' };
                            type = map[m[1]]; pathStr = m[2].trim();
                        }
                    }
                }

                infos.push({ type, path: pathStr, stripFirstLine, start: blockStartOffset, isClosed: false });
            }
        } else {
            // We are inside a block, check for Aider markers to auto-detect 'replace' type
            if (line.includes('<<<<' + '<<< SEARCH')) {
                infos[infos.length - 1].type = 'replace';
            }

            if (match && match[2].length >= fenceLength) {
                const hasLabel = line.substring(match[0].length).trim().length > 0;
                if (hasLabel) depth++;
                else depth--;

                if (depth === 0) {
                    inBlock = false;
                    infos[infos.length - 1].end = currentOffset + lineWithNewline.length;
                    infos[infos.length - 1].isClosed = true;
                }
            }
        }
        currentOffset += lineWithNewline.length;
    }

    // Fix: Ensure open blocks (streaming) have a valid 'end' so they don't cause duplication
    if (inBlock && infos.length > 0) {
        infos[infos.length - 1].end = currentOffset;
    }

    return infos;
}

function looksLikeDiff(text: string): boolean {
    const lines = text.split('\n');
    let headerLines = 0;
    let chunkMarkers = 0;
    
    for (let i = 0; i < Math.min(lines.length, 20); i++) {
        const line = lines[i].trim();
        // Standard unified diff headers
        if (line.startsWith('--- ') || line.startsWith('+++ ')) {
            headerLines++;
        }
        // Check for hunk markers. We are lenient here to support simplified 
        // formats like "@@" or "@@ -1,1 +1,1 @@"
        if (line.startsWith('@@')) {
            chunkMarkers++;
        }
    }
    
    // It's a diff if we have the file headers OR at least one hunk marker 
    // combined with common diff line prefixes (+/-)
    const hasDiffMarkers = text.includes('\n+') || text.includes('\n-');
    
    return (headerLines >= 2) || (chunkMarkers >= 1 && hasDiffMarkers);
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
        // Ignore code blocks that are already wrapped or are part of a skill preview
        if (pre.parentElement?.classList.contains('code-collapsible') || 
            pre.parentElement?.classList.contains('file-operation-block') ||
            pre.closest('.skill-preview')) {
            return;
        }

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
            isFileBlock = false; isDiff = false; isInsert = false; isReplace = false; isDeleteCode = false; isFileDelete = false;

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
        
        // --- SPECIALIZED UI FOR RENAME/DELETE ---
        if (info && info.type === 'rename') {
            const parts = info.path.split(' -> ');
            const oldPath = parts[0];
            const newPath = parts[1] || '';

            const opBlock = document.createElement('div');
            opBlock.className = 'file-operation-block';
            opBlock.innerHTML = `
                <div class="file-operation-header">
                    <span class="codicon codicon-edit"></span> 
                    <span>Proposed File Rename</span>
                </div>
                <div class="file-operation-details">
                    <span class="path-old" title="${oldPath}">${oldPath}</span>
                    <span class="codicon codicon-arrow-right file-operation-arrow"></span>
                    <span class="path-new" title="${newPath}">${newPath}</span>
                </div>
                <div class="file-operation-actions">
                     <button class="code-action-btn apply-btn" id="apply-rename-${blockId}">Apply Rename</button>
                </div>
            `;
            
            pre.replaceWith(opBlock);
            const applyBtn = opBlock.querySelector(`#apply-rename-${blockId}`) as HTMLButtonElement;
            applyBtn.onclick = () => {
                vscode.postMessage({ command: 'renameFile', originalPath: oldPath, newPath: newPath });
                applyBtn.disabled = true;
                applyBtn.innerHTML = '<span class="codicon codicon-check"></span> Applied';
            };
            return;
        }

        if (info && (info.type === 'file_delete' || language === 'delete')) {
            const pathToDelete = info.path || codeText.trim();
            const opBlock = document.createElement('div');
            opBlock.className = 'file-operation-block';
            opBlock.innerHTML = `
                <div class="file-operation-header">
                    <span class="codicon codicon-trash" style="color:var(--vscode-errorForeground)"></span> 
                    <span>Proposed File Deletion</span>
                </div>
                <div class="file-operation-details">
                    <span class="path-target" title="${pathToDelete}">${pathToDelete}</span>
                </div>
                <div class="file-operation-actions">
                     <button class="code-action-btn delete-btn" id="apply-delete-${blockId}">Delete File</button>
                </div>
            `;
            
            pre.replaceWith(opBlock);
            const delBtn = opBlock.querySelector(`#apply-delete-${blockId}`) as HTMLButtonElement;
            delBtn.onclick = () => {
                vscode.postMessage({ command: 'deleteFile', filePaths: pathToDelete });
                delBtn.disabled = true;
                delBtn.innerHTML = '<span class="codicon codicon-check"></span> Deleted';
            };
            return;
        }

        if (!isDiff && (language === 'diff' || looksLikeDiff(codeText))) {
            isDiff = true;
            // Improved regex to skip /dev/null and handle a/ b/ prefixes
            const headerMatch = codeText.match(/^(?:---|\+\+\+)\s+(?:[ab]\/)?([^\s\n\r]+)/m);
            if (headerMatch && headerMatch[1] && headerMatch[1] !== '/dev/null') {
                diffFilePath = headerMatch[1].trim();
            }
        }

        const isDiagram = language === 'mermaid' || language === 'svg';
        const details = document.createElement('details');
        details.className = 'code-collapsible';
        details.open = !isDiagram; // Diagrams default to collapsed source view

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
            // Ensure we use the message passing interface
            window.vscode.postMessage({ 
                command: 'copyToClipboard', 
                text: codeText 
            });
            
            // Visual feedback
            const iconEl = copyBtn.querySelector('.codicon');
            if(iconEl) {
                iconEl.classList.remove('codicon-copy');
                iconEl.classList.add('codicon-check');
                setTimeout(() => {
                    if (iconEl) {
                        iconEl.classList.remove('codicon-check');
                        iconEl.classList.add('codicon-copy');
                    }
                }, 2000);
            }
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

        if (isDiagram) {
            // Add a "Source" button to the header to make it clear how to view code
            const showCodeBtn = createButton('Source', 'codicon-code', () => {
                details.open = !details.open;
            }, 'code-action-btn', 'View diagram source');
            actions.appendChild(showCodeBtn);
        }

        if (isReplace && filePath) {
            // Aider style Search/Replace block
            const aiderRegex = /<<<<<<< SEARCH([\s\S]*?)=======([\s\S]*?)>>>>>>> REPLACE/;
            const match = codeText.match(aiderRegex);
            if (match) {
                const searchPart = match[1].trim();
                const replacePart = match[2].trim();

                const copySearchBtn = createButton('Copy Search', 'codicon-copy', () => {
                    vscode.postMessage({ command: 'copyToClipboard', text: searchPart });
                    copySearchBtn.innerHTML = '<span class="codicon codicon-check"></span>';
                    setTimeout(() => { copySearchBtn.innerHTML = '<span class="codicon codicon-copy"></span>'; }, 2000);
                }, 'code-action-btn', 'Copy text to search for');
                copySearchBtn.disabled = isDisabled;
                actions.appendChild(copySearchBtn);

                const copyReplaceBtn = createButton('Copy Replace', 'codicon-copy', () => {
                    vscode.postMessage({ command: 'copyToClipboard', text: replacePart });
                    copyReplaceBtn.innerHTML = '<span class="codicon codicon-check"></span>';
                    setTimeout(() => { copyReplaceBtn.innerHTML = '<span class="codicon codicon-copy"></span>'; }, 2000);
                }, 'code-action-btn', 'Copy text to replace with');
                copyReplaceBtn.disabled = isDisabled;
                actions.appendChild(copyReplaceBtn);
            }
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
            // If it's a diagram, create the render zone ABOVE the collapsible block
            if (isDiagram) {
                const renderZone = document.createElement('div');
                renderZone.className = 'diagram-render-zone';
                parent.insertBefore(renderZone, pre); 
                renderDiagram(code, language, renderZone);
            }

            // Add gutter to standard Prism blocks too
            if (!pre.querySelector('.code-line-gutter')) {
                const gutter = document.createElement('div');
                gutter.className = 'code-line-gutter';
                const lineCount = code.textContent?.split('\n').length || 1;
                gutter.innerHTML = Array.from({ length: lineCount }, (_, i) => i + 1).join('<br>');
                pre.insertBefore(gutter, pre.firstChild);
            }

            details.appendChild(summary);
            parent.insertBefore(details, pre); 
            details.appendChild(pre); 
        }

        // Apply highlighting (always do it now so source view looks good)
        Prism.highlightElement(code);
    });

    if (actionableBlockCount > 0) {
        const contentDiv = container.querySelector('.message-content');
        if (contentDiv && !contentDiv.querySelector('.apply-all-wrapper')) {
            const wrapper = document.createElement('div');
            wrapper.className = 'apply-all-wrapper';
            wrapper.style.marginTop = '16px';

            const btn = document.createElement('button');
            btn.className = 'apply-all-btn';
            btn.innerHTML = '<span class="codicon codicon-check-all"></span> Apply All Changes';
            btn.disabled = !isFinal;
            
            const resultsList = document.createElement('div');
            resultsList.className = 'apply-results-list';
            resultsList.style.cssText = 'display:none; margin-top:8px; font-size:11px; padding:8px; background:var(--vscode-editor-inactiveSelectionBackground); border-radius:4px; border:1px solid var(--vscode-widget-border);';

            btn.onclick = () => {
                const changes: any[] = [];
                // We re-query pres inside the current message container to ensure we get the right ones
                const pres = container.querySelectorAll('pre');
                pres.forEach((pre, index) => {
                    const code = pre.querySelector('code');
                    if (!code) return;
                    // match the code block to its info from the earlier extraction
                    const info = codeBlockInfos[index];
                    if (info && info.path && ['file', 'diff', 'insert', 'replace', 'delete', 'file_delete'].includes(info.type || '')) {
                        changes.push({ 
                            type: info.type === 'file' ? 'file' : (info.type || 'replace'), 
                            path: info.path, 
                            content: code.innerText 
                        });
                    }
                });

                if (changes.length > 0) {
                    btn.disabled = true;
                    btn.innerHTML = '<span class="codicon codicon-sync spin"></span> Processing Sequentially...';
                    
                    // Show the results container
                    resultsList.style.display = 'block';
                    resultsList.innerHTML = '<div style="opacity:0.7; margin-bottom:4px;">Executing operations...</div>';

                    // 1. Prepare the validation list with "Pending" states immediately
                    resultsList.innerHTML = changes.map((c) => {
                        const isFull = c.type === 'file';
                        const typeLabel = isFull ? 'FULL' : 'PATCH';
                        const typeColor = isFull ? 'var(--vscode-charts-blue)' : 'var(--vscode-charts-orange)';
                        const hunkAttr = c.hunkIndex !== undefined ? `data-hunk-index="${c.hunkIndex}"` : '';
                        
                        return `
                        <div class="apply-row" data-path="${c.path}" data-block-index="${c.blockIndex}" ${hunkAttr} data-target-id="block-${messageId}-${c.blockIndex}" style="display:flex; align-items:center; gap:8px; margin-bottom:6px; padding:4px; border-radius:4px; cursor:pointer;">
                            <span class="status-icon"><span class="codicon codicon-clock"></span></span>
                            <span style="font-weight:800; font-size:9px; color:${typeColor}; min-width:45px; border:1px solid ${typeColor}; border-radius:3px; text-align:center; padding:0 2px;">${typeLabel}</span>
                            <span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:11px;">${c.label}</span>
                            <div class="row-actions" style="display:none;"></div>
                        </div>`;
                    }).join('');

                    // 2. Start the actual sequential process in the extension
                    vscode.postMessage({ command: 'applyAllChanges', changes, messageId });
                }
            };

            wrapper.appendChild(btn);
            wrapper.appendChild(resultsList);
            contentDiv.appendChild(wrapper);
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

function renderDebugReport(dataStr: string): string {
    try {
        const data = JSON.parse(dataStr.replace(/&apos;/g, "'"));
        
        // Format variables if present
        let varHtml = '<div style="opacity:0.6; font-style:italic;">No variables captured.</div>';
        if (data.variables) {
            const lines = data.variables.split('\n').filter((l: string) => l.includes('='));
            if (lines.length > 0) {
                varHtml = '<table class="debug-var-table">';
                lines.forEach((l: string) => {
                    const [name, rest] = l.split('=');
                    const valueMatch = rest.match(/^(.*?)\s*\((.*?)\)$/);
                    const val = valueMatch ? valueMatch[1] : rest;
                    const type = valueMatch ? valueMatch[2] : 'unknown';
                    varHtml += `<tr>
                        <td class="var-name">${sanitizer.sanitize(name.trim())}</td>
                        <td class="var-type">${sanitizer.sanitize(type)}</td>
                        <td class="var-val">${sanitizer.sanitize(val.trim())}</td>
                    </tr>`;
                });
                varHtml += '</table>';
            }
        }

        return `
        <div class="debug-report-card">
            <div class="debug-header">
                <span class="codicon codicon-error"></span>
                <span>Runtime Exception</span>
            </div>
            <div class="debug-section">
                <span class="debug-label">Error Message</span>
                <div style="font-weight:600; color:var(--vscode-errorForeground);">${sanitizer.sanitize(data.message)}</div>
            </div>
            <div class="debug-section">
                <span class="debug-label">Crash Site: ${sanitizer.sanitize(data.file)}</span>
                <div class="debug-code-box">
                    <span class="debug-line-num">${data.line}</span>
                    <code>${sanitizer.sanitize(data.code)}</code>
                </div>
            </div>
            <div class="debug-section">
                <span class="debug-label">Live Variables (State)</span>
                ${varHtml}
            </div>
            <details class="debug-section" style="border:none;">
                <summary class="debug-label" style="cursor:pointer; margin:0;">View Full Stack Trace</summary>
                <pre style="font-size:10px; margin-top:10px; opacity:0.8;">${sanitizer.sanitize(data.stack)}</pre>
            </details>
        </div>`;
    } catch (e) {
        return `<div class="error">Failed to render debug report.</div>`;
    }
}

function renderMissionControl(dataStr: string): string {
    try {
        const cleanStr = dataStr.replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
        const data = JSON.parse(cleanStr);
        const renderMd = (text: string) => sanitizer.sanitize(marked.parse(text) as string, SANITIZE_CONFIG);

        const agents = [
            { id: 'librarian', label: 'Librarian', icon: 'library', content: data.librarian },
            { id: 'inspector', label: 'Inspector', icon: 'search', content: data.inspector },
            { id: 'debugger', label: 'Debugger', icon: 'debug', content: data.debugger },
            { id: 'web', label: 'Web Research', icon: 'globe', content: data.web },
            { id: 'skills', label: 'Skills', icon: 'lightbulb', content: data.skills }
        ];

        const activeColumns = agents
            .filter(a => a.content && !a.content.includes('Inactive'))
            .map(a => `
                <div class="agent-col">
                    <div class="agent-col-header"><span class="codicon codicon-${a.icon}"></span> ${a.label}</div>
                    <div class="agent-col-body markdown-body">${renderMd(a.content)}</div>
                </div>
            `).join('');

        return `
        <div class="mission-control-panel">
            <div class="technical-briefing-card" style="margin: 0 0 15px 0; border-left-color: var(--vscode-charts-purple);">
                <div class="briefing-header"><span class="codicon codicon-organization"></span> Team Briefing (Live Sync)</div>
                <div class="briefing-content">${renderMd(data.briefing)}</div>
            </div>
            <div class="mission-control-columns">
                ${activeColumns}
            </div>
        </div>`;
    } catch(e) {
        return `<div class="error">Failed to render Mission Control dashboard.</div>`;
    }
}

function renderAddFilesBlock(params: any, messageId: string): string {
    const files: string[] = Array.isArray(params.paths) ? params.paths : [];

    if (files.length === 0) return "";

    const currentFiles = state.lastContextData?.files || [];
    let allIncluded = true;

    const fileItems = files.map(f => {
        const isIncluded = currentFiles.includes(f);
        if (!isIncluded) allIncluded = false;

        const itemStyle = isIncluded 
            ? 'border-color: var(--vscode-charts-green); background: rgba(15, 157, 88, 0.1);' 
            : '';
        const iconClass = isIncluded ? 'codicon-check' : 'codicon-file-add';
        const iconStyle = isIncluded ? 'color: var(--vscode-charts-green);' : '';

        return `
        <div class="expansion-file-item" style="display:flex; justify-content:space-between; align-items:center; ${itemStyle}">
            <div style="display:flex; align-items:center; gap:8px;">
                <span class="codicon ${iconClass}" style="${iconStyle}"></span>
                <span>${sanitizer.sanitize(f)}</span>
            </div>
        </div>`;
    }).join('');

    const blockId = `add-files-${messageId}`;
    const fileListJson = JSON.stringify(files).replace(/"/g, '&quot;');
    
    const btnText = allIncluded ? 'Added to Context' : 'Add all to Context';
    const btnClass = allIncluded ? 'applied' : 'apply-btn';
    const btnDisabled = allIncluded ? 'disabled' : '';
    const btnIcon = allIncluded ? 'codicon-check' : 'codicon-add';

    // We use a data-files attribute to allow the updateContext function to re-verify this block later
    return `
    <div class="context-expansion-block expansion-request-block" id="${blockId}" data-files="${fileListJson}">
        <div class="expansion-header">
            <span class="codicon codicon-library"></span>
            <span>Context Expansion Requested</span>
        </div>
        <div class="expansion-body">
            <p style="margin-bottom:12px; font-size: 11px; opacity: 0.8;">The AI identified that it needs the following files to complete the task without making assumptions:</p>
            <div class="expansion-file-list" id="list-${blockId}" style="margin-bottom:12px;">
                ${fileItems}
            </div>
            <button class="code-action-btn ${btnClass} add-files-to-context-btn" 
                id="btn-${blockId}" 
                ${btnDisabled}
                data-files="${fileListJson}" 
                data-block-id="${blockId}">
                <span class="codicon ${btnIcon}"></span> ${btnText}
            </button>
        </div>
    </div>`;
}

function renderFileOpBlock(type: 'delete' | 'move' | 'prune', params: any, messageId: string): string {
    const blockId = `file-op-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
    let title = "";
    let icon = "";
    let detailsHtml = "";
    let buttonText = "";
    let command = "";
    let cmdData = {};

    switch (type) {
        case 'prune':
            const prunePaths = Array.isArray(params.paths) ? params.paths : [];
            title = "Propose Context Pruning";
            icon = "codicon-clear-all";
            buttonText = "Remove from Context";
            detailsHtml = prunePaths.map((p: string) => `<div class="expansion-file-item"><span class="codicon codicon-history"></span> <span>${sanitizer.sanitize(p)}</span></div>`).join('');
            command = "syncFilesContext";
            cmdData = { remove: prunePaths };
            break;
        case 'delete':
            const delPaths: string[] = Array.isArray(params.paths) ? params.paths : (params.path ? [params.path] : []);
            title = "Propose Deletion (Files/Folders)";
            icon = "codicon-trash";
            
            // Generate individual rows with buttons
            detailsHtml = delPaths.map((p: string, idx: number) => {
                const safePath = sanitizer.sanitize(p);
                const rowId = `${blockId}-item-${idx}`;
                return `
                <div class="expansion-file-item" id="${rowId}" style="display:flex; justify-content:space-between; align-items:center; gap:10px; padding: 4px 8px;">
                    <div style="display:flex; align-items:center; gap:8px; flex:1; min-width:0;">
                        <span class="codicon codicon-file"></span>
                        <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${safePath}</span>
                    </div>
                    <button class="code-action-btn delete-btn delete-single-btn" style="height:20px; font-size:9px; padding:0 6px; flex-shrink:0;"
                        data-path="${safePath}" data-row-id="${rowId}">
                        Delete
                    </button>
                </div>`;
            }).join('');

            // Special layout: The "Delete All" button goes in the footer
            return `
            <div class="file-operation-block" id="${blockId}">
                <div class="file-operation-header">
                    <span class="codicon ${icon}"></span> 
                    <span>${title}</span>
                </div>
                <div class="expansion-body" style="padding: 8px 0;">
                    <div class="expansion-file-list" style="margin-bottom:8px;">
                        ${detailsHtml}
                    </div>
                    <div class="file-operation-actions" style="padding: 0 12px 8px 12px;">
                        <button class="code-action-btn apply-btn delete-all-btn" style="width:100%; justify-content:center; background-color:var(--vscode-errorForeground) !important; color:white !important;"
                            data-paths="${delPaths.join(',')}" data-block-id="${blockId}">
                            Delete All Selected (${delPaths.length})
                        </button>
                    </div>
                </div>
            </div>`;
        case 'move':
            title = "Propose File Move/Rename";
            icon = "codicon-move";
            buttonText = "Apply Move";
            detailsHtml = `
                <div class="file-operation-details">
                    <span class="path-old">${sanitizer.sanitize(params.src || params.source)}</span>
                    <span class="codicon codicon-arrow-right"></span>
                    <span class="path-new">${sanitizer.sanitize(params.dest || params.destination)}</span>
                </div>`;
            command = "renameFile";
            cmdData = { originalPath: params.src || params.source, newPath: params.dest || params.destination };
            break;
    }

    const safeCmdData = JSON.stringify(cmdData).replace(/"/g, '&quot;');
    return `
    <div class="file-operation-block" id="${blockId}">
        <div class="file-operation-header">
            <span class="codicon ${icon}"></span> 
            <span>${title}</span>
        </div>
        <div class="expansion-body">
            <div class="expansion-file-list" style="margin-bottom:12px;">
                ${detailsHtml}
            </div>
            <div class="file-operation-actions">
                <button class="code-action-btn apply-btn file-op-action-btn" 
                    data-command="${command}"
                    data-payload="${safeCmdData}">
                    ${buttonText}
                </button>
            </div>
        </div>
    </div>`;
}

function renderFormBlock(xmlContent: string, messageId: string): string {
    const titleMatch = xmlContent.match(/title=["'](.*?)["']/);
    const idMatch = xmlContent.match(/id=["'](.*?)["']/);
    const title = titleMatch ? titleMatch[1] : "Decision Required";
    const formId = idMatch ? idMatch[1] : "generic-form";

    // Parse nested input elements
    const inputRegex = /<input\s+([^>]*?)\s*\/>/gi;
    let inputsHtml = "";
    let match;
    const radioGroups: Record<string, string[]> = {};

    while ((match = inputRegex.exec(xmlContent)) !== null) {
        const attrStr = match[1];
        const attrs: any = {};
        const attrRegex = /(\w+)=["']([^"']*)["']/g;
        let m;
        while ((m = attrRegex.exec(attrStr)) !== null) attrs[m[1]] = m[2];

        if (attrs.type === 'radio') {
            if (!radioGroups[attrs.name]) radioGroups[attrs.name] = [];
            radioGroups[attrs.name].push(`
                <label class="radio-option">
                    <input type="radio" name="${attrs.name}" value="${attrs.value}" ${attrs.checked === 'true' ? 'checked' : ''}>
                    <span>${sanitizer.sanitize(attrs.label)}</span>
                </label>
            `);
        } else {
            inputsHtml += `
                <div class="form-field">
                    <label>${sanitizer.sanitize(attrs.label)}</label>
                    <input type="${attrs.type}" name="${attrs.name}" value="${attrs.value || ''}" 
                           placeholder="${attrs.placeholder || ''}" 
                           style="width:100%; padding:6px; border:1px solid var(--vscode-input-border); background:var(--vscode-input-background); color:var(--vscode-input-foreground); border-radius:4px;" />
                </div>
            `;
        }
    }

    // Add radio groups to body
    for (const name in radioGroups) {
        inputsHtml += `<div class="radio-group">${radioGroups[name].join('')}</div>`;
    }

    const submitMatch = xmlContent.match(/<submit\s+label=["'](.*?)["']\s*\/>/i);
    const submitLabel = submitMatch ? submitMatch[1] : "Validate Choice";

    return `
    <div class="lollms-form-block" data-form-id="${formId}">
        <div class="lollms-form-header">
            <span class="codicon codicon-question"></span>
            <span>${sanitizer.sanitize(title)}</span>
        </div>
        <div class="lollms-form-body">
            ${inputsHtml}
        </div>
        <div class="lollms-form-footer">
            <button class="code-action-btn apply-btn lollms-form-submit-btn" 
                    data-form-id="${formId}" 
                    data-message-id="${messageId}">
                <span class="codicon codicon-check"></span> ${sanitizer.sanitize(submitLabel)}
            </button>
        </div>
    </div>`;
}

function renderProcessingBlock(rawContent: string, isClosed: boolean): string {
    const lines = rawContent.trim().split('\n').filter(l => l.trim().length > 0);
    const displayTitle = lines.length > 0 ? lines[lines.length - 1].replace(/^\*\s*/, '') : "Processing...";
    
    const icon = isClosed 
        ? '<span class="codicon codicon-check" style="color:var(--vscode-charts-green)"></span>' 
        : '<div class="spinner"></div>';

    return `
    <div class="processing-block">
        <details ${!isClosed ? 'open' : ''}>
            <summary class="processing-header">
                <span class="folder-handle codicon codicon-chevron-right"></span>
                ${icon}
                <span class="processing-title">${sanitizer.sanitize(displayTitle)}</span>
            </summary>
            <div class="processing-body">
                ${sanitizer.sanitize(rawContent.trim())}
            </div>
        </details>
    </div>`;
}

function renderImageGenBlock(prompt: string, path: string, width?: string, height?: string): string {
    const safePrompt = encodeURIComponent(prompt);
    const safePath = encodeURIComponent(path);
    const buttonId = `gen-btn-${Date.now()}${Math.random().toString(36).substr(2, 5)}`;
    
    // FIX: Replaced onclick="..." with data attributes and a class for event delegation
    return `
    <div class="generation-block">
        <div class="generation-header">
            <span class="summary-lang-label"><span class="codicon codicon-device-camera"></span> Propose Image Generation ${path ? ': ' + path : ''}</span>
            <div class="code-actions">
                <button id="${buttonId}" class="code-action-btn apply-btn generate-image-btn" 
                    data-prompt="${safePrompt}" 
                    data-path="${safePath}" 
                    data-width="${width || ''}" 
                    data-height="${height || ''}"
                    title="Generate Image with AI">
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

    // PRESERVE STATE of Apply All List to prevent blinking/resetting during repair
    const existingResultsList = contentDiv.querySelector('.apply-results-list');
    const existingApplyBtn = contentDiv.querySelector('.apply-all-btn');
    let savedResultsHtml = '';
    let savedBtnClasses = '';
    let savedBtnText = '';
    let savedBtnDisabled = false;
    let isApplyListVisible = false;

    if (existingResultsList) {
        savedResultsHtml = existingResultsList.innerHTML;
        isApplyListVisible = (existingResultsList as HTMLElement).style.display !== 'none';
    }
    if (existingApplyBtn) {
        savedBtnClasses = existingApplyBtn.className;
        savedBtnText = existingApplyBtn.innerHTML;
        savedBtnDisabled = (existingApplyBtn as HTMLButtonElement).disabled;
    }

    const shouldScroll = isScrolledToBottom(dom.messagesDiv);

    try {
        const isUser = messageDiv.classList.contains('user-message');
        const isEmpty = !rawContent || 
                        (typeof rawContent === 'string' && rawContent.trim() === '') || 
                        (Array.isArray(rawContent) && rawContent.length === 0);

        if (isUser && isEmpty) {
            contentDiv.innerHTML = `<div style="opacity: 0.7; font-style: italic; margin-bottom: 8px;">Empty message</div>
            <button class="code-action-btn apply-btn infer-prompt-btn" data-message-id="${messageId}"><span class="codicon codicon-wand"></span> Infer Prompt</button>`;
            if (shouldScroll && dom.messagesDiv) dom.messagesDiv.scrollTop = dom.messagesDiv.scrollHeight;
            return;
        }

        if (Array.isArray(rawContent)) {
            // Handle Multipart
            let html = '';
            rawContent.forEach(p => {
                if (p.type === 'text'){
                    html += `<div>${sanitizer.sanitize(marked.parse(p.text) as string)}</div>`;
                } else if (p.type === 'image_url') {
                    const isMuted = state.capabilities?.enableImages === false;
                    if (isMuted) {
                        html += `
                        <div class="muted-image-container">
                            <img src="${p.image_url.url}" style="max-width:100%; border-radius:4px; opacity: 0.5; filter: grayscale(1);">
                            <div class="muted-image-warning">
                                <span class="codicon codicon-warning"></span>
                                Vision Disabled: The LLM will NOT see this image.
                            </div>
                        </div>`;
                    } else {
                        html += `<img src="${p.image_url.url}" style="max-width:100%; border-radius:4px; margin-top:8px;">`;
                    }
                }
            });
            contentDiv.innerHTML = html;
        } else if (typeof rawContent === 'string') {
            const { thoughts, processedContent: contentWithoutThoughts } = processThinkTags(rawContent);

            // --- SKILL TAG PARSING ---
            const skills: { html: string, start: number, end: number }[] = [];
            let processedContent = contentWithoutThoughts;

            const skillRegex = /<skill\s+([^>]*?)>([\s\S]*?)<\/skill>/gi;
            let skillMatch;
            while ((skillMatch = skillRegex.exec(contentWithoutThoughts)) !== null) {
                const attrStr = skillMatch[1];
                const innerContent = skillMatch[2];
                const attrs: any = {};
                const attrRegex = /(\w+)=["']([^"']*)["']/g;
                let m;
                while ((m = attrRegex.exec(attrStr)) !== null) attrs[m[1]] = m[2];

                const skillHtml = renderSkillBlock(innerContent, attrs, messageId);
                skills.push({ html: skillHtml, start: skillMatch.index, end: skillMatch.index + skillMatch[0].length });
            }

            // --- IMAGE GENERATION TAG PARSING ---
            const images: { html: string, start: number, end: number }[] = [];
            const imgRegex = /<generate_image\s+([^>]*?)>([\s\S]*?)<\/generate_image>/gi;
            let imgMatch;
            while ((imgMatch = imgRegex.exec(contentWithoutThoughts)) !== null) {
                const attrStr = imgMatch[1];
                const prompt = imgMatch[2].trim();
                const attrs: any = {};
                const attrRegex = /(\w+)=["']([^"']*)["']/g;
                let m;
                while ((m = attrRegex.exec(attrStr)) !== null) attrs[m[1]] = m[2];

                const imgHtml = renderImageGenBlock(prompt, attrs.path || "", attrs.width, attrs.height);
                images.push({ html: imgHtml, start: imgMatch.index, end: imgMatch.index + imgMatch[0].length });
            }

            // --- DEBUG REPORT TAG PARSING ---
            const debugReports: { html: string, start: number, end: number }[] = [];
            const debugRegex = /<debug_report\s+data=['"]([\s\S]*?)['"]\s*\/>/gi;
            let dMatch;
            while ((dMatch = debugRegex.exec(contentWithoutThoughts)) !== null) {
                const dHtml = renderDebugReport(dMatch[1]);
                debugReports.push({ html: dHtml, start: dMatch.index, end: dMatch.index + dMatch[0].length });
            }

            // --- PROJECT MEMORY TAG PARSING ---
            const memTags: { html: string, start: number, end: number }[] = [];
            const pMemRegex = /<project_memory\s+([^>]*?)>([\s\S]*?)<\/project_memory>/gi;
            let pMemMatch;
            while ((pMemMatch = pMemRegex.exec(contentWithoutThoughts)) !== null) {
                const attrStr = pMemMatch[1];
                const memContent = pMemMatch[2].trim();
                const attrs: any = {};
                const attrRegex = /(\w+)=["']([^"']*)["']/g;
                let m;
                while ((m = attrRegex.exec(attrStr)) !== null) attrs[m[1]] = m[2];
                
                const html = renderMemoryTag(attrs.action || 'add', attrs.id, attrs.title || attrs.id, memContent);
                memTags.push({ html, start: pMemMatch.index, end: pMemMatch.index + pMemMatch[0].length });
            }

            // --- FILE OPERATIONS & CONTEXT TAG PARSING ---
            // --- PROCESSING TAG PARSING ---
            const processingBlocks: { html: string, start: number, end: number }[] = [];
            // --- FORM TAG PARSING ---
            const forms: { html: string, start: number, end: number }[] = [];
            const formRegex = /<lollms_form\b[^>]*>([\s\S]*?)<\/lollms_form>/gi;
            let formMatch;
            while ((formMatch = formRegex.exec(contentWithoutThoughts)) !== null) {
                const html = renderFormBlock(formMatch[0], messageId);
                forms.push({ html, start: formMatch.index, end: formMatch.index + formMatch[0].length });
            }

            const procRegex = /<processing\b[^>]*>([\s\S]*?)(?:<\/processing>|$)/gi;
            let procMatch;
            while ((procMatch = procRegex.exec(contentWithoutThoughts)) !== null) {
                const innerContent = procMatch[1];
                const isClosed = procMatch[0].toLowerCase().includes('</processing>');
                const html = renderProcessingBlock(innerContent, isClosed);
                processingBlocks.push({ html, start: procMatch.index, end: procMatch.index + procMatch[0].length });
            }

            const fileOps: { html: string, start: number, end: number }[] = [];
            const opRegex = /<(move_file|delete_file|add_files_to_context|remove_files_from_context)\s+([^>]*?)\s*\/>/gi;
            let opMatch;
            while ((opMatch = opRegex.exec(contentWithoutThoughts)) !== null) {
                const tagName = opMatch[1].toLowerCase();
                const attrStr = opMatch[2];
                const attrs: any = {};
                // Enhanced attribute regex to handle single/double quotes and escaped sequences
                const attrRegex = /(\w+)=(['"])([\s\S]*?)\2/g;
                let m;
                while ((m = attrRegex.exec(attrStr)) !== null) {
                    attrs[m[1]] = unescapeXml(m[3]);
                }
                
                // Handle JSON arrays in paths (often wrapped in different quote types)
                if (attrs.paths && (attrs.paths.trim().startsWith('[') || attrs.paths.trim().startsWith('{'))) {
                    try { 
                        // First replace XML entities, then parse
                        const cleanJson = attrs.paths.replace(/&quot;/g, '"').replace(/&apos;/g, "'");
                        attrs.paths = JSON.parse(cleanJson); 
                    } catch(e){
                        console.error("Failed to parse paths attribute as JSON", e);
                    }
                }

                let opType: 'delete' | 'move' | 'prune' | 'add_ctx' = 'delete';
                if (tagName === 'move_file') opType = 'move';
                if (tagName === 'remove_files_from_context') opType = 'prune';
                if (tagName === 'add_files_to_context') opType = 'add_ctx';

                const opHtml = opType === 'add_ctx' ? renderAddFilesBlock(attrs, messageId) : renderFileOpBlock(opType, attrs, messageId);
                fileOps.push({ html: opHtml, start: opMatch.index, end: opMatch.index + opMatch[0].length });
            }

            messageDiv.querySelectorAll('.plan-scratchpad, .skill-creation-block, .generation-block, .context-expansion-block, .file-operation-block').forEach(el => el.remove());

            // Render Thoughts
            thoughts.forEach(thought => {
                const thinkDiv = document.createElement('div');
                thinkDiv.className = 'plan-scratchpad';
                // Force open during generation (not final) for transparency
                const isOpen = isFinal ? '' : 'open';
                thinkDiv.innerHTML = `<details ${isOpen}><summary class="scratchpad-header">AI Reasoning</summary><div class="scratchpad-content">${sanitizer.sanitize(marked.parse(thought.content) as string)}</div></details>`;
                if (contentDiv.parentNode) contentDiv.parentNode.insertBefore(thinkDiv, contentDiv);
            });

            // SURGICAL RENDERING LOGIC
            // 1. Identify all potential UI elements
            const codeBlocks = extractFilePaths(processedContent);
            // --- ALL CANDIDATES SORTING ---
            const allCandidates =[
                ...codeBlocks.map(b => ({ ...b, elementType: 'code' as const })),
                ...skills.map(s => ({ start: s.start, end: s.end, html: s.html, elementType: 'skill' as const })),
                ...images.map(i => ({ start: i.start, end: i.end, html: i.html, elementType: 'image' as const })),
                ...fileOps.map(o => ({ start: o.start, end: o.end, html: o.html, elementType: 'fileOp' as const })),
                ...memTags.map(m => ({ start: m.start, end: m.end, html: m.html, elementType: 'projectMemory' as const })),
                ...forms.map(f => ({ start: f.start, end: f.end, html: f.html, elementType: 'form' as const })),
                ...debugReports.map(d => ({ start: d.start, end: d.end, html: d.html, elementType: 'debugReport' as const })),
                ...processingBlocks.map(p => ({ start: p.start, end: p.end, html: p.html, elementType: 'processing' as const }))
            ].sort((a, b) => a.start - b.start);

            // 2. Filter to keep only TOP-LEVEL elements
            const elements = allCandidates.filter((el, idx) => {
                return !allCandidates.some((other, oIdx) => {
                    if (idx === oIdx) return false;
                    
                    // If 'el' is a standard code block and 'other' is a custom UI tag inside it, 
                    // we want to discard the code block and keep the UI tag.
                    if (el.elementType === 'code' && other.elementType !== 'code') {
                        if (other.start >= el.start && other.end <= el.end) return false;
                    }

                    // Standard containment check
                    return el.start >= other.start && el.end <= other.end;
                });
            });

            let lastIndex = 0;
            const fragment = document.createDocumentFragment();

            // 3. Partitioned Rendering
            elements.forEach((el, idx) => {
                const textBefore = processedContent.substring(lastIndex, el.start);
                if (textBefore.length > 0) { 
                    const textDiv = document.createElement('div');
                    textDiv.innerHTML = sanitizer.sanitize(marked.parse(textBefore) as string, SANITIZE_CONFIG);
                    fragment.appendChild(textDiv);
                }

                // B. Render the UI element (Code Block or Skill or Image or AddFiles or FileOp or DebugReport or ProjectMemory or Processing or Form)
                const uiTypes = ['skill', 'image', 'addFiles', 'fileOp', 'projectMemory', 'debugReport', 'processing', 'form'];
                if (uiTypes.includes(el.elementType)) {
                    const uiDiv = document.createElement('div');
                    uiDiv.innerHTML = (el as any).html;
                    fragment.appendChild(uiDiv);
                    lastIndex = el.end;
                    return;
                }

                // 2b. Render code block
                const block = el as any;
                const blockIdx = idx; // Use current iteration index as block identifier
                // Trim the block content to remove trailing newlines that cause slice errors
                const blockContent = processedContent.substring(block.start, block.end).trim();
                let lines = blockContent.split('\n');

                const firstLine = lines[0];
                const langMatch = firstLine.match(/```(\w+)/);
                const language = langMatch ? langMatch[1] : 'plaintext';
                const codeOnly = lines.length >= 2 ? lines.slice(1, -1).join('\n') : "";

                // Permit zero or one newline after SEARCH and before REPLACE markers
                const aiderRegex = /^<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n=======[\r\n]*([\s\S]*?)[\r\n]*>>>>>>> REPLACE/gm;
                const aiderMatches = [...codeOnly.matchAll(aiderRegex)];
                const isAider = aiderMatches.length > 0;
                
                // MALFORMED DETECTION: Check if block contains bits of Aider but isn't valid
                const hasAiderStart = codeOnly.includes('<<<<<<< SEARCH');
                const hasAiderMid = codeOnly.includes('=======');
                const hasAiderEnd = codeOnly.includes('>>>>>>> REPLACE');
                const isMalformed = (hasAiderStart || hasAiderMid || hasAiderEnd) && !isAider;

                const details = document.createElement('details');
                details.className = 'code-collapsible';
                if (isMalformed) details.classList.add('malformed');
                details.open = true;

                const summary = document.createElement('summary');
                summary.className = 'code-summary';

                const langLabel = document.createElement('span');
                langLabel.className = 'summary-lang-label';
                langLabel.textContent = `${language}${block.path ? ' : ' + block.path : ''}`;
                
                if (isMalformed) {
                    const badge = document.createElement('span');
                    badge.className = 'malformed-badge';
                    badge.textContent = 'Malformed Block';
                    langLabel.appendChild(badge);
                }

                const actions = document.createElement('div');
                actions.className = 'code-actions';

                if (isMalformed) {
                    const fixBtn = createButton('Manual Fix', 'codicon-edit', () => {
                        const msgWrapper = details.closest('.message-wrapper') as HTMLElement;
                        const msgId = msgWrapper?.dataset.messageId;
                        const msgDiv = msgWrapper?.querySelector('.message') as HTMLElement;
                        if (msgDiv && msgId) {
                            // Trigger the global edit function defined in messageRenderer
                            startEdit(msgDiv, msgId, 'assistant');
                        }
                    }, 'code-action-btn apply-btn', 'The AI generated broken syntax. Click to edit and fix the markers manually.');
                    actions.appendChild(fixBtn);
                }

                // Copy All button
                const copyBtn = createButton('Copy All', 'codicon-copy', () => {
                    vscode.postMessage({ command: 'copyToClipboard', text: codeOnly });
                    const iconEl = copyBtn.querySelector('.codicon');
                    if (iconEl) {
                        iconEl.classList.replace('codicon-copy', 'codicon-check');
                        setTimeout(() => iconEl.classList.replace('codicon-check', 'codicon-copy'), 2000);
                    }
                }, 'code-action-btn', 'Copy entire block content');
                actions.appendChild(copyBtn);

                // NEW: View Raw Button for Aider
                if (isAider) {
                    const rawBtn = createButton('Raw', 'codicon-source-control', () => {
                        if (dom.rawCodeDisplay) {
                            dom.rawCodeFilename.textContent = block.path || "Unspecified File";
                            const hunkIdEl = document.getElementById('raw-hunk-id');
                            if (hunkIdEl) hunkIdEl.textContent = `ALL HUNKS`;
                            dom.rawCodeDisplay.textContent = codeOnly;
                            dom.rawCodeDisplay.dataset.messageId = messageId;
                            dom.rawCodeDisplay.dataset.blockIndex = String(blockIdx);
                            dom.rawCodeDisplay.dataset.hunkIndex = ""; // Empty means full block
                            dom.rawCodeModal.classList.add('visible');
                        }
                    }, 'code-action-btn', 'View raw SEARCH/REPLACE format');
                    actions.appendChild(rawBtn);
                }

                // Aider specific badge for multi-hunk blocks
                if (isAider && aiderMatches.length > 1) {
                    const countBadge = document.createElement('span');
                    countBadge.className = 'summary-lang-label';
                    countBadge.style.opacity = '0.7';
                    countBadge.style.marginLeft = '8px';
                    countBadge.textContent = `(${aiderMatches.length} hunks)`;
                    langLabel.appendChild(countBadge);
                }

                const isBlockGenerating = !isFinal && !block.isClosed;
                const isDiagram = language === 'mermaid' || language === 'svg';
                
                // Assign a unique ID to the block for navigation from the summary list
                const blockIdentifier = `block-${messageId}-${idx}`;
                details.id = blockIdentifier;
                
                // --- DIAGRAM RENDER ZONE (SURGICAL PATH) ---
                // If it's a finished diagram block, render the visual ABOVE the code details
                if (isDiagram && !isBlockGenerating) {
                    const renderZone = document.createElement('div');
                    renderZone.className = 'diagram-render-zone';
                    fragment.appendChild(renderZone);
                    
                    // Pass the raw code block content directly
                    const tempCode = document.createElement('code');
                    tempCode.textContent = codeOnly;
                    
                    // Do not block UI with await, let it render in background
                    renderDiagram(tempCode, language, renderZone);
                }

                // Go to File button
                if (block.path) {
                    const gotoBtn = createButton('Go to File', 'codicon-go-to-file', () => {
                        vscode.postMessage({ command: 'openFile', path: block.path });
                    }, 'code-action-btn', 'Open this file in editor');
                    actions.appendChild(gotoBtn);
                }

                // Determine icon for the apply buttons
                const isSurgical = isAider || ['replace', 'insert', 'diff'].includes(block.type);
                const applyIcon = isSurgical ? 'codicon-arrow-swap' : 'codicon-tools';

                // Apply button
                if (block.path && ['file', 'replace', 'insert', 'diff'].includes(block.type)) {
                    const effectiveType = isAider ? 'replace' : block.type;
                    
                    // Use unique ID based on message + index for reliable lookup
                    const applyBtnId = `apply-btn-${messageId}-${blockIdx}`;

                    const applyBtn = createButton('Apply', applyIcon, () => {
                        const cmd = effectiveType === 'diff' ? 'applyPatchContent' :
                            (effectiveType === 'replace' ? 'replaceCode' : 'applyFileContent');

                        const btn = document.getElementById(applyBtnId) as HTMLButtonElement;
                        if (!btn) return;

                        btn.disabled = true;
                        btn.dataset.originalHtml = btn.innerHTML;
                        btn.innerHTML = '<div class="spinner"></div>';

                        vscode.postMessage({ 
                            command: cmd, 
                            filePath: block.path, 
                            content: codeOnly, 
                            messageId,
                            blockIndex: blockIdx 
                        });
                    }, 'code-action-btn apply-btn');
                    
                    applyBtn.id = applyBtnId;
                    applyBtn.title = isSurgical ? 'Apply surgical update to file' : 'Overwrite entire file with this content';

                    // Restore state from persistence
                    const isFullyApplied = state.appliedState?.[messageId]?.[blockIdx]?.includes(-1);
                    if (isFullyApplied) {
                        applyBtn.classList.add('applied');
                        applyBtn.innerHTML = '<span class="codicon codicon-check"></span>';
                    }

                    if (isBlockGenerating) {
                        applyBtn.disabled = true;
                        applyBtn.title = "Generating code... please wait for block to close.";
                    }
                    actions.appendChild(applyBtn);
                }

                // Execute button for runnable languages
                const runnableLanguages = ['python', 'py', 'javascript', 'js', 'typescript', 'ts', 'bash', 'sh', 'shell', 'powershell', 'pwsh', 'batch', 'cmd', 'bat'];
                if (runnableLanguages.includes(language.toLowerCase())) {
                    const execBtn = createButton('Execute', 'codicon-play', () => {
                        execBtn.disabled = true;
                        const oldHtml = execBtn.innerHTML;
                        execBtn.innerHTML = '<div class="spinner"></div>';
                        vscode.postMessage({ command: 'runScript', code: codeOnly, language });
                        // Re-enable after 3 seconds for scripts (since we don't always get a "done" signal)
                        setTimeout(() => { 
                            if (execBtn.innerHTML.includes('spinner')) {
                                execBtn.innerHTML = oldHtml;
                                execBtn.disabled = false;
                            }
                        }, 3000);
                    }, 'code-action-btn apply-btn', 'Run this code in terminal');
                    if (isBlockGenerating) execBtn.disabled = true;
                    actions.appendChild(execBtn);
                }

                // Save button
                const saveBtn = createButton('Save', 'codicon-save', () => {
                    vscode.postMessage({ command: 'saveCodeToFile', content: codeOnly, language });
                });
                if (isBlockGenerating) saveBtn.disabled = true;
                actions.appendChild(saveBtn);

                // Inspect button
                if (state.isInspectorEnabled) {
                    const inspectBtn = createButton('Inspect', 'codicon-search', () => {
                        vscode.postMessage({ command: 'inspectCode', code: codeOnly, language });
                    });
                    actions.appendChild(inspectBtn);
                }

                summary.appendChild(langLabel);
                summary.appendChild(actions);
                details.appendChild(summary);
                // Preserve raw code for the 'Apply All' aggregator
                details.dataset.rawCode = codeOnly;
                
        const pre = document.createElement('pre');
        pre.className = `language-${language}`;
        pre.style.width = '100%';
        pre.style.maxHeight = '400px';

                if (isAider) {
                    // Clear pre to prevent raw text or old gutters from leaking into the Aider UI
                    pre.innerHTML = '';
                    pre.style.display = 'block'; 

                    const hunkGroup = document.createElement('div');
                    hunkGroup.className = 'aider-hunk-group';
                    
                    aiderMatches.forEach((match, hIdx) => {
                        const hunkBubble = document.createElement('div');
                        hunkBubble.className = 'aider-hunk-bubble';
                        
                        const hunkHeader = document.createElement('div');
                        hunkHeader.className = 'aider-hunk-header';
                        
                        // Add toggle chevron and title
                        hunkHeader.innerHTML = `
                            <div style="display:flex; align-items:center;">
                                <span class="codicon codicon-chevron-down hunk-toggle-icon"></span>
                                <span>HUNK ${hIdx + 1} OF ${aiderMatches.length}</span>
                            </div>
                        `;

                        // Collapse toggle logic
                        hunkHeader.onclick = (e) => {
                            // Don't toggle if a button inside the header was clicked
                            if ((e.target as HTMLElement).closest('.code-action-btn')) return;
                            hunkBubble.classList.toggle('collapsed');
                        };
                        
                        const hunkActions = document.createElement('div');
                        hunkActions.className = 'aider-hunk-actions';

                        const searchPart = match[1].trim();
                        const replacePart = match[2] ? match[2].trim() : "";

                        // Copy Search Button for this hunk
                        const copySearchBtn = createButton('Copy Search', 'codicon-copy', () => {
                            vscode.postMessage({ command: 'copyToClipboard', text: searchPart });
                            const iconEl = copySearchBtn.querySelector('.codicon');
                            if (iconEl) iconEl.className = 'codicon codicon-check';
                            setTimeout(() => { if (iconEl) iconEl.className = 'codicon codicon-copy'; }, 2000);
                        }, 'code-action-btn', 'Copy the SEARCH block for this hunk');

                        // Copy Replace Button for this hunk
                        const copyReplaceBtn = createButton('Copy Replace', 'codicon-copy', () => {
                            vscode.postMessage({ command: 'copyToClipboard', text: replacePart });
                            const iconEl = copyReplaceBtn.querySelector('.codicon');
                            if (iconEl) iconEl.className = 'codicon codicon-check';
                            setTimeout(() => { if (iconEl) iconEl.className = 'codicon codicon-copy'; }, 2000);
                        }, 'code-action-btn', 'Copy the REPLACE block for this hunk');

                        // NEW: View Raw button for this specific hunk
                        const rawHunkBtn = createButton('Raw', 'codicon-code', () => {
                            if (dom.rawCodeDisplay) {
                                dom.rawCodeFilename.textContent = block.path || "Unspecified File";
                                const hunkIdEl = document.getElementById('raw-hunk-id');
                                if (hunkIdEl) hunkIdEl.textContent = `HUNK ${hIdx + 1}`;
                                dom.rawCodeDisplay.textContent = match[0]; // match[0] is the full block string
                                dom.rawCodeDisplay.dataset.messageId = messageId;
                                dom.rawCodeDisplay.dataset.blockIndex = String(blockIdx);
                                dom.rawCodeDisplay.dataset.hunkIndex = String(hIdx);
                                dom.rawCodeModal.classList.add('visible');
                            }
                        }, 'code-action-btn', 'View raw SEARCH/REPLACE for this hunk');
                        
                        // Apply Hunk Button
                        const applyHunkBtn = createButton('Apply Hunk', applyIcon, () => {
                            vscode.postMessage({ 
                                command: 'replaceCode', 
                                filePath: block.path, 
                                content: match[0], 
                                messageId,
                                blockIndex: blockIdx,
                                hunkIndex: hIdx
                            });
                        }, 'code-action-btn apply-btn', 'Apply only this modification');
                        
                        // Restore hunk state from persistence
                        const appliedHunks = state.appliedState?.[messageId]?.[blockIdx] || [];
                        if (appliedHunks.includes(hIdx) || appliedHunks.includes(-1)) {
                            applyHunkBtn.classList.add('applied');
                            applyHunkBtn.innerHTML = '<span class="codicon codicon-check"></span>';
                            hunkBubble.classList.add('collapsed');
                        }

                        if (isBlockGenerating) {
                            applyHunkBtn.disabled = true;
                            copySearchBtn.disabled = true;
                            copyReplaceBtn.disabled = true;
                        }
                        
                        hunkActions.appendChild(copySearchBtn);
                        hunkActions.appendChild(copyReplaceBtn);
                        hunkActions.appendChild(rawHunkBtn);
                        hunkActions.appendChild(applyHunkBtn);
                        hunkHeader.appendChild(hunkActions);
                        hunkBubble.appendChild(hunkHeader);
                        
                        const hunkContent = document.createElement('div');
                        hunkContent.className = 'aider-hunk-content';
                        
                        const diffContainer = document.createElement('div');
                        diffContainer.className = 'aider-diff-container';

                        const sLines = (match[1] || "").split('\n');
                        const rRaw = (match[2] || "").trim();
                        const rLines = rRaw === "" ? [] : rRaw.split('\n');

                        let prefix = 0;
                        while (prefix < sLines.length && prefix < rLines.length && sLines[prefix] === rLines[prefix]) prefix++;
                        let suffix = 0;
                        while (suffix < (sLines.length - prefix) && suffix < (rLines.length - prefix) && sLines[sLines.length - 1 - suffix] === rLines[rLines.length - 1 - suffix]) suffix++;

                        const renderLine = (line: string, type: 'added' | 'removed' | 'unchanged') => {
                            const lDiv = document.createElement('div');
                            lDiv.className = `aider-diff-line aider-diff-${type}`;

                            const codeSpan = document.createElement('span');
                            codeSpan.className = 'aider-diff-code';
                            codeSpan.textContent = line; 

                            lDiv.appendChild(codeSpan);
                            diffContainer.appendChild(lDiv);
                        };

                        for (let i = 0; i < prefix; i++) renderLine(sLines[i], 'unchanged');
                        for (let i = prefix; i < sLines.length - suffix; i++) renderLine(sLines[i], 'removed');
                        for (let i = prefix; i < rLines.length - suffix; i++) renderLine(rLines[i], 'added');
                        for (let i = sLines.length - suffix; i < sLines.length; i++) renderLine(sLines[i], 'unchanged');

                        hunkContent.appendChild(diffContainer);
                        hunkBubble.appendChild(hunkContent);
                        hunkGroup.appendChild(hunkBubble);
                    });
                    
                    pre.appendChild(hunkGroup);
                    // Hide the raw code text as we now have visual bubbles
                    pre.style.background = 'transparent';
                    pre.style.border = 'none';
                } else {
                    pre.innerHTML = ''; 
                    pre.style.display = 'flex';
                    pre.style.overflow = 'auto';

                    const gutter = document.createElement('div');
                    gutter.className = 'code-line-gutter';
                    const lineCount = codeOnly.split('\n').length;
                    gutter.innerHTML = Array.from({ length: lineCount }, (_, i) => i + 1).join('<br>');

                    const codeElement = document.createElement('code');
                    codeElement.className = `language-${language}`;
                    codeElement.textContent = codeOnly;

                    pre.appendChild(gutter);
                    pre.appendChild(codeElement);
                    Prism.highlightElement(codeElement);
                }

                details.appendChild(pre);
                fragment.appendChild(details);
                lastIndex = block.end;
            });

            // Render remaining text
            const remaining = processedContent.substring(lastIndex);
            if (remaining.trim()) {
                const lastTextDiv = document.createElement('div');
                lastTextDiv.innerHTML = sanitizer.sanitize(marked.parse(remaining) as string, SANITIZE_CONFIG);
                fragment.appendChild(lastTextDiv);
            }

            contentDiv.innerHTML = '';
            contentDiv.appendChild(fragment);

            // Apply All button logic
            const actionableBlocks = codeBlocks.filter(b => b.path && ['file', 'replace', 'insert', 'diff'].includes(b.type || ''));
            if (actionableBlocks.length > 0) {
                const wrapper = document.createElement('div');
                wrapper.className = 'apply-all-wrapper';
                wrapper.style.marginTop = '16px';

                const btn = document.createElement('button');
                btn.className = 'apply-all-btn';
                
                const resultsList = document.createElement('div');
                resultsList.className = 'apply-results-list';
                resultsList.style.cssText = 'display:none; margin-top:8px; font-size:11px; padding:8px; background:var(--vscode-editor-inactiveSelectionBackground); border-radius:4px; border:1px solid var(--vscode-widget-border);';

                // Restore state if we are re-rendering due to an update (e.g. repair)
                if (savedResultsHtml && isApplyListVisible) {
                    resultsList.innerHTML = savedResultsHtml;
                    resultsList.style.display = 'block';
                    btn.className = savedBtnClasses;
                    btn.innerHTML = savedBtnText;
                    btn.disabled = savedBtnDisabled;
                } else {
                    // Default state
                    btn.innerHTML = `<span class="codicon codicon-check-all"></span> Apply All Modifications (${actionableBlocks.length})`;
                    btn.disabled = !isFinal;
                    if (!isFinal) {
                        btn.style.opacity = '0.5';
                        btn.style.cursor = 'not-allowed';
                    }
                }

                btn.onclick = () => {
                    if (btn.classList.contains('applied')) return;

                    if (btn.classList.contains('stop-btn-red')) {
                        vscode.postMessage({ command: 'stopGeneration' });
                        return;
                    }

                    const changes = gatherChangesFromBlocks(messageId);
                    if (changes.length === 0) return;

                    btn.classList.add('sequential-applying');
                    btn.classList.add('stop-btn-red');
                    btn.innerHTML = '<span class="codicon codicon-stop"></span> Stop Applying';
                    resultsList.style.display = 'block';

                    resultsList.innerHTML = changes.map((c) => {
                        const isFull = c.type === 'file';
                        const typeLabel = isFull ? 'FULL' : 'PATCH';
                        const typeColor = isFull ? 'var(--vscode-charts-blue)' : 'var(--vscode-charts-orange)';
                        const hunkAttr = c.hunkIndex !== undefined ? `data-hunk-index="${c.hunkIndex}"` : '';
                        
                        return `
                        <div class="apply-row" data-path="${c.path}" data-block-index="${c.blockIndex}" ${hunkAttr} data-target-id="block-${messageId}-${c.blockIndex}" style="display:flex; align-items:center; gap:8px; margin-bottom:6px; padding:4px; border-radius:4px; cursor:pointer;">
                            <span class="status-icon"><span class="codicon codicon-clock"></span></span>
                            <span style="font-weight:800; font-size:9px; color:${typeColor}; min-width:45px; border:1px solid ${typeColor}; border-radius:3px; text-align:center; padding:0 2px;">${typeLabel}</span>
                            <span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:11px;">${c.label}</span>
                            <div class="row-actions" style="display:none;"></div>
                        </div>`;
                    }).join('');

                    // Add navigation listener to results list
                    resultsList.onclick = (e) => {
                        const targetElement = e.target as HTMLElement;
                        // DO NOT scroll if the user clicked a button (like Repair)
                        if (targetElement.closest('button')) return;

                        const row = targetElement.closest('.apply-row') as HTMLElement;
                        if (row && row.dataset.targetId) {
                            const target = document.getElementById(row.dataset.targetId);
                            if (target) {
                                target.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                // Visual feedback: pulse highlight
                                target.style.transition = 'outline 0.2s';
                                target.style.outline = '2px solid var(--vscode-focusBorder)';
                                setTimeout(() => target.style.outline = 'none', 1000);
                            }
                        }
                    };

                    vscode.postMessage({ command: 'applyAllChanges', changes, messageId });
                };

                const verifyBtn = document.createElement('button');
                verifyBtn.className = 'apply-all-btn secondary-btn'; // Use secondary style
                verifyBtn.style.width = 'auto';
                verifyBtn.style.flex = '0 0 auto';
                verifyBtn.style.margin = '16px 8px 4px 0';
                verifyBtn.innerHTML = '<span class="codicon codicon-search"></span> Verify Status';
                
                verifyBtn.onclick = () => {
                    const changes = gatherChangesFromBlocks(messageId);
                    if (changes.length === 0) return;

                    verifyBtn.disabled = true;
                    verifyBtn.innerHTML = '<div class="spinner"></div> Verifying...';
                    vscode.postMessage({ command: 'verifyAllChanges', changes, messageId });
                };

                const btnContainer = document.createElement('div');
                btnContainer.className = 'apply-all-buttons-container';
                btnContainer.style.display = 'flex';
                btnContainer.style.gap = '8px';
                btnContainer.style.width = '100%';
                btnContainer.style.alignItems = 'center';
                
                btnContainer.appendChild(verifyBtn);
                btnContainer.appendChild(btn);

                wrapper.appendChild(btnContainer);
                wrapper.appendChild(resultsList);
                contentDiv.appendChild(wrapper);

                // --- INITIAL SYNC ---
                checkAndSyncMessageAppliedState(messageId);
            }
        }
    } catch (e) {
        contentDiv.innerText = "Rendering Error: " + e;
    }

    if (shouldScroll && dom.messagesDiv) dom.messagesDiv.scrollTop = dom.messagesDiv.scrollHeight;
}

function gatherChangesFromBlocks(messageId: string) {
    const changes: any[] = [];
    const wrapper = document.querySelector(`.message-wrapper[data-message-id='${messageId}']`);
    if (!wrapper) return changes;

    const blocks = wrapper.querySelectorAll('details.code-collapsible');
    
    blocks.forEach((block: any) => {
        const blockIdParts = block.id.split('-');
        if (blockIdParts.length < 3) return;
        const blockIndex = parseInt(blockIdParts[2], 10);
        
        const codeText = block.dataset.rawCode || "";
        const summaryText = block.querySelector('.summary-lang-label')?.textContent || "";
        const parts = summaryText.split(' : ');
        const path = parts.length > 1 ? parts[1].replace('Diff: ', '').trim() : "";
        if (!path) return;

        const hunkBubbles = block.querySelectorAll('.aider-hunk-bubble');

        if (hunkBubbles.length > 0) {
            // Aider Multi-Hunk: Send each hunk separately for verification/application
            hunkBubbles.forEach((hunk: any, hIdx: number) => {
                const hunkBtn = hunk.querySelector('.apply-btn');
                if (hunkBtn && !hunkBtn.classList.contains('applied')) {
                    changes.push({
                        type: 'replace',
                        path: path,
                        content: codeText, // Backend will use hunkIndex to pick the right part
                        label: `${path} (Hunk ${hIdx + 1})`,
                        blockIndex: blockIndex,
                        hunkIndex: hIdx
                    });
                }
            });
        } else {
            const applyBtn = block.querySelector('.code-actions .apply-btn') as HTMLButtonElement;
            if (applyBtn && !applyBtn.classList.contains('applied')) {
                let type: any = 'file';
                if (summaryText.toLowerCase().includes('diff')) type = 'diff';
                else if (summaryText.toLowerCase().includes('insert')) type = 'insert';
                else if (summaryText.toLowerCase().includes('replace')) type = 'replace';

                changes.push({
                    type: type,
                    path: path,
                    content: codeText,
                    label: path,
                    blockIndex: blockIndex
                });
            }
        }
    });
    return changes;
}

/**
 * Clean text for Text-to-Speech by removing code blocks and markdown artifacts.
 */
function sanitizeForTTS(text: string): string {
    if (typeof text !== 'string') return "";
    // 1. Remove triple backtick code blocks entirely
    let clean = text.replace(/```[\s\S]*?```/g, ' [code block] ');
    // 2. Remove inline code backticks
    clean = clean.replace(/`[^`]+`/g, '');
    // 3. Remove markdown formatting characters
    clean = clean.replace(/[#*_~>\[\]\(\)]/g, ' ');
    // 4. Clean up whitespace
    return clean.replace(/\s+/g, ' ').trim();
}

export function addMessage(message: any, isFinal: boolean = true) {
    // Hide welcome message as soon as any content is added
    if (dom.welcomeMessage) {
        dom.welcomeMessage.style.display = 'none';
    }

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

    const data = message.attachmentData || {};
    const fileName = data.name || 'Unknown File';
    const textContent = data.text || '';
    const images = data.images || [];

    const details = document.createElement('details');
    details.className = 'attachment-item-details';
    details.dataset.messageId = message.id;

    // Create an interleaved preview: Images first as a gallery, then searchable text.
    // If the data contains page-markers, we could interleave precisely. 
    // For now, we provide a structured document view.
    const summaryEl = document.createElement('summary');
    summaryEl.className = 'attachment-item-summary';
    
    const isPdf = fileName.toLowerCase().endsWith('.pdf');
    const icon = isPdf ? 'codicon-file-pdf' : 'codicon-file-binary';

    summaryEl.innerHTML = `
        <div class="attachment-info">
            <span class="codicon ${icon}"></span> 
            <span style="font-weight: 600;">${fileName}</span>
            <span class="generation-stats" style="margin-left:10px; opacity:0.7;">Imported Data</span>
        </div>
        <div class="attachment-controls">
            <button class="remove-attachment-btn" title="Delete from Chat"><i class="codicon codicon-trash"></i></button>
        </div>
    `;

    // --- UPDATED IMAGE GALLERY RENDERING ---
    let bodyHtml = `<div class="attachment-content">`;
    
    if (images && images.length > 0) {
        const imageCards = images.map((img: any) => {
            const src = img.data.startsWith('data:') ? img.data : `data:image/png;base64,${img.data}`;
            return `
                <div class="staged-image-card" style="background-image: url(${src});" 
                     onclick="const w=window.open(); w.document.write('<img src=\\'${src}\\' style=\\'max-width:100%\\'>')">
                </div>`;
        }).join('');

        bodyHtml += `
            <div style="margin-bottom: 15px;">
                <div style="font-size: 10px; font-weight: 800; opacity: 0.6; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px;">
                    <i class="codicon codicon-device-camera"></i> Extracted Pages/Visuals (${images.length})
                </div>
                <div class="image-grid">
                    ${imageCards}
                </div>
            </div>`;
    }

    if (textContent && textContent.trim().length > 0) {
        bodyHtml += `
            <div style="font-size: 10px; font-weight: 800; opacity: 0.5; margin-bottom: 5px; text-transform: uppercase;">Extracted Text Content</div>
            <div class="markdown-body" style="font-size: 12px; line-height: 1.6; max-height: 400px; overflow-y: auto; padding: 12px; background: var(--vscode-editor-background); border: 1px solid var(--vscode-widget-border); border-radius: 4px;">
                ${sanitizer.sanitize(marked.parse(textContent) as string)}
            </div>`;
    }
    
    bodyHtml += `</div>`;

    details.innerHTML = bodyHtml;
    
    details.prepend(summaryEl);

    summaryEl.querySelector('.remove-attachment-btn')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        vscode.postMessage({ command: 'requestDeleteMessage', messageId: message.id });
    });

    dom.attachmentsContainer.appendChild(details);
    
    const count = dom.attachmentsContainer.children.length;
    const headerTitle = wrapper?.querySelector('.role-name');
    if(headerTitle) headerTitle.textContent = `Attached Files (${count})`;
}

function addChatMessage(message: any, isFinal: boolean = true) {
    const { role, id, content: rawContent, startTime, model, personalityName } = message;
    
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
    if (personalityName) messageWrapper.dataset.personalityName = personalityName;

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

     // 1. Create Floating HUD Toolbar
    const actions = document.createElement('div');
    actions.className = 'message-actions';
    
    const isMultipart = Array.isArray(rawContent);
    const textForClipboard = isMultipart 
        ? (rawContent.find((p: any) => p.type === 'text')?.text || '') 
        : (typeof rawContent === 'string' ? rawContent : '');

    if (role !== 'system') {
        actions.appendChild(createButton('', 'codicon-edit', () => startEdit(messageDiv, id, role), 'msg-action-btn', 'Edit Message'));
        
        if (role === 'user') {
            actions.appendChild(createButton('', 'codicon-sync', () => vscode.postMessage({ command: 'regenerateFromMessage', messageId: id }), 'msg-action-btn', 'Regenerate Response'));
        }
    }
    
    const copyBtn = createButton('', 'codicon-copy', () => {
        window.vscode.postMessage({ command: 'copyToClipboard', text: textForClipboard });
        const iconEl = copyBtn.querySelector('.codicon');
        if(iconEl) {
            iconEl.classList.replace('codicon-copy', 'codicon-check');
            setTimeout(() => { if (iconEl) iconEl.classList.replace('codicon-check', 'codicon-copy'); }, 2000);
        }
    }, 'msg-action-btn', 'Copy Message');
    actions.appendChild(copyBtn);

    // Only add megaphone if TTS is enabled
    if (state.capabilities?.enableTTS) {
        const speakBtn = createButton('', 'codicon-megaphone', (e) => {
            const textToRead = sanitizeForTTS(textForClipboard);
            if (typeof (window as any).halSpeak === 'function') {
                const btn = (e.currentTarget as HTMLElement);
                (window as any).halSpeak(textToRead, true, btn);
            }
        }, 'msg-action-btn', 'Read Explanation');
        actions.appendChild(speakBtn);
    }

    if (role === 'assistant') {
        actions.appendChild(createButton('', 'codicon-save', () => vscode.postMessage({ command: 'saveMessageAsPrompt', content: textForClipboard }), 'msg-action-btn', 'Save as Prompt'));
        actions.appendChild(createButton('', 'codicon-book', () => vscode.postMessage({ command: 'requestLog' }), 'msg-action-btn', 'Show Debug Log'));
    }
    
    actions.appendChild(createButton('', 'codicon-trash', () => vscode.postMessage({ command: 'requestDeleteMessage', messageId: id }), 'msg-action-btn', 'Delete Message'));

    // CRITICAL: Inject HUD as the ABSOLUTE FIRST child of the body.
    // In block layout, the first child being sticky+floated will correctly track the viewport.
    bodyDiv.innerHTML = ''; // Clear for fresh injection
    bodyDiv.appendChild(actions);

    const isAgent = state.capabilities?.agentMode && role === 'assistant';
    if (isAgent) {
        messageDiv.classList.add('agent-mode-message');
    }

    const headerDiv = document.createElement('div');
    headerDiv.className = 'message-header';
    let roleDisplay = 'System';
    if (role === 'user') roleDisplay = 'You';
    else if (role === 'assistant') {
        roleDisplay = isAgent ? '🛰️ Leader Architect' : (personalityName || message.personalityName || 'Lollms');
    }
    
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



export function updateContext(contextText: string, files: string[] = [], skills: any[] = [], diagrams: any[] = [], briefing: string = "") {
    if(!dom.contextContainer) return;

    // Cache the data so we can re-render if capabilities (like Mute) change
    state.lastContextData = { context: contextText, files, skills, diagrams };
    
    // If no context text but we have files/skills, show "Loading content..." in the preview
    const displayContent = contextText || (files.length > 0 ? "_Loading project content..._" : "");
    const renderedMarkdown = displayContent ? sanitizer.sanitize(marked.parse(displayContent) as string, SANITIZE_CONFIG) : "";

    // Categorize as external if it's in the cache, a web URL, or an absolute path (outside workspace)
    // Strictly define what belongs in the "Project Files" list
    // Only relative paths that don't belong to the internal cache are allowed.
    const isProjectFile = (f: string) => {
        const isAbsolute = f.includes(':') || f.startsWith('/') || f.startsWith('\\');
        const isInternal = f.includes('.lollms/') || f.startsWith('http');
        return !isAbsolute && !isInternal;
    };

    const projectFiles = files.filter(isProjectFile);
    // Everything else (Cache, Absolute paths, Web) is External/Research
    const externalFiles = files.filter(f => !isProjectFile(f));

    const renderFileList = (list: string[], emptyMsg: string, allowSummarize: boolean = false) => {
        if (!list || list.length === 0) return `<div class="empty-context-msg">${emptyMsg}</div>`;
        return `<ul class="context-file-list">
            ${list.map(f => `
                <li class="context-item">
                    <span class="codicon codicon-file"></span> 
                    <span class="context-item-label" title="${f}">${f}</span>
                    <div style="display:flex; gap:2px;">
                        ${allowSummarize ? `
                        <button class="summarize-context-btn" data-value="${f}" title="Synthesize / Clean / Summarize">
                            <span class="codicon codicon-wand"></span>
                        </button>` : ''}
                        <button class="open-context-btn" data-value="${f}" title="Inspect / Edit File">
                            <span class="codicon codicon-edit"></span>
                        </button>
                        <button class="remove-context-btn" data-type="file" data-value="${f}" title="Remove from context">
                            <span class="codicon codicon-close"></span>
                        </button>
                    </div>
                </li>`).join('')}
           </ul>`;
    };

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

    const isMuted = state.capabilities?.disableProjectContext;
    const isAgentActive = state.capabilities?.agentMode === true;
    
    const themeClass = isAgentActive ? 'agent-mode-bubble' : '';
    const muteClass = isMuted ? 'muted-bubble' : '';

    const renderDataBriefing = () => {
        const raw = briefing || "";
        if (!raw.trim()) return "Librarian is analyzing project state...";
        try {
            if (!raw.startsWith('{')) return raw;
            const entries = JSON.parse(raw);
            return Object.keys(entries).map(id => {
                const title = id.replace(/_/g, ' ').toUpperCase();
                return `<strong>[${title}]</strong><br>${entries[id]}`;
            }).join('<br><br>');
        } catch { return raw; }
    };

    const innerHTML = `
    <div class="message special-zone-message context-message ${themeClass} ${muteClass}">
        <div class="message-avatar">
            ${isAgentActive 
                ? '<div class="agent-active-indicator" title="Autonomous Agent Mode Active"><span class="codicon codicon-robot"></span></div>' 
                : '<span class="codicon codicon-library"></span>'}
        </div>
        <div class="message-body">
            <div class="message-header" style="display: flex; justify-content: space-between; align-items: flex-start; width: 100%; margin-bottom: 10px; flex-wrap: wrap; gap: 10px;">
                <div style="display:flex; flex-direction:column; gap:4px; min-width: 180px;">
                    <div style="display:flex; align-items:center; gap:8px;">
                        <span class="role-name">Project Context</span>
                        <div id="status-label" class="status-label visible" style="background:transparent; padding:0; margin:0; font-weight:normal; opacity:0.7;">
                            <div id="status-spinner" class="spinner" style="display:none; width:10px; height:10px;"></div>
                            <span id="status-text" style="font-size:10px;">Ready</span>
                        </div>
                    </div>
                    <div class="token-progress" style="width: 100%; max-width: 200px; margin-top: 2px;">
                        <div class="token-progress-container" style="height: 3px;">
                            <div class="token-progress-bar" id="token-progress-bar"></div>
                        </div>
                        <div id="context-status-container" style="display: flex; align-items: center; gap: 4px; font-size: 10px; opacity: 0.8;">
                            <span id="token-count-label"></span>
                            <button id="cancel-tokens-btn" class="icon-btn" style="padding:0; font-size: 10px; display: none;" title="Stop"><i class="codicon codicon-debug-stop"></i></button>
                            <button id="refresh-context-btn" class="icon-btn" style="padding:0; font-size: 10px;" title="Refresh"><i class="codicon codicon-refresh"></i></button>
                        </div>
                    </div>
                </div>
                <div style="display: flex; gap: 5px; flex-wrap: wrap; justify-content: flex-start; flex: 1;">
                    <button id="view-full-context-btn" class="code-action-btn apply-btn" style="height: 22px; padding: 0 10px; font-size: 11px; margin: 0;" title="View Full Context and Structure">
                        <span class="codicon codicon-book"></span> View
                    </button>
                    <button id="view-usage-context-btn" class="code-action-btn apply-btn" style="height: 22px; padding: 0 10px; font-size: 11px; margin: 0;" title="View per-file token usage">
                        <span class="codicon codicon-dashboard"></span> Usage
                    </button>
                    <div style="width: 1px; background: var(--vscode-widget-border); margin: 0 4px;"></div>
                    <button id="add-file-context-btn" class="code-action-btn apply-btn" style="height: 22px; padding: 0 10px; font-size: 11px; margin: 0;" title="Add File to Context">
                        <span class="codicon codicon-add"></span> File
                    </button>
                    <button id="add-skill-context-btn" class="code-action-btn apply-btn" style="height: 22px; padding: 0 10px; font-size: 11px; margin: 0;" title="Add Skill to Context">
                        <span class="codicon codicon-lightbulb"></span> Skill
                    </button>
                    <button id="web-context-btn" class="code-action-btn apply-btn" style="height: 22px; padding: 0 10px; font-size: 11px; margin: 0;" title="Web Discovery (URL, YouTube, Wiki, etc.)">
                        <span class="codicon codicon-globe"></span> Web
                    </button>
                    <button id="edit-briefing-btn" class="code-action-btn apply-btn" style="height: 22px; padding: 0 10px; font-size: 11px; margin: 0; border-color: var(--vscode-charts-purple);" title="Set the Technical Briefing (Prime Directive)">
                        <span class="codicon codicon-shield"></span> Briefing
                    </button>
                    <button id="add-diagram-context-btn" class="code-action-btn apply-btn" style="height: 22px; padding: 0 10px; font-size: 11px; margin: 0;" title="Add Architecture Diagram to Context">
                        <span class="codicon codicon-graph"></span> Diagram
                    </button>
                    <button id="search-add-context-btn" class="code-action-btn apply-btn" style="height: 22px; padding: 0 10px; font-size: 11px; margin: 0;" title="Search and Add Files (supports wildcards)">
                        <span class="codicon codicon-search"></span> Search
                    </button>
                    <div style="width: 1px; background: var(--vscode-widget-border); margin: 0 4px;"></div>
                    <button id="mute-context-btn" class="code-action-btn ${isMuted ? 'applied' : 'apply-btn'}" style="height: 22px; padding: 0 10px; font-size: 11px; margin: 0; background-color: ${isMuted ? 'var(--vscode-charts-red)' : ''} !important; color: ${isMuted ? 'white' : ''} !important;" title="${isMuted ? 'Unmute Context' : 'Mute Context (Don\'t send project files to AI)'}">
                        <span class="codicon ${isMuted ? 'codicon-mute' : 'codicon-unmute'}"></span> ${isMuted ? 'Muted' : 'Mute'}
                    </button>
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
                <details class="info-collapsible" style="margin-bottom: 6px; border-left: 4px solid var(--vscode-charts-purple);">
                    <summary>Team Technical Briefing</summary>
                    <div class="collapsible-content">
                        <div class="briefing-content" style="padding: 10px; font-size: 12px; line-height: 1.5;">
                            ${renderDataBriefing()}
                        </div>
                    </div>
                </details>
                <details class="info-collapsible" style="margin-bottom: 6px;">
                    <summary>Selected Files (${files.length})</summary>
                    <div class="collapsible-content" style="padding-top: 8px;">
                        <h4 style="margin: 0 0 8px 4px; font-size: 11px; opacity: 0.7; text-transform: uppercase;">Project Files</h4>
                        ${renderFileList(projectFiles, "No project files selected.", false)}
                        
                        <h4 style="margin: 12px 0 8px 4px; font-size: 11px; opacity: 0.7; text-transform: uppercase; display: flex; justify-content: space-between; align-items: center;">
                            <span>External & Research</span>
                            ${externalFiles.length > 0 ? `
                            <div style="display: flex; gap: 4px;">
                                <button id="bulk-process-external-btn" class="section-bulk-btn">
                                    <span class="codicon codicon-wand"></span> Process
                                </button>
                                <button id="bulk-delete-external-btn" class="section-bulk-btn delete">
                                    <span class="codicon codicon-trash"></span> Delete
                                </button>
                            </div>` : ''}
                        </h4>
                        ${renderFileList(externalFiles, "No search results or external data in context.", true)}
                    </div>
                </details>
                <details class="info-collapsible" style="margin-bottom: 6px;">
                    <summary>Active Diagrams (${diagrams?.length || 0})</summary>
                    <div class="collapsible-content">
                        ${diagrams && diagrams.length > 0 ? diagrams.map(d => `
                            <div class="context-item" style="flex-direction:column; align-items:stretch;">
                                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:5px;">
                                    <span style="font-weight:bold; font-size:11px;">${d.type.replace('_', ' ').toUpperCase()}</span>
                                    <button class="remove-context-btn" data-type="diagram" data-value="${d.type}"><span class="codicon codicon-close"></span></button>
                                </div>
                                <pre class="mermaid" style="background:var(--vscode-editor-background); border-radius:4px; padding:5px;">${d.mermaid}</pre>
                            </div>
                        `).join('') : '<div class="empty-context-msg">No diagrams included.</div>'}
                    </div>
                </details>
                <details class="info-collapsible">
                    <summary>
                        <div style="display: inline-flex; justify-content: space-between; align-items: center; width: calc(100% - 20px);">
                            <span>Active Skills (${skills.length})</span>
                            ${skills.length > 0 ? `
                            <button id="bulk-delete-skills-btn" class="section-bulk-btn delete" style="margin-right: 5px;">
                                <span class="codicon codicon-trash"></span> Bulk Remove
                            </button>` : ''}
                        </div>
                    </summary>
                    <div class="collapsible-content">
                        ${skillsList}
                    </div>
                </details>
            </div>
        </div>
    </div>`;
    
    const hasMetadata = files.length > 0 || skills.length > 0 || (diagrams && diagrams.length > 0);
    dom.contextContainer.innerHTML = (contextText || hasMetadata) ? innerHTML : '';

    const markdownView = dom.contextContainer.querySelector('.markdown-context-view');
    if (markdownView) {
        enhanceCodeBlocks(markdownView as HTMLElement, contextText, true);
    }

    // Trigger Mermaid rendering for diagrams in the context bubble
    if (diagrams.length > 0) {
        const nodes = dom.contextContainer.querySelectorAll('.mermaid');
        nodes.forEach(async (node) => {
            const rawText = node.textContent || '';
            // Quote labels in brackets to prevent syntax errors
            const sanitizedText = rawText.split('\n').map(line => {
                const trimmed = line.trim();
                if (trimmed.match(/^(subgraph|end|class|state|note|participant|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|pie|gitGraph|flowchart|graph|class)/i)) {
                    return line;
                }
                return line.replace(/([a-zA-Z0-9_-]+)\s*([\[\(\{]{1,2})\s*([^"'\n\r\t]+?)\s*([\]\)\}]{1,2})/g, (match, id, open, label, close) => {
                    const safeLabel = label.replace(/"/g, "'");
                    return `${id}${open}"${safeLabel.trim()}"${close}`;
                });
            }).join('\n');

            node.textContent = sanitizedText;
            
            try {
                await (window as any).mermaid.run({ nodes: [node] });
            } catch (e: any) {
                console.error("📊 Context Mermaid Error:", e);
                node.parentElement!.innerHTML = `
                    <div style="color:var(--vscode-errorForeground); padding:10px; background:var(--vscode-inputValidation-errorBackground); border:1px solid var(--vscode-errorForeground); border-radius:4px; font-size:10px;">
                        <strong>Mermaid Syntax Error:</strong> ${e.message || e}
                        <details style="margin-top:5px;"><summary>View Code</summary><pre style="font-size:9px; white-space:pre-wrap; margin-top:5px;">${sanitizedText}</pre></details>
                    </div>`;
            }
        });
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
            } else if (type === 'diagram') {
                vscode.postMessage({ 
                    command: 'updateDiscussionCapabilitiesPartial', 
                    partial: { 
                        // Note: We'll filter the activeDiagrams list on the extension side
                        // but we send the command to trigger the update.
                        removeDiagram: value 
                    } 
                });
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

    dom.contextContainer.querySelectorAll('.summarize-context-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const target = e.currentTarget as HTMLElement;
            const value = target.dataset.value;
            if (value) {
                vscode.postMessage({ command: 'summarizeContextFile', path: value });
            }
        });
    });

    const bulkBtn = document.getElementById('bulk-process-external-btn');
    if (bulkBtn) {
        bulkBtn.addEventListener('click', () => {
            showBulkProcessModal(externalFiles);
        });
    }

    const bulkDeleteBtn = document.getElementById('bulk-delete-external-btn');
    if (bulkDeleteBtn) {
        bulkDeleteBtn.addEventListener('click', () => {
            showBulkDeleteModal(externalFiles);
        });
    }

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

    const webBtn = document.getElementById('web-context-btn');
    if (webBtn) {
        webBtn.addEventListener('click', () => {
            if (dom.webModal) {
                dom.webModal.classList.add('visible');
            }
        });
    }

    const addDiagramBtn = document.getElementById('add-diagram-context-btn');
    if (addDiagramBtn) {
        addDiagramBtn.addEventListener('click', () => {
            vscode.postMessage({ command: 'requestAddDiagramToContext' });
        });
    }

    const searchAddBtn = document.getElementById('search-add-context-btn');
    if (searchAddBtn) {
        searchAddBtn.addEventListener('click', () => {
            if (dom.fileSearchModal) {
                dom.fileSearchModal.classList.add('visible');
                dom.fileSearchInput.focus();
            }
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

    const viewFullBtn = document.getElementById('view-full-context-btn');
    if (viewFullBtn) {
        viewFullBtn.addEventListener('click', () => {
            vscode.postMessage({ command: 'requestViewFullContext' });
        });
    }

    const briefingBtn = document.getElementById('edit-briefing-btn');
    if (briefingBtn) {
        briefingBtn.addEventListener('click', () => {
            vscode.postMessage({ command: 'requestMissionBriefingUI' });
        });
    }


    const usageBtn = document.getElementById('view-usage-context-btn');
    if (usageBtn) {
        usageBtn.addEventListener('click', () => {
            dom.usageModal.classList.add('visible');
            dom.usageListContainer.innerHTML = '<div style="text-align:center; padding: 20px;"><div class="spinner"></div> Calculating individual file tokens...</div>';
            vscode.postMessage({ command: 'requestContextUsage' });
        });
    }

    if (dom.usageCloseBtn) dom.usageCloseBtn.onclick = () => dom.usageModal.classList.remove('visible');
    if (dom.usageRefreshBtn) dom.usageRefreshBtn.onclick = () => {
        dom.usageListContainer.innerHTML = '<div style="text-align:center; padding: 20px;"><div class="spinner"></div> Recalculating...</div>';
        vscode.postMessage({ command: 'requestContextUsage' });
    };

    const resetBtn = document.getElementById('reset-context-bubble-btn');
    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            vscode.postMessage({ command: 'executeLollmsCommand', details: { command: 'resetContext', params: {} } });
        });
    }

    // --- REACTIVE CONTEXT SYNC FOR EXPANSION BLOCKS ---
    // Find all <add_files> blocks in the history and update them if files were added elsewhere
    const expansionBlocks = document.querySelectorAll('.expansion-request-block');
    expansionBlocks.forEach(block => {
        try {
            const blockId = block.id;
            const blockFiles = JSON.parse(block.getAttribute('data-files') || '[]');
            const currentFiles = files || [];
            let allIncluded = true;

            const listContainer = document.getElementById(`list-${blockId}`);
            if (listContainer) {
                const items = listContainer.querySelectorAll('.expansion-file-item');
                items.forEach((item: any, idx) => {
                    const path = blockFiles[idx];
                    const isIncluded = currentFiles.includes(path);
                    if (!isIncluded) allIncluded = false;

                    if (isIncluded) {
                        item.style.borderColor = 'var(--vscode-charts-green)';
                        item.style.background = 'rgba(15, 157, 88, 0.1)';
                        const icon = item.querySelector('.codicon');
                        if (icon) {
                            icon.className = 'codicon codicon-check';
                            icon.style.color = 'var(--vscode-charts-green)';
                        }
                    }
                });
            }

            const actionBtn = document.getElementById(`btn-${blockId}`) as HTMLButtonElement;
            if (actionBtn && allIncluded && !actionBtn.classList.contains('applied')) {
                actionBtn.innerHTML = `<span class="codicon codicon-check"></span> Added to Context`;
                actionBtn.className = 'code-action-btn applied';
                actionBtn.disabled = true;
            }
        } catch (e) {
            console.error("Failed to sync expansion block:", e);
        }
    });

    const muteBtn = document.getElementById('mute-context-btn');
    if (muteBtn) {
        muteBtn.addEventListener('click', () => {
            const isMuted = !state.capabilities?.disableProjectContext;
            vscode.postMessage({ 
                command: 'updateDiscussionCapabilitiesPartial', 
                partial: { disableProjectContext: isMuted } 
            });
        });
    }

    const refreshCtxBtn = document.getElementById('refresh-context-btn');
    if (refreshCtxBtn) {
        refreshCtxBtn.addEventListener('click', () => {
            vscode.postMessage({ command: 'calculateTokens' });
        });
    }

    const cancelCtxBtn = document.getElementById('cancel-tokens-btn');
    if (cancelCtxBtn) {
        cancelCtxBtn.addEventListener('click', () => {
            vscode.postMessage({ command: 'stopTokenCalculation' });
        });
    }

    const bulkDeleteSkillsBtn = document.getElementById('bulk-delete-skills-btn');
    if (bulkDeleteSkillsBtn) {
        bulkDeleteSkillsBtn.addEventListener('click', () => {
            showBulkDeleteSkillsModal(skills);
        });
    }
}

function showBulkDeleteSkillsModal(skills: any[]) {
    const modal = document.getElementById('bulk-delete-skills-modal');
    const list = document.getElementById('bulk-delete-skills-list');
    const master = document.getElementById('bulk-skills-select-all') as HTMLInputElement;
    const closeBtn = document.getElementById('bulk-delete-skills-close-btn');
    const runBtn = document.getElementById('bulk-delete-skills-run-btn');

    if (!modal || !list) return;

    list.innerHTML = skills.map(s => `
        <div class="checkbox-container" style="margin-bottom: 4px;">
            <input type="checkbox" class="bulk-skill-check" value="${s.id}" id="bulk-skill-check-${s.id}" checked>
            <label for="bulk-skill-check-${s.id}" style="font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer;">${s.name}</label>
        </div>
    `).join('');

    if (master) {
        master.checked = true;
        master.onchange = () => {
            list.querySelectorAll('.bulk-skill-check').forEach((cb: any) => cb.checked = master.checked);
        };
    }

    modal.classList.add('visible');

    const close = () => modal.classList.remove('visible');
    closeBtn!.onclick = close;

    runBtn!.onclick = () => {
        const selected = Array.from(document.querySelectorAll('.bulk-skill-check:checked')).map((el: any) => el.value);
        if (selected.length > 0) {
            vscode.postMessage({ command: 'bulkRemoveSkills', skillIds: selected });
            close();
        }
    };
}

function showBulkDeleteModal(files: string[]) {
    const modal = document.getElementById('bulk-delete-modal');
    const list = document.getElementById('bulk-delete-files-list');
    const master = document.getElementById('bulk-delete-select-all') as HTMLInputElement;
    const closeBtn = document.getElementById('bulk-delete-close-btn');
    const runBtn = document.getElementById('bulk-delete-run-btn');

    if (!modal || !list) return;

    list.innerHTML = files.map(f => `
        <div class="checkbox-container" style="margin-bottom: 4px;">
            <input type="checkbox" class="bulk-delete-file-check" value="${f}" id="bulk-del-check-${f}" checked>
            <label for="bulk-del-check-${f}" style="font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer;">${f}</label>
        </div>
    `).join('');

    if (master) {
        master.checked = true;
        master.onchange = () => {
            list.querySelectorAll('.bulk-delete-file-check').forEach((cb: any) => cb.checked = master.checked);
        };
    }

    modal.classList.add('visible');

    const close = () => modal.classList.remove('visible');
    closeBtn!.onclick = close;

    runBtn!.onclick = () => {
        const selected = Array.from(document.querySelectorAll('.bulk-delete-file-check:checked')).map((el: any) => el.value);
        if (selected.length > 0) {
            vscode.postMessage({ command: 'bulkDeleteContextFiles', files: selected });
            close();
        }
    };
}

function showBulkProcessModal(files: string[]) {
    const modal = document.getElementById('bulk-process-modal');
    const list = document.getElementById('bulk-files-list');
    const master = document.getElementById('bulk-process-select-all') as HTMLInputElement;
    const promptArea = document.getElementById('bulk-process-prompt') as HTMLTextAreaElement;
    const closeBtn = document.getElementById('bulk-process-close-btn');
    const runBtn = document.getElementById('bulk-process-run-btn');

    if (!modal || !list || !promptArea) return;

    list.innerHTML = files.map(f => `
        <div class="checkbox-container" style="margin-bottom: 4px;">
            <input type="checkbox" class="bulk-file-check" value="${f}" id="bulk-check-${f}" checked>
            <label for="bulk-check-${f}" style="font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer;">${f}</label>
        </div>
    `).join('');

    if (master) {
        master.checked = true;
        master.onchange = () => {
            list.querySelectorAll('.bulk-file-check').forEach((cb: any) => cb.checked = master.checked);
        };
    }

    promptArea.value = "Summarize this document and extract key insights.";
    modal.classList.add('visible');

    const close = () => modal.classList.remove('visible');
    closeBtn!.onclick = close;

    runBtn!.onclick = () => {
        const selected = Array.from(document.querySelectorAll('.bulk-file-check:checked')).map((el: any) => el.value);
        const instruction = promptArea.value.trim();
        if (selected.length > 0 && instruction) {
            vscode.postMessage({ command: 'bulkSummarizeContextFiles', files: selected, instruction });
            close();
        }
    };
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
            
            let detailsHtml = '';
            if (item.action === 'thought') {
                detailsHtml = `<div style="padding-top:6px; opacity: 0.9; white-space: pre-wrap; font-family: var(--vscode-editor-font-family);">${sanitizer.sanitize(item.result)}</div>`;
            } else {
                detailsHtml = `
                <details style="margin-top:4px;" ${item.status === 'in_progress' ? 'open' : ''}>
                    <summary style="opacity:0.7; cursor:pointer; font-size: 10px;">Details</summary>
                    <div style="background:var(--vscode-textCodeBlock-background); padding:6px; margin-top:4px; border-radius:4px; overflow-x:auto; font-family:var(--vscode-editor-font-family); border: 1px solid var(--vscode-widget-border);">
                        <div style="margin-bottom:4px;"><strong style="color:var(--vscode-descriptionForeground)">Parameters:</strong><pre style="margin: 4px 0 0 0; font-size: 11px; white-space: pre-wrap;">${sanitizer.sanitize(JSON.stringify(item.parameters, null, 2))}</pre></div>
                        ${item.result ? `<div><strong style="color:var(--vscode-descriptionForeground)">Result:</strong><pre style="margin: 4px 0 0 0; font-size: 11px; white-space: pre-wrap;">${sanitizer.sanitize(item.result.substring(0, 1500))}${item.result.length > 1500 ? '\n...[truncated]' : ''}</pre></div>` : ''}
                    </div>
                </details>`;
            }

            return `
            <div class="investigation-item" style="padding: 8px; border-bottom: 1px solid var(--vscode-widget-border); font-size: 12px;">
                <div style="display:flex; justify-content:space-between; align-items:center; font-weight:600;">
                    <span>${statusIcon} ${item.action === 'thought' ? 'Architect Thought' : item.action}</span>
                </div>
                ${detailsHtml}
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
            
            // Show Parameters for all tasks to allow inspection and editing
            if (task.parameters) {
                let editHtml = '';
                if (task.status === 'failed' || task.status === 'pending') {
                    editHtml = `
                    <div class="task-edit-zone" style="margin-top: 8px; border-top: 1px solid var(--vscode-widget-border); padding-top: 8px;">
                        <button class="code-action-btn edit-params-btn" data-task-id="${task.id}" style="margin-bottom: 4px;">
                            <span class="codicon codicon-edit"></span> Edit & Retry
                        </button>
                        <div id="edit-params-container-${task.id}" style="display: none; flex-direction: column; gap: 6px; margin-top: 4px;">
                            <label style="font-size: 10px; font-weight: bold; color: var(--vscode-descriptionForeground);">Edit JSON Parameters:</label>
                            <textarea id="edit-params-text-${task.id}" style="width: 100%; height: 120px; font-family: monospace; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 8px; border-radius: 4px;">${sanitizer.sanitize(JSON.stringify(task.parameters, null, 2))}</textarea>
                            <button class="code-action-btn apply-btn save-retry-params-btn" data-task-id="${task.id}" style="align-self: flex-start;">
                                <span class="codicon codicon-play"></span> Save & Run
                            </button>
                        </div>
                    </div>`;
                }

                resultHtml += `
                    <div class="task-result" style="margin-bottom: 4px;">
                        <details ${task.status === 'in_progress' || task.status === 'failed' ? 'open' : ''}>
                            <summary class="task-result-summary" style="opacity:0.7;">Task Details & Parameters</summary>
                            <div class="task-result-box" style="border-style: dashed; opacity: 0.9;">
                                <div style="font-size: 11px; font-weight: bold; color: var(--vscode-descriptionForeground); margin-bottom: 6px;">
                                    TOOL: <span style="color: var(--vscode-textLink-foreground);">${task.action}</span>
                                    ${task.model ? `<span style="margin-left: 8px; opacity: 0.7;">🤖 ${sanitizer.sanitize(task.model)}</span>` : ''}
                                    ${task.agent_skills && task.agent_skills.length > 0 ? `<span style="margin-left: 8px; opacity: 0.7;">💡 ${sanitizer.sanitize(task.agent_skills.join(', '))}</span>` : ''}
                                </div>
                                <pre style="margin:0; padding:4px; background:var(--vscode-editor-inactiveSelectionBackground); border-radius:4px;"><code>${sanitizer.sanitize(JSON.stringify(task.parameters, null, 2))}</code></pre>
                                ${editHtml}
                            </div>
                        </details>
                    </div>`;
            }

            if (task.result) {
                const isFailure = task.status === 'failed';
                const label = isFailure ? 'Failure Details' : 'Output';
                const resultBoxClass = isFailure ? 'failure' : 'success';
                const summaryClass = isFailure ? 'failure-text' : 'success-text';

                resultHtml += `
                    <div class="task-result">
                        <details ${isFailure ? 'open' : ''}>
                            <summary class="task-result-summary ${summaryClass}">${label}</summary>
                            <div class="task-result-box ${resultBoxClass}">${sanitizer.sanitize(task.result)}</div>
                        </details>
                    </div>`;
            }

            let metaTabsHtml = '';
            if (task.model) metaTabsHtml += `<div class="agent-meta-tab" title="Assigned Model"><span class="codicon codicon-hubot"></span> ${sanitizer.sanitize(task.model)}</div>`;
            if (task.agent_persona) metaTabsHtml += `<div class="agent-meta-tab" title="Persona"><span class="codicon codicon-organization"></span> Persona Set</div>`;
            if (task.agent_skills && task.agent_skills.length > 0) metaTabsHtml += `<div class="agent-meta-tab" title="Skills"><span class="codicon codicon-lightbulb"></span> ${task.agent_skills.length} Skills</div>`;
            if (task.agent_files && task.agent_files.length > 0) metaTabsHtml += `<div class="agent-meta-tab" title="Files Context"><span class="codicon codicon-file-code"></span> ${task.agent_files.length} Files</div>`;
            if (task.dependencies && task.dependencies.length > 0) metaTabsHtml += `<div class="agent-meta-tab" title="Waiting for Tasks"><span class="codicon codicon-git-merge"></span> Dep: [${task.dependencies.join(', ')}]</div>`;

            return `
                <li class="agent-card status-${task.status}" data-task-id="${task.id}">
                    <div class="agent-card-header">
                        <div style="display:flex; align-items:center; gap:8px;">
                            <div class="${statusClass}">${icon}</div>
                            <span style="font-weight:bold;">Agent Task ${task.id}</span>
                        </div>
                        <div style="display:flex; gap:8px; align-items:center;">
                            ${toolBadge}
                            ${retryButtonHtml}
                        </div>
                    </div>
                    <div class="agent-card-body">
                        <div class="task-description" style="margin-bottom: ${metaTabsHtml ? '8px' : '0'}; line-height: 1.4;">${sanitizer.sanitize(task.description)}</div>
                        ${metaTabsHtml ? `<div class="agent-meta-tabs">${metaTabsHtml}</div>` : ''}
                        ${resultHtml}
                    </div>
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
 * Checks all actionable blocks in a message. If all are red (applied), 
 * makes the "Apply All" button at the bottom red as well.
 */
export function checkAndSyncMessageAppliedState(messageId: string) {
    const wrapper = document.querySelector(`.message-wrapper[data-message-id='${messageId}']`);
    if (!wrapper) return;

    const applyAllBtn = wrapper.querySelector('.apply-all-btn') as HTMLButtonElement;
    if (!applyAllBtn) return;

    // Find all blocks that actually HAVE an Apply button. 
    // We ignore blocks that are just for display (no path header).
    const blockButtons = Array.from(wrapper.querySelectorAll('.code-actions .apply-btn'));
    
    if (blockButtons.length === 0) return;

    const allApplied = blockButtons.every(btn => btn.classList.contains('applied'));

    if (allApplied) {
        applyAllBtn.classList.add('applied');
        applyAllBtn.innerHTML = '<span class="codicon codicon-check"></span> All Changes Applied';
        applyAllBtn.disabled = true;
        
        // Also collapse the details if everything is finished to keep the view tidy
        wrapper.querySelectorAll('details.code-collapsible').forEach(d => (d as HTMLDetailsElement).open = false);
    } else {
        applyAllBtn.classList.remove('applied');
        applyAllBtn.disabled = false;
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

