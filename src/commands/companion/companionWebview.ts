import { state } from '../chatPanel/webview/dom.js';
import {
    isValidFilePath,
    parseAiderHunks,
    parseFileTagAttributes,
    collapseBlockWithScrollPreservation
} from '../chatPanel/webview/utils.js';
import { registerPlugin, pluginRegistry, PluginContext, TagPlugin } from '../chatPanel/webview/pluginSystem.js';
import {
    extractFileBlocks,
    normalizePseudoFileBlocks,
    fileMutationPlugin,
    fileOpPlugin,
    peekFilesPlugin,
    loadStructurePlugin,
    showSymbolPlugin
} from '../chatPanel/webview/plugins/fileOpPlugin.js';
import { thinkPlugin } from '../chatPanel/webview/plugins/thinkPlugin.js';
import { processingPlugin } from '../chatPanel/webview/plugins/processingPlugin.js';
import { sparqlPlugin } from '../chatPanel/webview/plugins/sparqlPlugin.js';
import { toolPlugin } from '../chatPanel/webview/plugins/toolPlugin.js';

import { marked } from 'marked';
import DOMPurify from 'dompurify';
import Prism from 'prismjs';

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
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-tsx';
import 'prismjs/components/prism-diff';

declare function acquireVsCodeApi(): any;
const vscode = acquireVsCodeApi();
(window as any).vscode = vscode;

const sanitizer = typeof DOMPurify === 'function' ? (DOMPurify as any)(window) : DOMPurify;
(window as any).marked = marked;
(window as any).DOMPurify = sanitizer;
(window as any).Prism = Prism;

try {
    marked.setOptions({ breaks: true, gfm: true });
} catch (err) {
    console.warn('[Companion] marked init warning:', err);
}

const SANITIZE_CONFIG: any = {
    ADD_TAGS: ['button', 'i', 'span', 'details', 'summary', 'b', 'strong', 'code', 'pre', 'ul', 'ol', 'li', 'div', 'input', 'textarea', 'label'],
    ADD_ATTR: [
        'data-value', 'data-type', 'data-message-id', 'data-files', 'data-block-id',
        'data-action', 'data-action-type', 'data-id', 'data-path', 'data-paths',
        'data-payload', 'data-target', 'data-symbol', 'data-symbols', 'data-query',
        'data-tool', 'data-tool-name', 'data-params', 'data-block-index',
        'data-raw-code', 'data-lang', 'data-hunk-index', 'data-idx', 'data-closed',
        'data-code', 'open', 'style', 'type', 'value', 'name', 'checked', 'disabled', 'title'
    ]
};

const langMap: Record<string, string> = {
    js: 'javascript', ts: 'typescript', py: 'python', sh: 'bash', shell: 'bash',
    cs: 'csharp', cpp: 'cpp', 'c++': 'cpp', h: 'c', hpp: 'cpp', txt: 'plaintext',
    md: 'markdown', yml: 'yaml', vue: 'html', svelte: 'html', xml: 'xml',
    htm: 'html', html: 'html', svg: 'markup'
};

function escapeHtml(str: string): string {
    return (str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

const companionFocusPlugin: TagPlugin = {
    id: 'companion_focus',
    tagPattern: /^[ \t]*<(?:focuse|focus)\b[^>]*>([\s\S]*?)<\/(?:focuse|focus)>/gim,
    render: (match) => {
        const snippet = (match[1] || '').replace(/^\r?\n/, '').replace(/\r?\n$/, '');
        if (!snippet.trim()) return null;
        const encoded = encodeURIComponent(snippet);
        const firstLine = snippet.trim().split('\n')[0] || '';
        const preview = firstLine.length > 60 ? firstLine.substring(0, 57) + '...' : firstLine;
        return `
        <div class="apply-row focus-code-row" data-code="${encoded}" style="background: rgba(0, 122, 204, 0.08); border-left: 3px solid var(--vscode-charts-blue); border-radius: 6px; margin: 8px 0; padding: 6px 10px; display: flex; align-items: center; justify-content: space-between; gap: 8px;">
            <div style="display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1;">
                <span class="status-icon"><i class="codicon codicon-target" style="color: var(--vscode-charts-blue);"></i></span>
                <span style="font-size: 11px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">Focus: <code>${escapeHtml(preview)}</code></span>
            </div>
            <button type="button" class="code-action-btn apply-btn companion-focus-btn" data-code="${encoded}" style="height: 22px; font-size: 10px; padding: 0 8px; flex-shrink: 0;">
                <i class="codicon codicon-selection"></i> Focus Code
            </button>
        </div>`;
    },
    initialize: (container) => {
        container.querySelectorAll('.companion-focus-btn').forEach((btn: any) => {
            btn.onclick = (e: MouseEvent) => {
                e.stopPropagation();
                const raw = btn.dataset.code;
                if (raw) {
                    vscode.postMessage({ command: 'focusCode', code: decodeURIComponent(raw) });
                }
            };
        });
    }
};

let pluginsInitialized = false;
function ensurePluginsInitialized() {
    if (pluginsInitialized && pluginRegistry.length > 0) return;
    pluginRegistry.length = 0;
    [
        thinkPlugin,
        processingPlugin,
        companionFocusPlugin,
        fileMutationPlugin,
        fileOpPlugin,
        peekFilesPlugin,
        loadStructurePlugin,
        showSymbolPlugin,
        sparqlPlugin,
        toolPlugin
    ].forEach(p => {
        if (p) registerPlugin(p);
    });
    pluginsInitialized = true;
}

let activeFilePath = '';
let activeContentBuffer = '';
let lastHistorySig = '';
let lastAutoFocusedCode = '';
let streamingBufferPending: string | null = null;
let streamingRaf: number | null = null;
let lastStreamRenderTime = 0;
/*
let pendingImages: { name: string; data: string }[] = [];

function renderPendingImages() {
    const preview = document.getElementById('companion-attachment-preview');
    if (!preview) return;
    preview.innerHTML = '';

    if (pendingImages.length === 0) {
        preview.style.display = 'none';
        return;
    }

    preview.style.display = 'flex';
    pendingImages.forEach((img, idx) => {
        if (!img.data) return;
        const card = document.createElement('div');
        card.className = 'staged-image-card';

        const imageEl = document.createElement('img');
        imageEl.src = img.data;
        imageEl.alt = img.name || 'Attached image';
        card.appendChild(imageEl);

        const remove = document.createElement('div');
        remove.className = 'remove-btn';
        remove.innerHTML = '<span class="codicon codicon-close"></span>';
        remove.title = 'Remove attached image';
        remove.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            pendingImages.splice(idx, 1);
            renderPendingImages();
        };
        card.appendChild(remove);
        preview.appendChild(card);
    });
}

function addImageFiles(files: FileList | File[] | null) {
    if (!files) return;
    Array.from(files).forEach((file) => {
        if (!file) return;
        const isSvg = file.name.toLowerCase().endsWith('.svg') || file.type === 'image/svg+xml';
        if (isSvg) return;
        if (!file.type.startsWith('image/') && !/\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name)) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            const data = ev.target?.result as string;
            if (data) {
                pendingImages.push({ name: file.name || `image_${Date.now()}.png`, data });
                renderPendingImages();
            }
        };
        reader.readAsDataURL(file);
    });
}

function handlePasteImages(e: ClipboardEvent): boolean {
    const clipboardData = e.clipboardData;
    if (!clipboardData) return false;
    const blobs: File[] = [];

    if (clipboardData.items && clipboardData.items.length > 0) {
        for (let i = 0; i < clipboardData.items.length; i++) {
            const item = clipboardData.items[i];
            if (item.type && item.type.startsWith('image/') && !item.type.includes('svg')) {
                const f = item.getAsFile();
                if (f) blobs.push(f);
            } else if (item.kind === 'file') {
                const f = item.getAsFile();
                if (f && (f.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(f.name)) && !f.name.toLowerCase().endsWith('.svg')) {
                    blobs.push(f);
                }
            }
        }
    }

    if (blobs.length === 0 && clipboardData.files && clipboardData.files.length > 0) {
        for (let i = 0; i < clipboardData.files.length; i++) {
            const f = clipboardData.files[i];
            if (f && (f.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(f.name)) && !f.name.toLowerCase().endsWith('.svg')) {
                blobs.push(f);
            }
        }
    }

    if (blobs.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        addImageFiles(blobs);
        return true;
    }
    return false;
}
*/
let pendingImages: { name: string; data: string }[] = [];

function openCompanionImageZoom(src: string) {
    if (!src) return;
    const overlay = document.getElementById('image-zoom-overlay');
    const display = document.getElementById('zoomed-image-display') as HTMLImageElement | null;
    if (!overlay || !display) return;

    display.src = src;
    overlay.classList.add('active');

    const close = (e?: Event) => {
        if (e) e.stopPropagation();
        overlay.classList.remove('active');
    };

    overlay.onclick = (e) => {
        if (e.target === overlay) close(e);
    };

    const closeBtn = document.getElementById('zoom-close-btn');
    if (closeBtn) closeBtn.onclick = close;

    const copyBtn = document.getElementById('zoom-copy-btn');
    if (copyBtn) {
        copyBtn.onclick = (e) => {
            e.stopPropagation();
            vscode.postMessage({ command: 'copyToClipboard', text: src });
            copyBtn.innerHTML = '<i class="codicon codicon-check"></i>';
            setTimeout(() => { copyBtn.innerHTML = '<i class="codicon codicon-copy"></i>'; }, 1500);
        };
    }

    const escHandler = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
            close();
            window.removeEventListener('keydown', escHandler);
        }
    };
    window.addEventListener('keydown', escHandler);
}

function renderPendingImages() {
    const previewArea = document.getElementById('attachment-preview-area');
    if (!previewArea) return;
    previewArea.innerHTML = '';

    if (pendingImages.length === 0) {
        previewArea.style.display = 'none';
        return;
    }

    previewArea.style.display = 'flex';
    pendingImages.forEach((img, idx) => {
        if (!img.data) return;
        const card = document.createElement('div');
        card.className = 'staged-image-card';
        card.title = `${img.name || 'Attached image'} (Click to zoom)`;

        const imageEl = document.createElement('img');
        imageEl.src = img.data;
        imageEl.alt = img.name || 'Attached image';
        imageEl.onclick = (e) => {
            e.stopPropagation();
            openCompanionImageZoom(img.data);
        };
        card.appendChild(imageEl);

        const removeBtn = document.createElement('div');
        removeBtn.className = 'remove-btn';
        removeBtn.title = 'Remove attached image';
        removeBtn.innerHTML = '<span class="codicon codicon-close"></span>';
        removeBtn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            pendingImages.splice(idx, 1);
            renderPendingImages();
        };
        card.appendChild(removeBtn);

        previewArea.appendChild(card);
    });
}

function addImageFiles(files: FileList | File[] | null) {
    if (!files || files.length === 0) return;
    Array.from(files).forEach((file, idx) => {
        const isSvg = file.name.toLowerCase().endsWith('.svg') || file.type === 'image/svg+xml';
        const isRaster = !isSvg && (file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name));
        if (!isRaster) return;

        const reader = new FileReader();
        reader.onload = (ev) => {
            const dataUrl = ev.target?.result as string;
            if (dataUrl) {
                pendingImages.push({
                    name: file.name || `image_${Date.now()}_${idx}.png`,
                    data: dataUrl
                });
                renderPendingImages();
            }
        };
        reader.readAsDataURL(file);
    });
}

function handlePasteImages(e: ClipboardEvent): boolean {
    const clipboardData = e.clipboardData;
    if (!clipboardData) return false;

    const imageBlobs: File[] = [];
    if (clipboardData.items && clipboardData.items.length > 0) {
        for (const item of Array.from(clipboardData.items)) {
            if (item.type && item.type.indexOf('image') !== -1 && !item.type.includes('svg')) {
                const blob = item.getAsFile();
                if (blob) imageBlobs.push(blob);
            } else if (item.kind === 'file') {
                const file = item.getAsFile();
                if (file && !file.name.toLowerCase().endsWith('.svg') && file.type !== 'image/svg+xml' && (file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name))) {
                    imageBlobs.push(file);
                }
            }
        }
    }

    if (imageBlobs.length === 0 && clipboardData.files && clipboardData.files.length > 0) {
        for (const file of Array.from(clipboardData.files)) {
            if (!file.name.toLowerCase().endsWith('.svg') && file.type !== 'image/svg+xml' && (file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name))) {
                imageBlobs.push(file);
            }
        }
    }

    if (imageBlobs.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        addImageFiles(imageBlobs);
        return true;
    }
    return false;
}

interface MessageSegment {
    type: 'markdown' | 'plugin';
    content: string;
    start: number;
    end: number;
    plugin?: TagPlugin;
}

interface CompanionPatchItem {
    id: string;
    blockIndex: number;
    hunkIndex?: number;
    path: string;
    label: string;
    content: string;
    type: 'replace' | 'file' | 'delete_code';
    blockId: string;
    isApplied: boolean;
}

function getMessagesContainer(): HTMLElement | null {
    return document.getElementById('markdown-content');
}

function isNearBottom(el: HTMLElement | null): boolean {
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 60;
}

function extractFencedCodeBlocks(text: string, occupied: { start: number; end: number }[]) {
    const blocks: { start: number; end: number; lang: string; filePath: string; code: string; isClosed: boolean }[] = [];
    const lines = text.split('\n');
    let offset = 0;
    let inFence = false;
    let fenceStart = 0;
    let fenceLen = 0;
    let fenceLang = '';
    let fencePath = '';
    let codeLines: string[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineWithNl = line + (i < lines.length - 1 ? '\n' : '');
        const isOccupied = occupied.some(r => offset >= r.start && offset < r.end);

        if (!inFence) {
            if (!isOccupied) {
                const m = line.match(/^[ \t]*(`{3,})(.*)$/);
                if (m) {
                    inFence = true;
                    fenceStart = offset;
                    fenceLen = m[1].length;
                    const header = m[2].trim();
                    if (header.includes(':')) {
                        const parts = header.split(':');
                        let prefix = parts[0].trim().toLowerCase();
                        let candidatePath = parts.slice(1).join(':').trim();
                        if ((prefix === 'language' || prefix === 'lang') && parts.length > 2) {
                            prefix = parts[1].trim().toLowerCase();
                            candidatePath = parts.slice(2).join(':').trim();
                        }
                        fenceLang = prefix || 'plaintext';
                        fencePath = isValidFilePath(candidatePath) ? candidatePath : '';
                    } else {
                        fenceLang = header || 'plaintext';
                        fencePath = '';
                    }
                    codeLines = [];
                }
            }
        } else {
            const closeM = line.match(/^[ \t]*(`{3,})[ \t]*$/);
            if (closeM && closeM[1].length >= fenceLen) {
                blocks.push({
                    start: fenceStart,
                    end: offset + lineWithNl.length,
                    lang: fenceLang,
                    filePath: fencePath,
                    code: codeLines.join('\n'),
                    isClosed: true
                });
                inFence = false;
            } else {
                codeLines.push(line);
            }
        }

        offset += lineWithNl.length;
    }

    if (inFence) {
        blocks.push({
            start: fenceStart,
            end: offset,
            lang: fenceLang,
            filePath: fencePath,
            code: codeLines.join('\n'),
            isClosed: false
        });
    }

    return blocks;
}

function getPatchesForMessage(messageId: string): CompanionPatchItem[] {
    const patches: CompanionPatchItem[] = [];
    const wrapper = document.querySelector(`.message-wrapper[data-message-id='${messageId}']`);
    if (!wrapper) return patches;

    const appliedStateForMsg = state.appliedState?.[messageId] || {};
    const cards = Array.from(wrapper.querySelectorAll('.file-mutation-card')) as HTMLElement[];

    cards.forEach((card, idx) => {
        const bIdxAttr = card.dataset.blockIndex;
        let blockIndex = bIdxAttr !== undefined && bIdxAttr !== '' ? parseInt(bIdxAttr, 10) : idx;
        if (isNaN(blockIndex)) blockIndex = idx;

        const appliedHunks = appliedStateForMsg[blockIndex] || [];
        const isBlockFullyApplied = appliedHunks.includes(-1);

        const rawPath = card.dataset.path || '';
        const action = card.dataset.action || 'write';
        const symbol = card.dataset.symbol || '';
        const rawCodeAttr = card.dataset.rawCode;
        const codeText = rawCodeAttr ? decodeURIComponent(rawCodeAttr) : (card.querySelector('pre code')?.textContent || '');
        const applyBtn = card.querySelector('.apply-mutation-btn, .apply-btn');
        const targetPath = (symbol && action !== 'patch' && action !== 'delete_code') ? `${rawPath}:${symbol}` : rawPath;
        const changeType: CompanionPatchItem['type'] = action === 'delete_code'
            ? 'delete_code'
            : ((action === 'patch' || codeText.includes('<<<<<<< SEARCH')) ? 'replace' : 'file');

        const hunkTabs = Array.from(card.querySelectorAll('.hunk-tab')) as HTMLElement[];
        if (hunkTabs.length > 1) {
            hunkTabs.forEach((tab, hIdx) => {
                const pane = card.querySelector(`.hunk-pane-${hIdx}`);
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
                    blockId: card.id,
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
                blockId: card.id,
                isApplied
            });
        }
    });

    return patches;
}

function syncSummaryCard(messageId: string) {
    const wrapper = document.querySelector(`.message-wrapper[data-message-id='${messageId}']`);
    if (!wrapper) return;
    const resList = document.getElementById(`results-${messageId}`);
    const applyAllBtn = document.getElementById(`apply-all-${messageId}`) as HTMLButtonElement | null;
    const bar = document.getElementById(`progress-bar-${messageId}`);
    const patches = getPatchesForMessage(messageId);

    if (patches.length === 0) return;

    if (resList) {
        resList.style.display = 'flex';
        resList.style.flexDirection = 'column';
        resList.style.gap = '4px';

        resList.innerHTML = patches.map(p => {
            const isDone = p.isApplied;
            return `
            <div class="apply-row ${isDone ? 'status-success' : 'status-pending'}"
                 data-block-index="${p.blockIndex}"
                 ${p.hunkIndex !== undefined ? `data-hunk-index="${p.hunkIndex}"` : ''}
                 style="display:flex; align-items:center; gap:8px; padding:5px 8px; border-radius:4px; border:1px solid var(--vscode-widget-border);">
                <span class="status-icon">
                    ${isDone
                        ? '<i class="codicon codicon-check" style="color:var(--vscode-charts-green)"></i>'
                        : '<i class="codicon codicon-primitive-dot" style="opacity:0.6"></i>'}
                </span>
                <span class="row-path clickable" data-path="${escapeHtml(p.path)}" style="flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:11px; cursor:pointer;">${escapeHtml(p.label)}</span>
                <button type="button" class="icon-btn row-jump-btn" data-block-id="${escapeHtml(p.blockId)}" data-hunk-index="${p.hunkIndex ?? ''}" title="Jump to code block" style="width:20px; height:20px; padding:0;">
                    <i class="codicon codicon-link-external" style="font-size:11px; color:var(--vscode-textLink-foreground);"></i>
                </button>
                <span style="font-size:10px; font-weight:600; color:${isDone ? 'var(--vscode-charts-green)' : 'var(--vscode-descriptionForeground)'};">${isDone ? 'Applied' : 'Pending'}</span>
            </div>`;
        }).join('');

        resList.querySelectorAll('.row-path').forEach((el: any) => {
            el.onclick = (e: MouseEvent) => {
                e.stopPropagation();
                if (el.dataset.path) {
                    vscode.postMessage({ command: 'openFile', path: el.dataset.path });
                }
            };
        });

        resList.querySelectorAll('.row-jump-btn').forEach((btn: any) => {
            btn.onclick = (e: MouseEvent) => {
                e.stopPropagation();
                const blockEl = btn.dataset.blockId ? document.getElementById(btn.dataset.blockId) as HTMLDetailsElement : null;
                if (blockEl) {
                    blockEl.open = true;
                    if (btn.dataset.hunkIndex !== '') {
                        const tab = blockEl.querySelector(`.hunk-tab-${btn.dataset.hunkIndex}`) as HTMLElement;
                        if (tab) tab.click();
                    }
                    blockEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            };
        });
    }

    const doneCount = patches.filter(p => p.isApplied).length;
    if (bar) {
        const pct = Math.round((doneCount / patches.length) * 100);
        bar.style.width = `${pct}%`;
        bar.style.background = pct === 100 ? 'var(--vscode-charts-green)' : 'var(--vscode-charts-blue)';
    }

    if (applyAllBtn) {
        const pending = patches.filter(p => !p.isApplied);
        const word = patches.length === 1 ? 'Changes' : 'All Changes';
        applyAllBtn.disabled = false;
        if (pending.length === 0) {
            applyAllBtn.classList.add('undo-all-btn');
            applyAllBtn.innerHTML = `<span class="codicon codicon-discard"></span> Undo ${word} (${patches.length})`;
        } else {
            applyAllBtn.classList.remove('undo-all-btn');
            applyAllBtn.innerHTML = `<span class="codicon codicon-check-all"></span> Apply ${word} (${pending.length})`;
        }
    }
}

function enhancePlainCodeBlocks(bodyZone: HTMLElement, messageId: string) {
    const pres = Array.from(bodyZone.querySelectorAll('pre.lollms-placeholder')) as HTMLElement[];
    pres.forEach((pre, idx) => {
        const codeEl = pre.querySelector('code');
        if (!codeEl) return;

        let language = (pre.getAttribute('data-lang') || 'plaintext').toLowerCase();
        const filePath = pre.getAttribute('data-path') || '';
        if (langMap[language]) language = langMap[language];
        codeEl.className = `language-${language}`;

        const rawCode = codeEl.textContent || '';
        const lineCount = rawCode.split('\n').length;

        const details = document.createElement('details');
        details.className = 'code-collapsible';
        details.open = true;
        details.id = `comp-code-${messageId}-${idx}`;

        const summary = document.createElement('summary');
        summary.className = 'code-summary';
        summary.innerHTML = `
            <div class="summary-lang-label">
                <span class="lang-badge" data-lang="${escapeHtml(language)}">${escapeHtml(language)}</span>
                ${filePath ? `<span class="path-display-label" style="font-family:var(--vscode-editor-font-family); font-size:11px; font-weight:bold; margin-left:6px; color:var(--vscode-textLink-foreground);">${escapeHtml(filePath)}</span>` : ''}
            </div>
            <div class="code-actions"></div>
        `;

        const actions = summary.querySelector('.code-actions') as HTMLElement;
        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'code-action-btn';
        copyBtn.title = 'Copy code';
        copyBtn.innerHTML = '<span class="codicon codicon-copy"></span>';
        copyBtn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            vscode.postMessage({ command: 'copyToClipboard', text: rawCode });
            copyBtn.innerHTML = '<span class="codicon codicon-check"></span>';
            setTimeout(() => { copyBtn.innerHTML = '<span class="codicon codicon-copy"></span>'; }, 1500);
        };
        actions.appendChild(copyBtn);

        if (filePath && isValidFilePath(filePath)) {
            const isAider = rawCode.includes('<<<<<<< SEARCH') && rawCode.includes('>>>>>>> REPLACE');
            const applyBtn = document.createElement('button');
            applyBtn.type = 'button';
            applyBtn.className = 'code-action-btn apply-btn';
            applyBtn.title = 'Review Diff & Apply';
            applyBtn.innerHTML = `<span class="codicon ${isAider ? 'codicon-arrow-swap' : 'codicon-tools'}"></span>`;
            applyBtn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                vscode.postMessage({
                    command: isAider ? 'replaceCode' : 'applyFileContent',
                    filePath,
                    content: rawCode,
                    messageId,
                    blockId: details.id,
                    options: { silent: false, autoSave: false, blockId: details.id }
                });
            };
            actions.appendChild(applyBtn);
        }

        pre.style.display = 'flex';
        pre.style.flexDirection = 'row';
        pre.style.overflow = 'auto';

        const gutter = document.createElement('div');
        gutter.className = 'code-line-gutter';
        gutter.innerHTML = Array.from({ length: lineCount }, (_, i) => i + 1).join('<br>');
        pre.insertBefore(gutter, pre.firstChild);

        details.appendChild(summary);
        pre.replaceWith(details);
        details.appendChild(pre);

        Prism.highlightElement(codeEl);
    });
}

function renderMessageContent(messageId: string, rawContent: any, isFinal: boolean) {
    const wrapper = document.querySelector(`.message-wrapper[data-message-id='${messageId}']`) as HTMLElement | null;
    if (!wrapper) return;
    const contentDiv = wrapper.querySelector('.message-content') as HTMLElement | null;
    if (!contentDiv) return;

    const isUser = wrapper.classList.contains('user-msg-wrapper');
    if (isUser) {
        if (Array.isArray(rawContent)) {
            contentDiv.innerHTML = '';
            const images = rawContent.filter((p: any) => p?.type === 'image_url' && (p.image_url?.url || p.url));
            if (images.length > 0) {
                const gallery = document.createElement('div');
                gallery.className = 'message-images-gallery';
                images.forEach((imgPart: any) => {
                    const url = imgPart.image_url?.url || imgPart.url || '';
                    if (!url) return;
                    const card = document.createElement('div');
                    card.className = 'message-inline-image-card';
                    const img = document.createElement('img');
                    img.src = url;
                    img.alt = 'Attached Image';
                    card.appendChild(img);
                    gallery.appendChild(card);
                });
                contentDiv.appendChild(gallery);
            }
            const textStr = rawContent.filter((p: any) => p?.type === 'text').map((p: any) => p.text || '').join('\n');
            if (textStr) {
                const textEl = document.createElement('div');
                textEl.style.whiteSpace = 'pre-wrap';
                textEl.textContent = textStr;
                contentDiv.appendChild(textEl);
            }
        } else {
            contentDiv.style.whiteSpace = 'pre-wrap';
            contentDiv.textContent = rawContent || '';
        }
        return;
    }
}

function createMessageElement(role: 'user' | 'assistant', messageId: string, rawContent: any): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = `message-wrapper ${role === 'user' ? 'user-msg-wrapper' : 'assistant-msg-wrapper'}`;
    wrapper.dataset.messageId = messageId;

    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${role === 'user' ? 'user-message' : 'assistant-message'}`;
    msgDiv.dataset.originalContent = JSON.stringify(rawContent || '');

    const avatarDiv = document.createElement('div');
    avatarDiv.className = 'message-avatar';
    avatarDiv.innerHTML = role === 'user'
        ? '<span class="codicon codicon-account"></span>'
        : '<span class="codicon codicon-sparkle" style="color:var(--vscode-textLink-foreground);"></span>';

    const bodyDiv = document.createElement('div');
    bodyDiv.className = 'message-body';

    const actions = document.createElement('div');
    actions.className = 'message-actions';
    actions.innerHTML = `
        <button type="button" class="msg-action-btn collapse-msg-action-btn" title="Collapse / Expand"><i class="codicon codicon-fold"></i></button>
        <button type="button" class="msg-action-btn edit-msg-btn" title="Edit Message"><i class="codicon codicon-edit"></i></button>
        <button type="button" class="msg-action-btn copy-msg-btn" title="Copy Message"><i class="codicon codicon-copy"></i></button>
        <button type="button" class="msg-action-btn delete-msg-btn" title="Delete Message"><i class="codicon codicon-trash"></i></button>
    `;

    const header = document.createElement('div');
    header.className = 'message-header';
    const collapseBtn = document.createElement('button');
    collapseBtn.type = 'button';
    collapseBtn.className = 'msg-collapse-btn';
    collapseBtn.title = 'Collapse / Expand message';
    collapseBtn.innerHTML = '<i class="codicon codicon-chevron-down"></i>';

    const roleSpan = document.createElement('span');
    roleSpan.className = 'role-name';
    roleSpan.textContent = role === 'user' ? 'You' : 'Lollms Companion';
    if (role === 'user') {
        roleSpan.style.color = 'var(--vscode-charts-blue)';
    } else {
        roleSpan.style.color = 'var(--vscode-charts-green)';
    }

    header.appendChild(collapseBtn);
    header.appendChild(roleSpan);

    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    contentDiv.id = `content-${messageId}`;

    bodyDiv.appendChild(actions);
    bodyDiv.appendChild(header);
    bodyDiv.appendChild(contentDiv);

    msgDiv.appendChild(avatarDiv);
    msgDiv.appendChild(bodyDiv);
    wrapper.appendChild(msgDiv);

    const toggleCollapse = () => {
        const isCollapsed = wrapper.classList.toggle('collapsed-message');
        collapseBtn.innerHTML = `<i class="codicon ${isCollapsed ? 'codicon-chevron-right' : 'codicon-chevron-down'}"></i>`;
    };
    collapseBtn.onclick = (e) => { e.stopPropagation(); toggleCollapse(); };
    actions.querySelector('.collapse-msg-action-btn')?.addEventListener('click', (e) => { e.stopPropagation(); toggleCollapse(); });

    actions.querySelector('.copy-msg-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        let text = '';
        try {
            const parsed = JSON.parse(msgDiv.dataset.originalContent || '""');
            if (typeof parsed === 'string') text = parsed;
            else if (Array.isArray(parsed)) text = parsed.filter((p: any) => p?.type === 'text').map((p: any) => p.text || '').join('\n');
            else text = String(parsed);
        } catch {
            text = contentDiv.textContent || '';
        }
        vscode.postMessage({ command: 'copyToClipboard', text });
        const icon = actions.querySelector('.copy-msg-btn i');
        if (icon) {
            icon.className = 'codicon codicon-check';
            setTimeout(() => { icon.className = 'codicon codicon-copy'; }, 1500);
        }
    });

    actions.querySelector('.delete-msg-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        wrapper.remove();
        vscode.postMessage({ command: 'deleteMessage', messageId });
        const container = getMessagesContainer();
        if (container && container.querySelectorAll('.message-wrapper').length === 0) {
            renderEmptyState();
        }
    });

    actions.querySelector('.edit-msg-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        startInlineEdit(wrapper, msgDiv, messageId, role);
    });

    return wrapper;
}

function startInlineEdit(wrapper: HTMLElement, msgDiv: HTMLElement, messageId: string, role: 'user' | 'assistant') {
    const contentDiv = wrapper.querySelector('.message-content') as HTMLElement | null;
    const actionsDiv = wrapper.querySelector('.message-actions') as HTMLElement | null;
    if (!contentDiv) return;

    let originalContent: any = '';
    let originalText = '';
    let localImages: { name: string; data: string }[] = [];
    try {
        originalContent = JSON.parse(msgDiv.dataset.originalContent || '""');
        if (typeof originalContent === 'string') {
            originalText = originalContent;
        } else if (Array.isArray(originalContent)) {
            originalText = originalContent.filter((p: any) => p?.type === 'text').map((p: any) => p.text || '').join('\n');
            localImages = originalContent
                .filter((p: any) => p?.type === 'image_url' && (p.image_url?.url || p.url))
                .map((p: any, idx: number) => ({ name: `image_${idx}.png`, data: p.image_url?.url || p.url }));
        } else {
            originalText = String(originalContent || '');
        }
    } catch {
        originalText = contentDiv.textContent || '';
        originalContent = originalText;
    }

    if (actionsDiv) actionsDiv.style.display = 'none';

    const editBox = document.createElement('div');
    editBox.className = 'edit-overlay';

    const imageTray = document.createElement('div');
    imageTray.className = 'attachment-preview-area';
    imageTray.style.display = localImages.length > 0 ? 'flex' : 'none';

    const renderEditImages = () => {
        imageTray.innerHTML = '';
        if (localImages.length === 0) {
            imageTray.style.display = 'none';
            return;
        }
        imageTray.style.display = 'flex';
        localImages.forEach((img, idx) => {
            const card = document.createElement('div');
            card.className = 'staged-image-card';
            const im = document.createElement('img');
            im.src = img.data;
            im.alt = img.name;
            card.appendChild(im);
            const del = document.createElement('div');
            del.className = 'remove-btn';
            del.innerHTML = '<span class="codicon codicon-close"></span>';
            del.onclick = () => { localImages.splice(idx, 1); renderEditImages(); };
            card.appendChild(del);
            imageTray.appendChild(card);
        });
    };
    renderEditImages();

    const textarea = document.createElement('textarea');
    textarea.style.cssText = 'width:100%; min-height:85px; background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border); border-radius:6px; padding:8px; font-family:var(--vscode-editor-font-family, inherit); font-size:12px; resize:vertical; box-sizing:border-box;';
    textarea.value = originalText;

    textarea.addEventListener('paste', (e: ClipboardEvent) => {
        const items = e.clipboardData?.items;
        if (!items) return;
        for (const item of Array.from(items)) {
            if (item.type.indexOf('image') !== -1 && !item.type.includes('svg')) {
                const blob = item.getAsFile();
                if (blob) {
                    e.preventDefault();
                    const reader = new FileReader();
                    reader.onload = (ev) => {
                        const url = ev.target?.result as string;
                        if (url) {
                            localImages.push({ name: `pasted_${Date.now()}.png`, data: url });
                            renderEditImages();
                        }
                    };
                    reader.readAsDataURL(blob);
                }
            }
        }
    });

    const buildUpdatedContent = () => {
        const newVal = textarea.value.trim();
        if (localImages.length > 0) {
            const parts: any[] = [];
            if (newVal) parts.push({ type: 'text', text: newVal });
            localImages.forEach(img => parts.push({ type: 'image_url', image_url: { url: img.data } }));
            return parts;
        }
        return newVal;
    };

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex; justify-content:flex-end; gap:8px; margin-top:8px;';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'code-action-btn secondary-btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.onclick = () => {
        if (actionsDiv) actionsDiv.style.display = '';
        renderMessageContent(messageId, originalContent, true);
    };

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'code-action-btn secondary-btn';
    saveBtn.textContent = 'Save';
    saveBtn.onclick = () => {
        const newVal = textarea.value.trim();
        if (actionsDiv) actionsDiv.style.display = '';
        if (newVal || localImages.length > 0) {
            const updated = buildUpdatedContent();
            msgDiv.dataset.originalContent = JSON.stringify(updated);
            vscode.postMessage({ command: 'updateMessage', messageId, newContent: updated });
            renderMessageContent(messageId, updated, true);
        } else {
            renderMessageContent(messageId, originalContent, true);
        }
    };

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(saveBtn);

    if (role === 'user') {
        const askBtn = document.createElement('button');
        askBtn.type = 'button';
        askBtn.className = 'code-action-btn apply-btn';
        askBtn.innerHTML = '<span class="codicon codicon-send"></span> Save &amp; Ask';
        askBtn.onclick = () => {
            const newVal = textarea.value.trim();
            if (!newVal && localImages.length === 0) return;
            const updated = buildUpdatedContent();
            if (actionsDiv) actionsDiv.style.display = '';
            msgDiv.dataset.originalContent = JSON.stringify(updated);
            renderMessageContent(messageId, updated, true);

            let next = wrapper.nextElementSibling;
            while (next) {
                const toRemove = next;
                next = next.nextElementSibling;
                toRemove.remove();
            }

            vscode.postMessage({ command: 'saveAndAsk', messageId, text: newVal, images: localImages });
        };
        btnRow.appendChild(askBtn);

        textarea.onkeydown = (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                askBtn.click();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                cancelBtn.click();
            }
        };
    } else {
        textarea.onkeydown = (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                saveBtn.click();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                cancelBtn.click();
            }
        };
    }

    editBox.appendChild(imageTray);
    editBox.appendChild(textarea);
    editBox.appendChild(btnRow);
    contentDiv.innerHTML = '';
    contentDiv.appendChild(editBox);
    textarea.focus();
}

function renderEmptyState() {
    const container = getMessagesContainer();
    if (!container) return;
    lastHistorySig = '';
    container.innerHTML = `
        <div class="empty-state">
            <div style="font-size: 28px; opacity: 0.75; margin-bottom: 10px;"><i class="codicon codicon-sparkle"></i></div>
            <h3>Lollms Companion</h3>
            <p>Lightweight file-focused assistant. Sees your active file, current selection, and session history &mdash; and can grep, search files, or recover symbols from across your codebase on demand.</p>
        </div>`;
}

function flushStreamingRender() {
    streamingRaf = null;
    if (streamingBufferPending === null) return;
    const text = streamingBufferPending;
    streamingBufferPending = null;
    lastStreamRenderTime = Date.now();

    const container = getMessagesContainer();
    if (!container) return;

    const empty = container.querySelector('.empty-state');
    if (empty) empty.remove();

    const wasAtBottom = isNearBottom(container);
    let streamWrapper = document.querySelector(`.message-wrapper[data-message-id='companion_streaming']`) as HTMLElement | null;
    if (!streamWrapper) {
        streamWrapper = createMessageElement('assistant', 'companion_streaming', text);
        container.appendChild(streamWrapper);
    } else {
        const msgDiv = streamWrapper.querySelector('.message') as HTMLElement | null;
        if (msgDiv) msgDiv.dataset.originalContent = JSON.stringify(text);
    }

    renderMessageContent('companion_streaming', text, false);
    if (wasAtBottom) container.scrollTop = container.scrollHeight;
}

function renderChat(history: any[], streamingText: string) {
    const container = getMessagesContainer();
    if (!container) return;

    const validHistory = Array.isArray(history) ? history : [];
    if (validHistory.length === 0 && !streamingText && !state.isGenerating) {
        renderEmptyState();
        return;
    }

    const empty = container.querySelector('.empty-state');
    if (empty) empty.remove();

    if (validHistory.length > 0) {
        activeContentBuffer = validHistory
            .map(m => {
                const txt = typeof m.content === 'string'
                    ? m.content
                    : (Array.isArray(m.content)
                        ? m.content.map((p: any) => p?.type === 'text' ? (p.text || '') : '[Attached Image]').join('\n')
                        : JSON.stringify(m.content));
                return `${m.role === 'user' ? '### User' : '### Assistant'}\n${txt}`;
            })
            .join('\n\n');
    }
    if (streamingText) {
        activeContentBuffer = streamingText;
    }

    const historySig = JSON.stringify(validHistory.map((m, idx) => [
        m.id || idx,
        m.role,
        typeof m.content === 'string'
            ? m.content.length
            : (Array.isArray(m.content) ? m.content.map((p: any) => p?.type === 'text' ? (p.text?.length || 0) : (p?.isMuted ? 'm' : 'i')).join(',') : 0)
    ]));
    const wasAtBottom = isNearBottom(container);

    if (historySig !== lastHistorySig) {
        lastHistorySig = historySig;
        container.innerHTML = '';

        validHistory.forEach((msg, idx) => {
            const role: 'user' | 'assistant' = msg.role === 'user' ? 'user' : 'assistant';
            const msgId = msg.id || `${role}_${idx}`;
            const rawContent = (typeof msg.content === 'string' || Array.isArray(msg.content))
                ? msg.content
                : String(msg.content || '');
            const el = createMessageElement(role, msgId, rawContent);
            container.appendChild(el);
            renderMessageContent(msgId, rawContent, true);
        });
    }

    if (streamingText) {
        streamingBufferPending = streamingText;
        const now = Date.now();
        if (now - lastStreamRenderTime >= 120) {
            flushStreamingRender();
        } else if (streamingRaf === null) {
            streamingRaf = requestAnimationFrame(flushStreamingRender);
        }
    } else {
        streamingBufferPending = null;
        const staleStream = document.querySelector(`.message-wrapper[data-message-id='companion_streaming']`);
        if (staleStream) staleStream.remove();

        if (state.isGenerating) {
            const placeholder = createMessageElement('assistant', 'companion_streaming', '');
            container.appendChild(placeholder);
            renderMessageContent('companion_streaming', '', false);
        }
    }

    if (wasAtBottom) {
        container.scrollTop = container.scrollHeight;
    }
}

function setLoadingState(isLoading: boolean) {
    state.isGenerating = isLoading;
    const sendBtn = document.getElementById('send-btn') as HTMLButtonElement | null;
    const promptInput = document.getElementById('prompt-input') as HTMLTextAreaElement | null;

    if (sendBtn) {
        if (isLoading) {
            sendBtn.disabled = false;
            sendBtn.classList.add('is-stopping');
            sendBtn.title = 'Stop Generation (Esc)';
            sendBtn.innerHTML = '<span class="codicon codicon-primitive-square" style="color: #ffffff;"></span>';
        } else {
            sendBtn.disabled = false;
            sendBtn.classList.remove('is-stopping');
            sendBtn.title = 'Send Message (Enter)';
            sendBtn.innerHTML = '<span class="codicon codicon-send"></span>';
            promptInput?.focus();
        }
    }
}

function handleApplyAllResult(message: any) {
    const isUndo = message.undo === true;
    const blockId = message.blockId;
    const escapedAttrPath = String(message.filePath || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const card = (blockId ? document.getElementById(blockId) : null) ||
        (message.filePath ? document.querySelector(`.file-mutation-card[data-path="${escapedAttrPath}"]`) : null);

    if (card) {
        const wrapper = card.closest('.message-wrapper') as HTMLElement | null;
        const messageId = message.messageId || wrapper?.dataset.messageId || '';
        const blockIndex = message.blockIndex !== undefined
            ? message.blockIndex
            : parseInt(card.getAttribute('data-block-index') || '0', 10);

        const existingReview = card.querySelector('.review-actions-row');
        if (existingReview) existingReview.remove();
        const existingErr = card.querySelector('.apply-failed-banner');
        if (existingErr) existingErr.remove();

        const applyBtn = card.querySelector('.apply-mutation-btn, .apply-btn') as HTMLButtonElement | null;
        const undoBtn = card.querySelector('.undo-mutation-btn') as HTMLButtonElement | null;

        if (message.success) {
            if (messageId && !isNaN(blockIndex)) {
                if (!state.appliedState[messageId]) state.appliedState[messageId] = {};
                if (!state.appliedState[messageId][blockIndex]) state.appliedState[messageId][blockIndex] = [];
                const hVal = message.hunkIndex !== undefined ? message.hunkIndex : -1;
                if (isUndo || message.rejected) {
                    state.appliedState[messageId][blockIndex] = state.appliedState[messageId][blockIndex].filter(v => v !== hVal && v !== -1);
                } else if (message.alreadyApplied) {
                    if (!state.appliedState[messageId][blockIndex].includes(hVal)) {
                        state.appliedState[messageId][blockIndex].push(hVal);
                    }
                }
            }

            if (isUndo || message.rejected) {
                buttonsToReset.forEach(btn => {
                    delete btn.dataset.applying;
                    btn.disabled = false;
                    btn.classList.remove('applied', 'stop-btn-red');
                    btn.style.removeProperty('background-color');
                    btn.style.removeProperty('color');
                    btn.innerHTML = btn === hunkApplyBtn ? '<i class="codicon codicon-arrow-swap"></i> Apply Hunk' : '<i class="codicon codicon-arrow-swap"></i>';
                    btn.title = 'Review Diff & Apply';
                });
                if (hunkTab) {
                    hunkTab.classList.remove('status-completed');
                    const icon = hunkTab.querySelector('.hunk-status-icon i');
                    if (icon) icon.className = 'codicon codicon-primitive-dot';
                }
                if (hunkUndoBtn) hunkUndoBtn.style.display = 'none';
                if (undoBtn && message.hunkIndex === undefined) undoBtn.style.display = 'none';
                (card as HTMLDetailsElement).open = true;
            } else if (message.alreadyApplied) {
                buttonsToReset.forEach(btn => {
                    delete btn.dataset.applying;
                    btn.disabled = false;
                    btn.classList.remove('stop-btn-red');
                    btn.style.removeProperty('background-color');
                    btn.style.removeProperty('color');
                    btn.classList.add('applied');
                    btn.innerHTML = btn === hunkApplyBtn ? '<i class="codicon codicon-check"></i> Apply Hunk' : '<i class="codicon codicon-check"></i>';
                    btn.title = 'Applied. Click to re-apply.';
                });
                if (hunkTab) {
                    hunkTab.classList.add('status-completed');
                    const icon = hunkTab.querySelector('.hunk-status-icon i');
                    if (icon) icon.className = 'codicon codicon-check';
                }
                if (hunkUndoBtn) {
                    hunkUndoBtn.style.display = 'inline-flex';
                }
                if (undoBtn) {
                    undoBtn.style.display = 'inline-flex';
                    undoBtn.disabled = false;
                }
                const allTabs = card.querySelectorAll('.hunk-tab');
                const doneTabs = card.querySelectorAll('.hunk-tab.status-completed');
                if (allTabs.length <= 1 || doneTabs.length >= allTabs.length) {
                    collapseBlockWithScrollPreservation(card as HTMLDetailsElement, getMessagesContainer());
                }
            } else if (message.reviewingDiff) {
                buttonsToReset.forEach(btn => {
                    delete btn.dataset.applying;
                    btn.disabled = false;
                    btn.classList.remove('applied', 'stop-btn-red');
                    btn.style.removeProperty('background-color');
                    btn.style.removeProperty('color');
                    btn.innerHTML = btn === hunkApplyBtn ? '<i class="codicon codicon-diff"></i> Reviewing' : '<i class="codicon codicon-diff"></i>';
                    btn.title = 'Reviewing diff in editor';
                });
                const reviewRow = document.createElement('div');
                reviewRow.className = 'review-actions-row';
                reviewRow.innerHTML = `
                    <div style="display:flex; align-items:center; gap:6px; font-size:11px; font-weight:bold; color:var(--vscode-textLink-foreground);">
                        <i class="codicon codicon-diff"></i>
                        <span>Reviewing diff in editor</span>
                    </div>
                    <div style="display:flex; gap:6px;">
                        <button type="button" class="code-action-btn review-btn-accept" style="height:22px; font-size:10px; padding:0 8px;">
                            <i class="codicon codicon-check"></i> Accept
                        </button>
                        <button type="button" class="code-action-btn review-btn-reject" style="height:22px; font-size:10px; padding:0 8px;">
                            <i class="codicon codicon-close"></i> Reject
                        </button>
                    </div>`;
                reviewRow.querySelector('.review-btn-accept')?.addEventListener('click', (e) => {
                    e.stopPropagation();
                    reviewRow.remove();
                    vscode.postMessage({ command: 'acceptDiff', blockId: card.id, filePath: message.filePath });
                });
                reviewRow.querySelector('.review-btn-reject')?.addEventListener('click', (e) => {
                    e.stopPropagation();
                    reviewRow.remove();
                    vscode.postMessage({ command: 'rejectDiff', blockId: card.id, filePath: message.filePath });
                });
                card.appendChild(reviewRow);
                (card as HTMLDetailsElement).open = true;
            }
        } else {
            if (applyBtn) {
                delete applyBtn.dataset.applying;
                applyBtn.disabled = false;
                applyBtn.classList.remove('applied', 'stop-btn-red');
                applyBtn.style.removeProperty('background-color');
                applyBtn.style.removeProperty('color');
                applyBtn.innerHTML = '<i class="codicon codicon-error"></i>';
                applyBtn.title = message.error || 'Failed to apply';
            }
            const errBanner = document.createElement('div');
            errBanner.className = 'apply-failed-banner';
            errBanner.style.cssText = 'display:flex; align-items:center; justify-content:space-between; padding:6px 10px; background:rgba(231, 76, 60, 0.12); border-top:1px solid var(--vscode-charts-red); font-size:11px; color:var(--vscode-charts-red); gap:8px;';
            errBanner.innerHTML = `<span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(message.error || '')}"><i class="codicon codicon-error"></i> ${escapeHtml(message.error || 'Patch match failed')}</span>`;
            card.appendChild(errBanner);
            (card as HTMLDetailsElement).open = true;
        }

        if (messageId) {
            syncSummaryCard(messageId);
        }
    }
}

function submitPrompt() {
    if (state.isGenerating) {
        vscode.postMessage({ command: 'stopGeneration' });
        setLoadingState(false);
        return;
    }
    const promptInput = document.getElementById('prompt-input') as HTMLTextAreaElement | null;
    const text = promptInput?.value?.trim() || '';
    if (!text && pendingImages.length === 0) return;

    const imagesToSend = [...pendingImages];
    pendingImages = [];
    renderPendingImages();

    setLoadingState(true);
    vscode.postMessage({ command: 'submitPrompt', text, images: imagesToSend });
    if (promptInput) {
        promptInput.value = '';
        promptInput.style.height = 'auto';
    }
}

function wrapText(type: string) {
    const textarea = document.getElementById('prompt-input') as HTMLTextAreaElement | null;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = textarea.value.substring(start, end);
    let prefix = '';
    let suffix = '';
    switch (type) {
        case 'python': prefix = '```python\n'; suffix = '\n```'; break;
        case 'code': prefix = '```\n'; suffix = '\n```'; break;
        case 'h1': prefix = '# '; break;
        case 'h2': prefix = '## '; break;
        case 'h3': prefix = '### '; break;
        case 'list': prefix = '- '; break;
        case 'bold': prefix = '**'; suffix = '**'; break;
        case 'italic': prefix = '*'; suffix = '*'; break;
    }
    const replacement = prefix + (selected || (type.startsWith('h') ? 'Heading' : 'text')) + suffix;
    textarea.setRangeText(replacement, start, end, 'select');
    textarea.focus();
}

function toggleHistory() {
    document.getElementById('sidebar')?.classList.toggle('visible');
    document.querySelector('.sidebar-overlay')?.classList.toggle('visible');
}

function initCompanionUI() {
    const promptInput = document.getElementById('prompt-input') as HTMLTextAreaElement | null;
    const sendBtn = document.getElementById('send-btn');
    const attachBtn = document.getElementById('attach-btn');
    const clearBtn = document.getElementById('clear-chat-btn');
    const copyBtn = document.getElementById('copy-full-btn');
    const historyBtn = document.getElementById('toggle-history-btn');
    const closeSidebarBtn = document.getElementById('close-sidebar-btn');
    const clearHistoryBtn = document.getElementById('clear-history-btn');
    const overlay = document.querySelector('.sidebar-overlay');

    sendBtn?.addEventListener('click', submitPrompt);
    attachBtn?.addEventListener('click', () => vscode.postMessage({ command: 'toggleAttach' }));
    document.getElementById('companion-context-bar')?.addEventListener('click', () => {
        if (activeFilePath) {
            vscode.postMessage({ command: 'openFile', path: activeFilePath });
        }
    });
    clearBtn?.addEventListener('click', () => {
        activeContentBuffer = '';
        lastHistorySig = '';
        lastAutoFocusedCode = '';
        pendingImages = [];
        renderPendingImages();
        renderEmptyState();
        vscode.postMessage({ command: 'clearActiveChat' });
    });
    copyBtn?.addEventListener('click', () => {
        vscode.postMessage({ command: 'copyToClipboard', text: activeContentBuffer });
    });
    historyBtn?.addEventListener('click', toggleHistory);
    closeSidebarBtn?.addEventListener('click', toggleHistory);
    overlay?.addEventListener('click', toggleHistory);
    clearHistoryBtn?.addEventListener('click', () => vscode.postMessage({ command: 'clearHistory' }));

    const attachImageBtn = document.getElementById('attach-image-btn');
    const companionImageInput = document.getElementById('companion-image-input') as HTMLInputElement | null;
    const companionInputArea = document.getElementById('companion-input-area');

    if (attachImageBtn && companionImageInput) {
        attachImageBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            companionImageInput.click();
        });

        companionImageInput.addEventListener('change', () => {
            addImageFiles(companionImageInput.files);
            companionImageInput.value = '';
        });
    }

    if (companionInputArea) {
        companionInputArea.addEventListener('paste', (e: Event) => {
            handlePasteImages(e as ClipboardEvent);
        });
    }

    window.addEventListener('paste', (e: ClipboardEvent) => {
        const target = e.target as HTMLElement | null;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') && target.id !== 'prompt-input') {
            return;
        }
        handlePasteImages(e);
    });

    ['dragenter', 'dragover'].forEach(evtName => {
        window.addEventListener(evtName, (e: Event) => {
            e.preventDefault();
            e.stopPropagation();
            companionInputArea?.classList.add('drag-over');
        }, { capture: true, passive: false });
    });

    ['dragleave'].forEach(evtName => {
        window.addEventListener(evtName, (e: Event) => {
            e.preventDefault();
            e.stopPropagation();
            if ((e as MouseEvent).relatedTarget === null) {
                companionInputArea?.classList.remove('drag-over');
            }
        }, { capture: true, passive: false });
    });

    window.addEventListener('drop', (e: DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        companionInputArea?.classList.remove('drag-over');
        addImageFiles(e.dataTransfer?.files || null);
    }, { capture: true });

    document.querySelectorAll('.toolbar-tool[data-wrap]').forEach((btn: any) => {
        btn.addEventListener('click', () => wrapText(btn.dataset.wrap));
    });

    const attachImgBtn = document.getElementById('attach-image-btn');
    const imgInput = document.getElementById('companion-image-input') as HTMLInputElement | null;
    attachImgBtn?.addEventListener('click', () => imgInput?.click());
    imgInput?.addEventListener('change', () => {
        addImageFiles(imgInput.files);
        imgInput.value = '';
    });

    const inputArea = document.querySelector('.companion-input-wrapper .input-area') as HTMLElement | null;
    if (inputArea) {
        inputArea.addEventListener('paste', (e: Event) => handlePasteImages(e as ClipboardEvent));
        inputArea.addEventListener('dragover', (e: DragEvent) => {
            e.preventDefault();
            inputArea.classList.add('drag-over');
        });
        inputArea.addEventListener('dragleave', () => inputArea.classList.remove('drag-over'));
        inputArea.addEventListener('drop', (e: DragEvent) => {
            e.preventDefault();
            inputArea.classList.remove('drag-over');
            addImageFiles(e.dataTransfer?.files || null);
        });
    }

    if (promptInput) {
        promptInput.addEventListener('paste', (e: ClipboardEvent) => handlePasteImages(e));
        promptInput.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (!state.isGenerating) submitPrompt();
            } else if (e.key === 'Escape' && state.isGenerating) {
                e.preventDefault();
                vscode.postMessage({ command: 'stopGeneration' });
                setLoadingState(false);
            }
        });
        promptInput.addEventListener('input', () => {
            promptInput.style.height = 'auto';
            promptInput.style.height = `${Math.min(promptInput.scrollHeight, 160)}px`;
        });
    }

    window.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Escape' && state.isGenerating) {
            vscode.postMessage({ command: 'stopGeneration' });
            setLoadingState(false);
        }
    });

    window.addEventListener('message', (event: MessageEvent) => {
        const msg = event.data;
        if (!msg || typeof msg !== 'object') return;

        switch (msg.command) {
            case 'updateContextInfo': {
                const ctxText = document.getElementById('context-info-text');
                if (ctxText) ctxText.textContent = msg.text || 'No active editor';
                if (msg.filePath) {
                    activeFilePath = msg.filePath;
                } else if (msg.text && msg.text !== 'No active editor') {
                    activeFilePath = String(msg.text).split(' (')[0].trim();
                }
                break;
            }
            case 'updateAttachState': {
                const btn = document.getElementById('attach-btn');
                if (btn) {
                    const icon = btn.querySelector('.codicon');
                    btn.classList.toggle('attached', !!msg.isAttached);
                    btn.title = msg.isAttached ? 'Pinned to current file (Click to unpin)' : 'Follow active file (Click to pin)';
                    if (icon) icon.className = `codicon ${msg.isAttached ? 'codicon-pinned' : 'codicon-pin'}`;
                }
                break;
            }
            case 'setLoading':
                setLoadingState(!!msg.isLoading);
                if (!msg.isLoading) {
                    streamingBufferPending = null;
                    const staleStream = document.querySelector(`.message-wrapper[data-message-id='companion_streaming']`);
                    if (staleStream) {
                        staleStream.remove();
                    }
                }
                break;
            case 'updateChat':
                renderChat(msg.history || [], msg.streamingText || '');
                break;
            case 'renderResponse':
                if (msg.text) {
                    renderChat([{ id: 'companion_single', role: 'assistant', content: msg.text }], '');
                } else {
                    renderEmptyState();
                }
                break;
            case 'clearResponse':
                activeContentBuffer = '';
                lastHistorySig = '';
                renderEmptyState();
                break;
            case 'updateHistory': {
                const list = document.getElementById('history-list');
                if (!list) break;
                const items = Array.isArray(msg.history) ? msg.history : [];
                list.innerHTML = items.map((h: any) => {
                    const promptStr = String(h.prompt || '');
                    const shortPrompt = promptStr.length > 55 ? `${promptStr.substring(0, 52)}...` : promptStr;
                    const timeStr = new Date(h.timestamp || Date.now()).toLocaleTimeString();
                    return `
                        <div class="history-item" data-id="${escapeHtml(h.id)}">
                            <div class="history-prompt" title="${escapeHtml(promptStr)}">${escapeHtml(shortPrompt)}</div>
                            <div class="history-actions">
                                <span class="history-time">${escapeHtml(timeStr)}</span>
                                <button type="button" class="delete-btn history-delete-btn" data-id="${escapeHtml(h.id)}" title="Delete">&times;</button>
                            </div>
                        </div>`;
                }).join('');

                list.querySelectorAll('.history-item').forEach((item: any) => {
                    item.addEventListener('click', (e: MouseEvent) => {
                        if ((e.target as HTMLElement).closest('.history-delete-btn')) return;
                        vscode.postMessage({ command: 'loadHistory', id: item.dataset.id });
                        toggleHistory();
                    });
                });
                list.querySelectorAll('.history-delete-btn').forEach((btn: any) => {
                    btn.addEventListener('click', (e: MouseEvent) => {
                        e.stopPropagation();
                        vscode.postMessage({ command: 'deleteHistory', id: btn.dataset.id });
                    });
                });
                break;
            }
            case 'applyAllResult':
                handleApplyAllResult(msg);
                break;
        }
    });

    renderEmptyState();
    vscode.postMessage({ command: 'webview-ready' });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initCompanionUI);
} else {
    initCompanionUI();
}