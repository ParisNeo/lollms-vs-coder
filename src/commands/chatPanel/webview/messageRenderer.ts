import { dom, vscode, state } from './dom.js';
import { isScrolledToBottom } from './utils.js';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import mermaid from 'mermaid';
import Prism from 'prismjs';
import { renderWorkspaceMatrix } from './ui.js';

// CodeMirror imports
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { searchKeymap, openSearchPanel, search } from "@codemirror/search";
import { markdown } from "@codemirror/lang-markdown";
import { oneDark } from "@codemirror/theme-one-dark";


import { pluginRegistry, PluginContext } from './pluginSystem.js';
import { contextExpansionPlugin } from './plugins/contextExpansionPlugin.js';

// 🛠️ PLUGINS REGISTRY
import { registerPlugin, pluginRegistry } from './pluginSystem.js';
import { contextExpansionPlugin } from './plugins/contextExpansionPlugin.js';
import { projectMemoryPlugin } from './plugins/projectMemoryPlugin.js';
import { milestonePlugin } from './plugins/milestonePlugin.js';
import { processingPlugin } from './plugins/processingPlugin.js';
import { formPlugin } from './plugins/formPlugin.js';
import { fileOpPlugin } from './plugins/fileOpPlugin.js';
import { milestonePlugin } from './plugins/milestonePlugin.js';
import { breakpointPlugin } from './plugins/breakpointPlugin.js';
import { imageAssetPlugin } from './plugins/imageAssetPlugin.js';
import { imageGenPlugin } from './plugins/imageGenPlugin.js';
import { imageResultPlugin } from './plugins/imageResultPlugin.js';
import { planStatusPlugin } from './plugins/planStatusPlugin.js';
import { processingPlugin } from './plugins/processingPlugin.js';

function initPlugins() {
    pluginRegistry.length = 0; 
    registerPlugin(contextExpansionPlugin);
    registerPlugin(projectMemoryPlugin);
    registerPlugin(milestonePlugin);
    registerPlugin(processingPlugin);
    registerPlugin(formPlugin);
    registerPlugin(fileOpPlugin);
    registerPlugin(breakpointPlugin);
    registerPlugin(imageAssetPlugin);
    registerPlugin(imageGenPlugin);
    registerPlugin(imageResultPlugin);
    registerPlugin(planStatusPlugin);
}

initPlugins();


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
    ADD_TAGS: ['iframe', 'script', 'style', 'button', 'i', 'span', 'details', 'summary'],
    ADD_ATTR: [
        'target', 'allow', 'allowfullscreen', 'frameborder', 'scrolling', 
        'onclick', 'data-value', 'data-type', 'data-message-id', 'data-pid',
        'data-files', 'data-block-id', 'data-action', 'data-id', 'data-title', 
        'data-content', 'data-importance', 'data-mem-id'
    ],
    // IMPORTANT: Allow all classes for our custom UI blocks
    ADD_CLASSES: { 
        '*': [
            'expansion-request-block', 'context-expansion-block', 'expansion-header', 'expansion-body', 
            'expansion-file-list', 'expansion-file-item', 'code-action-btn', 'apply-btn', 
            'add-files-to-context-btn', 'add-and-reprompt-btn', 'copy-files-to-clipboard-btn',
            'learning-card', 'learning-card-header', 'learning-body', 'learning-title', 
            'learning-content', 'learning-meta', 'project-memory-block', 'memory-summary'
        ] 
    }
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

/**
 * Renders lines of code with a specific diff type (added, removed, or unchanged).
 */
function renderLines(lines: string[], type: 'added' | 'removed' | 'unchanged'): string {
    return lines.map(line => {
        // Escape special characters to ensure code symbols are rendered correctly.
        const escaped = line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
        const safeLine = escaped.length === 0 ? ' ' : escaped;
        return `<div class="aider-diff-line aider-diff-${type}"><span class="aider-diff-code">${safeLine}</span></div>`;
    }).join('');
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

    const svg = container.querySelector('svg') as unknown as SVGSVGElement;
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
/**
 * Renders a small interactive button to block decay for a specific memory.
 */
function renderReinforceTag(id: string): string {
    return `
    <div class="project-memory-block" style="border-left-color: var(--vscode-charts-green); margin: 8px 0;">
        <div style="display:flex; align-items:center; justify-content:space-between; padding: 8px 12px; background: rgba(15, 157, 88, 0.05);">
            <div style="display:flex; align-items:center; gap:10px;">
                <span class="codicon codicon-pulse" style="color:var(--vscode-charts-green)"></span>
                <span class="memory-summary-text" style="font-size: 10px;">REINFORCE MEMORY: ${sanitizer.sanitize(id)}</span>
            </div>
            <button class="code-action-btn apply-btn sync-memory-btn" 
                    data-action="update" 
                    data-id="${id}" 
                    data-importance="100"
                    title="Refresh this memory to prevent decay">
                <i class="codicon codicon-zap"></i> Reinforce
            </button>
        </div>
    </div>`;
}

function renderMemoryTag(action: string, id: string, title: string, content: string): string {
    const isDelete = action === 'delete';
    const actionLabel = isDelete ? 'Forgotten' : (action === 'update' ? 'Reinforced' : 'Learned');
    const headerTitle = `Genie Memory: ${actionLabel}`;

    if (isDelete) {
        return `
        <div class="project-memory-block memory-deleted" data-mem-id="${id}">
            <div class="memory-summary" style="padding: 10px;">
                <span class="codicon codicon-trash" style="color:var(--vscode-charts-red)"></span>
                <span class="memory-summary-text">REMOVED FROM MEMORY: ${sanitizer.sanitize(id)}</span>
            </div>
        </div>`;
    }

    const safeContent = encodeURIComponent(content);
    const safeTitle = encodeURIComponent(title);

    return `
    <div class="learning-card" data-mem-id="${id}">
        <div class="learning-card-header">
            <span class="codicon codicon-chip"></span>
            <span>${headerTitle}</span>
        </div>
        <div class="learning-body">
            <div class="learning-title">${sanitizer.sanitize(title || id)}</div>
            <div class="learning-content">${sanitizer.sanitize(content)}</div>
            <div class="learning-meta">
                <span>Identity: ${sanitizer.sanitize(id)}</span>
                <button class="icon-btn sync-memory-btn" 
                        data-action="${action}" 
                        data-id="${id}" 
                        data-title="${safeTitle}" 
                        data-content="${safeContent}"
                        title="Sync this discovery to project vault">
                    <i class="codicon codicon-sync"></i>
                </button>
            </div>
        </div>
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
        <button class="toolbar-tool" data-wrap-type="code" title="Code Block"><i class="codicon codicon-code"></i></button>
        <button class="toolbar-tool" id="edit-add-image" title="Add Image"><i class="codicon codicon-file-media"></i></button>
        <div class="toolbar-separator"></div>
        <button class="toolbar-tool" data-wrap-type="aider-search" title="Aider SEARCH"><i class="codicon codicon-search"></i><span>SEARCH</span></button>
        <button class="toolbar-tool" data-wrap-type="aider-sep" title="Aider Separator"><i class="codicon codicon-git-compare"></i><span>SEP</span></button>
        <button class="toolbar-tool" data-wrap-type="aider-replace" title="Aider REPLACE"><i class="codicon codicon-replace"></i><span>REPLACE</span></button>
        <div class="toolbar-separator"></div>
        <button class="toolbar-tool" data-wrap-type="bold" title="Bold"><i class="codicon codicon-bold"></i></button>
        <button class="toolbar-tool" data-wrap-type="italic" title="Italic"><i class="codicon codicon-italic"></i></button>
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
        const lineText = lines[i]; 
        const line = lineText.trim();
        const match = line.match(/^(\s{0,3})(`{3,})/);

        if (!inBlock) {
            // --- NAKED AIDER DETECTION ---
            // If we see a SEARCH marker outside a code fence, treat it as the start of a block
            if (lineText.startsWith('<<<<<<< SEARCH')) {
                inBlock = true;
                // Heuristic: Find the nearest file path mentioned in the 5 lines above
                let inferredPath = "";
                for (let k = i - 1; k >= Math.max(0, i - 5); k--) {
                    const pathMatch = lines[k].match(/[`"']?([a-zA-Z0-9._\-\/]+\.[a-z0-9]+)[`"']?/);
                    if (pathMatch) { inferredPath = pathMatch[1]; break; }
                }
                infos.push({ type: 'replace', path: inferredPath, stripFirstLine: false, start: currentOffset, isClosed: false });
                currentOffset += lineWithNewline.length;
                continue;
            }

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
                const nextLine = lines[i+1] ? lines[i+1].trim() : "";
                if (nextLine.startsWith('```') || nextLine === "") {
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
                    let prefix = parts[0].toLowerCase();
                    
                    if ((prefix === 'language' || prefix === 'lang') && parts.length > 2) {
                        prefix = parts[1].toLowerCase();
                        pathStr = parts.slice(2).join(':').trim();
                    } else {
                        pathStr = parts.slice(1).join(':').trim();
                    }
                    if (prefix === 'insert') type = 'insert';
                    else if (prefix === 'replace') type = 'replace';
                    else if (prefix === 'diff') type = 'diff';
                    else if (prefix === 'delete_code') type = 'delete';
                    else type = 'file';

                    pathStr = pathStr.replace(/\s*\(\d+\s+hunks?\)$/i, '').trim();
                } else if (headerText.toLowerCase() === 'diff') {
                    type = 'diff';
                }

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
            if (lineText.startsWith('<<<<<<< SEARCH')) {
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

function enhanceCodeBlocks(container: HTMLElement, messageId: string, contentSource?: any, isFinal: boolean = false) {
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
                originalContentText = Array.isArray(raw) ? raw.map(p => p.type === 'text' ? p.text : '').join('\n') : raw;
            } catch(e) {}
        }
    }

    const codeBlockInfos = extractFilePaths(originalContentText);
    let actionableBlockCount = 0;

    pres.forEach((pre, index) => {
        const code = pre.querySelector('code');
        if (!code || pre.parentElement?.classList.contains('code-collapsible') || pre.closest('.skill-preview')) return;

        const langMatch = code.className.match(/language-(\S+)/);
        let language = langMatch ? langMatch[1] : 'plaintext';
        let filePath = '', isDiff = false, diffFilePath = '';

        const info = codeBlockInfos[index];
        if (info) {
            if (info.type === 'file' || info.type === 'insert' || info.type === 'replace' || info.type === 'delete') filePath = info.path;
            else if (info.type === 'diff') { diffFilePath = info.path; isDiff = true; }
        }

        if (langMap[language.toLowerCase()]) language = langMap[language.toLowerCase()];
        code.className = `language-${language}`;

        let codeText = code.innerText;
        if (!isDiff && (language === 'diff' || looksLikeDiff(codeText))) {
            isDiff = true;
            const headerMatch = codeText.match(/^(?:---|\+\+\+)\s+(?:[ab]\/)?([^\s\n\r]+)/m);
            if (headerMatch && headerMatch[1] && headerMatch[1] !== '/dev/null') diffFilePath = headerMatch[1].trim();
        }

        // Improved Regex: More permissive with line endings and prevents eating into the 
        // replacement code if it starts with leading newlines.
        const aiderRegex = /<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>> REPLACE/g;
        const aiderMatches = [...codeText.matchAll(aiderRegex)];
        const isAider = aiderMatches.length > 0;
        const isDiagram = language === 'mermaid' || language === 'svg';
        const pathVal = isDiff ? diffFilePath : filePath;

        const details = document.createElement('details');
        details.className = 'code-collapsible';
        details.open = true;
        details.dataset.rawCode = codeText;
        details.id = `block-${messageId}-${index}`;

        const summary = document.createElement('summary');
        summary.className = 'code-summary';
        summary.innerHTML = `<div class="summary-lang-label"><span>${language}</span>${pathVal ? ` : <input type="text" class="path-editor-input" value="${pathVal}">` : ''}</div>`;

        const actions = document.createElement('div');
        actions.className = 'code-actions';
        summary.appendChild(actions);

        const isDisabled = !isFinal && (info ? !info.isClosed : false);
        actions.appendChild(createButton('Copy', 'codicon-copy', () => {
            vscode.postMessage({ command: 'copyToClipboard', text: codeText });
        }));

        // ADDED: Raw Aider Button
        if (isAider) {
            actions.appendChild(createButton('Raw', 'codicon-source-control', () => {
                if (dom.rawCodeDisplay) {
                    dom.rawCodeFilename.textContent = pathVal || "Unspecified File";
                    dom.rawCodeDisplay.textContent = codeText;
                    dom.rawCodeDisplay.dataset.messageId = messageId;
                    dom.rawCodeDisplay.dataset.blockIndex = String(index);
                    dom.rawCodeModal.classList.add('visible');
                }
            }, 'code-action-btn', 'Open manual stitching view'));
        }

        // ADDED: Save Button for all blocks
        actions.appendChild(createButton('Save', 'codicon-save', () => {
            vscode.postMessage({ command: 'saveCodeToFile', content: codeText, language: language });
        }, 'code-action-btn', 'Save code to file...'));

        // ADDED: Inspect Code Block Button
        if (pathVal) {
            actions.appendChild(createButton('Inspect', 'codicon-eye', () => {
                const isApplied = state.appliedState?.[messageId]?.[index]?.includes(-1) || false;
                vscode.postMessage({ 
                    command: 'inspectPatch', 
                    filePath: pathVal, 
                    content: codeText, 
                    messageId: messageId,
                    blockIndex: index,
                    type: isAider ? 'replace' : (isDiff ? 'diff' : 'file'),
                    isApplied: isApplied
                });
            }, 'code-action-btn', 'Inspect this code for potential errors'));
        }

        if (pathVal && ['file', 'replace', 'insert', 'diff'].includes(info?.type || (isAider ? 'replace' : ''))) {
            actionableBlockCount++;
            const currentMsgId = messageId;
            const blockIdx = index;
            const applyBtnId = `apply-btn-${currentMsgId}-${blockIdx}`;

            // Re-apply logic: Check if it's already applied to set initial visual state
            const appliedHunks = state.appliedState?.[currentMsgId]?.[blockIdx] || [];
            const isFullyApplied = appliedHunks.includes(-1);

            const applyBtn = createButton(
                isFullyApplied ? 'Re-apply' : 'Apply', 
                isFullyApplied ? 'codicon-check' : (isAider ? 'codicon-arrow-swap' : 'codicon-tools'), 
                () => {
                    const finalPath = (details.querySelector('.path-editor-input') as HTMLInputElement)?.value || pathVal;
                    const cmd = isDiff ? 'applyPatchContent' : (isAider ? 'replaceCode' : 'applyFileContent');

                    // Show spinner on the specific button
                    applyBtn.innerHTML = '<div class="spinner"></div>';

                    vscode.postMessage({ 
                        command: cmd, 
                        filePath: finalPath, 
                        content: codeText, 
                        messageId: currentMsgId, 
                        blockIndex: blockIdx 
                    });
                }, 
                `code-action-btn apply-btn ${isFullyApplied ? 'applied' : ''}`
            );
            applyBtn.id = applyBtnId;
            applyBtn.disabled = isDisabled; // Only disabled if block is still streaming/unclosed
            actions.appendChild(applyBtn);
        } else {
            // ADDED: Play button for code without path
            const runnableLangs = ['python', 'py', 'javascript', 'js', 'typescript', 'ts', 'bash', 'sh', 'powershell', 'pwsh'];
            if (runnableLangs.includes(language.toLowerCase())) {
                const runBtn = createButton('Run', 'codicon-play', () => {
                    runBtn.disabled = true;
                    runBtn.innerHTML = '<div class="spinner"></div>';
                    vscode.postMessage({ command: 'runScript', code: codeText, language: language });
                    setTimeout(() => { 
                        runBtn.disabled = false; 
                        runBtn.innerHTML = '<span class="codicon codicon-play"></span>'; 
                    }, 3000);
                }, 'code-action-btn apply-btn');
                runBtn.disabled = isDisabled;
                actions.appendChild(runBtn);
            }
        }

        const parent = pre.parentNode;
        if (!parent) return;

        // 1. Handle Diagrams
        if (isDiagram && !isDisabled) {
            const rz = document.createElement('div');
            rz.className = 'diagram-render-zone';
            parent.insertBefore(rz, pre);
            renderDiagram(code, language, rz);
        }

        // 2. Assemble Header (Summary)
        details.appendChild(summary);

        if (isAider) {
            // --- AIDER MODE: TABBED HUNK NAVIGATION ---
            const tabContainer = document.createElement('div');
            tabContainer.className = 'hunk-tabs-container';

            const nav = document.createElement('div');
            nav.className = 'hunk-tabs-nav';
            tabContainer.appendChild(nav);

            const contentWrapper = document.createElement('div');
            contentWrapper.className = 'hunk-contents-wrapper';
            tabContainer.appendChild(contentWrapper);

            const currentMsgId = messageId;
            const blockIdx = index;

            aiderMatches.forEach((m, hIdx) => {
                const appliedHunks = state.appliedState?.[currentMsgId]?.[blockIdx] || [];
                const isHunkApplied = appliedHunks.includes(hIdx) || appliedHunks.includes(-1);

                // 1. Create Tab
                const tab = document.createElement('div');
                tab.className = `hunk-tab hunk-tab-${hIdx} ${isHunkApplied ? 'status-completed' : ''}`;
                tab.innerHTML = `<span class="hunk-status-icon"><i class="codicon ${isHunkApplied ? 'codicon-check' : 'codicon-primitive-dot'}"></i></span> HUNK ${hIdx + 1}`;
                nav.appendChild(tab);

                // 2. Create Content Pane
                const pane = document.createElement('div');
                pane.className = `hunk-tab-content hunk-pane-${hIdx}`;
                pane.id = `pane-${currentMsgId}-${blockIdx}-${hIdx}`;

                const sLines = m[1].replace(/\r\n/g, '\n').split('\n');
                const rLines = m[2].replace(/\r\n/g, '\n').split('\n');
                let pref = 0;
                while (pref < sLines.length && pref < rLines.length && sLines[pref] === rLines[pref]) pref++;
                let suff = 0;
                while (suff < (sLines.length - pref) && suff < (rLines.length - pref) && sLines[sLines.length - 1 - suff] === rLines[rLines.length - 1 - suff]) suff++;

                pane.innerHTML = `
                    <div class="aider-hunk-bubble">
                        <div class="aider-hunk-content">
                            <pre style="margin:0; padding:12px; background:var(--vscode-editor-background); border:none; overflow:auto; max-height: 400px;">${renderLines(sLines.slice(0, pref), 'unchanged')}${renderLines(sLines.slice(pref, sLines.length - suff), 'removed')}${renderLines(rLines.slice(pref, rLines.length - suff), 'added')}${renderLines(sLines.slice(sLines.length - suff), 'unchanged')}</pre>
                        </div>
                        <div class="aider-hunk-header" style="border-top: 1px solid var(--vscode-widget-border); border-bottom: none;">
                            <div style="font-size: 10px; opacity:0.7;">Actions for Hunk ${hIdx + 1}</div>
                            <div class="aider-hunk-actions">
                                <button class="code-action-btn delete-btn undo-hunk-btn" style="display: ${isHunkApplied ? 'flex' : 'none'}" title="Undo this hunk"><i class="codicon codicon-discard"></i> UNDO</button>
                                <button class="code-action-btn apply-btn ${isHunkApplied ? 'applied' : ''}" title="Apply this hunk"><i class="codicon ${isHunkApplied ? 'codicon-check' : 'codicon-arrow-swap'}"></i> APPLY</button>
                            </div>
                        </div>
                    </div>
                `;

                // 3. Tab Interaction
                tab.onclick = () => {
                    nav.querySelectorAll('.hunk-tab').forEach(t => t.classList.remove('active'));
                    contentWrapper.querySelectorAll('.hunk-tab-content').forEach(p => p.classList.remove('active'));
                    tab.classList.add('active');
                    pane.classList.add('active');
                };

                // 4. Action Logic
                const hunkApply = pane.querySelector('.apply-btn') as HTMLElement;
                const hunkUndo = pane.querySelector('.undo-hunk-btn') as HTMLElement;

                hunkApply.onclick = () => {
                    const finalPath = (details.querySelector('.path-editor-input') as HTMLInputElement)?.value || pathVal;
                    hunkApply.disabled = true;
                    vscode.postMessage({ command: 'replaceCode', filePath: finalPath, content: m[0], messageId: currentMsgId, blockIndex: blockIdx, hunkIndex: hIdx });
                };

                hunkUndo.onclick = () => {
                    const finalPath = (details.querySelector('.path-editor-input') as HTMLInputElement)?.value || pathVal;
                    hunkUndo.disabled = true;
                    vscode.postMessage({ command: 'replaceCode', filePath: finalPath, content: m[0], messageId: currentMsgId, blockIndex: blockIdx, hunkIndex: hIdx, options: { undo: true } });
                };

                if (hIdx === 0) { tab.classList.add('active'); pane.classList.add('active'); }
                contentWrapper.appendChild(pane);
            });

            details.appendChild(tabContainer);
            pre.replaceWith(details);
        } else {
            // --- STANDARD MODE: GUTTER + SYNTAX HIGHLIGHTING ---
            pre.style.display = 'flex';
            pre.style.flexDirection = 'row';
            pre.style.overflow = 'auto';

            const gutter = document.createElement('div');
            gutter.className = 'code-line-gutter';
            const lineCount = codeText.split('\n').length;
            gutter.innerHTML = Array.from({ length: lineCount }, (_, i) => i + 1).join('<br>');

            pre.insertBefore(gutter, pre.firstChild);
            
            // Move the original pre inside the details
            parent.replaceChild(details, pre);
            details.appendChild(pre);

            Prism.highlightElement(code);
        }
    });
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
    // Expose to window so that artifacts inside Agent Cards can use it during dynamic rendering
    if (!(window as any).processThinkTags) {
        (window as any).processThinkTags = processThinkTags;
    }
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

/**
 * Renders the high-fidelity Aider hunk-by-hunk visualizer
 */
function renderAiderDiff(pre: HTMLElement, rawCode: string, filePath: string, messageId: string, blockIdx: number, isFinal: boolean) {
    const details = document.createElement('details');
    details.className = 'code-collapsible aider-diff-container';
    details.open = true;
    details.id = `block-${messageId}-${blockIdx}`;
    details.setAttribute('data-raw-code', rawCode);

    const summary = document.createElement('summary');
    summary.className = 'code-summary';
    summary.innerHTML = `
        <div class="summary-lang-label">
            <span class="codicon codicon-diff-modified"></span>
            <input type="text" class="path-editor-input" value="${filePath}" 
                   onchange="this.closest('.code-collapsible').dataset.path = this.value"
                   title="Edit target path if incorrect">
        </div>
        <div class="code-actions">
            <button class="code-action-btn apply-btn apply-all-btn" id="apply-btn-${messageId}-${blockIdx}">
                <span class="codicon codicon-tools"></span> Apply All
            </button>
        </div>
    `;

    const hunkGroup = document.createElement('div');
    hunkGroup.className = 'aider-hunk-group';

    // IMPROVED REGEX: More permissive with line endings to ensure no hunks are missed
    const aiderRegex = /<<<<<<< SEARCH\s*[\r\n]+([\s\S]*?)[\r\n]+=======[\r\n]+([\s\S]*?)[\r\n]+>>>>>>> REPLACE/g;
    const matches = [...rawCode.matchAll(aiderRegex)];

    matches.forEach((match, hIdx) => {
        const searchPart = match[1];
        const replacePart = match[2];

        const hunkBubble = document.createElement('div');
        hunkBubble.className = 'aider-hunk-bubble';
        hunkBubble.innerHTML = `
            <div class="aider-hunk-header" onclick="this.parentElement.classList.toggle('collapsed')">
                <div style="display:flex; align-items:center; gap:8px;">
                    <i class="codicon codicon-chevron-down hunk-toggle-icon"></i>
                    <span>HUNK ${hIdx + 1} of ${matches.length}</span>
                </div>
                <div class="aider-hunk-actions">
                    <button class="code-action-btn apply-btn" data-block-index="${blockIdx}" data-hunk-index="${hIdx}">
                        <span class="codicon codicon-arrow-swap"></span> Apply Hunk
                    </button>
                </div>
            </div>
            <div class="aider-hunk-content">
                ${searchPart.split('\n').map(l => `<div class="aider-diff-line aider-diff-removed">${l}</div>`).join('')}
                ${replacePart.split('\n').map(l => `<div class="aider-diff-line aider-diff-added">${l}</div>`).join('')}
            </div>
        `;
        hunkGroup.appendChild(hunkBubble);
    });

    details.appendChild(summary);
    details.appendChild(hunkGroup);
    pre.replaceWith(details);
}


export function renderFileOpBlock(type: 'delete' | 'move' | 'copy' | 'prune', params: any, messageId: string): string {
    const blockId = `file-op-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
    let title = "";
    let icon = "";
    let detailsHtml = "";
    let buttonText = "";
    let command = "";
    let cmdData = {};

    switch (type) {
        case 'prune':
            const prunePaths = Array.isArray(params.paths) ? params.paths :[];
            title = "Propose Context Pruning";
            icon = "codicon-clear-all";
            buttonText = "Remove from Context";
            detailsHtml = prunePaths.map((p: string) => `<div class="expansion-file-item"><span class="codicon codicon-history"></span> <span>${sanitizer.sanitize(p)}</span></div>`).join('');
            command = "syncFilesContext";
            cmdData = { remove: prunePaths };
            break;
        case 'delete':
            const delPaths: string[] = Array.isArray(params.paths) ? params.paths : (params.path ? [params.path] :[]);
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
        case 'copy':
            const ops: {src: string, dest: string}[] = params.operations ||[];
            title = type === 'move' ? "Propose Move/Rename" : "Propose Copy";
            icon = type === 'move' ? "codicon-arrow-swap" : "codicon-files";
            buttonText = type === 'move' ? "Apply Move" : "Apply Copy";
            detailsHtml = ops.map((op: {src: string, dest: string}) => `
                <div class="file-operation-details" style="margin-bottom:4px;">
                    <span class="path-old">${sanitizer.sanitize(op.src)}</span>
                    <span class="codicon codicon-arrow-right file-operation-arrow"></span>
                    <span class="path-new">${sanitizer.sanitize(op.dest)}</span>
                </div>
            `).join('');
            command = type === 'move' ? "bulkMoveFiles" : "bulkCopyFiles";
            cmdData = { operations: ops };
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

    const safeMsgId = messageId || "agent_plan";
    return `
    <div class="lollms-form-block" data-form-id="${formId}" id="form-${formId}">
        <div class="lollms-form-header">
            <span class="codicon codicon-question"></span>
            <span>${sanitizer.sanitize(title)}</span>
        </div>
        <div class="lollms-form-body">
            ${inputsHtml}
        </div>
        <div class="lollms-form-footer">
            <button class="code-action-btn apply-btn lollms-form-submit-btn" 
                    id="btn-submit-${formId}"
                    data-form-id="${formId}" 
                    data-message-id="${safeMsgId}">
                <span class="codicon codicon-check"></span> <span>${sanitizer.sanitize(submitLabel)}</span>
            </button>
        </div>
    </div>`;
}

function renderMilestoneCard(attrs: any): string {
    return `
    <div class="milestone-card">
        <div class="milestone-card-header">
            <span class="codicon codicon-bookmark"></span>
            <h3>Milestone: ${sanitizer.sanitize(attrs.title)}</h3>
        </div>
        <div class="milestone-body">
            <div class="milestone-section win">
                <div class="milestone-section-title"><span class="codicon codicon-check"></span> Achievements</div>
                <div class="milestone-section-content">${sanitizer.sanitize(attrs.achievements)}</div>
            </div>
            <div class="milestone-section hurdle">
                <div class="milestone-section-title"><span class="codicon codicon-warning"></span> Challenges & Hurdles</div>
                <div class="milestone-section-content">${sanitizer.sanitize(attrs.challenges)}</div>
            </div>
            <div class="milestone-section fix">
                <div class="milestone-section-title"><span class="codicon codicon-tools"></span> Applied Solutions</div>
                <div class="milestone-section-content">${sanitizer.sanitize(attrs.solutions)}</div>
            </div>
        </div>
    </div>`;
}



interface MessageSegment {
    type: 'markdown' | 'plugin';
    content: string;
    start: number;
    end: number;
    plugin?: any;
    match?: RegExpExecArray;
}

export function renderMessageContent(messageId: string, rawContent: any, isFinal: boolean = false) {
    const wrapper = document.querySelector(`.message-wrapper[data-message-id='${messageId}']`);
    if (!wrapper) return;
    const contentDiv = wrapper.querySelector('.message-content') as HTMLElement;
    if (!contentDiv) return;

    let sourceText = "";
    if (Array.isArray(rawContent)) {
        sourceText = rawContent.filter(p => p.type === 'text').map(p => p.text).join('\n');
    } else {
        sourceText = String(rawContent || "");
    }

    const forbidden: {start: number, end: number}[] = [];
    const fenceRegex = /```[\s\S]*?(?:```|$)|`[^`]+`/g;
    let fMatch;
    while ((fMatch = fenceRegex.exec(sourceText)) !== null) {
        forbidden.push({ start: fMatch.index, end: fMatch.index + fMatch[0].length });
    }

    const segments: MessageSegment[] = [];
    const ctx: PluginContext = { messageId, isFinal, capabilities: state.capabilities, vscode };

    pluginRegistry.forEach(plugin => {
        plugin.tagPattern.lastIndex = 0;
        let pMatch;
        while ((pMatch = plugin.tagPattern.exec(sourceText)) !== null) {
            const matchIndex = pMatch.index;
            const fullMatch = pMatch[0];
            const isInside = forbidden.some(r => matchIndex >= r.start && matchIndex < r.end);
            if (isInside) continue;

            const textBefore = sourceText.substring(0, matchIndex);
            const lastNewline = textBefore.lastIndexOf('\n');
            const linePrefix = lastNewline === -1 ? textBefore : textBefore.substring(lastNewline + 1);
            if (linePrefix.trim().length > 0) continue;

            const html = plugin.render(pMatch, ctx);
            if (html) {
                segments.push({
                    type: 'plugin',
                    content: html,
                    start: matchIndex,
                    end: matchIndex + fullMatch.length,
                    plugin
                });
            }
        }
    });

    const allSegments: MessageSegment[] = [...segments];
    allSegments.sort((a, b) => a.start - b.start);

    const finalSegments: MessageSegment[] = [];
    let cursor = 0;

    allSegments.forEach(seg => {
        if (seg.start > cursor) {
            finalSegments.push({
                type: 'markdown',
                content: sourceText.substring(cursor, seg.start),
                start: cursor,
                end: seg.start
            });
        }
        finalSegments.push(seg);
        cursor = seg.end;
    });

    if (cursor < sourceText.length) {
        finalSegments.push({
            type: 'markdown',
            content: sourceText.substring(cursor),
            start: cursor,
            end: sourceText.length
        });
    }

    let finalHtml = "";
    finalSegments.forEach(seg => {
        if (seg.type === 'plugin') {
            finalHtml += seg.content;
        } else {
            finalHtml += `<div class="markdown-body">${marked.parse(seg.content)}</div>`;
        }
    });

    // --- APPLY ALL AGGREGATOR (RE-INTEGRATED) ---
    const globalBlockInfos = extractFilePaths(sourceText);
    const actionableBlockCount = globalBlockInfos.filter(info => info.type !== null && info.path).length;

    if (actionableBlockCount > 1 && isFinal) {
        finalHtml += `
            <div class="apply-all-wrapper" style="margin-top: 16px; padding: 0 12px;">
                <button class="apply-all-btn" id="apply-all-${messageId}">
                    <span class="codicon codicon-check-all"></span> Apply All Changes (${actionableBlockCount} files)
                </button>
                <div class="apply-progress-container" id="progress-container-${messageId}" style="display:none; height:4px; background:var(--vscode-widget-border); border-radius:2px; margin-top:8px; overflow:hidden;">
                    <div class="apply-progress-bar" id="progress-bar-${messageId}" style="width:0%; height:100%; background:var(--vscode-charts-blue); transition: width 0.3s ease;"></div>
                </div>
                <div class="apply-results-list" id="results-${messageId}" style="display:none; margin-top:8px;"></div>
            </div>`;
    }


    contentDiv.innerHTML = DOMPurify.sanitize(finalHtml, SANITIZE_CONFIG);
    enhanceCodeBlocks(contentDiv, messageId, rawContent, isFinal);

        // Attach listener for the new Apply All button
        const applyAllBtn = contentDiv.querySelector(`#apply-all-${messageId}`) as HTMLButtonElement;
        if (applyAllBtn) {
            applyAllBtn.onclick = () => {
                const changes = gatherChangesFromBlocks(messageId);
                if (changes.length > 0) {
                    // REDIRECTION: Open the Staging Modal instead of immediate apply
                    import('./ui.js').then(ui => {
                        ui.openStagingRevamp(messageId, changes);
                    });
                }
            };
        }

    // --- APPLY ALL AGGREGATOR ---
    // Note: The main Apply All button logic is handled via gatherChangesFromBlocks 
    // triggered by either the static button in finalHtml or a dynamically injected one.
    const btn = contentDiv.querySelector(`.apply-all-btn`) as HTMLButtonElement;
    if (btn) {
        btn.onclick = () => {
            const changes = gatherChangesFromBlocks(messageId);
            if (changes.length > 0) {
                btn.disabled = true;
                btn.innerHTML = '<span class="codicon codicon-sync spin"></span> Applying Batch...';

                const resList = document.getElementById(`results-${messageId}`);
                const progressContainer = document.getElementById(`progress-container-${messageId}`);

                if (resList) {
                    resList.style.display = 'block';
                    resList.innerHTML = changes.map(c => `
                        <div class="apply-row" data-block-index="${c.blockIndex}" ${c.hunkIndex !== undefined ? `data-hunk-index="${c.hunkIndex}"` : ''}>
                            <span class="status-icon"><div class="spinner"></div></span>
                            <span class="row-path">${c.path} ${c.hunkIndex !== undefined ? `(Hunk ${c.hunkIndex+1})` : ''}</span>
                            <div class="row-actions" style="display:none"></div>
                        </div>`).join('');
                }

                if (progressContainer) {
                    progressContainer.style.display = 'block';
                    const bar = progressContainer.querySelector('.apply-progress-bar') as HTMLElement;
                    if (bar) bar.style.width = '0%';
                }

                vscode.postMessage({ command: 'applyAllChanges', changes, messageId });
            }
        };
    }

    finalSegments.forEach(seg => {
            if (seg.type === 'plugin' && seg.plugin?.initialize) {
            seg.plugin.initialize(contentDiv, ctx);
        }
    });
}









function gatherChangesFromBlocks(messageId: string) {
    const changes: any[] = [];
    const wrapper = document.querySelector(`.message-wrapper[data-message-id='${messageId}']`);
    if (!wrapper) return changes;

    const blocks = wrapper.querySelectorAll('details.code-collapsible');
    blocks.forEach((block: any) => {
        const idParts = block.id.split('-');
        const blockIndex = parseInt(idParts[idParts.length - 1], 10);
        const codeText = block.dataset.rawCode || "";

        // RE-INTEGRATED: User-edited path recovery
        const pathInp = block.querySelector('.path-editor-input') as HTMLInputElement;
        const path = pathInp ? pathInp.value.trim() : "";
        if (!path) return;

        const hunkBubbles = block.querySelectorAll('.aider-hunk-bubble');
        if (hunkBubbles.length > 0) {
            hunkBubbles.forEach((hunk: any, hIdx: number) => {
                const btn = hunk.querySelector('.apply-btn');
                if (btn && !btn.classList.contains('applied')) {
                    changes.push({
                        type: 'replace',
                        path: path,
                        content: codeText, 
                        label: `${path} (Hunk ${hIdx + 1})`,
                        blockIndex: blockIndex,
                        hunkIndex: hIdx
                    });
                }
            });
        } else {
            const applyBtn = block.querySelector('.code-actions .apply-btn');
            if (applyBtn && !applyBtn.classList.contains('applied')) {
                const labelText = block.querySelector('.summary-lang-label span')?.textContent || "";
                const type = labelText.toLowerCase().includes('diff') ? 'diff' : 'file';
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
    if (dom.welcomeMessage) {
        dom.welcomeMessage.style.display = 'none';
    }

    const content = typeof message.content === 'string' ? message.content : "";
    
    // DETECTOR: Identify purely technical messages to un-wrap them
    const technicalPatterns = [
        '<agent_task', 
        '<milestone', 
        '<project_memory', 
        '<git_event', 
        '<lollms_form'
    ];
    
    // Ensure builder_report is recognized as purely technical to remove chat bubble styling
    const isPurelyTechnical = technicalPatterns.some(p => content.trim().includes(p)) || content.includes('<builder_report>');

    if (message.role === 'system' && content.startsWith('Attached file:')) {
        addAttachment(message);
    } else {
        addChatMessage(message, isFinal, isPurelyTechnical);
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

function addChatMessage(message: any, isFinal: boolean = true, isTechnical: boolean = false) {
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
    messageDiv.className = `message ${role}-message ${isTechnical ? 'technical-event' : ''}`;
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

const renderDataBriefing = (briefing: string) => {
    const raw = (briefing || "").trim();
    if (!raw) return ""; // Return empty if truly empty
    try {
        if (!raw.startsWith('{')) return raw;
        const entries = JSON.parse(raw);
        const keys = Object.keys(entries);
        if (keys.length === 0) return "";
        return keys.map(id => {
            const title = id.replace(/_/g, ' ').toUpperCase();
            return `<strong>[${title}]</strong><br>${entries[id]}`;
        }).join('<br><br>');
    } catch { return raw; }
};

export function updateContext(contextText: string, files: string[] = [], skills: any[] = [], diagrams: any[] = [], briefing: string = "") {
    if(!dom.contextContainer) return;

    // MERGE PERSISTENCE: If files are empty in this message, preserve the ones we already know about
    const existingFiles = state.lastContextData?.files || [];
    const finalFiles = (files && files.length > 0) ? files : existingFiles;

    state.lastContextData = { context: contextText, files: finalFiles, skills, diagrams, briefing };

    // Detection for Welcome Message integration
    const isNewDiscussion = !document.querySelector('.message-wrapper:not(.context-message)');

    const isProjectFile = (f: string) => {
        const isInternal = f.includes('.lollms/') || f.startsWith('http') || f.startsWith('external/');
        return !isInternal;
    };

    const projectFiles = files.filter(isProjectFile);
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

    const isAgentActive = state.capabilities?.agentMode === true;

    // THEME LOGIC:
    // Agent Mode = Red (Genie has taken over)
    // Standard = Blue (Librarian/Architect mode)
    const themeClass = isAgentActive ? 'agent-mode-bubble' : 'standard-mode-bubble';

    const welcomeHtml = isNewDiscussion ? `
        <div id="welcome-message" style="padding: 15px; margin-bottom: 10px; background: rgba(0,0,0,0.1); border-radius: 6px; font-size: 12px; line-height: 1.5; border: 1px dashed var(--vscode-widget-border);">
            <h3 style="margin-top:0; font-size:14px; color: var(--vscode-textLink-foreground);"><i class="codicon codicon-rocket"></i> Welcome to Lollms VS Coder</h3>
            <ul style="padding-left: 20px; margin-bottom: 0;">
                <li>Add files to context by right-clicking them in the explorer.</li>
                <li>Use 🤖 <strong>Agent Mode</strong> for complex multi-step tasks.</li>
                <li>Toggle 🧠 <strong>Auto-Context</strong> to let the AI find relevant code for you.</li>
                <li>Check the 🔌 <strong>API status</strong> in the header above.</li>
            </ul>
        </div>` : "";

    const innerHTML = `
    <div class="context-message ${themeClass}" id="fused-context-dashboard">
        <details class="fused-context-details">
            <summary>
                <div class="fused-hud-header" style="display: flex; flex-direction: column; gap: 10px; padding: 12px; background: rgba(0,0,0,0.2); border-bottom: 1px solid rgba(255,255,255,0.05);">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <div id="badge-dashboard-panel" style="display: flex; align-items: center; gap: 10px;">
                            ${isAgentActive 
                                ? `<div class="agent-active-indicator">
                                    <div class="genie-orb-portal" style="transform: scale(0.55);">
                                        <div class="orb-ring-outer"></div>
                                        <div class="orb-ring-inner"></div>
                                        <div class="orb-core"></div>
                                    </div>
                                   </div>` 
                                : '<span class="codicon codicon-library" style="opacity:0.6;"></span>'}
                            <div class="active-badges" id="active-badges"></div>
                        </div>
                        <div style="display: flex; align-items: center; gap: 12px;">
                            <button id="hud-matrix-btn" class="icon-btn" title="Workspace Access Matrix" style="color: var(--vscode-textLink-foreground); padding: 2px;">
                                <i class="codicon codicon-layers" style="font-size: 14px;"></i>
                            </button>
                            <span id="status-text" style="font-size: 10px; font-weight: 900; opacity: 0.4; letter-spacing: 0.5px;">READY</span>
                            <i class="codicon codicon-chevron-down hud-toggle-icon" style="opacity:0.5; font-size: 12px;"></i>
                        </div>
                    </div>

                    <div class="token-fused-bar" style="display: flex; flex-direction: column; gap: 4px;">
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <button id="hud-quick-refresh-btn" class="icon-btn" title="Refresh Token Count" style="padding: 0; color: var(--vscode-descriptionForeground); opacity: 0.6;">
                                <i class="codicon codicon-refresh" style="font-size: 10px;"></i>
                            </button>
                            <div class="token-progress-container" id="token-progress-container" style="flex: 1; height: 4px; border-radius: 2px; background: rgba(255,255,255,0.03);">
                                <div class="token-progress-bar" id="token-progress-bar"></div>
                            </div>
                        </div>
                        <div style="display: flex; justify-content: space-between; align-items: center;">
                            <span id="token-count-label" style="font-size: 9px; opacity: 0.4; font-family: var(--vscode-editor-font-family);">Calculating...</span>
                            <div id="token-bar-legend" class="token-legend" style="display: none; gap: 10px;"></div>
                        </div>
                    </div>
                </div>
            </summary>

            <div class="message-body" style="padding: 16px;">
                <div id="welcome-message" style="display: ${isNewDiscussion ? 'block' : 'none'}; padding: 12px; margin-bottom: 20px; background: rgba(0,0,0,0.15); border-radius: 6px; border: 1px dashed var(--vscode-widget-border);">
                    <h3 style="margin:0 0 8px 0; font-size:13px; color: var(--vscode-textLink-foreground); display:flex; align-items:center; gap:8px;">
                        <i class="codicon codicon-rocket"></i> Welcome to Lollms VS Coder
                    </h3>
                    <ul style="padding-left: 20px; margin: 0; font-size: 11px; opacity: 0.85; display: flex; flex-direction: column; gap: 4px;">
                        <li>Right-click files in the explorer to <b>Include in AI Context</b>.</li>
                        <li>Toggle 🤖 <b>Agent Mode</b> for complex autonomous missions.</li>
                        <li>Toggle 🧠 <b>Auto-Context</b> to let the AI scout relevant files for you.</li>
                        <li>Select your preferred 🔌 <b>Model and Persona</b> in the header above.</li>
                    </ul>
                </div>

                <div class="message-header" style="display: flex; justify-content: space-between; align-items: center; width: 100%; margin-bottom: 12px;">
                    <div style="display:flex; align-items:center; gap:8px;">
                        <span class="role-name">Intelligence Context</span>
                    </div>
                    <div style="display: flex; gap: 8px; align-items: center;">
                        <div style="display:flex; gap:4px; margin-right:8px; padding-right:8px; border-right:1px solid var(--vscode-widget-border);">
                            <button class="icon-btn" title="Copy Discussion as Markdown" onclick="vscode.postMessage({command:'executeLollmsCommand', details:{command:'lollms-vs-coder.copyDiscussionMarkdown'}})"><i class="codicon codicon-markdown"></i></button>
                            <button class="icon-btn" title="Export Discussion as HTML" onclick="vscode.postMessage({command:'executeLollmsCommand', details:{command:'lollms-vs-coder.exportDiscussionHtml'}})"><i class="codicon codicon-cloud-download"></i></button>
                        </div>
                        <button id="refresh-context-btn" class="icon-btn" title="Force refresh context & recalculate bar" style="padding: 2px; color: var(--vscode-charts-blue);"><i class="codicon codicon-sync"></i></button>
                        <button id="save-context-btn" class="icon-btn" title="Save file selection" style="padding: 2px;"><i class="codicon codicon-save"></i></button>
                        <button id="load-context-btn" class="icon-btn" title="Load file selection" style="padding: 2px;"><i class="codicon codicon-folder-opened"></i></button>
                        <button id="reset-context-bubble-btn" class="icon-btn" title="Full Context Reset" style="padding: 2px; color: var(--vscode-errorForeground);"><i class="codicon codicon-clear-all"></i></button>
                    </div>
                </div>

                <div class="message-content">
                    <details class="info-collapsible" style="margin-bottom: 6px; border-left: 4px solid var(--vscode-charts-purple);" ${briefing ? 'open' : ''}>
                        <summary>
                            <div style="display: flex; justify-content: space-between; align-items: center; width: calc(100% - 20px);">
                                <span>Mission Briefing & Constraints</span>
                                <button id="edit-briefing-btn" class="icon-btn" title="Edit Briefing" style="color: var(--vscode-charts-purple);"><i class="codicon codicon-shield"></i></button>
                            </div>
                        </summary>
                        <div class="collapsible-content">
                            <div class="briefing-content" style="padding: 10px; font-size: 12px; line-height: 1.5; opacity: 0.9;">
                                ${briefing ? renderDataBriefing(briefing) : '<div style="font-style:italic; opacity:0.5;">No specific task constraints defined. Click the shield to add instructions.</div>'}
                            </div>
                        </div>
                    </details>

                    <details class="info-collapsible" style="margin-bottom: 6px;">
                        <summary>
                            <div style="display: flex; justify-content: space-between; align-items: center; width: calc(100% - 20px);">
                                <span>Selected Files (${files.length})</span>
                                <div style="display: flex; gap: 8px; align-items: center;">
                                    <button id="view-usage-context-btn" class="icon-btn" title="Verify File Sizes / Token Usage"><i class="codicon codicon-dashboard"></i></button>
                                    <div style="width: 1px; height: 12px; background: var(--vscode-widget-border);"></div>
                                    <button id="add-file-context-btn" class="icon-btn" title="Add File"><i class="codicon codicon-add"></i></button>
                                    <button id="web-context-btn" class="icon-btn" title="Web Discovery"><i class="codicon codicon-globe"></i></button>
                                    <button id="search-add-context-btn" class="icon-btn" title="Power Search"><i class="codicon codicon-search"></i></button>
                                </div>
                            </div>
                        </summary>
                        <div class="collapsible-content" style="padding-top: 8px;">
                            <h4 style="margin: 0 0 8px 4px; font-size: 11px; opacity: 0.7; text-transform: uppercase; display: flex; justify-content: space-between; align-items: center;">
                                <span>Project Files</span>
                                ${projectFiles.length > 0 ? `<button id="bulk-remove-project-btn" class="section-bulk-btn"><span class="codicon codicon-checklist"></span> Bulk Remove</button>` : ''}
                            </h4>
                            ${renderFileList(projectFiles, "No project files selected.", false)}
                            <h4 style="margin: 12px 0 8px 4px; font-size: 11px; opacity: 0.7; text-transform: uppercase; display: flex; justify-content: space-between; align-items: center;">
                                <span>External & Research</span>
                                ${externalFiles.length > 0 ? `<div style="display: flex; gap: 4px;"><button id="bulk-process-external-btn" class="section-bulk-btn"><span class="codicon codicon-wand"></span> Process</button><button id="bulk-delete-external-btn" class="section-bulk-btn delete"><span class="codicon codicon-trash"></span> Delete</button></div>` : ''}
                            </h4>
                            ${renderFileList(externalFiles, "No search results or external data in context.", true)}
                        </div>
                    </details>
                    <details class="info-collapsible" style="margin-bottom: 6px;">
                        <summary>
                            <div style="display: flex; justify-content: space-between; align-items: center; width: calc(100% - 20px);">
                                <span>Active Diagrams (${diagrams?.length || 0})</span>
                                <button id="add-diagram-context-btn" class="icon-btn" title="Add Diagram"><i class="codicon codicon-add"></i></button>
                            </div>
                        </summary>
                        <div class="collapsible-content">
                            ${diagrams && diagrams.length > 0 ? diagrams.map(d => `<div class="context-item" style="flex-direction:column; align-items:stretch;"><div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:5px;"><span style="font-weight:bold; font-size:11px;">${d.type.replace('_', ' ').toUpperCase()}</span><button class="remove-context-btn" data-type="diagram" data-value="${d.type}"><span class="codicon codicon-close"></span></button></div><pre class="mermaid" style="background:var(--vscode-editor-background); border-radius:4px; padding:5px;">${d.mermaid}</pre></div>`).join('') : '<div class="empty-context-msg">No diagrams included.</div>'}
                        </div>
                    </details>
                    <details class="info-collapsible">
                        <summary>
                            <div style="display: flex; justify-content: space-between; align-items: center; width: calc(100% - 20px);">
                                <span>Active Skills (${skills.length})</span>
                                <div style="display: flex; gap: 8px; align-items: center;">
                                    <button id="add-skill-context-btn" class="icon-btn" title="Import Skill"><i class="codicon codicon-add"></i></button>
                                    ${skills.length > 0 ? `<button id="bulk-delete-skills-btn" class="section-bulk-btn delete" style="margin-right: 5px;"><span class="codicon codicon-trash"></span> Bulk Remove</button>` : ''}
                                </div>
                            </div>
                        </summary>
                        <div class="collapsible-content">
                            ${skillsList}
                        </div>
                    </details>
                </div>
            </div>
        </details>
    </div>`;
    
    const hasMetadata = files.length > 0 || skills.length > 0 || (diagrams && diagrams.length > 0);
    dom.contextContainer.innerHTML = (contextText || hasMetadata) ? innerHTML : '';

    const markdownView = dom.contextContainer.querySelector('.markdown-context-view');
    if (markdownView) {
        enhanceCodeBlocks(markdownView as HTMLElement, messageId, contextText, true);
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

    const bulkRemoveProjectBtn = document.getElementById('bulk-remove-project-btn');
    if (bulkRemoveProjectBtn) {
        bulkRemoveProjectBtn.onclick = () => {
            // Re-use the existing bulk delete modal logic but for project files
            if (typeof (window as any).showBulkDeleteModal === 'function') {
                (window as any).showBulkDeleteModal(projectFiles);
            }
        };
    }

    const muteBtn = document.getElementById('mute-context-btn');
    if (muteBtn) {
        muteBtn.addEventListener('click', () => {
            // Instead of a binary toggle, open the matrix for granular muting
            renderWorkspaceMatrix();
            dom.matrixModal.classList.add('visible');
        });
    }

    // Workspace Matrix Logic
    const container = dom.contextContainer;
    if (container) {
        container.addEventListener('click', (e) => {
            const target = e.target as HTMLElement;
            const toggleBtn = target.closest('.matrix-toggle') as HTMLButtonElement;
            const row = target.closest('.ws-matrix-row') as HTMLElement;

            if (toggleBtn && row) {
                const uri = row.dataset.uri!;
                const type = toggleBtn.dataset.type as 'tree' | 'content';

                const currentSettings = state.capabilities?.folderSettings || {};
                const settings = currentSettings[uri] || { tree: true, content: true };

                // Toggle the specific setting
                settings[type] = !settings[type];

                // Debounce matrix updates
                if ((window as any).matrixUpdateTimer) clearTimeout((window as any).matrixUpdateTimer);
                (window as any).matrixUpdateTimer = setTimeout(() => {
                // Locally update state so updateBadges() sees it immediately
                if (state.capabilities) {
                    state.capabilities.folderSettings = { ...currentSettings, [uri]: settings };
                }

                // Sync with extension
                vscode.postMessage({ 
                    command: 'updateDiscussionCapabilitiesPartial', 
                    partial: { 
                        folderSettings: { ...currentSettings, [uri]: settings }
                    } 
                });

                // Force badge refresh because Matrix might have changed "Librarian" status
                updateBadges();
                }, 150);            
            }

            if (target.id === 'ws-all-on' || target.id === 'ws-all-off') {
                const turnOn = target.id === 'ws-all-on';
                const newSettings: Record<string, any> = {};
                workspaceFolders.forEach(f => {
                    newSettings[f.uri] = { tree: turnOn, content: turnOn };
                });
                vscode.postMessage({ command: 'updateDiscussionCapabilitiesPartial', partial: { folderSettings: newSettings } });
            }
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

            const repromptBtn = document.getElementById(`btn-reprompt-${blockId}`) as HTMLButtonElement;
            if (repromptBtn && allIncluded && !repromptBtn.classList.contains('applied')) {
                repromptBtn.innerHTML = `<span class="codicon codicon-check"></span> Added`;
                repromptBtn.className = 'code-action-btn applied';
                repromptBtn.disabled = true;
            }
            } catch (e) {
            console.error("Failed to sync expansion block:", e);
        }
    });

    const handleRefresh = (btn: HTMLElement | null) => {
        if (!btn) return;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const icon = btn.querySelector('.codicon');
            if (icon) icon.classList.add('spin');
            vscode.postMessage({ command: 'calculateTokens' });
            setTimeout(() => { if (icon) icon.classList.remove('spin'); }, 1000);
        });
    };

    handleRefresh(document.getElementById('refresh-context-btn'));
    handleRefresh(document.getElementById('hud-quick-refresh-btn'));
    
    const bulkDeleteSkillsBtn = document.getElementById('bulk-delete-skills-btn');
    if (bulkDeleteSkillsBtn) {
        bulkDeleteSkillsBtn.addEventListener('click', () => {
            showBulkDeleteSkillsModal(skills);
        });
    }

    const cancelCtxBtn = document.getElementById('cancel-tokens-btn');
    if (cancelCtxBtn) {
        cancelCtxBtn.addEventListener('click', () => {
            vscode.postMessage({ command: 'stopTokenCalculation' });
        });
    }

    // CRITICAL: Force badge rendering immediately after injecting the Dashboard HTML
    const { updateBadges } = require('./ui.js');
    updateBadges();
    }


/**
 * Opens a modal to select multiple files for removal from context.
 */
export function showBulkDeleteModal(files: string[]) {
    const modal = document.getElementById('bulk-delete-modal');
    const list = document.getElementById('bulk-delete-files-list');
    const master = document.getElementById('bulk-delete-select-all') as HTMLInputElement;
    const closeBtn = document.getElementById('bulk-delete-close-btn');
    const runBtn = document.getElementById('bulk-delete-run-btn');

    if (!modal || !list) return;

    // We sort alphabetically by the filename (not path) for easier browsing
    const sortedFiles = [...files].sort((a, b) => a.split('/').pop()!.localeCompare(b.split('/').pop()!));

    list.innerHTML = sortedFiles.map(f => {
        const fileName = f.split('/').pop();
        const dirName = f.includes('/') ? f.substring(0, f.lastIndexOf('/')) : '';
        return `
        <div class="checkbox-container" style="margin-bottom: 6px; padding: 4px; border-radius: 4px; background: rgba(0,0,0,0.15); display: flex; align-items: center;">
            <input type="checkbox" class="bulk-delete-file-check" value="${f}" id="bulk-del-check-${f}" checked style="margin: 0 10px 0 5px;">
            <label for="bulk-del-check-${f}" style="font-size: 11px; cursor: pointer; flex: 1; min-width: 0;">
                <div style="font-weight: bold; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${fileName}</div>
                <div style="font-size: 9px; opacity: 0.5; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${dirName}</div>
            </label>
        </div>`;
    }).join('');

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
            // This command triggers bulkRemoveFiles in ChatPanel.ts
            vscode.postMessage({ command: 'bulkRemoveFiles', paths: selected });
            modal.classList.remove('visible');
        }
    };
}

// Expose to global so messageRenderer can trigger it
(window as any).showBulkDeleteModal = showBulkDeleteModal;

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
 * Renders tool parameters as a structured form instead of raw JSON.
 */
function renderFormFields(params: any): string {
    if (!params || typeof params !== 'object') return '';

    let html = '<div class="task-form">';
    for (const [key, value] of Object.entries(params)) {
        // Skip internal or empty metadata
        if (key.startsWith('_')) continue;

        const label = key.replace(/_/g, ' ').toUpperCase();
        let displayValue = '';

        if (Array.isArray(value)) {
            displayValue = value.map(v => `<div style="margin-bottom:2px;">• ${sanitizer.sanitize(String(v))}</div>`).join('');
        } else if (typeof value === 'object' && value !== null) {
            displayValue = `<pre style="margin:0; font-size:11px;">${sanitizer.sanitize(JSON.stringify(value, null, 2))}</pre>`;
        } else {
            displayValue = sanitizer.sanitize(String(value));
        }

        html += `
            <div class="task-form-row">
                <div class="task-form-label">${label}</div>
                <div class="task-form-value">${displayValue}</div>
            </div>
        `;
    }
    html += '</div>';
    return html;
}

function getStatusIcon(status: string) {
    switch(status) {
        case 'pending': return '<span class="codicon codicon-circle-large"></span>';
        case 'in_progress': return '<span class="codicon codicon-sync spin"></span>';
        case 'completed': return '<span class="codicon codicon-check" style="color:var(--vscode-charts-green)"></span>';
        case 'failed': return '<span class="codicon codicon-error" style="color:var(--vscode-charts-red)"></span>';
        default: return '<span class="codicon codicon-circle-slash"></span>';
    }
}

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

    let scratchpadHtml = '';
    if (plan.observations && plan.observations.length > 0) {
        const obsItems = plan.observations.map((obs: string) => 
            `<div class="observation-step" style="padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,0.05); font-size: 11px;">
                <span class="codicon codicon-eye" style="font-size:10px; margin-right:8px; opacity:0.6;"></span>
                ${sanitizer.sanitize(obs)}
            </div>`).join('');

        scratchpadHtml = `
            <div class="plan-scratchpad" style="margin-top:10px; border-left: 3px solid var(--vscode-charts-orange);">
                <details ${isPrevious ? '' : 'open'}>
                    <summary class="scratchpad-header"><span class="codicon codicon-history"></span> Technical Remarks</summary>
                    <div class="scratchpad-content" style="max-height: 300px; overflow-y: auto;">${obsItems}</div>
                </details>
            </div>`;
    } else if (plan.scratchpad) {
        scratchpadHtml = `
            <div class="plan-scratchpad" style="margin-top:10px; border-left: 3px solid var(--vscode-charts-orange);">
                <details ${isPrevious ? '' : 'open'}>
                    <summary class="scratchpad-header"><span class="codicon codicon-history"></span> Architect Notes</summary>
                    <div class="scratchpad-content" style="padding: 8px 12px; font-size: 11px;">${sanitizer.sanitize(plan.scratchpad)}</div>
                </details>
            </div>`;
    }

    let subGoalHtml = plan.current_sub_goal ? `
        <div style="margin: 12px 12px 0 12px; padding: 10px; background: rgba(0, 122, 204, 0.1); border: 1px solid var(--vscode-charts-blue); border-radius: 6px;">
            <div style="font-size: 9px; font-weight: 900; opacity: 0.6; text-transform: uppercase; margin-bottom: 4px;">🎯 Next Objective</div>
            <div style="font-size: 12px; font-weight: 600;">${sanitizer.sanitize(plan.current_sub_goal)}</div>
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

            let approvalButtonHtml = '';
            if ((task as any).needsApproval && task.status === 'pending' && !isPrevious) {
                approvalButtonHtml = `
                <div style="margin-bottom: 8px; background: rgba(0,0,0,0.2); padding: 10px; border-radius: 6px; border: 1px dashed var(--vscode-charts-orange);">
                    <div style="font-size: 11px; margin-bottom: 8px; font-weight: bold; color: var(--vscode-charts-orange);">
                        <i class="codicon codicon-shield"></i> Action Requires Approval
                    </div>
                    <button class="code-action-btn apply-btn approve-task-btn" data-task-id="${task.id}" style="width:100%; justify-content:center; margin-bottom:8px; border: 2px solid var(--vscode-charts-green);"><span class="codicon codicon-play"></span> Run Task & Continue</button>
                    <div class="checkbox-container" style="margin-top:0; padding:0; background:transparent;">
                        <input type="checkbox" id="always-allow-${task.id}" class="always-allow-check">
                        <label for="always-allow-${task.id}" style="font-size:10px; opacity:0.8;">Always allow <b>${task.action}</b> in this session</label>
                    </div>
                </div>`;
            }
            
            let resultHtml = '';

            // 1. Render Associated Artifacts (Milestones/Learnings)
            let artifactsHtml = '';
            if (task.artifacts && task.artifacts.length > 0) {
                artifactsHtml = task.artifacts.map((art: string) => {
                    // Reuse the existing tag-to-card parsing logic
                    const { processedContent } = (window as any).processThinkTags(art);
                    const milestoneRegex = /<milestone\s+([^>]*?)\s*\/>/gi;
                    const pMemRegex = /<project_memory\s+([^>]*?)>([\s\S]*?)<\/project_memory>/gi;

                    let out = art;
                    out = out.replace(milestoneRegex, (match, attrStr) => {
                        const attrs: any = {};
                        attrStr.replace(/(\w+)=["']([^"']*)["']/g, (m:any, k:any, v:any) => attrs[k] = v);
                        return renderMilestoneCard(attrs);
                    });
                    out = out.replace(pMemRegex, (match, attrStr, content) => {
                        const attrs: any = {};
                        attrStr.replace(/(\w+)=["']([^"']*)["']/g, (m:any, k:any, v:any) => attrs[k] = v);
                        return renderMemoryTag(attrs.action || 'add', attrs.id, attrs.title, content.trim());
                    });
                    return out;
                }).join('');
            }

            // Show Parameters for all tasks to allow inspection and editing
            if (task.parameters) {
                let editHtml = '';
                let formHtml = '';
                const isDebuggable = ['execute_command', 'run_file', 'execute_python_script', 'read_file', 'read_files', 'scrape_website', 'search_web'].includes(task.action);
                const hasForm = !!task.parameters.lollms_form;

                // --- NEW: Render Forms inside Plan Tasks ---
                // We use 'agent_plan' as the identifier since the Plan Zone is global to the session
                if (hasForm) {
                    formHtml = `<div style="margin-top: 10px;">${renderFormBlock(task.parameters.lollms_form, "agent_plan")}</div>`;
                }

                if (task.status === 'failed' || (task.status === 'pending' && !hasForm)) {
                    editHtml = `
                    <div class="task-edit-zone" style="margin-top: 8px; border-top: 1px solid var(--vscode-widget-border); padding-top: 8px;">
                        <div style="display:flex; gap: 4px; margin-bottom: 4px;">
                            <button class="code-action-btn edit-params-btn" data-task-id="${task.id}" style="flex:1;">
                                <span class="codicon codicon-edit"></span> Edit Params
                            </button>
                            ${isDebuggable ? `
                            <button class="code-action-btn secondary-btn view-full-log-btn" data-task-id="${task.id}" style="flex:1;">
                                <span class="codicon codicon-output"></span> System Log
                            </button>` : ''}
                        </div>
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
                        <details ${task.status === 'in_progress' || task.status === 'failed' || hasForm ? 'open' : ''}>
                            <summary class="task-result-summary" style="opacity:0.7;">${hasForm ? '🛡️ SAFETY ACTION REQUIRED' : 'Task Details & Parameters'}</summary>
                            <div class="task-result-box" style="border-style: dashed; opacity: 0.9; padding: 12px;">
                                ${task.model || (task.agent_skills && task.agent_skills.length > 0) ? `
                                <div style="display:flex; gap:8px; margin-bottom: 10px; opacity: 0.7;">
                                    ${task.model ? `<span class="tool-badge">🤖 ${sanitizer.sanitize(task.model)}</span>` : ''}
                                    ${task.agent_skills && task.agent_skills.length > 0 ? `<span class="tool-badge">💡 ${task.agent_skills.length} Skills</span>` : ''}
                                </div>` : ''}

                                ${task.parameters.lollms_form ? formHtml : renderFormFields(task.parameters)}

                                ${editHtml}
                            </div>
                            </details>
                    </div>`;
            }

            if (task.result) {
                const resultText = String(task.result);

                // 🛡️ REFINED ERROR DETECTION
                // We only render as a 'Failure' if the backend explicitly set the status to 'failed'.
                // Keyword detection (like 'error') is now a fallback ONLY for 'failed' tasks
                // to avoid misclassifying successful analyses of faulty assets.
                const isFailure = task.status === 'failed';

                const label = isFailure ? 'Failure Details' : 'Output';
                const resultBoxClass = isFailure ? 'failure' : 'success';
                const summaryClass = isFailure ? 'failure-text' : 'success-text';

                resultHtml += `
                    <div class="task-result">
                        <details ${isFailure ? 'open' : ''}>
                            <summary class="task-result-summary ${summaryClass}">${label}</summary>
                            <div class="task-result-box ${resultBoxClass}">${sanitizer.sanitize(resultText)}</div>
                        </details>
                    </div>`;
            }

            let metaTabsHtml = '';
            if (task.model) metaTabsHtml += `<div class="agent-meta-tab" title="Assigned Model"><span class="codicon codicon-hubot"></span> ${sanitizer.sanitize(task.model)}</div>`;

            // Calculate Mini Brain Bar Segments
            const hasThoughts = !!task.memory_delta?.thought;
            const hasVariables = Object.keys(task.memory_delta?.variables || {}).length > 0;
            const hasDiscoveries = (task.memory_delta?.discoveries || []).length > 0;
            const hasOutput = !!task.result;

            let memoryBarHtml = '';
            if (task.status === 'completed' || task.status === 'failed') {
                memoryBarHtml = `
                    <div class="task-memory-bar" title="Click a segment to inspect step data">
                        <div class="brain-segment segment-scratchpad" style="width: ${hasThoughts ? '25' : '0'}%" data-type="thoughts" title="Reasoning: View internal thoughts for this step"></div>
                        <div class="brain-segment segment-memory" style="width: ${(hasVariables || hasDiscoveries) ? '50' : '0'}%" data-type="memory" title="Memory: View variables and facts discovered"></div>
                        <div class="brain-segment segment-history" style="width: ${hasOutput ? '25' : '0'}%" data-type="history" title="Output: View raw tool return data"></div>
                    </div>
                    <div id="task-mem-render-${task.id}" class="task-memory-render-area">
                        <div class="task-memory-header">
                            <span class="mem-title">Memory Content</span>
                            <span class="codicon codicon-close" style="cursor:pointer" onclick="this.parentElement.parentElement.classList.remove('visible')"></span>
                        </div>
                        <div class="task-memory-body markdown-body"></div>
                    </div>
                `;
            }
            if (task.agent_persona) metaTabsHtml += `<div class="agent-meta-tab" title="Persona"><span class="codicon codicon-organization"></span> Persona Set</div>`;
            if (task.agent_skills && task.agent_skills.length > 0) metaTabsHtml += `<div class="agent-meta-tab" title="Skills"><span class="codicon codicon-lightbulb"></span> ${task.agent_skills.length} Skills</div>`;
            if (task.agent_files && task.agent_files.length > 0) metaTabsHtml += `<div class="agent-meta-tab" title="Files Context"><span class="codicon codicon-file-code"></span> ${task.agent_files.length} Files</div>`;
            if (task.dependencies && task.dependencies.length > 0) metaTabsHtml += `<div class="agent-meta-tab" title="Waiting for Tasks"><span class="codicon codicon-git-merge"></span> Dep: [${task.dependencies.join(', ')}]</div>`;

            const isActive = task.status === 'in_progress';

            // --- SUBSTEP PROGRESS BAR ---
            let progressHtml = '';
            if (isActive && (task.progress !== undefined || task.current_substep)) {
                const pct = task.progress || 0;
                progressHtml = `
                    <div class="task-progress-container">
                        <div class="task-substep-text">
                            <span>${sanitizer.sanitize(task.current_substep || 'Processing...')}</span>
                            <span>${pct}%</span>
                        </div>
                        <div class="task-progress-bar">
                            <div class="task-progress-fill" style="width: ${pct}%"></div>
                        </div>
                    </div>
                `;
            }

            // 1. Standalone Reasoning Card
            const thoughtHtml = task.description ? `
                <div class="agent-thought-step">
                    <span class="thought-label">Reasoning for Step ${task.id}</span>
                    ${sanitizer.sanitize(task.description)}
                </div>` : '';

            // 2. Simplified Execution Card
            const cardHtml = `
                <li class="agent-card status-${task.status} ${isActive ? 'active-task' : ''}" data-task-id="${task.id}" style="margin-top: 15px;">
                    <div class="agent-card-header">
                        <div style="display:flex; align-items:center; gap:8px;">
                            <div class="${statusClass}">${icon}</div>
                            <span style="font-weight:bold;">Task ${task.id}</span>
                        </div>
                        <div style="display:flex; gap:8px; align-items:center;">
                            ${toolBadge}
                            ${retryButtonHtml}
                        </div>
                    </div>
                    <div class="agent-card-body" style="padding-top: 8px;">
                        ${approvalButtonHtml}
                        ${progressHtml}
                        ${metaTabsHtml}
                        ${memoryBarHtml}
                        ${resultHtml}
                        ${artifactsHtml}
                        </div>
                </li>`;

            return thoughtHtml + cardHtml;
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

let lastPlanRenderTime = 0;
const RENDER_THROTTLE = 150; // ms
let lastTaskCount = 0;
let lastTaskStates = "";

export function displayPlan(plan: any) {
    // Capture current scroll state before modifying the DOM
    const oldScroll = dom.agentPlanZone ? dom.agentPlanZone.scrollTop : 0;

    // Redirection: The Plan now renders as a Pinned Dashboard at the TOP of the chat
    let dashboard = document.getElementById('agent-sovereign-dashboard');

    if (!plan) {
        if (dashboard) dashboard.remove();
        return;
    }

    if (!dashboard) {
        dashboard = document.createElement('div');
        dashboard.id = 'agent-sovereign-dashboard';
        dashboard.className = 'message-wrapper pinned-dashboard';
        dom.chatMessagesContainer.prepend(dashboard);
    }

    const now = Date.now();
    const isStreaming = plan?.status === 'active' && state.isGenerating;
    (window as any).lastPlan = plan;

    // --- 🛡️ JSON SUPPRESSION LOGIC ---
    let displayThought = plan.scratchpad || "Standing by...";
    try {
        // Attempt to extract JSON from markdown fences or raw string
        const jsonMatch = displayThought.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            // Prioritize human-readable remarks over structural JSON
            displayThought = parsed.new_remark || parsed.thought || parsed.reasoning || "Analyzing project structure and planning next steps...";
        }
    } catch (e) {
        // Not JSON, or malformed JSON during streaming - keep as is (Markdown)
    }

    // 1. DASHBOARD HEADER (OBJECTIVE)
    let html = `
        <div class="message assistant-message agent-mode-message" style="border-bottom: 2px solid var(--vscode-charts-orange); margin-bottom: 20px;">
            <div class="message-avatar">
                <div class="agent-active-indicator">
                    <div class="genie-orb-portal" style="transform: scale(0.6);">
                        <div class="orb-ring-outer"></div>
                        <div class="orb-ring-inner"></div>
                        <div class="orb-core"></div>
                    </div>
                </div>
            </div>
            <div class="message-body">
                <div class="message-header"><span class="role-name">MISSION CONTROL</span></div>
                <div class="message-content">
                    <div style="font-weight:bold; font-size: 14px; margin-bottom: 10px; color: var(--vscode-charts-orange);">🎯 ${sanitizer.sanitize(plan.objective)}</div>
                    <div class="live-thought-box" style="margin-bottom: 15px; font-style: italic; color: var(--vscode-descriptionForeground); line-height: 1.5;">
                        ${sanitizer.sanitize(displayThought)}
                    </div>

                    <div style="display:flex; justify-content: space-between; align-items:center; margin-top:10px; padding-top:10px; border-top: 1px solid var(--vscode-widget-border);">
                         <div style="display:flex; gap:8px;">
                            <button class="code-action-btn secondary-btn export-audit-md-btn" title="Export Audit Trail (Markdown)">
                                <i class="codicon codicon-markdown"></i> MD
                            </button>
                            <button class="code-action-btn secondary-btn export-audit-html-btn" title="Export Interactive Report (HTML)">
                                <i class="codicon codicon-cloud-download"></i> HTML Report
                            </button>
                         </div>
                         <span style="font-size: 10px; opacity: 0.5;">Status: ${plan.status?.toUpperCase()}</span>
                    </div>
                </div>
            </div>
        </div>
    `;

    dashboard.innerHTML = html;

    // Restore scroll position to prevent the "jump"
    requestAnimationFrame(() => {
        if (dom.agentPlanZone) dom.agentPlanZone.scrollTop = oldScroll;
    });
    if (!plan) {
        dom.agentPlanZone.classList.remove('visible');
        dom.planResizer.classList.remove('visible');
        return;
    }

    dom.agentPlanZone.classList.add('visible');
    dom.planResizer.classList.add('visible');

    // 2. CONSOLIDATED HUD (Brain Bar)
    if (plan.metrics) {
        const m = plan.metrics;
        const total = Math.max(m.total, 1);
        const pScratch = (m.scratchpad / total) * 100;
        const pMem = (m.memory / total) * 100;
        const pHist = (m.history / total) * 100;

        const hud = document.createElement('div');
        hud.className = 'brain-bar-container';
        hud.innerHTML = `
            <div class="brain-bar-label">
                <span>Agent Cognitive Load</span>
                <span>${(m.total / 1024).toFixed(1)} KB</span>
            </div>
            <div class="brain-bar">
                <div class="brain-segment segment-scratchpad" data-type="scratchpad" style="width: ${pScratch}%" title="Thoughts: ${m.scratchpad} chars"></div>
                <div class="brain-segment segment-memory" data-type="memory" style="width: ${pMem}%" title="Working Memory: ${m.memory} chars"></div>
                <div class="brain-segment segment-history" data-type="history" style="width: ${pHist}%" title="Mission History: ${m.history} chars"></div>
            </div>
            <div class="brain-legend">
                <div class="legend-item" data-type="scratchpad">
                    <div class="dot segment-scratchpad"></div> Thoughts
                </div>
                <div class="legend-item" data-type="memory">
                    <div class="dot segment-memory"></div> Memory
                </div>
                <div class="legend-item" data-type="history">
                    <div class="dot segment-history"></div> History
                </div>
            </div>
        `;
        // Listeners are now handled via global delegation in events.ts

        dom.agentPlanZone.appendChild(hud);
    }

    // 3. PROGRESS TRACKER (Checklist)
    if (plan.milestones && plan.milestones.length > 0) {
        const tracker = document.createElement('div');
        tracker.className = 'agent-progress-tracker';
        tracker.innerHTML = plan.milestones.map((m: any) => {
            const icon = m.status === 'completed' ? 'pass-filled' : (m.status === 'active' ? 'play' : 'circle-outline');
            return `
                <div class="milestone-item ${m.status}">
                    <span class="milestone-icon"><i class="codicon codicon-${icon}"></i></span>
                    <span class="milestone-label">${m.label}</span>
                </div>
            `;
        }).join('');
        dom.agentPlanZone.appendChild(tracker);
    }

    // 1. CREATE THE STICKY TOOLBAR FIRST
    const globalActions = document.createElement('div');
    globalActions.className = 'plan-global-actions';
    globalActions.style.gap = '8px';

    const exportBtn = createButton('Export Report', 'codicon-export', () => {
        vscode.postMessage({ command: 'executeLollmsCommand', details: { command: 'lollms-vs-coder.exportAgentTimeline' } });
    }, 'code-action-btn');
    globalActions.appendChild(exportBtn);

    const copyLogBtn = createButton('Copy Log', 'codicon-copy', () => {
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
        applyAllBtn.style.backgroundColor = 'var(--vscode-charts-green)';

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

