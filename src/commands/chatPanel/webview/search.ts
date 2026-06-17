import { dom, state } from './dom.js';

export function clearSearch() {
    state.searchMatches = [];
    state.currentMatchIndex = -1;
    document.querySelectorAll('mark').forEach(mark => {
        if(mark.parentNode) {
            const textNode = document.createTextNode(mark.textContent || '');
            mark.parentNode.replaceChild(textNode, mark);
        }
    });
    updateSearchCount();
}

export function performSearch() {
    const query = dom.searchInput.value.trim();
    if (!query) {
        clearSearch();
        return;
    }

    // Save query to detect changes
    dom.searchInput.dataset.lastQuery = query;

    clearSearch();

    const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${escapedQuery})`, 'gi');

    // Select all message wrappers to search across the entire discussion pane
    document.querySelectorAll('.message-content').forEach(content => {
        const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, {
            acceptNode: node => {
                let parent = node.parentElement;
                while (parent) {
                    // Ignore search inside inputs, textareas, active editor components, and script elements
                    const isInputContainer = ['INPUT', 'TEXTAREA', 'SCRIPT', 'STYLE'].includes(parent.tagName) || 
                                             parent.classList.contains('cm-editor') ||
                                             parent.classList.contains('message-actions');
                    if (isInputContainer) {
                        return NodeFilter.FILTER_REJECT;
                    }
                    parent = parent.parentElement;
                }
                return NodeFilter.FILTER_ACCEPT;
            }
        });

        let node;
        while (node = walker.nextNode()) {
            if (node.nodeValue) {
                const fragments = node.nodeValue.split(regex);
                if (fragments.length > 1) {
                    const fragment = document.createDocumentFragment();
                    for (let i = 0; i < fragments.length; i++) {
                        if (i % 2 === 0) {
                            if (fragments[i]) fragment.appendChild(document.createTextNode(fragments[i]));
                        } else {
                            const mark = document.createElement('mark');
                            mark.appendChild(document.createTextNode(fragments[i]));
                            fragment.appendChild(mark);
                            state.searchMatches.push(mark);
                        }
                    }
                    node.parentNode?.replaceChild(fragment, node);
                }
            }
        }
    });

    if (state.searchMatches.length > 0) {
        state.currentMatchIndex = 0;
        updateMatchState();
    }
    updateSearchCount();
}

/**
 * Updates active highlighting and handles smooth scrolling to current search match
 */
function updateMatchState() {
    state.searchMatches.forEach(m => m.classList.remove('current-match'));
    if (state.currentMatchIndex >= 0 && state.currentMatchIndex < state.searchMatches.length) {
        const current = state.searchMatches[state.currentMatchIndex];
        current.classList.add('current-match');
        current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

export function navigateSearch(direction: number) {
    if (state.searchMatches.length === 0) return;

    state.currentMatchIndex += direction;
    if (state.currentMatchIndex >= state.searchMatches.length) state.currentMatchIndex = 0;
    if (state.currentMatchIndex < 0) state.currentMatchIndex = state.searchMatches.length - 1;

    updateMatchState();
    updateSearchCount();
}

function updateSearchCount() {
    if(dom.searchResultsCount) {
        dom.searchResultsCount.textContent = state.searchMatches.length > 0
            ? `${state.currentMatchIndex + 1} of ${state.searchMatches.length}`
            : '';
    }
}
