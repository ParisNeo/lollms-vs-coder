import { dom, state } from './dom.js';

export function clearSearch() {
    state.searchMatches = [];
    state.currentMatchIndex = -1;

    // Remove all existing marks cleanly by replacing them with their text node
    const marks = document.querySelectorAll('mark.search-highlight');
    marks.forEach(mark => {
        const parent = mark.parentNode;
        if (parent) {
            const textNode = document.createTextNode(mark.textContent || '');
            parent.replaceChild(textNode, mark);
            parent.normalize(); // Merge adjacent text nodes
        }
    });

    updateSearchCount();
}

export function performSearch(options?: { includeCode?: boolean }) {
    clearSearch();

    const input = (document.getElementById('hud-search-input') || dom.searchInput) as HTMLInputElement;
    const query = (input?.value || "").trim();

    if (!query || query.length === 0) {
        updateSearchCount();
        return;
    }

    const container = document.getElementById('messages') || dom.messagesDiv || dom.chatMessagesContainer;
    if (!container) return;

    // Escaped regex for safe searching
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${escaped})`, 'gi');

    // Default: search discussion text/prose only (exclude code blocks and file mutations)
    const includeCode = options?.includeCode !== undefined ? options.includeCode : (state.searchScope === 'all');

    // 1. Gather text nodes inside discussion messages
    const textNodes: Text[] = [];
    const walker = document.createTreeWalker(
        container,
        NodeFilter.SHOW_TEXT,
        {
            acceptNode: (node: Node) => {
                const parent = node.parentElement;
                if (!parent) return NodeFilter.FILTER_REJECT;

                // Skip tags that should not have visual text highlighting
                const tagName = parent.tagName.toLowerCase();
                if (['script', 'style', 'textarea', 'input', 'select', 'button'].includes(tagName)) {
                    return NodeFilter.FILTER_REJECT;
                }
                if (parent.closest('.code-line-gutter, #search-bar, .hud-search-container, .message-actions, .apply-results-list, .diagram-container, .token-legend')) {
                    return NodeFilter.FILTER_REJECT;
                }
                // When searching in discussion only (default), exclude code and file blocks
                if (!includeCode && parent.closest('.code-collapsible, .file-mutation-card, .aider-diff-container, .aider-hunk-content, pre code, .code-actions')) {
                    return NodeFilter.FILTER_REJECT;
                }
                if (parent.classList.contains('search-highlight')) {
                    return NodeFilter.FILTER_REJECT;
                }

                if (node.nodeValue && regex.test(node.nodeValue)) {
                    regex.lastIndex = 0;
                    return NodeFilter.FILTER_ACCEPT;
                }

                return NodeFilter.FILTER_SKIP;
            }
        }
    );

    let currentNode: Node | null;
    while ((currentNode = walker.nextNode())) {
        textNodes.push(currentNode as Text);
    }

    // 2. Safely highlight matches by splitting text nodes (Zero innerHTML corruption)
    const matches: HTMLElement[] = [];

    textNodes.forEach(textNode => {
        const parent = textNode.parentNode;
        if (!parent) return;

        const val = textNode.nodeValue || '';
        regex.lastIndex = 0;

        let match: RegExpExecArray | null;
        let lastIdx = 0;
        const fragment = document.createDocumentFragment();

        while ((match = regex.exec(val)) !== null) {
            // Text before match
            if (match.index > lastIdx) {
                fragment.appendChild(document.createTextNode(val.substring(lastIdx, match.index)));
            }

            // The highlighted match
            const mark = document.createElement('mark');
            mark.className = 'search-highlight';
            mark.textContent = match[0];
            fragment.appendChild(mark);
            matches.push(mark);

            lastIdx = regex.lastIndex;
        }

        // Remaining text after last match
        if (lastIdx < val.length) {
            fragment.appendChild(document.createTextNode(val.substring(lastIdx)));
        }

        parent.replaceChild(fragment, textNode);
    });

    state.searchMatches = matches;

    if (state.searchMatches.length > 0) {
        state.currentMatchIndex = 0;
        highlightCurrentMatch();
    } else {
        state.currentMatchIndex = -1;
    }

    updateSearchCount();
}

export function navigateSearch(direction: number) {
    if (state.searchMatches.length === 0) return;

    state.currentMatchIndex += direction;

    if (state.currentMatchIndex >= state.searchMatches.length) {
        state.currentMatchIndex = 0;
    } else if (state.currentMatchIndex < 0) {
        state.currentMatchIndex = state.searchMatches.length - 1;
    }

    highlightCurrentMatch();
    updateSearchCount();
}

function highlightCurrentMatch() {
    state.searchMatches.forEach((m, idx) => {
        const isCurrent = idx === state.currentMatchIndex;
        m.classList.toggle('current-match', isCurrent);
        if (isCurrent) {
            // Recursively auto-expand any collapsed parent details/accordions
            let parentDetails = m.closest('details');
            while (parentDetails) {
                if (!parentDetails.open) {
                    parentDetails.open = true;
                }
                parentDetails = parentDetails.parentElement ? parentDetails.parentElement.closest('details') : null;
            }

            m.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    });
}

export function updateSearchCount() {
    const counts = [
        document.getElementById('hud-search-count'),
        dom.searchResultsCount
    ].filter(Boolean) as HTMLElement[];

    const input = (document.getElementById('hud-search-input') || dom.searchInput) as HTMLInputElement;
    const hasQuery = Boolean(input && input.value.trim());

    counts.forEach(el => {
        if (state.searchMatches.length > 0) {
            el.textContent = `${state.currentMatchIndex + 1}/${state.searchMatches.length}`;
            el.style.opacity = '1';
        } else {
            el.textContent = hasQuery ? '0/0' : '';
            el.style.opacity = '0.5';
        }
    });
}