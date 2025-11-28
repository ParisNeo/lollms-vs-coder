import { dom, vscode, state } from './dom.js';
import { isScrolledToBottom } from './utils.js';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import mermaid from 'mermaid';
import Prism from 'prismjs';

// ... (Imports from @codemirror/view, etc. remain the same) ...
import { EditorView, keymap, drawSelection, highlightSpecialChars, highlightActiveLine, dropCursor } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { 
    search, 
    openSearchPanel, 
    closeSearchPanel, 
    findNext, 
    findPrevious, 
    replaceNext, 
    replaceAll, 
    SearchQuery, 
    setSearchQuery, 
    getSearchQuery,
    highlightSelectionMatches
} from "@codemirror/search";
import { 
    bracketMatching, 
    defaultHighlightStyle, 
    indentOnInput, 
    syntaxHighlighting 
} from "@codemirror/language";

const RENDER_THROTTLE_MS = 200; // Increased to 200ms

// ... (langMap, marked.setOptions, DOMPurify setup, vscodeTheme, minimalSetup remain the same) ...
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
    'json': 'json'
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

const vscodeTheme = EditorView.theme({
    "&": {
        backgroundColor: "var(--vscode-input-background)",
        color: "var(--vscode-input-foreground)",
        border: "1px solid var(--vscode-input-border)",
        borderRadius: "4px",
        height: "auto",
        maxHeight: "500px",
        minHeight: "100px"
    },
    ".cm-content": {
        fontFamily: "var(--vscode-editor-font-family)",
        fontSize: "var(--vscode-editor-font-size)",
        padding: "8px",
        lineHeight: "1.5"
    },
    "&.cm-focused": {
        outline: "1px solid var(--vscode-focusBorder)"
    },
    ".cm-scroller": {
        overflow: "auto"
    },
    ".cm-activeLine": {
        backgroundColor: "transparent" 
    },
    ".cm-searchMatch": {
        backgroundColor: "var(--vscode-editor-findMatchHighlightBackground)",
        border: "1px solid var(--vscode-editor-findMatchHighlightBorder)"
    },
    ".cm-searchMatch.cm-searchMatch-selected": {
        backgroundColor: "var(--vscode-editor-findMatchBackground)",
        border: "1px solid var(--vscode-editor-findMatchBorder)"
    },
    ".cm-selectionMatch": {
        backgroundColor: "var(--vscode-editor-selectionHighlightBackground)"
    },
    ".cm-cursor": {
        borderLeftColor: "var(--vscode-editorCursor-foreground)"
    }
});

// Minimal setup to replace basicSetup from 'codemirror' package
const minimalSetup = [
    highlightActiveLine(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    syntaxHighlighting(defaultHighlightStyle, {fallback: true}),
    bracketMatching(),
    keymap.of([
        ...defaultKeymap,
        ...historyKeymap,
        indentWithTab
    ])
];

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
        // Handle multipart content (images + text)
        textContent = originalContent.map(part => {
            if (part.type === 'text') return part.text;
            // We can't edit image URLs here easily, so we skip or leave placeholder
            return ''; 
        }).join('\n');
    }

    const contentDiv = messageDiv.querySelector('.message-content') as HTMLElement;
    const actionsDiv = messageDiv.querySelector('.message-actions') as HTMLElement;

    if (!contentDiv || !actionsDiv) return;

    const editOverlay = document.createElement('div');
    editOverlay.className = 'edit-overlay';
    
    // --- Search Bar Container ---
    const searchBar = document.createElement('div');
    searchBar.className = 'edit-search-bar';
    
    // --- Row 1: Find ---
    const findRow = document.createElement('div');
    findRow.style.display = 'flex';
    findRow.style.alignItems = 'center';
    findRow.style.gap = '4px';
    findRow.style.width = '100%';

    // Toggle Replace Mode Button
    const toggleReplaceBtn = document.createElement('button');
    toggleReplaceBtn.className = 'edit-search-btn';
    toggleReplaceBtn.innerHTML = '<span class="codicon codicon-chevron-right"></span>';
    toggleReplaceBtn.title = 'Toggle Replace';
    
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'edit-search-input';
    searchInput.placeholder = 'Find...';
    
    const caseBtn = document.createElement('button');
    caseBtn.className = 'edit-search-btn toggle-btn';
    caseBtn.innerHTML = '<span class="codicon codicon-case-sensitive"></span>';
    caseBtn.title = 'Match Case';
    
    const wordBtn = document.createElement('button');
    wordBtn.className = 'edit-search-btn toggle-btn';
    wordBtn.innerHTML = '<span class="codicon codicon-whole-word"></span>';
    wordBtn.title = 'Match Whole Word';

    const searchCount = document.createElement('span');
    searchCount.className = 'edit-search-count';
    searchCount.textContent = '0/0';
    searchCount.style.minWidth = '50px';
    searchCount.style.textAlign = 'center';
    
    const prevBtn = document.createElement('button');
    prevBtn.className = 'edit-search-btn';
    prevBtn.title = 'Previous Match';
    prevBtn.innerHTML = '<span class="codicon codicon-arrow-up"></span>';
    
    const nextBtn = document.createElement('button');
    nextBtn.className = 'edit-search-btn';
    nextBtn.title = 'Next Match';
    nextBtn.innerHTML = '<span class="codicon codicon-arrow-down"></span>';

    findRow.appendChild(toggleReplaceBtn);
    findRow.appendChild(searchInput);
    findRow.appendChild(caseBtn);
    findRow.appendChild(wordBtn);
    findRow.appendChild(searchCount);
    findRow.appendChild(prevBtn);
    findRow.appendChild(nextBtn);

    // --- Row 2: Replace ---
    const replaceRow = document.createElement('div');
    replaceRow.style.display = 'none'; // Hidden by default
    replaceRow.style.alignItems = 'center';
    replaceRow.style.gap = '4px';
    replaceRow.style.width = '100%';
    replaceRow.style.marginTop = '4px';
    replaceRow.style.paddingLeft = '24px'; // Indent to align with inputs

    const replaceInput = document.createElement('input');
    replaceInput.type = 'text';
    replaceInput.className = 'edit-search-input';
    replaceInput.placeholder = 'Replace...';

    const replaceBtn = document.createElement('button');
    replaceBtn.className = 'edit-search-btn';
    replaceBtn.innerHTML = '<span class="codicon codicon-replace"></span>';
    replaceBtn.title = 'Replace';

    const replaceAllBtn = document.createElement('button');
    replaceAllBtn.className = 'edit-search-btn';
    replaceAllBtn.innerHTML = '<span class="codicon codicon-replace-all"></span>';
    replaceAllBtn.title = 'Replace All';

    replaceRow.appendChild(replaceInput);
    replaceRow.appendChild(replaceBtn);
    replaceRow.appendChild(replaceAllBtn);

    searchBar.appendChild(findRow);
    searchBar.appendChild(replaceRow);
    editOverlay.appendChild(searchBar);

    // --- CodeMirror Editor ---
    const editorContainer = document.createElement('div');
    editorContainer.style.width = '100%';
    
    // --- Footer Buttons ---
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
    
    const originalHtml = contentDiv.innerHTML;
    
    contentDiv.innerHTML = '';
    contentDiv.appendChild(editOverlay);
    actionsDiv.style.display = 'none';

    // --- Setup CodeMirror ---
    
    const view = new EditorView({
        state: EditorState.create({
            doc: textContent,
            extensions: [
                minimalSetup,
                markdown(),
                vscodeTheme,
                search({ top: false }), // Enable search functionality
                EditorView.lineWrapping,
                highlightSelectionMatches(),
                EditorView.updateListener.of((update) => {
                    if (update.docChanged || update.selectionSet) {
                        // Defer counting to avoid freezing on every keystroke
                        setTimeout(updateMatchCount, 10); 
                    }
                })
            ]
        }),
        parent: editorContainer
    });
    view.focus();

    // --- State & Handlers ---
    let searchState = {
        caseSensitive: false,
        wholeWord: false
    };

    const updateMatchCount = () => {
        const queryStr = searchInput.value;
        if (!queryStr) {
            searchCount.textContent = '0/0';
            return;
        }

        const searchQuery = new SearchQuery({
            search: queryStr,
            caseSensitive: searchState.caseSensitive,
            wholeWord: searchState.wholeWord
        });
        
        let count = 0;
        let cursor = searchQuery.getCursor(view.state);
        let currentIdx = 0;
        const head = view.state.selection.main.head;
        let foundCurrent = false;

        // Limit counting to avoid freezing on huge files
        const maxCount = 1000; 

        let item = cursor.next();
        while(!item.done) {
            count++;
            if (!foundCurrent && item.value.to >= head) {
                currentIdx = count;
                foundCurrent = true;
            }
            if (count >= maxCount) break;
            item = cursor.next();
        }
        
        const displayCount = count >= maxCount ? `${maxCount}+` : `${count}`;
        
        // If cursor is after the last match
        if (!foundCurrent && count > 0) currentIdx = 0; 
        
        searchCount.textContent = count > 0 ? `${currentIdx || '?'}/${displayCount}` : '0/0';
    };

    const updateSearchEffect = () => {
        const query = searchInput.value;
        if (!query) {
            // Clear search
            view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "", caseSensitive: searchState.caseSensitive, wholeWord: searchState.wholeWord })) });
            searchCount.textContent = '0/0';
            return;
        }

        const searchQuery = new SearchQuery({
            search: query,
            caseSensitive: searchState.caseSensitive,
            wholeWord: searchState.wholeWord,
            replace: replaceInput.value
        });

        view.dispatch({ effects: setSearchQuery.of(searchQuery) });
        updateMatchCount();
    };

    // --- Event Listeners ---

    toggleReplaceBtn.onclick = () => {
        const isHidden = replaceRow.style.display === 'none';
        replaceRow.style.display = isHidden ? 'flex' : 'none';
        toggleReplaceBtn.innerHTML = isHidden ? '<span class="codicon codicon-chevron-down"></span>' : '<span class="codicon codicon-chevron-right"></span>';
    };

    caseBtn.onclick = () => {
        searchState.caseSensitive = !searchState.caseSensitive;
        caseBtn.classList.toggle('active', searchState.caseSensitive);
        updateSearchEffect();
    };

    wordBtn.onclick = () => {
        searchState.wholeWord = !searchState.wholeWord;
        wordBtn.classList.toggle('active', searchState.wholeWord);
        updateSearchEffect();
    };

    searchInput.addEventListener('input', () => updateSearchEffect());
    
    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            if (e.shiftKey) {
                findPrevious(view);
            } else {
                findNext(view);
            }
            view.focus(); // Ensure editor gets focus so highlight is visible
        }
    });

    prevBtn.onclick = () => {
        findPrevious(view);
        view.focus();
    };

    nextBtn.onclick = () => {
        findNext(view);
        view.focus();
    };

    replaceBtn.onclick = () => {
        replaceNext(view);
        view.focus();
    };

    replaceAllBtn.onclick = () => {
        replaceAll(view);
        view.focus();
    };
    
    replaceInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            if (e.shiftKey) replaceAll(view);
            else replaceNext(view);
            view.focus();
        }
    });

    replaceInput.addEventListener('input', () => {
        updateSearchEffect();
    });

    // --- Cleanup & Save ---

    const cleanup = () => {
        view.destroy();
        contentDiv.innerHTML = originalHtml;
        actionsDiv.style.display = '';
        editOverlay.remove();
    };

    saveBtn.onclick = () => {
        const newContent = view.state.doc.toString();
        if (newContent.trim() !== textContent.trim()) {
            messageDiv.dataset.originalContent = JSON.stringify(newContent);
            vscode.postMessage({
                command: 'updateMessage',
                messageId: messageId,
                newContent: newContent
            });
        }
        cleanup();
    };

    cancelBtn.onclick = cleanup;
}

function enhanceCodeBlocks(container: HTMLElement) {
    const pres = container.querySelectorAll('pre');
    pres.forEach(pre => {
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

        if (state.isInspectorEnabled) {
            const inspectBtn = createButton('Inspect', 'codicon-search', () => {
                vscode.postMessage({ command: 'inspectCode', code: codeText, language: language });
            });
            actions.appendChild(inspectBtn);
        }

        // --- Special Logic Detection ---
        const prevEl = pre.previousElementSibling as HTMLElement;
        let filePath = '';
        let isFileBlock = false;

        // Improved Regex
        const fileRegex = /(?:^|\n)(?:File:\s*|(?:\*\*|__)File:(?:\*\*|__)\s*)([^\n]+)(?:\s*|$)/i;

        if (prevEl && (prevEl.tagName === 'P' || prevEl.tagName === 'DIV')) {
             const text = prevEl.textContent || "";
             const match = text.match(fileRegex);
             if (match && match[1]) {
                 filePath = match[1].trim().replace(/`/g, '');
                 isFileBlock = true;
             }
        }

        let isDiff = language === 'diff';
        let diffFilePath = '';
        const diffRegex = /(?:^|\n)(?:Diff:\s*|(?:\*\*|__)Diff:(?:\*\*|__)\s*)([^\n]+)(?:\s*|$)/i;

        if (!isFileBlock && prevEl && (prevEl.tagName === 'P' || prevEl.tagName === 'DIV')) {
             const text = prevEl.textContent || "";
             const match = text.match(diffRegex);
             if (match && match[1]) {
                 diffFilePath = match[1].trim().replace(/`/g, '');
                 isDiff = true;
             }
        }
        
        if (!isDiff && !isFileBlock) {
            const diffHeaderMatch = codeText.match(/---\s+a\/(.+)\n\+\+\+\s+b\/(.+)/);
            if (diffHeaderMatch && diffHeaderMatch[1]) {
                diffFilePath = diffHeaderMatch[1].trim();
                isDiff = true;
            }
        }

        // --- Add Contextual Buttons ---

        if (isFileBlock && filePath) {
            langLabel.textContent = `${language} : ${filePath}`;
            prevEl.style.display = 'none'; 
            
            const applyBtn = createButton('Apply to File', 'codicon-tools', () => {
                vscode.postMessage({ command: 'applyFileContent', filePath: filePath, content: codeText });
            }, 'code-action-btn apply-btn');
            
            if (actions.firstChild) actions.insertBefore(applyBtn, actions.firstChild);
            else actions.appendChild(applyBtn);

        } else if (isDiff) {
            const path = diffFilePath || 'patch';
            langLabel.textContent = `${language} : Diff: ${path}`;
            if(prevEl && prevEl.textContent?.match(diffRegex)) prevEl.style.display = 'none';
            
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

        if (isFinal) {
            enhanceWithCommandButtons(wrapper as HTMLElement);
            enhanceCodeBlocks(wrapper as HTMLElement);
        }
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


