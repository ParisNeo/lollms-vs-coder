import { dom, vscode, state } from './dom.js';
import { isScrolledToBottom, collapseBlockWithScrollPreservation, parseAiderHunks } from './utils.js';
import { extractFileBlocks } from './plugins/fileOpPlugin.js';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import mermaid from 'mermaid';
import Prism from 'prismjs';
import cytoscape from 'cytoscape';
import coseBilkent from 'cytoscape-cose-bilkent';
import cytoscapeDagre from 'cytoscape-dagre';

cytoscape.use(coseBilkent);
cytoscape.use(cytoscapeDagre);
import { renderWorkspaceMatrix, openRawCodeModal, updateProgressBar } from './ui.js';
import { applyDiffToString, applySearchReplace, normalizeAiderContent } from './utils.js';

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
import { fileOpPlugin, fileMutationPlugin } from './plugins/fileOpPlugin.js';
import { breakpointPlugin } from './plugins/breakpointPlugin.js';
import { imageAssetPlugin } from './plugins/imageAssetPlugin.js';
import { imageGenPlugin } from './plugins/imageGenPlugin.js';
import { imageResultPlugin } from './plugins/imageResultPlugin.js';
import { planStatusPlugin } from './plugins/planStatusPlugin.js';
import { toolPlugin } from './plugins/toolPlugin.js';
import { sparqlPlugin } from './plugins/sparqlPlugin.js';

function initPlugins() {
    pluginRegistry.length = 0; 
    registerPlugin(contextExpansionPlugin);
    registerPlugin(projectMemoryPlugin);
    registerPlugin(milestonePlugin);
    registerPlugin(processingPlugin);
    registerPlugin(formPlugin);
    registerPlugin(fileOpPlugin);
    registerPlugin(fileMutationPlugin);
    registerPlugin(breakpointPlugin);
    registerPlugin(imageAssetPlugin);
    registerPlugin(imageGenPlugin);
    registerPlugin(imageResultPlugin);
    registerPlugin(planStatusPlugin);
    registerPlugin(toolPlugin);
    registerPlugin(sparqlPlugin);
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
        'data-content', 'data-importance', 'data-mem-id', 'data-path', 'data-symbol',
        'data-block-index', 'data-raw-code', 'data-lang', 'data-hunk-index', 'data-idx', 'data-closed',
        'open'
    ],
    // IMPORTANT: Allow all classes for our custom UI blocks
    ADD_CLASSES: { 
        '*': [
            'expansion-request-block', 'context-expansion-block', 'expansion-header', 'expansion-body', 
            'expansion-file-list', 'expansion-file-item', 'code-action-btn', 'apply-btn', 
            'add-files-to-context-btn', 'add-and-reprompt-btn', 'copy-files-to-clipboard-btn',
            'learning-card', 'learning-card-header', 'learning-body', 'learning-title', 
            'learning-content', 'learning-meta', 'project-memory-block', 'memory-summary',
            // File Operations Cards & Rows
            'file-operation-block', 'file-operation-header', 'file-operation-details', 
            'file-operation-actions', 'file-op-btn', 'path-old', 'path-new', 'file-operation-arrow',
            // Milestones, Progress, and Builder Reports
            'milestone-card', 'milestone-card-header', 'milestone-body', 'milestone-section', 
            'win', 'hurdle', 'fix', 'milestone-section-title', 'milestone-section-content',
            'builder_report', 'objective', 'briefing', 'timeline', 'timeline-item', 
            'timeline-dot', 'spinner', 'step', 'active', 'success', 'failed', 'git-event',
            'agent-thought-step', 'thought-label', 'collapsible-content'
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

// Dynamic block creation moved to specialized plugins to unify Discussion/Agent modes.

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

function renderCytoscapeDiagram(data: any, container: HTMLElement) {
    container.style.width = '100%';
    container.style.height = '250px';
    container.style.position = 'relative';
    container.style.overflow = 'hidden';
    container.style.background = 'var(--vscode-editor-background)';
    container.style.borderRadius = '6px';
    container.style.border = '1px solid var(--vscode-widget-border)';

    const rawNodes = data.nodes || [];
    const rawEdges = data.edges || [];
    const elements: any[] = [];

    const getEstDimensions = (label: any, type: string) => {
        const safeLabel = typeof label === 'string' ? label : String(label || '');
        const cleanLabel = safeLabel.replace(/📁\s*/, '').trim();
        const charCount = cleanLabel.length;

        let width = Math.max(50, Math.min(180, charCount * 6.5 + 16));
        let height = 25;

        if (type === 'class' || type === 'function' || type === 'method') {
            width = Math.max(55, Math.min(200, charCount * 7 + 22));
            height = 32;
        }
        return { width, height };
    };

    const nodeIds = new Set<string>();

    if (data.elements && Array.isArray(data.elements)) {
        data.elements.forEach((ele: any) => {
            if (ele.group === 'nodes' || (!ele.group && ele.data && !ele.data.source)) {
                if (ele.data && ele.data.id) {
                    nodeIds.add(ele.data.id);
                    if (!ele.data.isParent) {
                        const labelVal = ele.data.label || ele.data.name || ele.data.id || 'Node';
                        const dims = getEstDimensions(labelVal, ele.data.type);
                        ele.data.estWidth = dims.width;
                        ele.data.estHeight = dims.height;
                        ele.data.label = labelVal;
                    }
                }
            }
            elements.push(ele);
        });
    } else {
        rawNodes.forEach((n: any) => {
            if (n.id) {
                nodeIds.add(n.id);
                const labelVal = n.label || n.name || n.id || 'Node';
                const dims = getEstDimensions(labelVal, n.type);
                elements.push({
                    group: 'nodes',
                    data: {
                        id: n.id,
                        label: labelVal,
                        type: n.type || 'file',
                        filePath: n.filePath || '',
                        estWidth: dims.width,
                        estHeight: dims.height
                    }
                });
            }
        });

        // Defensive Sieve: Filter out any edges pointing to unrendered/missing nodes
        rawEdges.forEach((e: any) => {
            if (e.source && e.target && nodeIds.has(e.source) && nodeIds.has(e.target)) {
                elements.push({
                    group: 'edges',
                    data: {
                        id: e.id || `${e.source}-${e.target}-${Math.random()}`,
                        source: e.source,
                        target: e.target,
                        label: e.label || ''
                    }
                });
            } else {
                console.warn(`[Cytoscape Sieve] Stripped orphaned edge: ${e.source} -> ${e.target}`);
            }
        });
    }

    // Double-check element list for standard elements format as well
    let securedElements = elements;
    if (data.elements && Array.isArray(data.elements)) {
        securedElements = elements.filter(ele => {
            const isEdge = ele.group === 'edges' || (ele.data && ele.data.source);
            if (isEdge) {
                return nodeIds.has(ele.data.source) && nodeIds.has(ele.data.target);
            }
            return true;
        });
    }

    const cyStyle: any[] = [
        {
            selector: 'node',
            style: {
                'label': 'data(label)',
                'color': '#ffffff',
                'font-family': 'var(--vscode-font-family), monospace',
                'font-size': '8px',
                'text-valign': 'center',
                'text-halign': 'center',
                'background-color': '#2d2d2d',
                'border-width': '1px',
                'border-color': '#555555',
                'width': 'data(estWidth)',
                'height': 'data(estHeight)',
                'shape': 'round-rectangle',
                'text-wrap': 'wrap',
                'text-max-width': '100px'
            }
        },
        {
            selector: 'node[type="file"]',
            style: {
                'background-color': '#1f4e79',
                'border-color': '#569cd6',
                'shape': 'round-rectangle'
            }
        },
        {
            selector: 'node[type="class"]',
            style: {
                'background-color': '#2d6a4f',
                'border-color': '#4ec9b0',
                'shape': 'ellipse'
            }
        },
        {
            selector: 'node[type="function"]',
            style: {
                'background-color': '#8c7a1e',
                'border-color': '#dcdcaa',
                'shape': 'ellipse'
            }
        },
        {
            selector: 'node[type="library"]',
            style: {
                'background-color': '#8f5c2c',
                'border-color': '#d19a66',
                'shape': 'hexagon'
            }
        },
        {
            selector: 'node[type="folder"]',
            style: {
                'background-color': '#114b7a',
                'border-color': '#ffffff',
                'shape': 'round-rectangle'
            }
        },
        {
            selector: 'node:parent',
            style: {
                'background-color': '#000000',
                'background-opacity': 0.25,
                'border-color': '#555555',
                'border-width': '1px',
                'border-style': 'dashed',
                'label': 'data(label)',
                'text-valign': 'top',
                'text-halign': 'center',
                'color': '#aaaaaa',
                'font-size': '8px',
                'font-weight': 'bold',
                'padding': '8px'
            }
        },
        {
            selector: 'edge',
            style: {
                'width': 1,
                'line-color': '#555555',
                'target-arrow-color': '#555555',
                'target-arrow-shape': 'triangle',
                'curve-style': 'bezier',
                'arrow-scale': 0.6,
                'font-size': '6px',
                'color': '#888888',
                'text-background-opacity': 0.8,
                'text-background-color': '#1e1e1e',
                'text-background-padding': '1px',
                'text-background-shape': 'round-rectangle'
            }
        },
        {
            selector: 'edge[label]',
            style: {
                'label': 'data(label)'
            }
        },
        {
            selector: 'node:selected',
            style: {
                'border-color': '#ff9d00',
                'border-width': '2px',
                'background-color': '#ff9d00',
                'color': '#000000'
            }
        }
    ];

    const layoutStyle = data.layout || 'cose-bilkent';
    let layoutConfig = {
            name: 'cose-bilkent',
            animate: 'end',
            animationEasing: 'ease-out-quad',
            animationDuration: 1000,
            randomize: true,
            nodeDimensionsIncludeLabels: true, // Factor in text labels during overlap calculations
            nodeRepulsion: 15000,             // Significantly increased repulsion to aggressively push dense clusters apart
            idealEdgeLength: 160,             // Longer edges to allow clusters to breathe
            edgeElasticity: 0.1,              // Softer edges so they can stretch much further
            nestingFactor: 0.05,              // Reduced nesting constraint to let compounds expand
            gravity: 0.05,                    // Greatly reduced gravity (center pull) to let repulsion spread the nodes
            numIter: 5000,                    // More iterations to ensure a settled, overlap-free layout
            tile: true
        };

    if (layoutStyle === 'dagre' || layoutStyle === 'hierarchical') {
        layoutConfig = {
            name: 'dagre',
            nodeSep: 80,
            rankSep: 100,
            rankDir: 'TB'
        };
    } else if (layoutStyle === 'circle') {
        layoutConfig = { name: 'circle', radius: 150 };
    } else if (layoutStyle === 'grid') {
        layoutConfig = { name: 'grid' };
    }

    const cy = cytoscape({
        container: container,
        elements: securedElements, // Pass the secured, orphaned-free elements list to Cytoscape
        style: cyStyle,
        layout: layoutConfig,
        zoomingEnabled: true,
        panningEnabled: true,
        boxSelectionEnabled: false,
        autounselectify: false
    });

    cy.on('dblclick', 'node', function(evt: any) {
        const node = evt.target;
        const nodeData = node.data();
        if (nodeData && nodeData.filePath) {
            vscode.postMessage({ 
                command: 'openFile', 
                path: nodeData.filePath 
            });
        }
    });
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
    } else if (language === 'cytoscape' || language === 'json') {
        const rawText = codeElement.textContent || '';
        try {
            const parsed = JSON.parse(rawText);
            renderCytoscapeDiagram(parsed, diagramContainer);
        } catch (e: any) {
            diagramContainer.innerHTML = `
                <div style="color:var(--vscode-errorForeground); padding:10px; font-size:11px; background:var(--vscode-inputValidation-errorBackground); border-radius:4px; border: 1px solid var(--vscode-errorForeground);">
                    <strong>Cytoscape Error:</strong> ${sanitizer.sanitize(e.message)}
                </div>`;
        }
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

// Safely expose startEdit globally after its complete definition
(window as any).startEdit = startEdit;

function extractFilePaths(content: string): ({ type: 'file' | 'diff' | 'insert' | 'replace' | 'delete' | 'search_replace' | 'rename' | 'select' | 'file_delete' | null, path: string, stripFirstLine: boolean, isClosed: boolean, start: number, end: number })[] {
    // 🧠 Strip thinking blocks BEFORE running path extraction to keep index alignments perfect
    const cleanContent = (window as any).processThinkTags ? (window as any).processThinkTags(content).processedContent : content;
    const fileBlocks = extractFileBlocks(cleanContent);
    const fileRanges = fileBlocks.map(b => ({ start: b.start, end: b.end }));

    const isInsideFileBlock = (offset: number) => {
        return fileRanges.some(r => offset >= r.start && offset < r.end);
    };

    const infos: any[] = [];
    const lines = cleanContent.split('\n');
    let inBlock = false;
    let fenceLength = 0;
    let depth = 0;
    let currentOffset = 0;
    let blockStartOffset = 0;

    for (let i = 0; i < lines.length; i++) {
        const lineWithNewline = lines[i] + (i < lines.length - 1 ? '\n' : '');
        const lineText = lines[i]; 
        const line = lineText.trim();
        const match = lineText.match(/^(\s*)(`{3,})/); // Indentation agnostic match

        // Skip any line that resides inside a top-level <file> block
        if (isInsideFileBlock(currentOffset)) {
            currentOffset += lineWithNewline.length;
            continue;
        }

        if (!inBlock) {
            // --- NAKED AIDER DETECTION (OUTSIDE <file> TAGS ONLY) ---
            if (line.startsWith('<<<<<<< SEARCH')) {
                inBlock = true;
                fenceLength = 0;
                depth = 1;
                blockStartOffset = currentOffset;
                let inferredPath = "";
                for (let k = i - 1; k >= Math.max(0, i - 10); k--) {
                    const pathMatch = lines[k].match(/[`"']?([a-zA-Z0-9._\-\/]+\.[a-z0-9]+)[`"']?/);
                    if (pathMatch) { inferredPath = pathMatch[1]; break; }
                }
                infos.push({ type: 'replace', path: inferredPath, stripFirstLine: false, start: blockStartOffset, isClosed: false });
                currentOffset += lineWithNewline.length;
                continue;
            }

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
                    let prefix = parts[0].trim().toLowerCase();

                    if ((prefix === 'language' || prefix === 'lang') && parts.length > 2) {
                        prefix = parts[1].trim().toLowerCase();
                        pathStr = parts.slice(2).join(':').trim();
                    } else {
                        pathStr = parts.slice(1).join(':').trim();
                    }

                    const actionTypes = ['insert', 'replace', 'diff', 'delete_code'];
                    if (actionTypes.includes(prefix)) {
                        type = prefix === 'delete_code' ? 'delete' : prefix;
                    } else {
                        type = 'file';
                    }

                    pathStr = pathStr.replace(/\s*\(\d+\s*hunks?\)$/i, '').trim();
                } else if (headerText.toLowerCase().trim() === 'diff') {
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
                        const m = prevLine.match(/^(?:(?:\textbf|__)?(File|Diff|Insert|Replace|DeleteCode)(?:\textbf|__)?[:\s])\s*(.+)$/i);
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

            if (fenceLength === 0 && line.startsWith('>>>>>>> REPLACE')) {
                inBlock = false;
                depth = 0;
                infos[infos.length - 1].end = currentOffset + lineWithNewline.length;
                infos[infos.length - 1].isClosed = true;
            } else if (match && match[2].length >= fenceLength && fenceLength > 0) {
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
    const pres = Array.from(container.querySelectorAll('pre.lollms-placeholder'));
    if (pres.length === 0) return;

    // Capture the existing details expansion states before we modify the DOM
    const preservedStates = new Map<string, { open: boolean, activeTabIdx: number }>();
    container.querySelectorAll('.code-collapsible').forEach((el: any) => {
        if (el.id) {
            const activeTab = el.querySelector('.hunk-tab.active');
            let activeTabIdx = 0;
            if (activeTab) {
                const tabIndexMatch = activeTab.className.match(/hunk-tab-(\d+)/);
                if (tabIndexMatch) activeTabIdx = parseInt(tabIndexMatch[1], 10);
            }
            preservedStates.set(el.id, {
                open: el.open,
                activeTabIdx
            });
        }
    });

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
                originalContentText = Array.isArray(raw) ? raw.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n') : String(raw);
            } catch (e) {
                originalContentText = "";
            }
        }
    }

    const codeBlockInfos = extractFilePaths(originalContentText);
    let actionableBlockCount = 0;

    pres.forEach((pre) => {
        const code = pre.querySelector('code');
        if (!code || pre.parentElement?.classList.contains('code-collapsible') || pre.closest('.skill-preview')) return;

        const preLang = pre.getAttribute('data-lang') || '';
        let language = preLang || 'plaintext';

        // --- LANGUAGE SANITIZATION ---
        // If Prism captures the path (e.g. language-python:main.py), strip it
        if (language.includes(':')) {
            language = language.split(':')[0];
        }

        let filePath = '', isDiff = false, diffFilePath = '';

        const blockIdx = parseInt(pre.getAttribute('data-block-index') || '0', 10);
        const info = codeBlockInfos[blockIdx];
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

        // Normalize any lone ======= separators or un-bracketed hunks to standard Aider format
        codeText = normalizeAiderContent(codeText);

        const hunks = parseAiderHunks(codeText);
        const isAider = hunks.length > 0;

        const hasAiderMarkers = codeText.includes('<<<<<<< SEARCH') && codeText.includes('>>>>>>> REPLACE') && codeText.includes('=======');

        let isMalformedAider = false;
        if (hasAiderMarkers && !isAider) {
            if (!info || info.type === 'replace') {
                isMalformedAider = true;
            }
        }

        const isCytoscapeJson = language === 'json' && codeText.includes('"nodes"') && codeText.includes('"edges"');
        const isDiagram = language === 'mermaid' || language === 'svg' || language === 'cytoscape' || isCytoscapeJson;

        const pathVal = isDiff ? diffFilePath : filePath;
        const appliedHunksCheck = state.appliedState?.[messageId]?.[blockIdx] || [];
        const isAlreadyAppliedOnLoad = appliedHunksCheck.includes(-1);

        const details = document.createElement('details');
        details.className = 'code-collapsible' + (isMalformedAider ? ' malformed' : '');
        // Collapse by default if already applied to preserve screen space
        details.open = !isAlreadyAppliedOnLoad;
        details.dataset.rawCode = codeText;
        details.id = `block-${messageId}-${blockIdx}`;

        // Format path representation to display targeted OOP members beautifully if present
        let displayPathVal = pathVal;
        if (pathVal.includes(':')) {
            const parts = pathVal.split(':');
            displayPathVal = parts.join(' › ');
        }

        const summary = document.createElement('summary');
        summary.className = 'code-summary';
        summary.innerHTML = `<div class="summary-lang-label"><span class="lang-badge" data-lang="${language.toLowerCase()}">${language}</span>${pathVal ? ` : <input type="text" class="path-editor-input" value="${pathVal}" style="display:none;"><span class="path-display-label" style="font-family: var(--vscode-editor-font-family); font-size: 11px; font-weight: bold; margin-left: 8px; color: var(--vscode-textLink-foreground); cursor: pointer;" title="Double-click to edit path">${displayPathVal}</span><button class="code-action-btn goto-file-btn" style="height: 18px; font-size: 9px; padding: 0 5px;" title="Goto: Open this file">Goto</button>` : ''}${isMalformedAider ? '<span class="malformed-badge">Malformed Patch</span>' : ''}</div>`;

        const gotoBtn = summary.querySelector('.goto-file-btn') as HTMLElement;
        if (gotoBtn) {
            gotoBtn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                const finalPath = (details.querySelector('.path-editor-input') as HTMLInputElement)?.value || pathVal;
                if (finalPath) {
                    vscode.postMessage({ command: 'openFile', path: finalPath.trim() });
                }
            };
        }

        const pathDisplayLabel = summary.querySelector('.path-display-label') as HTMLElement;
        const pathEditorInput = summary.querySelector('.path-editor-input') as HTMLInputElement;
        if (pathDisplayLabel && pathEditorInput) {
            pathDisplayLabel.ondblclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                pathDisplayLabel.style.display = 'none';
                pathEditorInput.style.display = 'inline-block';
                pathEditorInput.focus();
                pathEditorInput.select();
            };
            pathEditorInput.onblur = () => {
                pathDisplayLabel.textContent = pathEditorInput.value;
                pathDisplayLabel.style.display = 'inline-block';
                pathEditorInput.style.display = 'none';
            };
            pathEditorInput.onkeydown = (e) => {
                if (e.key === 'Enter') {
                    pathEditorInput.blur();
                } else if (e.key === 'Escape') {
                    pathEditorInput.value = pathVal;
                    pathEditorInput.blur();
                }
            };
        }

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
                    dom.rawCodeDisplay.dataset.blockIndex = String(blockIdx);
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
                const isApplied = state.appliedState?.[messageId]?.[blockIdx]?.includes(-1) || false;
                vscode.postMessage({ 
                    command: 'inspectPatch', 
                    filePath: pathVal, 
                    content: codeText, 
                    messageId: messageId,
                    blockIndex: blockIdx,
                    type: isAider ? 'replace' : (isDiff ? 'diff' : 'file'),
                    isApplied: isApplied
                });
            }, 'code-action-btn', 'Inspect this code for potential errors'));
        }

        if (pathVal && ['file', 'replace', 'insert', 'diff'].includes(info?.type || (isAider ? 'replace' : ''))) {
            actionableBlockCount++;
            const currentMsgId = messageId;
            const applyBtnId = `apply-btn-${currentMsgId}-${blockIdx}`;

            // Re-apply logic: Check if it's already applied to set initial visual state
            const appliedHunks = state.appliedState?.[currentMsgId]?.[blockIdx] || [];
            const isFullyApplied = appliedHunks.includes(-1);

            if (isMalformedAider) {
                // Safeguard: Never render a full-file apply button for malformed aider blocks!
                // Instead, render an AI Repair button
                const repairBtn = createButton(
                    'Fix Patch', 
                    'codicon-sparkle', 
                    () => {
                        repairBtn.disabled = true;
                        repairBtn.innerHTML = '<div class="spinner"></div> Repairing...';
                        vscode.postMessage({ 
                            command: 'replaceCode', 
                            filePath: pathVal, 
                            content: "REPAIR_REQUESTED", 
                            messageId: currentMsgId, 
                            blockIndex: blockIdx,
                            options: { silent: true }
                        });
                    }, 
                    'code-action-btn apply-btn',
                    'Ask Lollms to repair this malformed patch'
                );
                repairBtn.id = applyBtnId;
                repairBtn.disabled = isDisabled;
                actions.appendChild(repairBtn);
            } else {
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

                // ADDED: Companion Undo Button for Aider/Full File block
                if (isFullyApplied) {
                    const undoBtn = createButton(
                        'Undo',
                        'codicon-discard',
                        () => {
                            const finalPath = (details.querySelector('.path-editor-input') as HTMLInputElement)?.value || pathVal;
                            undoBtn.innerHTML = '<div class="spinner"></div>';
                            vscode.postMessage({ 
                                command: isAider ? 'replaceCode' : (isDiff ? 'applyPatchContent' : 'applyFileContent'), 
                                filePath: finalPath, 
                                content: codeText, 
                                messageId: currentMsgId, 
                                blockIndex: blockIdx,
                                options: { undo: true }
                            });
                        },
                        'code-action-btn delete-btn undo-block-btn',
                        'Undo all changes for this block'
                    );
                    undoBtn.disabled = isDisabled;
                    actions.appendChild(undoBtn);
                }
            }
        } else {
            // Action buttons for runnable script/command code blocks
            const runnableLangs = ['python', 'py', 'javascript', 'js', 'typescript', 'ts', 'bash', 'sh', 'powershell', 'pwsh', 'batch', 'cmd'];
            if (runnableLangs.includes(language.toLowerCase())) {
                // 1. Send to Active Opened Terminal
                const terminalBtn = createButton('Terminal', 'codicon-terminal', () => {
                    vscode.postMessage({ command: 'runInActiveTerminal', code: codeText });
                }, 'code-action-btn secondary-btn', 'Send to currently opened VS Code terminal');
                terminalBtn.disabled = isDisabled;
                actions.appendChild(terminalBtn);

                // 2. Captured Local Run
                const runBtn = createButton('Run', 'codicon-play', () => {
                    runBtn.disabled = true;
                    runBtn.innerHTML = '<div class="spinner"></div>';
                    vscode.postMessage({ command: 'runScript', code: codeText, language: language, reprompt: false });
                    setTimeout(() => { 
                        runBtn.disabled = false; 
                        runBtn.innerHTML = '<span class="codicon codicon-play"></span>'; 
                    }, 3000);
                }, 'code-action-btn secondary-btn', 'Run and capture output');
                runBtn.disabled = isDisabled;
                actions.appendChild(runBtn);

                // 3. Run & Reprompt AI
                const repromptBtn = createButton('Run & Reprompt', 'codicon-sync', () => {
                    repromptBtn.disabled = true;
                    repromptBtn.innerHTML = '<div class="spinner"></div>';
                    vscode.postMessage({ command: 'runScript', code: codeText, language: language, reprompt: true });
                    setTimeout(() => { 
                        repromptBtn.disabled = false; 
                        repromptBtn.innerHTML = '<span class="codicon codicon-sync"></span>'; 
                    }, 3000);
                }, 'code-action-btn apply-btn', 'Run command and feed output back to AI');
                repromptBtn.disabled = isDisabled;
                actions.appendChild(repromptBtn);
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
            pre.remove();
            return; // Exit early to prevent duplicate raw code rendering
        }

        // Ensure Carriage Returns (\r\n) from Windows/editor environments are normalized 
        // to UNIX Newlines (\n) before evaluating any markers.
        const normalizedCodeText = codeText.replace(/\r\n/g, '\n');

        // Capture indices of all primary markers in the normalized text
        const searchPos = normalizedCodeText.indexOf('<<<<<<< SEARCH');
        const sepPos = normalizedCodeText.indexOf('=======');
        const replacePos = normalizedCodeText.indexOf('>>>>>>> REPLACE');

        // Robust structural verification of Aider segments
        if (hasAiderMarkers) {
            if (searchPos === -1 || sepPos === -1 || replacePos === -1 || searchPos > sepPos || sepPos > replacePos) {
                isMalformedAider = true;
                details.className = 'code-collapsible malformed';
            }
        }

        // Assemble Header (Summary)
        details.appendChild(summary);


        if (isAider && !isMalformedAider) {
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

            // Retrieve previously active tab for this block if it was selected by the user
            const savedState = preservedStates.get(details.id);
            const initialActiveTabIdx = savedState ? savedState.activeTabIdx : 0;

            const hunks = parseAiderHunks(normalizedCodeText);
            const robustMatches = hunks.map(h => [h.fullMatch, h.searchPart, h.replacePart]);

            robustMatches.forEach((m, hIdx) => {
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

                const sLines = (m[1] || "").replace(/\r\n/g, '\n').split('\n');
                const rLines = (m[2] || "").replace(/\r\n/g, '\n').split('\n');

                // Calculate common prefix and suffix lines to minimize diff highlight area
                let pref = 0;
                while (pref < sLines.length && pref < rLines.length && sLines[pref].trim() === rLines[pref].trim()) {
                    pref++;
                }
                let suff = 0;
                while (suff < (sLines.length - pref) && suff < (rLines.length - pref) && sLines[sLines.length - 1 - suff].trim() === rLines[rLines.length - 1 - suff].trim()) {
                    suff++;
                }

                pane.innerHTML = `
                    <div class="aider-hunk-bubble">
                        <div class="aider-hunk-content">
                            <pre style="margin:0; padding:12px; background:var(--vscode-editor-background); border:none; overflow:auto; max-height: 400px;">${renderLines(sLines.slice(0, pref), 'unchanged')}${renderLines(sLines.slice(pref, sLines.length - suff), 'removed')}${renderLines(rLines.slice(pref, rLines.length - suff), 'added')}${renderLines(sLines.slice(sLines.length - suff), 'unchanged')}</pre>
                        </div>
                        <div class="aider-hunk-header" style="border-top: 1px solid var(--vscode-widget-border); border-bottom: none;">
                            <div style="font-size: 10px; opacity:0.7;">Actions for Hunk ${hIdx + 1}</div>
                            <div class="aider-hunk-actions">
                                <button class="code-action-btn delete-btn undo-hunk-btn" style="display: ${isHunkApplied ? 'flex' : 'none'}" title="Undo this hunk"><i class="codicon codicon-discard"></i> UNDO</button>
                                <button class="code-action-btn apply-btn ${isHunkApplied ? 'applied' : ''}" title="Apply this hunk"><i class="codicon ${isHunkApplied ? 'codicon-check' : 'codicon-git-commit'}"></i> APPLY</button>
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
                    // Store selection inside the details DOM element to retain state during fast re-renders
                    details.dataset.activeTabIdx = String(hIdx);
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

                if (hIdx === initialActiveTabIdx) { tab.classList.add('active'); pane.classList.add('active'); }
                contentWrapper.appendChild(pane);
            });

            // Restore active tab selection from preserved states
            if (savedState) {
                const activeTab = nav.querySelector(`.hunk-tab-${savedState.activeTabIdx}`) as HTMLElement;
                const activePane = contentWrapper.querySelector(`.hunk-pane-${savedState.activeTabIdx}`) as HTMLElement;
                if (activeTab && activePane) {
                    nav.querySelectorAll('.hunk-tab').forEach(t => t.classList.remove('active'));
                    contentWrapper.querySelectorAll('.hunk-tab-content').forEach(p => p.classList.remove('active'));
                    activeTab.classList.add('active');
                    activePane.classList.add('active');
                }
            }

            details.appendChild(tabContainer);
            pre.replaceWith(details);
        } else {
            // --- STANDARD MODE: GUTTER + SYNTAX HIGHLIGHTING ---
            pre.style.display = 'flex';
            pre.style.flexDirection = 'row';
            pre.style.overflow = 'auto';

            const gutter = document.createElement('div');
            gutter.className = 'code-line-gutter';
            const lineCount = normalizedCodeText.split('\n').length;
            gutter.innerHTML = Array.from({ length: lineCount }, (_, i) => i + 1).join('<br>');

            pre.insertBefore(gutter, pre.firstChild);

            // Move the original pre inside the details
            parent.replaceChild(details, pre);
            details.appendChild(pre);

            Prism.highlightElement(code);
        }

        // Restore details toggled state
        const savedState = preservedStates.get(details.id);
        if (savedState) {
            details.open = savedState.open;
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

export interface ParsedThought {
    tag: string;
    content: string;
    closed: boolean;
}

export function processThinkTags(content: string): { thoughts: ParsedThought[], processedContent: string } {
    if (!(window as any).processThinkTags) {
        (window as any).processThinkTags = processThinkTags;
    }
    const thoughts: ParsedThought[] = [];
    if (typeof content !== 'string') return { thoughts, processedContent: '' };

    // 1. Identify all backtick code block ranges to protect them from parsing
    const protectedRanges: { start: number, end: number }[] = [];
    const fenceRegex = /```[\s\S]*?(?:```|$)|`[^`\n\r]+`/g;
    let fMatch;
    while ((fMatch = fenceRegex.exec(content)) !== null) {
        protectedRanges.push({ start: fMatch.index, end: fMatch.index + fMatch[0].length });
    }

    const isIndexProtected = (index: number) => {
        return protectedRanges.some(r => index >= r.start && index < r.end);
    };

    const lines = content.split('\n');
    let workingContent = "";
    
    const openTags = ['<think>', '<thinking>', '<analysis>', '<reasoning>'];
    const closeTags = ['</think>', '</thinking>', '</analysis>', '</reasoning>'];

    let activeThought: ParsedThought | null = null;
    let currentOffset = 0;

    for (let i = 0; i < lines.length; i++) {
        const lineText = lines[i];
        const lineTrim = lineText.trim();
        const lineWithNL = lineText + (i < lines.length - 1 ? '\n' : '');

        // Check if current line starts at a protected index (inside code block)
        if (isIndexProtected(currentOffset)) {
            if (activeThought) {
                activeThought.content += lineWithNL;
            } else {
                workingContent += lineWithNL;
            }
            currentOffset += lineWithNL.length;
            continue;
        }

        // Look for line-starting opening tag
        const openMatch = openTags.find(tag => lineTrim.startsWith(tag));
        // Look for line-starting closing tag
        const closeMatch = closeTags.find(tag => lineTrim.startsWith(tag));

        if (openMatch && !activeThought) {
            // Start of a valid thinking block
            const tagName = openMatch.replace(/[<>]/g, '');
            activeThought = {
                tag: tagName,
                content: lineTrim.substring(openMatch.length) + (i < lines.length - 1 ? '\n' : ''),
                closed: false
            };
        } else if (closeMatch && activeThought) {
            // End of active thinking block
            activeThought.closed = true;
            // Trim any trailing/leading whitespace from the gathered thought content
            activeThought.content = activeThought.content.trim();
            thoughts.push(activeThought);
            activeThought = null;
        } else if (closeMatch && !activeThought) {
            // Dangling line-start closure: Treat preceding text as the thought
            const tagName = closeMatch.replace(/[<\/>]/g, '');
            thoughts.push({
                tag: tagName,
                content: workingContent.trim(),
                closed: true
            });
            workingContent = ""; // Clear working content
        } else {
            if (activeThought) {
                activeThought.content += lineWithNL;
            } else {
                workingContent += lineWithNL;
            }
        }

        currentOffset += lineWithNL.length;
    }

    // Handle unclosed active streaming thoughts
    if (activeThought) {
        activeThought.content = activeThought.content.trim();
        thoughts.push(activeThought);
    }

    return { thoughts, processedContent: workingContent.trim() };
}

// --- STREAM THROTTLER & DEBOUNCED RENDERER ---
const streamQueues = new Map<string, { buffer: string; lastRender: number }>();
let animationFrameRequest: number | null = null;

function flushStreamQueues() {
    if (streamQueues.size === 0) {
        if (animationFrameRequest !== null) {
            cancelAnimationFrame(animationFrameRequest);
            animationFrameRequest = null;
        }
        return;
    }

    const now = Date.now();
    let hasUpdates = false;

    streamQueues.forEach((data, messageId) => {
        if (now - data.lastRender >= 150) { // Throttled to 150ms to prevent browser thread freeze
            renderMessageContent(messageId, data.buffer);
            data.lastRender = now;
            hasUpdates = true;
        }
    });

    if (hasUpdates) {
        triggerVirtualListRecalculation();
    }

    animationFrameRequest = requestAnimationFrame(flushStreamQueues);
}

export function scheduleRender(messageId: string) {
    const stream = state.streamingMessages[messageId];
    if (!stream) return;

    if (!streamQueues.has(messageId)) {
        streamQueues.set(messageId, { buffer: stream.buffer, lastRender: 0 });
    } else {
        streamQueues.get(messageId)!.buffer = stream.buffer;
    }

    if (animationFrameRequest === null) {
        animationFrameRequest = requestAnimationFrame(flushStreamQueues);
    }
}


// --- LIGHTWEIGHT VIRTUAL SCROLL LIST ENGINE ---
// Deactivated virtual windowing to resolve layout-shifting feedback loops when scrolling up.
// Keeps scrolling 100% stable, smooth, and predictable across all views.
export function triggerVirtualListRecalculation() {
    // No-op to preserve interface compatibility
}

function runVirtualWindowing() {
    const container = dom.messagesDiv;
    if (!container) return;
    const wrappers = Array.from(container.querySelectorAll('.message-wrapper')) as HTMLElement[];
    wrappers.forEach(w => {
        w.style.display = 'flex';
        w.style.height = '';
    });
    let listContainer = document.getElementById('chat-messages-container');
    if (listContainer) {
        listContainer.style.paddingTop = '0px';
        listContainer.style.paddingBottom = '0px';
    }
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
    
    const label = document.createElement('div');
    label.className = 'summary-lang-label';
    label.innerHTML = `
        <span class="codicon codicon-diff-modified"></span>
        <input type="text" class="path-editor-input" value="${filePath}" 
               onchange="this.closest('.code-collapsible').dataset.path = this.value"
               title="Edit target path if incorrect">
        <button class="code-action-btn goto-file-btn" style="height: 18px; font-size: 9px; padding: 0 5px;" title="Goto: Open this file">Goto</button>
    `;

    const gotoBtn = label.querySelector('.goto-file-btn') as HTMLElement;
    if (gotoBtn) {
        gotoBtn.onclick = (e) => {
            e.stopPropagation();
            const currentPath = (label.querySelector('.path-editor-input') as HTMLInputElement).value;
            vscode.postMessage({ command: 'openFile', path: currentPath });
        };
    }
    summary.appendChild(label);

    const actions = document.createElement('div');
    actions.className = 'code-actions';
    
    // 1. Copy button
    actions.appendChild(createButton('Copy', 'codicon-copy', () => {
        vscode.postMessage({ command: 'copyToClipboard', text: rawCode });
    }));

    // 2. Raw Stitching button
    actions.appendChild(createButton('Raw', 'codicon-source-control', () => {
        if (dom.rawCodeDisplay) {
            dom.rawCodeFilename.textContent = filePath || "Unspecified File";
            dom.rawCodeDisplay.textContent = rawCode;
            dom.rawCodeDisplay.dataset.messageId = messageId;
            dom.rawCodeDisplay.dataset.blockIndex = String(blockIdx);
            dom.rawCodeModal.classList.add('visible');
        }
    }, 'code-action-btn', 'Open manual stitching view'));

    // 3. Save button
    actions.appendChild(createButton('Save', 'codicon-save', () => {
        vscode.postMessage({ command: 'saveCodeToFile', content: rawCode, language: 'diff' });
    }, 'code-action-btn', 'Save code to file...'));

    // 4. Inspect button (Surgical HUD)
    actions.appendChild(createButton('Inspect', 'codicon-eye', () => {
        const isApplied = state.appliedState?.[messageId]?.[blockIdx]?.includes(-1) || false;
        vscode.postMessage({ 
            command: 'inspectPatch', 
            filePath: filePath, 
            content: rawCode, 
            messageId: messageId,
            blockIndex: blockIdx,
            type: 'replace',
            isApplied: isApplied
        });
    }, 'code-action-btn', 'Inspect this code for potential errors'));

    // 5. Apply All button (Sequential)
    const applyAllBtn = document.createElement('button');
    applyAllBtn.className = 'code-action-btn apply-btn apply-all-btn';
    applyAllBtn.id = `apply-btn-${messageId}-${blockIdx}`;
    applyAllBtn.innerHTML = '<span class="codicon codicon-tools"></span> Apply All';
    applyAllBtn.title = "Apply all hunks in this block sequentially";
    
    actions.appendChild(applyAllBtn);
    summary.appendChild(actions);

    const hunkGroup = document.createElement('div');
    hunkGroup.className = 'aider-hunk-group';

    // IMPROVED REGEX: More permissive with line endings to ensure no hunks are missed
    const aiderRegex = /<<<<<<< SEARCH\s*[\r\n]+([\s\S]*?)[\r\n]+=======(?:[\r\n]+(?!>>>>>>> REPLACE)([\s\S]*?))?[\r\n]+>>>>>>> REPLACE/g;
    const matches = [...rawCode.matchAll(aiderRegex)];

    matches.forEach((match, hIdx) => {
        const searchPart = match[1] || "";
        const replacePart = match[2] || "";

        const hunkBubble = document.createElement('div');
        hunkBubble.className = 'aider-hunk-bubble';
        hunkBubble.innerHTML = `
            <div class="aider-hunk-header" onclick="this.closest('.aider-hunk-bubble').classList.toggle('collapsed')">
                <div style="display:flex; align-items:center; gap:8px; pointer-events: none;">
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
    if (isFinal) {
        streamQueues.delete(messageId);
        if (streamQueues.size === 0 && animationFrameRequest !== null) {
            cancelAnimationFrame(animationFrameRequest);
            animationFrameRequest = null;
        }
    }

    const wrapper = document.querySelector(`.message-wrapper[data-message-id='${messageId}']`);
    if (!wrapper) return;
    const contentDiv = wrapper.querySelector('.message-content') as HTMLElement;
    if (!contentDiv) return;

    let sourceText = "";
    let imagesHtml = "";

    if (Array.isArray(rawContent)) {
        sourceText = rawContent.filter(p => p.type === 'text').map(p => p.text).join('\n');

        const imageParts = rawContent.filter(p => p.type === 'image_url' && (p.image_url?.url || p.url));
        if (imageParts.length > 0) {
            const renderedImages = imageParts.map((imgPart: any, imgIdx: number) => {
                const url = imgPart.image_url?.url || imgPart.url || "";
                if (!url) return "";
                const isMuted = imgPart.isMuted === true || imgPart.muted === true;
                const mutedClass = isMuted ? 'muted-image' : '';
                const mutedBadge = isMuted 
                    ? `<div class="image-suppressed-badge"><span class="codicon codicon-error"></span> Suppressed (Text-only model)</div>` 
                    : '';

                return `
                    <div class="message-inline-image-card ${mutedClass}" data-img-idx="${imgIdx}" onclick="(window.openSovereignZoom || window.openImageZoom)('${url}')" title="${isMuted ? 'Image suppressed: model is text-only' : 'Click to zoom image'}">
                        ${mutedBadge}
                        <img src="${url}" alt="Attached Image" loading="lazy" />
                    </div>
                `;
            }).filter(Boolean).join('');

            if (renderedImages) {
                imagesHtml = `<div class="message-images-gallery">${renderedImages}</div>`;
            }
        }
    } else {
        sourceText = String(rawContent || "");
    }

    // 1. EXTRACT AND PACKAGE COHERENT REASONING BLOCKS (THOUGHTS)
    const thinkResult = processThinkTags(sourceText);
    const mainProcessedContent = thinkResult.processedContent;

    // Partition zones in contentDiv to ensure DOM elements (like the animated spinner) are preserved in-place
    let thoughtsZone = contentDiv.querySelector(':scope > .message-thoughts-zone') as HTMLElement;
    let imagesZone = contentDiv.querySelector(':scope > .message-images-zone') as HTMLElement;
    let bodyZone = contentDiv.querySelector(':scope > .message-body-zone') as HTMLElement;

    if (!thoughtsZone || !imagesZone || !bodyZone) {
        contentDiv.innerHTML = `
            <div class="message-thoughts-zone"></div>
            <div class="message-images-zone"></div>
            <div class="message-body-zone"></div>
        `;
        thoughtsZone = contentDiv.querySelector('.message-thoughts-zone') as HTMLElement;
        imagesZone = contentDiv.querySelector('.message-images-zone') as HTMLElement;
        bodyZone = contentDiv.querySelector('.message-body-zone') as HTMLElement;
    }

    if (thinkResult.thoughts.length === 0) {
        thoughtsZone.innerHTML = "";
    } else {
        // Prune any excess thought elements if count changed
        const existingCards = thoughtsZone.querySelectorAll('.plan-scratchpad');
        if (existingCards.length > thinkResult.thoughts.length) {
            for (let i = thinkResult.thoughts.length; i < existingCards.length; i++) {
                existingCards[i].remove();
            }
        }

        thinkResult.thoughts.forEach((t, idx) => {
            const isClosed = t.closed || isFinal;
            let scratchpad = thoughtsZone.querySelector(`.plan-scratchpad[data-idx="${idx}"]`) as HTMLElement;

            // Calculate thinking duration
            const tStart = wrapper.getAttribute('data-think-start-time');
            const tEnd = wrapper.getAttribute('data-think-end-time');
            let durationText = "";
            let isLive = false;

            if (tStart && tEnd) {
                const elapsed = ((parseInt(tEnd, 10) - parseInt(tStart, 10)) / 1000).toFixed(1);
                durationText = `thought for ${elapsed}s`;
            } else if (tStart && !isClosed) {
                isLive = true;
                const elapsedLive = ((Date.now() - parseInt(tStart, 10)) / 1000).toFixed(1);
                durationText = `thinking... (${elapsedLive}s)`;
            } else if (!isClosed) {
                durationText = `thinking...`;
            }

            const parsedMarkdown = DOMPurify.sanitize(marked.parse(t.content || "*AI is contemplating...*"));

            if (!scratchpad) {
                // First initialization of this thought block
                scratchpad = document.createElement('div');
                scratchpad.className = 'plan-scratchpad';
                scratchpad.dataset.idx = String(idx);
                scratchpad.dataset.closed = isClosed ? 'true' : 'false';
                scratchpad.style.cssText = 'margin-top:0; margin-bottom: 12px; border-left: 3px solid var(--thinking-color); box-sizing: border-box;';

                const iconHtml = isClosed 
                    ? '<span class="codicon codicon-circuit-board thought-status-icon"></span>' 
                    : '<span class="spinner thought-status-icon" style="width:10px; height:10px; border-width:2px; margin-right:6px; color: var(--thinking-color); display: inline-block;"></span>';

                const durationHtml = `<span class="think-duration ${isLive ? 'live-thinking' : ''}" style="font-size: 10px; ${isLive ? 'color: var(--thinking-color); font-weight: bold; animation: lollms-pulse 1.5s infinite;' : 'opacity: 0.6; font-weight: normal;'} margin-left: auto; padding-right: 12px;">${durationText}</span>`;

                scratchpad.innerHTML = `
                    <details ${!isClosed ? 'open' : ''} style="border: none; background: transparent; margin: 0; box-shadow: none;">
                        <summary class="scratchpad-header" style="color: var(--thinking-color); display: flex; align-items: center; justify-content: space-between; width: 100%; box-sizing: border-box; padding: 6px 12px; list-style: none;">
                            <div style="display: flex; align-items: center; gap: 6px;">
                                ${iconHtml}
                                <span style="font-weight: bold;" class="thought-title-label">Thought (Reasoning)${!isClosed ? '...' : ''}</span>
                            </div>
                            ${durationHtml}
                        </summary>
                        <div class="scratchpad-content markdown-body" style="padding: 10px 15px; font-size:11px; opacity:0.9; background:rgba(0,0,0,0.05); border-radius:0 0 6px 6px;">
                            ${parsedMarkdown}
                        </div>
                    </details>
                `;
                thoughtsZone.appendChild(scratchpad);
            } else {
                // DOM node ALREADY exists: perform in-place updates so the spinner DOM element is never destroyed/reset
                const wasClosed = scratchpad.dataset.closed === 'true';

                if (!wasClosed && isClosed) {
                    scratchpad.dataset.closed = 'true';
                    const iconEl = scratchpad.querySelector('.thought-status-icon');
                    if (iconEl) {
                        iconEl.outerHTML = '<span class="codicon codicon-circuit-board thought-status-icon"></span>';
                    }
                    const titleLabel = scratchpad.querySelector('.thought-title-label');
                    if (titleLabel) {
                        titleLabel.textContent = 'Thought (Reasoning)';
                    }
                }

                // Update duration text in-place
                const durationEl = scratchpad.querySelector('.think-duration');
                if (durationEl) {
                    durationEl.textContent = durationText;
                    if (isClosed) {
                        durationEl.className = 'think-duration';
                        (durationEl as HTMLElement).style.color = '';
                        (durationEl as HTMLElement).style.fontWeight = 'normal';
                        (durationEl as HTMLElement).style.opacity = '0.6';
                        (durationEl as HTMLElement).style.animation = 'none';
                    }
                }

                // Update text content in-place without resetting scroll or summary
                const contentEl = scratchpad.querySelector('.scratchpad-content');
                if (contentEl) {
                    contentEl.innerHTML = parsedMarkdown;
                }
            }
        });
    }

    // 2. EXTRACT VALID LINE-START XML TAG PLUGINS (FIRST-CLASS MUTATIONS & WIDGETS)
    const segments: MessageSegment[] = [];
    const ctx: PluginContext = { messageId, isFinal, capabilities: state.capabilities, vscode };
    let mutationTagIndex = 0;

    pluginRegistry.forEach(plugin => {
        if (plugin.extractBlocks) {
            const extracted = plugin.extractBlocks(mainProcessedContent, ctx);
            extracted.forEach(b => {
                // Bidirectional interval overlap check
                const isOverlapping = segments.some(s => b.start < s.end && b.end > s.start);
                if (!isOverlapping && b.html) {
                    segments.push({
                        type: 'plugin',
                        content: b.html,
                        start: b.start,
                        end: b.end,
                        plugin
                    });
                }
            });
            return;
        }

        if (!plugin.tagPattern) return;
        plugin.tagPattern.lastIndex = 0;
        let pMatch;
        while ((pMatch = plugin.tagPattern.exec(mainProcessedContent)) !== null) {
            const matchIndex = pMatch.index;
            const fullMatch = pMatch[0];

            // Strict Line-Start check: verify the match begins at the start of a line
            const hasLineStart = matchIndex === 0 || mainProcessedContent[matchIndex - 1] === '\n' || mainProcessedContent[matchIndex - 1] === '\r';
            if (!hasLineStart) continue;

            // Also check that the closing tag is at the start of a line (if it is not self-closing and closing tag is present)
            const isSelfClosing = fullMatch.trim().endsWith('/>');
            const hasClosingTag = fullMatch.includes('</');
            if (!isSelfClosing && hasClosingTag) {
                const closingTagIndex = matchIndex + fullMatch.lastIndexOf('</');
                const textBeforeClosing = mainProcessedContent.substring(matchIndex, closingTagIndex);
                const lastNewline = Math.max(textBeforeClosing.lastIndexOf('\n'), textBeforeClosing.lastIndexOf('\r'));
                const linePrefix = lastNewline === -1 ? textBeforeClosing : textBeforeClosing.substring(lastNewline + 1);
                const hasClosingLineStart = linePrefix.trim() === '';
                if (!hasClosingLineStart) continue;
            }

            // Exclude matching if it overlaps with previously matched plugins
            const isOverlapping = segments.some(s => 
                (matchIndex >= s.start && matchIndex < s.end) ||
                (matchIndex + fullMatch.length > s.start && matchIndex + fullMatch.length <= s.end) ||
                (s.start >= matchIndex && s.start < matchIndex + fullMatch.length)
            );
            if (isOverlapping) continue;

            const currentBlockIdx = plugin.id === 'file_mutation' ? mutationTagIndex++ : undefined;
            const html = plugin.render(pMatch, { ...ctx, blockIndex: currentBlockIdx });
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

    // 3. EXTRACT FENCED CODE BLOCKS OUTSIDE OF PLUGINS
    const codeBlocks = extractFilePaths(mainProcessedContent);
    codeBlocks.forEach((block, idx) => {
        // Skip if this code block overlaps with an already segmented XML plugin (Bidirectional check)
        const isOverlapping = segments.some(s => block.start < s.end && block.end > s.start);
        if (isOverlapping) return;

        const blockText = mainProcessedContent.substring(block.start, block.end);
        const lines = blockText.split(/\r?\n/);
        if (lines.length === 0) return;

        if (lines.length > 1 && lines[lines.length - 1] === '') {
            lines.pop();
        }

        const firstLine = lines[0].trim();
        const match = firstLine.match(/^`{3,}(\S*)/);
        const language = match ? match[1] : '';

        const rawCode = block.isClosed 
            ? lines.slice(1, lines.length - 1).join('\n') 
            : lines.slice(1).join('\n');

        const escapedCode = rawCode
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");

        const placeholderHtml = `<pre class="lollms-placeholder" data-block-index="${idx}" data-lang="${language.replace(/"/g, '&quot;')}"><code>${escapedCode}</code></pre>`;

        segments.push({
            type: 'plugin',
            content: placeholderHtml,
            start: block.start,
            end: block.end
        });
    });

    const allSegments: MessageSegment[] = [...segments];
    allSegments.sort((a, b) => a.start - b.start);

    const finalSegments: MessageSegment[] = [];
    let cursor = 0;

    allSegments.forEach(seg => {
        if (seg.start > cursor) {
            finalSegments.push({
                type: 'markdown',
                content: mainProcessedContent.substring(cursor, seg.start),
                start: cursor,
                end: seg.start
            });
        }
        finalSegments.push(seg);
        cursor = seg.end;
    });

    if (cursor < mainProcessedContent.length) {
        finalSegments.push({
            type: 'markdown',
            content: mainProcessedContent.substring(cursor),
            start: cursor,
            end: mainProcessedContent.length
        });
    }

    // 4. CLEAN AND ESCAPE REMAINING INLINE CONVERSATIONAL TAGS
    // Since active line-start widgets have been extracted and replaced with segments,
    // any remaining occurrences in the markdown segments are *by definition* inline references.
    finalSegments.forEach(seg => {
        if (seg.type === 'markdown') {
            const forbiddenRanges: { start: number, end: number }[] = [];
            const inlineFenceRegex = /```[\s\S]*?(?:```|$)|`[^`\n\r]+`/g;
            let m;
            while ((m = inlineFenceRegex.exec(seg.content)) !== null) {
                forbiddenRanges.push({ start: m.index, end: m.index + m[0].length });
            }

            const isIndexInsideFence = (index: number) => {
                return forbiddenRanges.some(r => index >= r.start && index < r.end);
            };

            const inlineTagRegex = /<(add_files_to_context|query_architecture|project_memory|lollms_tool|move_files|copy_files|delete_files|remove_files_from_context|skill)\b([^>]*?)>([\s\S]*?)<\/\1>/gi;
            seg.content = seg.content.replace(inlineTagRegex, (match, tag, attrs, body, offset) => {
                if (isIndexInsideFence(offset)) return match;
                return `\`<${tag}${attrs}>${body}</${tag}>\``;
            });

            const inlineSelfClosingRegex = /<(lollms_tool|generate_image|edit_image_asset|milestone|plan_status)\s+([^>]*?)\s*\/>/gi;
            seg.content = seg.content.replace(inlineSelfClosingRegex, (match, tag, attrs, offset) => {
                if (isIndexInsideFence(offset)) return match;
                return `\`<${tag} ${attrs} />\``;
            });
        }
    });

    // 5. UNIFIED TOOL DISPATCHER (AGENT MODE SUPPORT)
    finalSegments.forEach(seg => {
        if (seg.type === 'markdown') {
            const jsonRegex = /```json[\r\n]+([\s\S]+?)[\r\n]+```/g;
            let jMatch;
            while ((jMatch = jsonRegex.exec(seg.content)) !== null) {
                try {
                    const toolObj = JSON.parse(jMatch[1]);
                    if (toolObj && toolObj.tool) {
                        const plugin = pluginRegistry.find(p => p.toolName === toolObj.tool);
                        if (plugin) {
                            const pluginHtml = plugin.render(toolObj, ctx);
                            if (pluginHtml) {
                                seg.content = seg.content.replace(jMatch[0], pluginHtml);
                            }
                        }
                    }
                } catch (e) {}
            }
        }
    });

    // 6. BUILD FINAL HTML STREAM
    let finalHtml = "";
    finalSegments.forEach(seg => {
        if (seg.type === 'plugin') {
            finalHtml += seg.content;
        } else {
            // Check if marked can be parsed safely
            try {
                finalHtml += `<div class="markdown-body">${marked.parse(seg.content)}</div>`;
            } catch (err) {
                finalHtml += `<div class="markdown-body"><pre>${seg.content}</pre></div>`;
            }
        }
    });

    // --- APPLY ALL AGGREGATOR (COUNTS BOTH XML <file> TAGS & LEGACY BLOCKS) ---
    const xmlFileBlocks = extractFileBlocks(sourceText);
    const xmlActionableCount = xmlFileBlocks.filter((b: any) => /path=["'][^"']+["']/i.test(b.attrStr)).length;

    const globalBlockInfos = extractFilePaths(sourceText);
    const legacyActionableCount = globalBlockInfos.filter(info => {
        return info.path && ['file', 'diff', 'insert', 'replace', 'delete'].includes(info.type || '');
    }).length;

    const totalActionableCount = xmlActionableCount + legacyActionableCount;

    if (totalActionableCount > 1 && isFinal) {
        finalHtml += `
            <div class="apply-all-wrapper" style="margin-top: 16px; padding: 0 12px;">
                <button class="apply-all-btn" id="apply-all-${messageId}">
                    <span class="codicon codicon-check-all"></span> Apply All Changes (${totalActionableCount} files)
                </button>
                <div class="apply-progress-container" id="progress-container-${messageId}" style="height:4px; background:var(--vscode-widget-border); border-radius:2px; margin-top:8px; overflow:hidden;">
                    <div class="apply-progress-bar" id="progress-bar-${messageId}" style="width:0%; height:100%; background:var(--vscode-charts-blue); transition: width 0.3s ease;"></div>
                </div>
                <div class="apply-results-list" id="results-${messageId}" style="margin-top:8px; display:flex; flex-direction:column; gap:4px;"></div>
            </div>`;
    }


    // Update images and main body zones separately to keep the thoughts zone stable
    if (imagesZone) {
        imagesZone.innerHTML = DOMPurify.sanitize(imagesHtml, SANITIZE_CONFIG);
    }

    if (bodyZone) {
        bodyZone.innerHTML = DOMPurify.sanitize(finalHtml, SANITIZE_CONFIG);
    }

    // Secure Auto-render invocation for Math expressions in Chat Messages
    if (typeof (window as any).renderMathInElement === 'function') {
        try {
            (window as any).renderMathInElement(contentDiv, {
                delimiters: [
                    {left: '$$', right: '$$', display: true},
                    {left: '$', right: '$', display: false},
                    {left: '\\\\(', right: '\\\\)', display: false},
                    {left: '\\\\[', right: '\\\\]', display: true}
                ],
                throwOnError: false
            });
        } catch (mathErr) {
            console.warn("KaTeX renderMathInElement failed", mathErr);
        }
    }

    // Highlight any raw code blocks inside thoughts or live streaming file mutation cards
    contentDiv.querySelectorAll('.plan-scratchpad pre code, .file-mutation-card pre code, .code-collapsible pre code').forEach(block => {
        Prism.highlightElement(block);
    });

    enhanceCodeBlocks(bodyZone, messageId, rawContent, isFinal);

    // Attach single unified listener for the Apply All button
    const applyAllBtn = contentDiv.querySelector(`#apply-all-${messageId}`) as HTMLButtonElement;
    if (applyAllBtn) {
        applyAllBtn.onclick = () => {
            // If clicked while active, cancel immediately
            if (applyAllBtn.classList.contains('sequential-applying')) {
                applyAllBtn.disabled = true;
                applyAllBtn.innerHTML = '<span class="codicon codicon-sync spin"></span> Cancelling...';
                vscode.postMessage({ command: 'stopGeneration' });
                return;
            }

            const isUndo = applyAllBtn.classList.contains('undo-all-btn');
            const changes = gatherChangesFromBlocks(messageId, isUndo);
            if (changes.length > 0) {
                applyAllBtn.disabled = true;
                applyAllBtn.innerHTML = isUndo 
                    ? '<span class="codicon codicon-sync spin"></span> Undoing Batch...' 
                    : '<span class="codicon codicon-sync spin"></span> Applying Batch...';

                const resList = document.getElementById(`results-${messageId}`);
                const progressContainer = document.getElementById(`progress-container-${messageId}`);

                if (resList) {
                    resList.style.display = 'block';
                    resList.innerHTML = changes.map(c => `
                        <div class="apply-row" data-block-index="${c.blockIndex}" ${c.hunkIndex !== undefined ? `data-hunk-index="${c.hunkIndex}"` : ''}>
                            <span class="status-icon"><div class="spinner"></div></span>
                            <span class="row-path clickable" onclick="vscode.postMessage({command:'openFile', path:'${c.path}'})">${c.path} ${c.hunkIndex !== undefined ? `(Hunk ${c.hunkIndex+1})` : ''}</span>
                            <div class="row-actions" style="display:none"></div>
                        </div>`).join('');
                }

                if (progressContainer) {
                    progressContainer.style.display = 'block';
                    const bar = progressContainer.querySelector('.apply-progress-bar') as HTMLElement;
                    if (bar) bar.style.width = '0%';
                }

                vscode.postMessage({ command: 'applyAllChanges', changes, messageId, undo: isUndo });
            }
        };
    }

    finalSegments.forEach(seg => {
            if (seg.type === 'plugin' && seg.plugin?.initialize) {
            seg.plugin.initialize(contentDiv, ctx);
        }
    });

    // Synchronize master batch button with initial/hydrated applied states
    if (isFinal) {
        checkAndSyncMessageAppliedState(messageId);
    }

    triggerVirtualListRecalculation();
}









export interface PatchItem {
    id: string;
    blockIndex: number;
    hunkIndex?: number;
    path: string;
    label: string;
    content: string;
    type: 'replace' | 'file' | 'diff';
    blockId: string;
    isApplied: boolean;
}

export function getPatchesForMessage(messageId: string): PatchItem[] {
    const patches: PatchItem[] = [];
    const wrapper = document.querySelector(`.message-wrapper[data-message-id='${messageId}']`);
    if (!wrapper) return patches;

    const appliedStateForMsg = state.appliedState?.[messageId] || {};
    const blocks = Array.from(new Set(wrapper.querySelectorAll('details.code-collapsible, .file-mutation-card')));

    blocks.forEach((block: any, idx: number) => {
        const isMutationCard = block.classList.contains('file-mutation-card');
        const bIdxAttr = block.dataset.blockIndex;
        let blockIndex = bIdxAttr !== undefined && bIdxAttr !== "" ? parseInt(bIdxAttr, 10) : idx;
        if (isNaN(blockIndex)) blockIndex = idx;

        const appliedHunks = appliedStateForMsg[blockIndex] || [];
        const isBlockFullyApplied = appliedHunks.includes(-1);

        if (isMutationCard) {
            const rawPath = block.dataset.path || "";
            const action = block.dataset.action || "write";
            const symbol = block.dataset.symbol || "";
            const rawCodeAttr = block.dataset.rawCode;
            const codeText = rawCodeAttr ? decodeURIComponent(rawCodeAttr) : (block.querySelector('pre code')?.textContent || "");
            const applyBtn = block.querySelector('.apply-mutation-btn, .apply-btn');
            const targetPath = (symbol && action !== 'patch') ? `${rawPath}:${symbol}` : rawPath;
            const changeType = (action === 'patch' || codeText.includes('<<<<<<< SEARCH')) ? 'replace' : 'file';

            const hunkTabs = Array.from(block.querySelectorAll('.hunk-tab')) as HTMLElement[];
            if (hunkTabs.length > 1) {
                hunkTabs.forEach((tab: HTMLElement, hIdx: number) => {
                    const pane = block.querySelector(`.hunk-pane-${hIdx}`);
                    const hunkBtn = pane?.querySelector('.apply-btn');
                    const isHunkApplied = isBlockFullyApplied || appliedHunks.includes(hIdx) || 
                        tab.classList.contains('status-completed') || hunkBtn?.classList.contains('applied') || false;

                    patches.push({
                        id: `${blockIndex}-${hIdx}`,
                        blockIndex,
                        hunkIndex: hIdx,
                        path: targetPath,
                        label: `${rawPath} (Hunk ${hIdx + 1})`,
                        content: codeText,
                        type: changeType,
                        blockId: block.id,
                        isApplied: isHunkApplied
                    });
                });
            } else {
                const isApplied = isBlockFullyApplied || appliedHunks.length > 0 || applyBtn?.classList.contains('applied') || false;
                patches.push({
                    id: `${blockIndex}-full`,
                    blockIndex,
                    hunkIndex: undefined,
                    path: targetPath,
                    label: `${rawPath}${symbol ? ` (${symbol})` : ''}`,
                    content: codeText,
                    type: changeType,
                    blockId: block.id,
                    isApplied
                });
            }
            return;
        }

        // Markdown code blocks
        const idParts = block.id ? block.id.split('-') : [];
        if (idParts.length > 0) {
            const parsed = parseInt(idParts[idParts.length - 1], 10);
            if (!isNaN(parsed)) blockIndex = parsed;
        }

        const rawCode = block.dataset.rawCode || "";
        const pathInp = block.querySelector('.path-editor-input') as HTMLInputElement;
        const path = pathInp ? pathInp.value.trim() : (block.dataset.path || "");
        if (!path) return;

        const hunkTabs = Array.from(block.querySelectorAll('.hunk-tab')) as HTMLElement[];
        const hunkBubbles = Array.from(block.querySelectorAll('.aider-hunk-bubble'));

        if (hunkTabs.length > 1) {
            hunkTabs.forEach((tab: HTMLElement, hIdx: number) => {
                const pane = block.querySelector(`.hunk-pane-${hIdx}`);
                const hunkBtn = pane?.querySelector('.apply-btn');
                const isHunkApplied = isBlockFullyApplied || appliedHunks.includes(hIdx) || 
                    tab.classList.contains('status-completed') || hunkBtn?.classList.contains('applied') || false;

                patches.push({
                    id: `${blockIndex}-${hIdx}`,
                    blockIndex,
                    hunkIndex: hIdx,
                    path,
                    label: `${path} (Hunk ${hIdx + 1})`,
                    content: rawCode,
                    type: 'replace',
                    blockId: block.id,
                    isApplied: isHunkApplied
                });
            });
        } else if (hunkBubbles.length > 0) {
            hunkBubbles.forEach((hunk: any, hIdx: number) => {
                const btn = hunk.querySelector('.apply-btn');
                const isHunkApplied = isBlockFullyApplied || appliedHunks.includes(hIdx) || btn?.classList.contains('applied') || false;

                patches.push({
                    id: `${blockIndex}-${hIdx}`,
                    blockIndex,
                    hunkIndex: hIdx,
                    path,
                    label: `${path} (Hunk ${hIdx + 1})`,
                    content: rawCode,
                    type: 'replace',
                    blockId: block.id,
                    isApplied: isHunkApplied
                });
            });
        } else {
            const applyBtn = block.querySelector('.code-actions .apply-btn');
            const labelText = block.querySelector('.summary-lang-label span')?.textContent || "";
            const changeType = labelText.toLowerCase().includes('diff') ? 'diff' : 'file';
            const isApplied = isBlockFullyApplied || appliedHunks.length > 0 || applyBtn?.classList.contains('applied') || false;

            patches.push({
                id: `${blockIndex}-full`,
                blockIndex,
                hunkIndex: undefined,
                path,
                label: path,
                content: rawCode,
                type: changeType,
                blockId: block.id,
                isApplied
            });
        }
    });

    return patches;
}

export function gatherChangesFromBlocks(messageId: string, isUndo: boolean = false) {
    const patches = getPatchesForMessage(messageId);
    if (isUndo) {
        return patches.filter(p => p.isApplied).map(p => ({
            type: p.type,
            path: p.path,
            content: p.content,
            label: p.label,
            blockIndex: p.blockIndex,
            hunkIndex: p.hunkIndex,
            blockId: p.blockId
        }));
    } else {
        return patches.filter(p => !p.isApplied).map(p => ({
            type: p.type,
            path: p.path,
            content: p.content,
            label: p.label,
            blockIndex: p.blockIndex,
            hunkIndex: p.hunkIndex,
            blockId: p.blockId
        }));
    }
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

    // DETECTOR: Identify PURELY technical messages to un-wrap them.
    const technicalPatterns = [
        '<agent_task', 
        '<milestone', 
        '<project_memory', 
        '<git_event', 
        '<lollms_form',
        '<builder_report'
    ];

    const trimmedContent = content.trim();
    const isPurelyTechnical = technicalPatterns.some(p => {
        return trimmedContent.startsWith(p) && (trimmedContent.endsWith('/>') || trimmedContent.endsWith('>') || trimmedContent.includes('</'));
    }) && !trimmedContent.match(/^[a-zA-Z0-9]/);

    if (message.role === 'system' && content.startsWith('Attached file:')) {
        addAttachment(message);
    } else {
        // Prevent layout shifts during appending: batch scroll metrics
        const wasAtBottom = dom.messagesDiv && (dom.messagesDiv.scrollHeight - dom.messagesDiv.scrollTop - dom.messagesDiv.clientHeight < 40);
        addChatMessage(message, isFinal, isPurelyTechnical);
        if (wasAtBottom && dom.messagesDiv) {
            dom.messagesDiv.scrollTop = dom.messagesDiv.scrollHeight;
        }
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
                <div class="staged-image-card" style="background-image: url(${src}); cursor: pointer;" 
                     onclick="(window.openSovereignZoom || window.openImageZoom)('${src}')" title="Click to view full screen">
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

    // Import specialized renderers dynamically to keep compilation light and clean
    import('./renderers/assistant_message_renderer.js').then(assistant => {
    import('./renderers/dynamic_message_renderer.js').then(dynamic => {
    import('./renderers/agent_message_renderer.js').then(agent => {

        const caps = state.capabilities || { agentMode: false, dynamicMode: false };
        const isAgent = state.capabilities?.agentMode && role === 'assistant';
        const isDynamic = caps.dynamicMode === true && !isAgent;
        const isAssistant = !isAgent && !isDynamic;

        let modeClass = "";
        if (role === 'assistant') {
            if (isAgent) modeClass = "agent-mode-message";
            else if (isDynamic) modeClass = "dynamic-mode-message";
            else modeClass = "assistant-mode-message";
        }

        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${role}-message ${modeClass} ${isTechnical ? 'technical-event' : ''}`;
        messageDiv.dataset.originalContent = JSON.stringify(rawContent);

        const avatarDiv = document.createElement('div');
        avatarDiv.className = 'message-avatar';

        if (role === 'user') {
            avatarDiv.innerHTML = '<span class="codicon codicon-account"></span>';
        }

        messageDiv.appendChild(avatarDiv);

        const bodyDiv = document.createElement('div');
        bodyDiv.className = 'message-body';
        messageDiv.appendChild(bodyDiv);

        messageWrapper.appendChild(messageDiv);

        const insertionControls = document.getElementById('message-insertion-controls');
        if (insertionControls) {
            dom.chatMessagesContainer.insertBefore(messageWrapper, insertionControls);
        } else {
            dom.chatMessagesContainer.appendChild(messageWrapper);
        }

        let isWaiting = false;
        // Centralized Stream Registration: Ensure we always capture incoming text tokens
        const isEmptyContent = !rawContent || (typeof rawContent === 'string' && rawContent.trim() === '');
        if (role === 'assistant' && isEmptyContent) {
            state.streamingMessages[id] = { buffer: '', timer: null };
            isWaiting = true;
        }

        // Delegate to specialized renderer depending on active discussion layout and mode
        if (role !== 'assistant') {
            assistant.renderAssistantMessage(id, rawContent, isFinal);
        } else {
            if (isAgent) {
                agent.renderAgentMessage(id, rawContent, isFinal);
            } else if (isDynamic) {
                dynamic.renderDynamicMessage(id, rawContent, isFinal);
            } else {
                assistant.renderAssistantMessage(id, rawContent, isFinal);
            }
        }

        if (isWaiting && role === 'assistant') {
            const contentDiv = messageDiv.querySelector('.message-content');
            if (contentDiv && !contentDiv.querySelector('.waiting-animation')) {
                // Ensure a stable, non-flickering, pre-allocated layout block is used for the thinking state
                contentDiv.innerHTML = `
                    <div class="waiting-animation" style="display:flex; align-items:center; gap:10px; opacity:0.95; padding:6px 0;">
                        <div class="lollms-spinner" style="flex-shrink:0;"></div>
                        <span class="thinking-text" style="font-style:italic; font-size:12px;">Thinking...</span>
                    </div>
                `;
            }
        }
    });
    });
    });
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

// --- presenters/ContextPresenter.ts ---
// Structural layout generator decoupled from visual rendering nodes & interactive binders.
export class ContextPresenter {
    public static renderModelSelectorBadge(currentModel: string, models: any[]): string {
        return `
        <div class="badge-wrapper" style="position: relative;">
            <span id="hud-model-badge" class="mode-badge model clickable" title="Current Model: ${currentModel}. Click to change model.">
                <span class="codicon codicon-hubot"></span> <span class="badge-label">${currentModel}</span>
            </span>
            <div id="hud-model-menu" class="custom-menu hidden"></div>
        </div>`;
    }

    public static renderFileList(
        list: (string | { path: string, bytes?: number, tokens?: number, state?: string })[], 
        emptyMsg: string, 
        allowSummarize: boolean = false,
        fileTokensMap: Record<string, number> = {},
        sortOrder: 'heavy-to-light' | 'light-to-heavy' | 'name' = 'heavy-to-light'
    ): string {
        if (!list || list.length === 0) return `<div class="empty-context-msg">${emptyMsg}</div>`;

        const registry = (window as any).lazyFilesRegistry;

        // Normalize list items to objects with byte sizes and approximate token conversions
        const normalized = list.map(item => {
            const rawPath = typeof item === 'string' ? item : item.path;
            const regItem = registry?.get(rawPath);

            let bytes = 0;
            let tokens = 0;
            let fileState = undefined;

            if (typeof item === 'object' && item !== null) {
                fileState = item.state;
                if (typeof item.bytes === 'number' && item.bytes > 0) {
                    bytes = item.bytes;
                }
                if (typeof item.tokens === 'number' && item.tokens > 0) {
                    tokens = item.tokens;
                }
            }

            if (regItem && typeof regItem === 'object') {
                if (bytes === 0 && typeof regItem.bytes === 'number' && regItem.bytes > 0) {
                    bytes = regItem.bytes;
                }
                if (tokens === 0 && typeof regItem.tokens === 'number' && regItem.tokens > 0) {
                    tokens = regItem.tokens;
                }
                if (!fileState) fileState = regItem.state;
            }

            if (tokens === 0 && fileTokensMap[rawPath]) {
                tokens = fileTokensMap[rawPath];
            }

            if (bytes === 0 && tokens > 0) {
                bytes = Math.round(tokens * 3.5);
            } else if (tokens === 0 && bytes > 0) {
                tokens = Math.max(1, Math.ceil(bytes / 3.5));
            }

            return { path: rawPath, bytes, tokens, state: fileState };
        });

        // Apply sorting
        if (sortOrder === 'heavy-to-light') {
            normalized.sort((a, b) => (b.bytes - a.bytes) || (b.tokens - a.tokens) || a.path.localeCompare(b.path));
        } else if (sortOrder === 'light-to-heavy') {
            normalized.sort((a, b) => (a.bytes - b.bytes) || (a.tokens - b.tokens) || a.path.localeCompare(b.path));
        } else if (sortOrder === 'name') {
            normalized.sort((a, b) => a.path.split('/').pop()!.localeCompare(b.path.split('/').pop()!));
        }

        return `<ul class="context-file-list">
            ${normalized.map(item => {
                const f = item.path;
                const bytes = item.bytes || 0;
                const tokens = item.tokens || (bytes > 0 ? Math.ceil(bytes / 3.5) : 0);
                const uniqueDomId = f.replace(/[^a-zA-Z0-9]/g, '_');
                const fileName = f.split('/').pop() || f;
                const dirName = f.includes('/') ? f.substring(0, f.lastIndexOf('/')) : '';

                // Build styled weight badge with byte size and estimated tokens
                let formattedBytes = `${bytes} B`;
                if (bytes >= 1024 * 1024) {
                    formattedBytes = `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
                } else if (bytes >= 1024) {
                    formattedBytes = `${(bytes / 1024).toFixed(1)} KB`;
                }

                const displayTok = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : `${tokens}`;
                const weightClass = bytes >= 35000 ? 'weight-heavy' : (bytes >= 10000 ? 'weight-medium' : 'weight-light');
                const tokenBadge = `<span class="file-token-badge ${weightClass}" title="Size: ${bytes.toLocaleString()} bytes (~${tokens.toLocaleString()} tokens)">${formattedBytes} (~${displayTok} tok)</span>`;

                return `
                <li class="context-item" style="flex-direction: column; align-items: stretch; gap: 4px;">
                    <div style="display:flex; align-items:center; width:100%; gap: 6px;">
                        <details class="info-collapsible lazy-file-accordion" data-path="${f}" style="flex: 1; min-width:0; border:none; padding:0;">
                            <summary style="padding: 2px 0; cursor: pointer; font-size: 11px; font-weight: 600; display:flex; align-items:center; gap: 6px;">
                                <span class="codicon codicon-file"></span>
                                <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1;" title="${f}">${fileName}</span>
                                ${dirName ? `<span style="font-size:9px; opacity:0.45; margin-right:4px; max-width:110px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${dirName}</span>` : ''}
                                ${tokenBadge}
                            </summary>
                            <div class="lazy-file-pane" id="lazy-pane-${uniqueDomId}" style="padding-top: 8px; font-size:11px; font-family:var(--vscode-editor-font-family);">
                                <div style="display:flex; align-items:center; gap:8px; opacity:0.6;"><div class="spinner"></div> Ingesting file content from disk...</div>
                            </div>
                        </details>
                        <div style="display:flex; gap:2px; flex-shrink:0;">
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
                    </div>
                </li>`}).join('')}
           </ul>`;
    }

    public static renderSkills(skills: any[]): string {
        return skills && skills.length > 0
            ? `<div class="context-skill-list">
                ${skills.map(s => `
                    <div class="context-item skill-item" style="display: flex; align-items: flex-start; gap: 8px; border-bottom: 1px solid var(--vscode-widget-border); padding: 4px 0;">
                        <details class="info-collapsible" style="flex: 1; border: none; padding: 0;">
                            <summary style="padding: 2px 0; cursor: pointer; font-size: 11px; font-weight: 600;">${DOMPurify.sanitize(s.name)}</summary>
                            <div class="skill-content" style="padding: 8px; background: rgba(0,0,0,0.2); border-radius: 4px; margin-top: 4px; font-family: var(--vscode-editor-font-family); font-size: 10px; max-height: 150px; overflow-y: auto;">
                                ${DOMPurify.sanitize(s.content)}
                            </div>
                        </details>
                        <button class="remove-context-btn" data-type="skill" data-value="${s.id}" title="Remove skill" style="padding: 2px; opacity: 0.6;">
                            <span class="codicon codicon-close"></span>
                        </button>
                    </div>
                `).join('')}
               </div>`
            : '<div class="empty-context-msg">No specialized skills currently active.</div>';
    }

    public static getDashboardHtml(
        themeClass: string,
        isAgentActive: boolean,
        isNewDiscussion: boolean,
        finalSelections: string[],
        finalFilesCount: number,
        projectFilesHtml: string,
        externalFilesHtml: string,
        finalDiagrams: any[],
        finalTools: any[],
        briefing: string,
        skillsHtml: string,
        briefingHtml: string
    ): string {
        return `
        <div class="context-message ${themeClass}" id="fused-context-dashboard">
            <details class="fused-context-details">
                <summary>
                    <div class="fused-hud-header" style="display: flex; flex-direction: column; gap: 10px; padding: 12px; background: rgba(0,0,0,0.2);">
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
                        </div>

                        <div class="token-fused-bar" style="display: flex; flex-direction: column; gap: 4px;">
                            <div style="display: flex; align-items: center; gap: 8px;">
                                <button id="hud-quick-refresh-btn" class="icon-btn" title="Refresh & Recalculate Context Tokens" style="padding: 2px; color: var(--vscode-textLink-foreground); opacity: 0.9; cursor: pointer;">
                                    <i class="codicon codicon-refresh" style="font-size: 12px;"></i>
                                </button>
                                <div class="token-progress-container" id="token-progress-container" style="flex: 1; height: 6px; border-radius: 3px; background: rgba(255,255,255,0.06);">
                                    <div class="token-progress-bar" id="token-progress-bar"></div>
                                </div>
                            </div>
                            <div style="display: flex; justify-content: space-between; align-items: center;">
                                <span id="token-count-label" style="font-size: 9px; opacity: 0.6; font-family: var(--vscode-editor-font-family);">Calculating...</span>
                                <div id="token-bar-legend" class="token-legend" style="display: none; gap: 10px;"></div>
                            </div>
                        </div>
                    </div>
                </summary>

                <div class="message-body">
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
                            <button id="refresh-context-btn" class="icon-btn" title="Force refresh context & recalculate bar" style="padding: 2px; color: var(--vscode-charts-blue);"><i class="codicon codicon-sync"></i></button>
                            <select id="hud-selections-dropdown" ${finalSelections.length === 0 ? 'disabled' : ''} style="background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); font-size: 11px; padding: 2px 6px; border-radius: 4px; cursor: ${finalSelections.length === 0 ? 'default' : 'pointer'}; height: 22px; max-width: 150px; outline: none; display: inline-block; opacity: ${finalSelections.length === 0 ? '0.5' : '1'};">
                                <option value="">${finalSelections.length > 0 ? '📁 Select Saved Context...' : '📁 No Saved Contexts'}</option>
                                ${finalSelections.map((s: string) => `<option value="${s}">${s.replace('.lollms-ctx', '')}</option>`).join('')}
                            </select>                        
                            <button id="save-context-btn" class="icon-btn" title="Save file selection" style="padding: 2px;"><i class="codicon codicon-save"></i></button>
                            <button id="load-context-btn" class="icon-btn" title="Load Context (Replace Selection)" style="padding: 2px;"><i class="codicon codicon-folder-opened"></i></button>
                            <button id="add-context-btn" class="icon-btn" title="Add Context (Append to Selection)" style="padding: 2px; color: var(--vscode-charts-green);"><i class="codicon codicon-folder-active"></i></button>
                            <button id="reset-context-bubble-btn" class="icon-btn" title="Full Context Reset" style="padding: 2px; color: var(--vscode-errorForeground);"><i class="codicon codicon-clear-all"></i></button>
                        </div>
                    </div>
                    <div class="hud-scroll-container">
                        <details class="info-collapsible briefing-details" style="margin-bottom: 6px; border-left: 4px solid var(--vscode-charts-purple);">
                            <summary>
                                <div style="display: flex; justify-content: space-between; align-items: center; width: calc(100% - 20px);">
                                    <span>Mission Briefing & Constraints</span>
                                    <button id="edit-briefing-btn" class="icon-btn" title="Edit Briefing" style="color: var(--vscode-charts-purple);"><i class="codicon codicon-shield"></i></button>
                                </div>
                            </summary>
                            <div class="collapsible-content">
                                <div class="briefing-content" style="padding: 10px; font-size: 12px; line-height: 1.5; color: var(--vscode-editor-foreground);">
                                    ${briefingHtml}
                                </div>
                            </div>
                        </details>

                        <details class="info-collapsible files-details" style="margin-bottom: 6px;">
                            <summary>
                                <div style="display: flex; justify-content: space-between; align-items: center; width: calc(100% - 20px);">
                                    <span class="files-count-label">Selected Files (${finalFilesCount})</span>
                                    <div style="display: flex; gap: 8px; align-items: center;">
                                        <button id="view-usage-context-btn" class="icon-btn" title="Verify File Sizes / Token Usage"><i class="codicon codicon-dashboard"></i></button>
                                        <div style="width: 1px; height: 12px; background: var(--vscode-widget-border);"></div>
                                        <button id="add-file-context-btn" class="icon-btn" title="Add File"><i class="codicon codicon-add"></i></button>
                                        <button id="web-context-btn" class="icon-btn" title="Web Discovery"><i class="codicon codicon-globe"></i></button>
                                        <button id="search-add-context-btn" class="icon-btn" title="Power Search"><i class="codicon codicon-search"></i></button>
                                    </div>
                                </div>
                            </summary>
                            <div class="collapsible-content hud-files-container" style="padding-top: 8px;">
                                <h4 style="margin: 0 0 8px 4px; font-size: 11px; opacity: 0.7; text-transform: uppercase; display: flex; justify-content: space-between; align-items: center;">
                                    <span>Project Files</span>
                                    <div style="display: flex; gap: 4px; align-items: center;">
                                        <button id="sort-files-btn" class="section-bulk-btn" title="Toggle sorting order (Heavy to Light / A-Z)">
                                            <span class="codicon ${state.fileSortOrder === 'name' ? 'codicon-sort-alphabetically' : (state.fileSortOrder === 'light-to-heavy' ? 'codicon-sort-numeric-up' : 'codicon-sort-numeric-down')}"></span>
                                            <span id="sort-files-label">${state.fileSortOrder === 'name' ? 'A-Z' : (state.fileSortOrder === 'light-to-heavy' ? 'Light to Heavy' : 'Heavy to Light')}</span>
                                        </button>
                                        ${finalFilesCount > 0 ? `<button id="bulk-remove-project-btn" class="section-bulk-btn"><span class="codicon codicon-checklist"></span> Bulk Remove</button>` : ''}
                                    </div>
                                </h4>
                                <div class="hud-project-files-list">${projectFilesHtml}</div>
                                <h4 style="margin: 12px 0 8px 4px; font-size: 11px; opacity: 0.7; text-transform: uppercase; display: flex; justify-content: space-between; align-items: center;">
                                    <span>External & Research</span>
                                    ${externalFilesHtml.includes('context-item') ? `<div style="display: flex; gap: 4px;"><button id="bulk-process-external-btn" class="section-bulk-btn"><span class="codicon codicon-wand"></span> Process</button><button id="bulk-delete-external-btn" class="section-bulk-btn delete"><span class="codicon codicon-trash"></span> Delete</button></div>` : ''}
                                </h4>
                                <div class="hud-external-files-list">${externalFilesHtml}</div>
                            </div>
                        </details>
                        <details class="info-collapsible diagrams-details" style="margin-bottom: 6px;">
                            <summary>
                                <div style="display: flex; justify-content: space-between; align-items: center; width: calc(100% - 20px);">
                                    <span class="diagrams-count-label">Active Diagrams (${(finalDiagrams || []).length})</span>
                                    <button id="add-diagram-context-btn" class="icon-btn" title="Add Diagram"><i class="codicon codicon-add"></i></button>
                                </div>
                            </summary>
                            <div class="collapsible-content">
                                ${finalDiagrams && finalDiagrams.length > 0 ? finalDiagrams.map(d => `<div class="context-item" style="flex-direction:column; align-items:stretch;"><div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:5px;"><span style="font-weight:bold; font-size:11px;">${d.type.replace('_', ' ').toUpperCase()}</span><button class="remove-context-btn" data-type="diagram" data-value="${d.type}"><span class="codicon codicon-close"></span></button></div><pre class="mermaid" style="background:var(--vscode-editor-background); border-radius:4px; padding:5px;">${d.mermaid}</pre></div>`).join('') : '<div class="empty-context-msg">No diagrams included.</div>'}
                            </div>
                        </details>
                        <details class="info-collapsible tools-details" style="margin-bottom: 6px;">
                            <summary>
                                <div style="display: flex; justify-content: space-between; align-items: center; width: calc(100% - 20px);">
                                    <span class="tools-count-label">Active Tools (${finalTools.length})</span>
                                    <div style="display: flex; gap: 8px; align-items: center;">
                                        <button id="add-tool-context-btn" class="icon-btn" title="Equip Tool"><i class="codicon codicon-add"></i></button>
                                        ${finalTools.length > 0 ? `<button id="bulk-remove-tools-btn" class="section-bulk-btn delete"><span class="codicon codicon-trash"></span> Clear</button>` : ''}
                                    </div>
                                </div>
                            </summary>
                            <div class="collapsible-content collapsible-content-inner-tools" style="padding-top: 8px;">
                                <div class="hud-tools-list">
                                    ${finalTools && finalTools.length > 0
                                        ? `<div class="context-file-list">
                                            ${finalTools.map(t => `
                                                <div class="context-item" style="padding: 4px 8px;">
                                                    <span class="codicon codicon-wrench" style="color:var(--vscode-charts-orange); opacity:0.8;"></span>
                                                    <span class="context-item-label" title="${t.description}">${t.name}</span>
                                                    <button class="remove-context-btn" data-type="tool" data-value="${t.name}" title="Unequip Tool">
                                                        <span class="codicon codicon-close"></span>
                                                    </button>
                                                </div>
                                            `).join('')}
                                           </div>`
                                        : '<div class="empty-context-msg">No specialized tools equipped. Using defaults only.</div>'
                                    }
                                </div>
                            </div>
                        </details>

                        <details class="info-collapsible skills-details">
                            <summary>
                                <div style="display: flex; justify-content: space-between; align-items: center; width: calc(100% - 20px);">
                                    <span class="skills-count-label">Active Skills (${skillsHtml.includes('skill-item') ? 'Active' : '0'})</span>
                                    <div style="display: flex; gap: 8px; align-items: center;">
                                        <button id="add-skill-context-btn" class="icon-btn" title="Import Skill"><i class="codicon codicon-add"></i></button>
                                        ${skillsHtml.includes('skill-item') ? `<button id="bulk-delete-skills-btn" class="section-bulk-btn delete" style="margin-right: 5px;"><span class="codicon codicon-trash"></span> Bulk Remove</button>` : ''}
                                    </div>
                                </div>
                            </summary>
                            <div class="collapsible-content collapsible-content-inner-skills" style="padding-top: 8px;">
                                <div class="hud-skills-list">
                                    ${skillsHtml}
                                </div>
                            </div>
                        </details>
                    </div>
                </div>
            </details>
        </div>`;
    }
}

// --- presenters/ContextBinder.ts ---
// Dedicated DOM binding system decoupled from HTML templates.
export class ContextBinder {
    public static bindModelMenu(wrapper: HTMLElement, models: any[], currentModel: string) {
        const badge = wrapper.querySelector('#hud-model-badge') as HTMLElement;
        const menu = wrapper.querySelector('#hud-model-menu') as HTMLElement;
        if (!badge || !menu) return;

        let menuHtml = `
            <div class="custom-menu-item manual-model-item" style="border-bottom: 1px solid var(--vscode-menu-separatorBackground); padding-bottom: 8px; margin-bottom: 4px;">
                <span class="codicon codicon-edit"></span> Enter model name manually...
            </div>`;

        menuHtml += models.map(m => {
            const isSel = m.id === currentModel;
            const icon = isSel ? 'codicon-check' : 'codicon-circle-outline';
            const extraStyle = isSel ? 'style="font-weight: bold; color: var(--vscode-textLink-foreground);"' : '';
            return `<div class="custom-menu-item model-opt-item" data-id="${m.id}" ${extraStyle}><span class="codicon ${icon}"></span> ${m.id}</div>`;
        }).join('');

        menu.innerHTML = menuHtml;

        const manual = menu.querySelector('.manual-model-item') as HTMLElement;
        if (manual) {
            manual.onclick = (e) => {
                e.stopPropagation();
                const name = prompt("Enter model name/id (e.g. ollama/mistral):");
                if (name) {
                    vscode.postMessage({ command: 'updateDiscussionModel', model: name.trim() });
                    vscode.postMessage({ command: 'calculateTokens' });
                }
                menu.classList.remove('visible');
            };
        }

        menu.querySelectorAll('.model-opt-item').forEach((item: any) => {
            item.onclick = (e: MouseEvent) => {
                e.preventDefault();
                e.stopPropagation();
                vscode.postMessage({ command: 'updateDiscussionModel', model: item.dataset.id });
                menu.classList.remove('visible');
            };
        });

        badge.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            const isOpening = !menu.classList.contains('visible');
            document.querySelectorAll('.custom-menu').forEach(m => m.classList.remove('visible'));
            if (isOpening) {
                const adjustFn = (window as any).adjustMenuPosition || ((trig: HTMLElement, mn: HTMLElement) => {
                    mn.style.top = '100%';
                    mn.style.bottom = 'auto';
                });
                adjustFn(badge, menu);
                menu.classList.add('visible');
            }
        };
    }

    public static bindGestures(dashboard: HTMLElement, files: string[], skills: any[]) {
        // Prevent collapse when clicking details elements inside HUD header panels
        const hudSummary = dashboard.querySelector('.fused-context-details summary');
        if (hudSummary) {
            hudSummary.addEventListener('click', (e) => {
                const target = e.target as HTMLElement;
                if (
                    target.closest('button') || 
                    target.closest('select') || 
                    target.closest('input') || 
                    target.closest('.active-badges') || 
                    target.closest('.token-progress-container') ||
                    target.closest('.token-legend')
                ) {
                    e.preventDefault();
                    e.stopPropagation();
                }
            });
        }

        // Dedicated HUD Quick Refresh Binding
        const quickRefresh = dashboard.querySelector('#hud-quick-refresh-btn');
        if (quickRefresh) {
            (quickRefresh as HTMLElement).onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                const icon = quickRefresh.querySelector('.codicon');
                if (icon) icon.classList.add('spin');
                const label = document.getElementById('token-count-label');
                if (label) label.textContent = 'Counting tokens...';
                vscode.postMessage({ command: 'calculateTokens' });
                setTimeout(() => { if (icon) icon.classList.remove('spin'); }, 1200);
            };
        }

        // Bind accordion toggles dynamically
        dashboard.querySelectorAll('.lazy-file-accordion').forEach(accordion => {
            accordion.addEventListener('toggle', () => {
                const details = accordion as HTMLDetailsElement;
                const filePath = details.dataset.path;
                const registry = (window as any).lazyFilesRegistry;

                if (details.open && filePath && registry) {
                    const cachedFile = registry.get(filePath);
                    if (cachedFile && !cachedFile.hasContent) {
                        vscode.postMessage({
                            command: 'requestLazyFileContent',
                            filePath: filePath
                        });
                    }
                }
            });
        });

        // Bind deletion / removal buttons natively
        dashboard.querySelectorAll('.remove-context-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
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
                        partial: { removeDiagram: value } 
                    });
                } else if (type === 'tool') {
                    vscode.postMessage({ command: 'removeToolFromContext', toolName: value });
                }
            });
        });

        // Open Files natively
        dashboard.querySelectorAll('.open-context-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const target = e.currentTarget as HTMLElement;
                const value = target.dataset.value;
                if (value) {
                    vscode.postMessage({ command: 'openFile', path: value });
                }
            });
        });

        // Bind Summarizers natively
        dashboard.querySelectorAll('.summarize-context-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const target = e.currentTarget as HTMLElement;
                const value = target.dataset.value;
                if (value) {
                    vscode.postMessage({ command: 'summarizeContextFile', path: value });
                }
            });
        });

        // Bind Sort button
        const sortBtn = dashboard.querySelector('#sort-files-btn') as HTMLElement;
        if (sortBtn) {
            sortBtn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (state.fileSortOrder === 'heavy-to-light') {
                    state.fileSortOrder = 'light-to-heavy';
                } else if (state.fileSortOrder === 'light-to-heavy') {
                    state.fileSortOrder = 'name';
                } else {
                    state.fileSortOrder = 'heavy-to-light';
                }
                updateContext();
            };
        }

        // Helper to extract file path string
        const getFilePath = (item: any) => typeof item === 'string' ? item : (item?.path || '');

        // Bind Project Files Bulk Remove button
        const bulkRemoveProjectBtn = dashboard.querySelector('#bulk-remove-project-btn') as HTMLElement;
        if (bulkRemoveProjectBtn) {
            bulkRemoveProjectBtn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                const projectFiles = files.filter(f => {
                    const p = getFilePath(f);
                    return !p.includes('.lollms/') && !p.startsWith('http') && !p.startsWith('external/');
                });
                showBulkDeleteModal(projectFiles);
            };
        }

        // Bind External Files Bulk Process button
        const bulkProcessExternalBtn = dashboard.querySelector('#bulk-process-external-btn') as HTMLElement;
        if (bulkProcessExternalBtn) {
            bulkProcessExternalBtn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                const externalFiles = files.filter(f => {
                    const p = getFilePath(f);
                    return p.includes('.lollms/') || p.startsWith('http') || p.startsWith('external/');
                }).map(getFilePath);
                showBulkProcessModal(externalFiles);
            };
        }

        // Bind External Files Bulk Remove/Delete button
        const bulkDeleteExternalBtn = dashboard.querySelector('#bulk-delete-external-btn') as HTMLElement;
        if (bulkDeleteExternalBtn) {
            bulkDeleteExternalBtn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                const externalFiles = files.filter(f => {
                    const p = getFilePath(f);
                    return p.includes('.lollms/') || p.startsWith('http') || p.startsWith('external/');
                });
                showBulkDeleteModal(externalFiles);
            };
        }

        // Bind Skills Bulk Remove button
        const bulkDeleteSkillsBtn = dashboard.querySelector('#bulk-delete-skills-btn') as HTMLElement;
        if (bulkDeleteSkillsBtn) {
            bulkDeleteSkillsBtn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                showBulkDeleteSkillsModal(skills);
            };
        }

        // Bind Tools Bulk Clear button
        const bulkRemoveToolsBtn = dashboard.querySelector('#bulk-remove-tools-btn') as HTMLElement;
        if (bulkRemoveToolsBtn) {
            bulkRemoveToolsBtn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                vscode.postMessage({
                    command: 'updateDiscussionCapabilitiesPartial',
                    partial: { importedTools: [], projectTools: [] }
                });
            };
        }

        // Bind Toolbar buttons
        const bindClick = (id: string, action: () => void) => {
            const el = document.getElementById(id);
            if (el) el.onclick = (e) => { e.stopPropagation(); action(); };
        };

        bindClick('refresh-context-btn', () => vscode.postMessage({ command: 'calculateTokens' }));
        bindClick('save-context-btn', () => vscode.postMessage({ command: 'executeLollmsCommand', details: { command: 'saveContext', params: {} } }));
        bindClick('load-context-btn', () => vscode.postMessage({ command: 'executeLollmsCommand', details: { command: 'loadContext', params: {} } }));
        bindClick('add-context-btn', () => vscode.postMessage({ command: 'executeLollmsCommand', details: { command: 'addContext', params: {} } }));
        bindClick('reset-context-bubble-btn', () => vscode.postMessage({ command: 'executeLollmsCommand', details: { command: 'resetContext', params: {} } }));
        bindClick('add-file-context-btn', () => vscode.postMessage({ command: 'requestAddFileToContext' }));
        bindClick('add-skill-context-btn', () => vscode.postMessage({ command: 'importSkills' }));
        bindClick('add-tool-context-btn', () => vscode.postMessage({ command: 'requestToolPicker' }));
        bindClick('edit-briefing-btn', () => vscode.postMessage({ command: 'requestMissionBriefingUI' }));

        bindClick('view-usage-context-btn', () => {
            dom.usageModal.classList.add('visible');
            dom.usageListContainer.innerHTML = '<div style="text-align:center; padding: 20px;"><div class="spinner"></div> Calculating individual file tokens...</div>';
            vscode.postMessage({ command: 'requestContextUsage' });
        });

        const selectionsDropdown = document.getElementById('hud-selections-dropdown') as HTMLSelectElement;
        if (selectionsDropdown) {
            selectionsDropdown.onchange = () => {
                const selectedVal = selectionsDropdown.value;
                if (selectedVal) {
                    vscode.postMessage({
                        command: 'executeLollmsCommand',
                        details: {
                            command: 'lollms-vs-coder.loadContextSelectionDirect',
                            params: [selectedVal]
                        }
                    });
                }
            };
        }

        // Bind matrix details
        const matrixBtn = dashboard.querySelector('#hud-matrix-btn');
        if (matrixBtn) {
            matrixBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                import('./ui.js').then(ui => {
                    ui.renderWorkspaceMatrix();
                    const modal = document.getElementById('workspace-matrix-modal');
                    if (modal) {
                        modal.style.display = 'flex';
                        modal.classList.add('visible');
                    }
                });
            });
        }
    }
}

export function updateContext(contextText?: string, files?: string[], skills?: any[], tools?: any[], diagrams?: any[], briefing?: string, selections?: string[]) {
    if(!dom.contextContainer) return;

    // 0. CAPTURE CURRENT EXPANSION STATE
    const openStates: Record<string, boolean> = {};
    dom.contextContainer.querySelectorAll('details').forEach((d, i) => {
        const summary = d.querySelector('summary')?.innerText || i.toString();
        openStates[summary] = d.open;
    });

    // 1. MERGE WITH EXISTING STATE (Partial updates)
    const prev = state.lastContextData || { context: "", files: [], skills: [], tools: [], diagrams: [], briefing: "", selections: [] };

    if (files && Array.isArray(files)) {
        if (!state.fileTokensMap) state.fileTokensMap = {};
        files.forEach((f: any) => {
            if (f && typeof f === 'object' && f.path) {
                if (f.tokens) state.fileTokensMap[f.path] = f.tokens;
                else if (f.bytes) state.fileTokensMap[f.path] = Math.ceil(f.bytes / 3.5);
            }
        });
    }

    state.lastContextData = {
        context: contextText !== undefined ? contextText : (prev.context || ""),
        files: files !== undefined ? files : (prev.files || []),
        skills: skills !== undefined ? skills : (prev.skills || []),
        tools: tools !== undefined ? tools : (prev.tools || []),
        diagrams: diagrams !== undefined ? diagrams : (prev.diagrams || []),
        briefing: briefing !== undefined ? briefing : (prev.briefing || ""),
        selections: selections !== undefined ? selections : ((prev as any).selections || [])
    };

    const finalFiles = state.lastContextData.files || [];
    const finalTools = state.lastContextData.tools || [];
    const finalSkills = state.lastContextData.skills || [];
    const finalSelections = (state.lastContextData as any).selections || [];
    const finalDiagrams = state.lastContextData.diagrams || [];
    const finalBriefing = state.lastContextData.briefing || "";

    // Detection for Welcome Message integration
    const isNewDiscussion = !document.querySelector('.message-wrapper:not(.context-message)');

    const getFilePath = (item: any) => typeof item === 'string' ? item : item.path;

    const isProjectFile = (item: any) => {
        const f = getFilePath(item);
        const isInternal = f.includes('.lollms/') || f.startsWith('http') || f.startsWith('external/');
        return !isInternal;
    };

    const projectFiles = finalFiles.filter(isProjectFile);
    const externalFiles = finalFiles.filter(f => !isProjectFile(f));

    try {
        // Decoupled templates generated via ContextPresenter with token weights
        const safeProjectFiles = Array.isArray(projectFiles) ? projectFiles : [];
        const safeExternalFiles = Array.isArray(externalFiles) ? externalFiles : [];
        const safeFinalSkills = Array.isArray(finalSkills) ? finalSkills : [];
        const safeFinalDiagrams = Array.isArray(finalDiagrams) ? finalDiagrams : [];
        const safeFinalTools = Array.isArray(finalTools) ? finalTools : [];
        const safeFinalSelections = Array.isArray(finalSelections) ? finalSelections : [];

        const tokenMap = state.fileTokensMap || {};
        const sortOrder = state.fileSortOrder || 'heavy-to-light';

        const projectFilesHtml = ContextPresenter.renderFileList(safeProjectFiles, "No project files selected.", false, tokenMap, sortOrder);
        const externalFilesHtml = ContextPresenter.renderFileList(safeExternalFiles, "No search results in context.", true, tokenMap, sortOrder);
        const skillsHtml = ContextPresenter.renderSkills(safeFinalSkills);
        const briefingHtml = finalBriefing ? renderDataBriefing(finalBriefing) : '<div style="font-style:italic; opacity:0.5;">No specific task constraints defined. Click the shield to add instructions.</div>';

        const isAgentActive = state.capabilities?.agentMode === true;
        const themeClass = isAgentActive ? 'agent-mode-bubble' : 'standard-mode-bubble';

        // Update outer HUD presentation content decoupled from binds
        dom.contextContainer.innerHTML = ContextPresenter.getDashboardHtml(
            themeClass,
            isAgentActive,
            isNewDiscussion,
            safeFinalSelections,
            safeProjectFiles.length + safeExternalFiles.length,
            projectFilesHtml,
            externalFilesHtml,
            safeFinalDiagrams,
            safeFinalTools,
            finalBriefing,
            skillsHtml,
            briefingHtml
        );

        const dashboard = document.getElementById('fused-context-dashboard');
        if (dashboard) {
            // Run dedicated DOM binding system (Layer 2)
            ContextBinder.bindGestures(dashboard, finalFiles, finalSkills);

            // Re-hydrate token metrics immediately to prevent "Calculating..." flicker
            if (state.lastTokenMetrics) {
                const { totalTokens, contextSize, isApproximate, segments } = state.lastTokenMetrics;
                const normalizedTotal = (typeof totalTokens === 'number' && !isNaN(totalTokens)) ? totalTokens : 0;
                const size = (contextSize > 0) ? contextSize : 128000;
                const finalLabel = `${isApproximate ? 'Est. ' : ''}Tokens: ${normalizedTotal.toLocaleString()} / ${size.toLocaleString()}`;
                const labelEl = document.getElementById('token-count-label');
                if (labelEl) labelEl.textContent = finalLabel;
                const barContainer = document.getElementById('token-progress-container');
                updateProgressBar(barContainer, normalizedTotal, size, segments);
            }
        }
    } catch (renderError: any) {
        console.error("❌ FAILED HUD PRESENTATION RENDERING:", renderError);

        // Output a highly visible error diagnostic report directly inside the visual container so it never hangs silently!
        dom.contextContainer.innerHTML = `
            <div style="padding: 15px; background: var(--vscode-inputValidation-errorBackground); border: 2px solid var(--vscode-charts-red); border-radius: 8px; color: var(--vscode-errorForeground); font-family: var(--vscode-editor-font-family); font-size: 11px; margin: 10px;">
                <h3 style="margin: 0 0 8px 0; font-size: 13px; font-weight: bold; display: flex; align-items: center; gap: 8px;">
                    <i class="codicon codicon-warning" style="color: var(--vscode-charts-red);"></i> Sovereign HUD Rendering Exception
                </h3>
                <p style="margin: 0 0 10px 0; opacity: 0.9;">The presentation layer failed to construct the intelligence dashboard dynamically.</p>
                <div style="background: rgba(0,0,0,0.3); padding: 8px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.05); font-family: monospace; white-space: pre-wrap; overflow-x: auto;">${renderError.stack || renderError.message || renderError}</div>
                <button onclick="vscode.postMessage({ command: 'calculateTokens' })" style="margin-top: 10px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 10px; border-radius: 4px; cursor: pointer;">
                    <i class="codicon codicon-sync"></i> Re-Calculate State
                </button>
            </div>
        `;
    }

    // 2. RESTORE EXPANSION STATE
    dom.contextContainer.querySelectorAll('details').forEach((d, i) => {
        const summary = d.querySelector('summary')?.innerText || i.toString();
        if (openStates[summary] !== undefined) {
            d.open = openStates[summary];
        }
    });

    // Run badge layout UI updates
    import('./ui.js').then(ui => ui.updateBadges());
}


/**
 * Opens a modal to select multiple files for removal from context.
 * Supports sorting by Alphabetical (A-Z / Z-A) and File Size / Tokens (Largest / Smallest).
 */
export function showBulkDeleteModal(files: any[]) {
    const modal = document.getElementById('bulk-delete-modal');
    const list = document.getElementById('bulk-delete-files-list');
    const master = document.getElementById('bulk-delete-select-all') as HTMLInputElement;
    const closeBtn = document.getElementById('bulk-delete-close-btn');
    const runBtn = document.getElementById('bulk-delete-run-btn') as HTMLButtonElement;
    const summaryLabel = document.getElementById('bulk-delete-summary');
    const sortNameBtn = document.getElementById('bulk-sort-name-btn');
    const sortSizeBtn = document.getElementById('bulk-sort-size-btn');
    const sortDirBtn = document.getElementById('bulk-sort-dir-btn');
    const sortDirIcon = document.getElementById('bulk-sort-dir-icon');

    if (!modal || !list) return;

    const getFilePath = (item: any) => typeof item === 'string' ? item : (item?.path || '');
    const registry = (window as any).lazyFilesRegistry;

    // Normalize raw file entries to objects with accurate byte count and token estimations
    const normalizedFiles = files.map(item => {
        const rawPath = getFilePath(item);
        const regItem = registry?.get(rawPath);

        let bytes = 0;
        let tokens = 0;

        if (typeof item === 'object' && item !== null) {
            if (typeof item.bytes === 'number' && item.bytes > 0) bytes = item.bytes;
            if (typeof item.tokens === 'number' && item.tokens > 0) tokens = item.tokens;
        }

        if (regItem && typeof regItem === 'object') {
            if (bytes === 0 && typeof regItem.bytes === 'number' && regItem.bytes > 0) bytes = regItem.bytes;
            if (tokens === 0 && typeof regItem.tokens === 'number' && regItem.tokens > 0) tokens = regItem.tokens;
        }

        if (tokens === 0 && state.fileTokensMap?.[rawPath]) {
            tokens = state.fileTokensMap[rawPath];
        }

        if (bytes === 0 && tokens > 0) {
            bytes = Math.round(tokens * 3.5);
        } else if (tokens === 0 && bytes > 0) {
            tokens = Math.max(1, Math.ceil(bytes / 3.5));
        }

        const fileName = rawPath.split('/').pop() || rawPath;
        const dirName = rawPath.includes('/') ? rawPath.substring(0, rawPath.lastIndexOf('/')) : '';

        return {
            path: rawPath,
            fileName,
            dirName,
            bytes,
            tokens
        };
    });

    // Tracking set of selected file paths (initially all selected)
    const selectedPaths = new Set<string>(normalizedFiles.map(f => f.path));

    let currentSortCol: 'name' | 'size' = 'size';
    let currentSortDir: 'asc' | 'desc' = 'desc'; // Default: Largest first

    const updateFooterSummary = () => {
        const checkedCount = selectedPaths.size;
        let totalFreedTokens = 0;
        let totalFreedBytes = 0;

        normalizedFiles.forEach(f => {
            if (selectedPaths.has(f.path)) {
                totalFreedTokens += f.tokens;
                totalFreedBytes += f.bytes;
            }
        });

        if (summaryLabel) {
            let sizeFormatted = `${totalFreedBytes} B`;
            if (totalFreedBytes >= 1024 * 1024) sizeFormatted = `${(totalFreedBytes / (1024 * 1024)).toFixed(1)} MB`;
            else if (totalFreedBytes >= 1024) sizeFormatted = `${(totalFreedBytes / 1024).toFixed(1)} KB`;

            const tokDisplay = totalFreedTokens >= 1000 ? `${(totalFreedTokens / 1000).toFixed(1)}k` : `${totalFreedTokens}`;
            summaryLabel.textContent = checkedCount > 0 
                ? `${checkedCount} of ${normalizedFiles.length} selected (${sizeFormatted} / ~${tokDisplay} tok)`
                : `0 of ${normalizedFiles.length} selected`;
        }

        if (runBtn) {
            runBtn.disabled = checkedCount === 0;
            runBtn.innerHTML = checkedCount > 0 
                ? `<span class="codicon codicon-trash"></span> Remove ${checkedCount} File${checkedCount > 1 ? 's' : ''}`
                : `<span class="codicon codicon-trash"></span> Remove Selected`;
        }

        if (master) {
            master.checked = checkedCount === normalizedFiles.length && normalizedFiles.length > 0;
            master.indeterminate = checkedCount > 0 && checkedCount < normalizedFiles.length;
        }
    };

    const renderList = () => {
        if (normalizedFiles.length === 0) {
            list.innerHTML = '<div style="padding: 20px; opacity: 0.6; text-align: center; font-size: 11px;">No files to remove.</div>';
            updateFooterSummary();
            return;
        }

        // Sort items
        const sorted = [...normalizedFiles].sort((a, b) => {
            const dir = currentSortDir === 'asc' ? 1 : -1;
            if (currentSortCol === 'name') {
                return dir * a.fileName.localeCompare(b.fileName, undefined, { sensitivity: 'base' }) || dir * a.path.localeCompare(b.path);
            } else {
                return dir * (a.bytes - b.bytes) || dir * (a.tokens - b.tokens) || a.fileName.localeCompare(b.fileName);
            }
        });

        list.innerHTML = sorted.map(item => {
            const f = item.path;
            const isChecked = selectedPaths.has(f);
            const bytes = item.bytes;
            const tokens = item.tokens;

            let formattedBytes = `${bytes} B`;
            if (bytes >= 1024 * 1024) formattedBytes = `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
            else if (bytes >= 1024) formattedBytes = `${(bytes / 1024).toFixed(1)} KB`;

            const displayTok = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : `${tokens}`;
            const weightClass = bytes >= 35000 ? 'weight-heavy' : (bytes >= 10000 ? 'weight-medium' : 'weight-light');
            const tokenBadge = `<span class="file-token-badge ${weightClass}" title="${bytes.toLocaleString()} bytes (~${tokens.toLocaleString()} tokens)">${formattedBytes} (~${displayTok} tok)</span>`;

            return `
            <div class="checkbox-container bulk-delete-item-row ${isChecked ? 'selected' : ''}" style="margin-bottom: 4px; padding: 6px 10px; border-radius: 4px; background: rgba(0,0,0,0.15); display: flex; align-items: center; border: 1px solid var(--vscode-widget-border); transition: background 0.1s, border-color 0.1s;">
                <input type="checkbox" class="bulk-delete-file-check" value="${f}" id="bulk-del-check-${item.path.replace(/[^a-zA-Z0-9]/g, '_')}" ${isChecked ? 'checked' : ''} style="margin: 0 10px 0 0; cursor: pointer;">
                <label for="bulk-del-check-${item.path.replace(/[^a-zA-Z0-9]/g, '_')}" style="font-size: 11px; cursor: pointer; flex: 1; min-width: 0; display: flex; align-items: center; justify-content: space-between; user-select: none;">
                    <div style="min-width: 0; overflow: hidden; padding-right: 8px;">
                        <div style="font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${f}">
                            <i class="codicon codicon-file" style="margin-right: 4px; opacity: 0.7;"></i>${item.fileName}
                        </div>
                        ${item.dirName ? `<div style="font-size: 9px; opacity: 0.5; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${item.dirName}</div>` : ''}
                    </div>
                    ${tokenBadge}
                </label>
            </div>`;
        }).join('');

        // Delegate checkbox listeners
        list.querySelectorAll('.bulk-delete-file-check').forEach((cb: any) => {
            cb.onchange = () => {
                if (cb.checked) {
                    selectedPaths.add(cb.value);
                } else {
                    selectedPaths.delete(cb.value);
                }
                const row = cb.closest('.bulk-delete-item-row');
                if (row) row.classList.toggle('selected', cb.checked);
                updateFooterSummary();
            };
        });

        // Delegate row clicks
        list.querySelectorAll('.bulk-delete-item-row').forEach((row: any) => {
            row.onclick = (e: MouseEvent) => {
                const target = e.target as HTMLElement;
                if (target.tagName === 'INPUT' || target.tagName === 'LABEL') return;
                const cb = row.querySelector('.bulk-delete-file-check') as HTMLInputElement;
                if (cb) {
                    cb.checked = !cb.checked;
                    cb.dispatchEvent(new Event('change'));
                }
            };
        });

        // Update sort button styling
        if (sortNameBtn) sortNameBtn.classList.toggle('active', currentSortCol === 'name');
        if (sortSizeBtn) sortSizeBtn.classList.toggle('active', currentSortCol === 'size');
        if (sortDirIcon) {
            sortDirIcon.className = `codicon ${currentSortDir === 'asc' ? 'codicon-arrow-up' : 'codicon-arrow-down'}`;
        }
        if (sortDirBtn) {
            sortDirBtn.title = currentSortCol === 'name' 
                ? (currentSortDir === 'asc' ? 'Direction: A to Z (Click to switch to Z to A)' : 'Direction: Z to A (Click to switch to A to Z)')
                : (currentSortDir === 'asc' ? 'Direction: Smallest First (Click for Largest First)' : 'Direction: Largest First (Click for Smallest First)');
        }

        updateFooterSummary();
    };

    // Sort button click handlers
    if (sortNameBtn) {
        sortNameBtn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (currentSortCol === 'name') {
                currentSortDir = currentSortDir === 'asc' ? 'desc' : 'asc';
            } else {
                currentSortCol = 'name';
                currentSortDir = 'asc'; // A-Z default
            }
            renderList();
        };
    }

    if (sortSizeBtn) {
        sortSizeBtn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (currentSortCol === 'size') {
                currentSortDir = currentSortDir === 'desc' ? 'asc' : 'desc';
            } else {
                currentSortCol = 'size';
                currentSortDir = 'desc'; // Largest first default
            }
            renderList();
        };
    }

    if (sortDirBtn) {
        sortDirBtn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            currentSortDir = currentSortDir === 'asc' ? 'desc' : 'asc';
            renderList();
        };
    }

    // Master Select / Deselect All
    if (master) {
        master.onchange = () => {
            if (master.checked) {
                normalizedFiles.forEach(f => selectedPaths.add(f.path));
            } else {
                selectedPaths.clear();
            }
            list.querySelectorAll('.bulk-delete-file-check').forEach((cb: any) => {
                cb.checked = master.checked;
            });
            list.querySelectorAll('.bulk-delete-item-row').forEach((row: any) => {
                row.classList.toggle('selected', master.checked);
            });
            updateFooterSummary();
        };
    }

    // Initial render
    renderList();

    modal.classList.add('visible');

    const close = () => modal.classList.remove('visible');
    if (closeBtn) closeBtn.onclick = close;

    if (runBtn) {
        runBtn.onclick = () => {
            const selected = Array.from(selectedPaths);
            if (selected.length > 0) {
                vscode.postMessage({ command: 'bulkRemoveFiles', paths: selected });
                modal.classList.remove('visible');
            }
        };
    }
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
    if (!dom.agentPlanZone) return;

    if (!plan) {
        dom.agentPlanZone.innerHTML = '';
        return;
    }

    const oldScroll = dom.agentPlanZone.scrollTop;
    (window as any).lastPlan = plan;

    let displayThought = plan.scratchpad || "Standing by...";
    try {
        const jsonMatch = displayThought.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            displayThought = parsed.new_remark || parsed.thought || parsed.reasoning || "Planning next steps...";
        }
    } catch (e) {}

    let brainBarHtml = '';
    if (plan.metrics) {
        const m = plan.metrics;
        const total = Math.max(m.total, 1);
        const pScratch = (m.scratchpad / total) * 100;
        const pMem = (m.memory / total) * 100;
        const pHist = (m.history / total) * 100;

        brainBarHtml = `
            <div class="brain-bar-container">
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
            </div>
        `;
    }

    let milestonesHtml = '';
    if (plan.milestones && plan.milestones.length > 0) {
        milestonesHtml = `
            <div class="agent-progress-tracker">
                ${plan.milestones.map((m: any) => {
                    const icon = m.status === 'completed' ? 'pass-filled' : (m.status === 'active' ? 'play' : 'circle-outline');
                    return `
                        <div class="milestone-item ${m.status}">
                            <span class="milestone-icon"><i class="codicon codicon-${icon}"></i></span>
                            <span class="milestone-label">${m.label}</span>
                        </div>
                    `;
                }).join('')}
            </div>
        `;
    }

    let globalActionsHtml = `
        <div class="plan-global-actions" style="gap: 8px;">
            <button class="code-action-btn copy-log-btn" id="copy-log-btn-panel" style="flex: 1;">
                <span class="codicon codicon-copy"></span> <span class="btn-text">Copy Experience Log</span>
            </button>
        </div>
    `;

    // Construct the overall sidebar inner content
    let sidebarHtml = `
        <div class="plan-block active">
            <div class="plan-header" style="background: var(--vscode-sideBarSectionHeader-background); padding: 12px; font-weight: bold; font-size: 13px;">
                <span class="codicon codicon-target" style="margin-right: 8px; color: var(--vscode-charts-orange);"></span>
                <span>MISSION: ${sanitizer.sanitize(plan.objective)}</span>
            </div>
            <div class="plan-content" style="padding: 12px;">
                <div class="live-thought-box" style="margin-bottom: 15px; font-style: italic; color: var(--vscode-descriptionForeground); line-height: 1.5;">
                    ${sanitizer.sanitize(displayThought)}
                </div>
            </div>
        </div>
        ${brainBarHtml}
        ${milestonesHtml}
        ${globalActionsHtml}
        <div class="plan-wrapper">
    `;

    if (plan.attempts && plan.attempts.length > 0) {
        plan.attempts.forEach((oldPlan: any) => {
            sidebarHtml += renderPlanAttempt(oldPlan, true).outerHTML;
        });
    }

    const tempDiv = renderPlanAttempt(plan, false);
    sidebarHtml += tempDiv.outerHTML;
    sidebarHtml += `</div>`;

    dom.agentPlanZone.innerHTML = sidebarHtml;

    // Attach Log Copy listener dynamically inside the panel
    const copyBtn = document.getElementById('copy-log-btn-panel');
    if (copyBtn) {
        copyBtn.onclick = () => {
            const text = formatPlanForCopy(plan);
            vscode.postMessage({ command: 'copyToClipboard', text: text });
            copyBtn.innerHTML = '<span class="codicon codicon-check"></span> <span class="btn-text">Copied!</span>';
            setTimeout(() => {
                copyBtn.innerHTML = '<span class="codicon codicon-copy"></span> <span class="btn-text">Copy Experience Log</span>';
            }, 2000);
        };
    }

    // Restore scroll position safely
    requestAnimationFrame(() => {
        if (dom.agentPlanZone) dom.agentPlanZone.scrollTop = oldScroll;
    });
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

export function syncResultsListRows(messageId: string) {
    if (!messageId) return;
    const wrapper = document.querySelector(`.message-wrapper[data-message-id='${messageId}']`);
    if (!wrapper) return;

    const resList = wrapper.querySelector('.apply-results-list') || document.getElementById(`results-${messageId}`);
    if (!resList) return;

    const patches = getPatchesForMessage(messageId);
    if (patches.length === 0) return;

    resList.style.display = 'flex';
    resList.style.flexDirection = 'column';
    resList.style.gap = '4px';

    const existingRows = Array.from(resList.querySelectorAll('.apply-row'));
    if (existingRows.length !== patches.length) {
        resList.innerHTML = patches.map(p => {
            const isDone = p.isApplied;
            const iconHtml = isDone 
                ? '<span class="status-icon"><i class="codicon codicon-check" style="color:var(--vscode-charts-green)"></i></span>'
                : '<span class="status-icon"><i class="codicon codicon-circle-large-outline" style="opacity:0.4"></i></span>';
            const badgeHtml = isDone 
                ? '<span class="validated-badge" style="margin-left:auto; font-size:10px; color:var(--vscode-charts-green); font-weight:bold; display:flex; align-items:center; gap:4px;"><i class="codicon codicon-pass-filled"></i> Validated</span>'
                : '<span class="pending-badge" style="margin-left:auto; font-size:10px; opacity:0.6;">Pending</span>';

            return `
                <div class="apply-row ${isDone ? 'status-success' : 'status-pending'}" 
                     data-block-index="${p.blockIndex}" 
                     ${p.hunkIndex !== undefined ? `data-hunk-index="${p.hunkIndex}"` : ''}
                     style="display:flex; align-items:center; gap:8px; padding:6px 10px; border-radius:4px; border:1px solid var(--vscode-widget-border);">
                    ${iconHtml}
                    <span class="row-path clickable" title="Click to open file in editor" onclick="vscode.postMessage({command:'openFile', path:'${p.path}'})">${p.label}</span>
                    ${badgeHtml}
                    <div class="row-actions" style="display:none"></div>
                </div>`;
        }).join('');
    } else {
        patches.forEach(p => {
            const hunkAttr = p.hunkIndex !== undefined ? `[data-hunk-index='${p.hunkIndex}']` : ':not([data-hunk-index])';
            const row = resList.querySelector(`.apply-row[data-block-index='${p.blockIndex}']${hunkAttr}`) as HTMLElement;
            if (!row) return;

            const iconEl = row.querySelector('.status-icon');
            if (p.isApplied) {
                row.classList.remove('status-failed', 'status-pending', 'status-applying');
                row.classList.add('status-success');
                if (iconEl) {
                    iconEl.innerHTML = '<i class="codicon codicon-check" style="color:var(--vscode-charts-green)"></i>';
                }
                row.style.background = '';
                row.style.opacity = '1';

                row.querySelector('.row-actions')?.remove();
                row.querySelector('.status-label-inline')?.remove();

                let badge = row.querySelector('.validated-badge');
                if (!badge) {
                    row.querySelector('.pending-badge')?.remove();
                    badge = document.createElement('span');
                    badge.className = 'validated-badge';
                    badge.style.cssText = 'margin-left:auto; font-size:10px; color:var(--vscode-charts-green); font-weight:bold; display:flex; align-items:center; gap:4px;';
                    badge.innerHTML = '<i class="codicon codicon-pass-filled"></i> Validated';
                    row.appendChild(badge);
                }
            } else {
                if (!row.classList.contains('status-failed')) {
                    row.classList.remove('status-success', 'status-applying');
                    row.classList.add('status-pending');
                    if (iconEl) {
                        iconEl.innerHTML = '<i class="codicon codicon-circle-large-outline" style="opacity:0.4"></i>';
                    }
                    row.querySelector('.validated-badge')?.remove();
                    if (!row.querySelector('.pending-badge')) {
                        const badge = document.createElement('span');
                        badge.className = 'pending-badge';
                        badge.style.cssText = 'margin-left:auto; font-size:10px; opacity:0.6;';
                        badge.textContent = 'Pending';
                        row.appendChild(badge);
                    }
                }
            }
        });
    }

    const totalPatches = patches.length;
    const validatedPatches = patches.filter(p => p.isApplied).length;
    if (totalPatches > 0) {
        const progressContainer = document.getElementById(`progress-container-${messageId}`) || wrapper.querySelector('.apply-progress-container') as HTMLElement;
        const bar = document.getElementById(`progress-bar-${messageId}`) as HTMLElement;
        if (progressContainer) progressContainer.style.display = 'block';
        if (bar) {
            const pct = Math.round((validatedPatches / totalPatches) * 100);
            bar.style.width = `${pct}%`;
            bar.style.background = pct === 100 ? 'var(--vscode-charts-green)' : 'var(--vscode-charts-blue)';
        }
    }
}

export function checkAndSyncMessageAppliedState(messageId: string) {
    if (!messageId) return;
    const wrapper = document.querySelector(`.message-wrapper[data-message-id='${messageId}']`);
    if (!wrapper) return;

    syncResultsListRows(messageId);

    const applyAllBtn = wrapper.querySelector('.apply-all-btn') as HTMLButtonElement;
    if (!applyAllBtn) return;

    const patches = getPatchesForMessage(messageId);
    const totalCount = patches.length;
    if (totalCount <= 1) return;

    const validatedCount = patches.filter(p => p.isApplied).length;
    const unappliedCount = totalCount - validatedCount;

    if (unappliedCount > 0) {
        applyAllBtn.classList.remove('applied', 'undo-all-btn', 'stop-btn-red', 'sequential-applying');
        applyAllBtn.style.removeProperty('background-color');
        applyAllBtn.style.removeProperty('color');
        applyAllBtn.disabled = false;

        if (validatedCount > 0) {
            applyAllBtn.innerHTML = `<span class="codicon codicon-check-all"></span> Apply Remaining Changes (${unappliedCount} of ${totalCount} files)`;
        } else {
            applyAllBtn.innerHTML = `<span class="codicon codicon-check-all"></span> Apply All Changes (${totalCount} files)`;
        }
    } else {
        applyAllBtn.classList.remove('sequential-applying', 'stop-btn-red');
        applyAllBtn.classList.add('undo-all-btn');
        applyAllBtn.disabled = false;
        applyAllBtn.style.removeProperty('background-color');
        applyAllBtn.style.removeProperty('color');
        applyAllBtn.innerHTML = `<span class="codicon codicon-discard"></span> Undo All Changes (${totalCount} files)`;
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
