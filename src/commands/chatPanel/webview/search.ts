import { dom } from './dom.js';
import { state } from './main.js';

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
    clearSearch();
    if (!query) {
        return;
    }

    const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${escapedQuery})`, 'gi');

    document.querySelectorAll('.message-content').forEach(content => {
        const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, {
            acceptNode: node => {
                let parent = node.parentElement;
                while (parent) {
                    if (['CODE', 'PRE', 'SCRIPT', 'STYLE'].includes(parent.tagName)) {
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
                            if(fragments[i]) fragment.appendChild(document.createTextNode(fragments[i]));
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
        navigateSearch(1);
    }
    updateSearchCount();
}

export function navigateSearch(direction: number) {
    if (state.searchMatches.length === 0) return;

    if (state.currentMatchIndex >= 0) {
        state.searchMatches[state.currentMatchIndex].classList.remove('current-match');
    }

    state.currentMatchIndex += direction;
    if (state.currentMatchIndex >= state.searchMatches.length) state.currentMatchIndex = 0;
    if (state.currentMatchIndex < 0) state.currentMatchIndex = state.searchMatches.length - 1;

    const currentMatch = state.searchMatches[state.currentMatchIndex];
    currentMatch.classList.add('current-match');
    currentMatch.scrollIntoView({ behavior: 'smooth', block: 'center' });

    updateSearchCount();
}

function updateSearchCount() {
    dom.searchResultsCount.textContent = state.searchMatches.length > 0
        ? `${state.currentMatchIndex + 1} of ${state.searchMatches.length}`
        : '';
}
