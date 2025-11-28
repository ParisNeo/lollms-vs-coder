// Define the API interface
export interface VsCodeApi {
    postMessage(message: any): void;
    getState(): any;
    setState(state: any): void;
}

// Robust API Accessor using Proxy
export const vscode = new Proxy({} as VsCodeApi, {
    get: (target, prop) => {
        const api = (window as any).vscode;
        if (api) {
            const value = api[prop as keyof VsCodeApi];
            if (typeof value === 'function') {
                return value.bind(api);
            }
            return value;
        }
        console.error(`CRITICAL: VS Code API '${String(prop)}' accessed but 'window.vscode' is missing. Check bootstrap.`);
        // Return no-op to prevent crash
        return () => console.warn(`Ignored call to ${String(prop)} because API is missing.`);
    }
});

export const state: {
    searchMatches: HTMLElement[],
    currentMatchIndex: number,
    isInspectorEnabled: boolean,
    streamingMessages: { [key: string]: { buffer: string, timer: any } },
} = {
    searchMatches: [],
    currentMatchIndex: -1,
    isInspectorEnabled: false,
    streamingMessages: {},
};

export const dom = {
    get messagesDiv() { return document.getElementById('messages') as HTMLDivElement; },
    get chatMessagesContainer() { return document.getElementById('chat-messages-container') as HTMLDivElement; },
    get messageInput() { return document.getElementById('messageInput') as HTMLTextAreaElement; },
    get sendButton() { return document.getElementById('sendButton') as HTMLButtonElement; },
    get stopButton() { return document.getElementById('stopButton') as HTMLButtonElement; },
    get moreActionsButton() { return document.getElementById('moreActionsButton') as HTMLButtonElement; },
    get moreActionsMenu() { return document.getElementById('more-actions-menu') as HTMLDivElement; },
    get attachButton() { return document.getElementById('attachButton') as HTMLButtonElement; },
    get copyFullPromptButton() { return document.getElementById('copyFullPromptButton') as HTMLButtonElement; },
    get executeButton() { return document.getElementById('executeButton') as HTMLButtonElement; },
    get setEntryPointButton() { return document.getElementById('setEntryPointButton') as HTMLButtonElement; },
    get debugRestartButton() { return document.getElementById('debugRestartButton') as HTMLButtonElement; },
    get showDebugLogButton() { return document.getElementById('showDebugLogButton') as HTMLButtonElement; },
    get fileInput() { return document.getElementById('fileInput') as HTMLInputElement; },
    get agentModeCheckbox() { return document.getElementById('agentModeCheckbox') as HTMLInputElement; },
    get agentModeToggle() { return document.querySelector('.agent-mode-toggle') as HTMLLabelElement; },
    get modelSelector() { return document.getElementById('model-selector') as HTMLSelectElement; },
    get contextContainer() { return document.getElementById('context-container') as HTMLDivElement; },
    get attachmentsContainer() { return document.getElementById('attachments-container') as HTMLDivElement; },
    get welcomeMessage() { return document.getElementById('welcome-message') as HTMLDivElement; },
    get scrollToBottomBtn() { return document.getElementById('scrollToBottomBtn') as HTMLButtonElement; },
    get tokenProgressBar() { return document.getElementById('token-progress-bar') as HTMLDivElement; },
    get tokenProgressContainer() { return document.querySelector('.token-progress-container') as HTMLDivElement; },
    get tokenCountLabel() { return document.getElementById('token-count-label') as HTMLSpanElement; },
    get refreshContextBtn() { return document.getElementById('refresh-context-btn') as HTMLButtonElement; },
    get contextStatusContainer() { return document.getElementById('context-status-container') as HTMLDivElement; },
    get contextLoadingSpinner() { return document.getElementById('context-loading-spinner') as HTMLDivElement; },
    get searchBar() { return document.getElementById('search-bar') as HTMLDivElement; },
    get searchInput() { return document.getElementById('searchInput') as HTMLInputElement; },
    get searchResultsCount() { return document.getElementById('search-results-count') as HTMLSpanElement; },
    get searchPrevBtn() { return document.getElementById('search-prev') as HTMLButtonElement; },
    get searchNextBtn() { return document.getElementById('search-next') as HTMLButtonElement; },
    get searchCloseBtn() { return document.getElementById('search-close') as HTMLButtonElement; },
    get configureToolsButton() { return document.getElementById('configureToolsButton') as HTMLButtonElement; },
    get toolsModal() { return document.getElementById('tools-modal') as HTMLDivElement; },
    get closeToolsModal() { return document.getElementById('close-tools-modal') as HTMLSpanElement; },
    get saveToolsBtn() { return document.getElementById('save-tools-btn') as HTMLButtonElement; },
    get toolsListDiv() { return document.getElementById('tools-list') as HTMLDivElement; },
    get addUserMessageBtn() { return document.getElementById('add-user-message-btn') as HTMLButtonElement; },
    get addAiMessageBtn() { return document.getElementById('add-ai-message-btn') as HTMLButtonElement; },
    get copyContextButton() { return document.getElementById('copyContextButton') as HTMLButtonElement; },
    get statusLabel() { return document.getElementById('status-label') as HTMLDivElement; },
    get statusText() { return document.getElementById('status-text') as HTMLSpanElement; },
    get statusSpinner() { return document.getElementById('status-spinner') as HTMLDivElement; },
    get tokenCountingOverlay() { return document.getElementById('token-counting-overlay') as HTMLDivElement; },
    get tokenCountingText() { return document.querySelector('#token-counting-overlay span') as HTMLSpanElement; },
    get inputAreaWrapper() { return document.querySelector('.input-area-wrapper') as HTMLDivElement; },
};
