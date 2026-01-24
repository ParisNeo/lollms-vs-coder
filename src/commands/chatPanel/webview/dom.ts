import { EditorView } from "@codemirror/view";

// ... VsCodeApi definition ...
export interface VsCodeApi {
    postMessage(message: any): void;
    getState(): any;
    setState(state: any): void;
}

// ... vscode proxy ...
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
        return () => console.warn(`Ignored call to ${String(prop)} because API is missing.`);
    }
});

export interface DiscussionCapabilities {
    codeGenType: 'full' | 'diff' | 'none';
    allowedFormats: {
        fullFile: boolean;
        insert: boolean;
        replace: boolean;
        delete: boolean;
    };
    fileRename: boolean;
    fileDelete: boolean;
    fileSelect: boolean;
    fileReset: boolean;
    imageGen: boolean;
    webSearch: boolean;
    arxivSearch: boolean;
    funMode: boolean;
    thinkingMode: string;
    // gitCommit removed
    gitWorkflow: boolean;
    herdMode: boolean;
    herdDynamicMode: boolean;
    herdParticipants: any[];
    herdPreCodeParticipants: any[];
    herdPostCodeParticipants: any[];
    herdRounds: number;
    agentMode: boolean;
    autoContextMode: boolean;
    guiState?: {
        agentBadge: boolean;
        autoContextBadge: boolean;
        herdBadge: boolean;
    };
}

// ... state object ...
export const state: {
    searchMatches: HTMLElement[],
    currentMatchIndex: number,
    isInspectorEnabled: boolean,
    streamingMessages: { [key: string]: { buffer: string, timer: any } },
    isGenerating: boolean,
    capabilities: DiscussionCapabilities | null,
    currentBranch: string,
    currentPersonalityId: string,
    personalities: any[]
} = {
    searchMatches: [],
    currentMatchIndex: -1,
    isInspectorEnabled: false,
    streamingMessages: {},
    isGenerating: false,
    capabilities: null,
    currentBranch: '',
    currentPersonalityId: 'default_coder',
    personalities: []
};

// ... dom object ...
export const dom = {
    get personalitySelector() { return document.getElementById('personality-selector') as HTMLSelectElement; },
    get messagesDiv() { return document.getElementById('messages') as HTMLDivElement; },
    get chatMessagesContainer() { return document.getElementById('chat-messages-container') as HTMLDivElement; },
    get agentPlanZone() { return document.getElementById('agent-plan-zone') as HTMLDivElement; }, // NEW
    get webSearchIndicator() { return document.getElementById('websearch-indicator') as HTMLDivElement; },
    get messageInput() { return document.getElementById('messageInput') as HTMLTextAreaElement; },
    get sendButton() { return document.getElementById('sendButton') as HTMLButtonElement; },
    get stopButton() { return document.getElementById('stopButton') as HTMLButtonElement; },
    get moreActionsButton() { return document.getElementById('moreActionsButton') as HTMLButtonElement; },
    get moreActionsMenu() { return document.getElementById('more-actions-menu') as HTMLDivElement; },
    get attachButton() { return document.getElementById('attachButton') as HTMLButtonElement; },
    get importSkillsButton() { return document.getElementById('importSkillsButton') as HTMLButtonElement; },
    get copyFullPromptButton() { return document.getElementById('copyFullPromptButton') as HTMLButtonElement; },
    get executeButton() { return document.getElementById('executeButton') as HTMLButtonElement; },
    get setEntryPointButton() { return document.getElementById('setEntryPointButton') as HTMLButtonElement; },
    get debugRestartButton() { return document.getElementById('debugRestartButton') as HTMLButtonElement; },
    get showDebugLogButton() { return document.getElementById('showDebugLogButton') as HTMLButtonElement; },
    get fileInput() { return document.getElementById('fileInput') as HTMLInputElement; },
    
    // Updated Selectors for New Menu
    get agentModeCheckbox() { return document.getElementById('agentModeCheckbox') as HTMLInputElement; },
    get autoContextCheckbox() { return document.getElementById('autoContextCheckbox') as HTMLInputElement; },
    get herdModeCheckbox() { return document.getElementById('herdModeCheckbox') as HTMLInputElement; },
    get activeBadges() { return document.getElementById('active-badges') as HTMLDivElement; },
    
    // Submenu Triggers
    get subMenuTriggers() { return document.querySelectorAll('.has-submenu'); },
    get backButtons() { return document.querySelectorAll('.back-btn'); },
    
    get modelSelector() { return document.getElementById('model-selector') as HTMLSelectElement; },
    get refreshModelsBtn() { return document.getElementById('refresh-models-btn') as HTMLButtonElement; },
    get contextContainer() { return document.getElementById('context-container') as HTMLDivElement; },
    get attachmentsContainer() { return document.getElementById('attachments-container') as HTMLDivElement; },
    get welcomeMessage() { return document.getElementById('welcome-message') as HTMLDivElement; },
    get scrollToBottomBtn() { return document.getElementById('scrollToBottomBtn') as HTMLButtonElement; },
    get tokenProgressBar() { return document.getElementById('token-progress-bar') as HTMLDivElement; },
    get tokenProgressContainer() { return document.querySelector('.token-progress-container') as HTMLDivElement; },
    get tokenCountLabel() { return document.getElementById('token-count-label') as HTMLSpanElement; },
    get refreshContextBtn() { return document.getElementById('refresh-context-btn') as HTMLButtonElement; },
    get cancelTokensBtn() { return document.getElementById('cancel-tokens-btn') as HTMLButtonElement; },
    get contextStatusContainer() { return document.getElementById('context-status-container') as HTMLDivElement; },
    get contextLoadingSpinner() { return document.getElementById('context-loading-spinner') as HTMLDivElement; },
    get searchBar() { return document.getElementById('search-bar') as HTMLDivElement; },
    get searchInput() { return document.getElementById('searchInput') as HTMLInputElement; },
    get searchResultsCount() { return document.getElementById('search-results-count') as HTMLSpanElement; },
    get searchPrevBtn() { return document.getElementById('search-prev') as HTMLButtonElement; },
    get searchNextBtn() { return document.getElementById('search-next') as HTMLButtonElement; },
    get searchCloseBtn() { return document.getElementById('search-close') as HTMLButtonElement; },
    get agentToolsButton() { return document.getElementById('agentToolsButton') as HTMLButtonElement; },
    get discussionToolsButton() { return document.getElementById('discussionToolsButton') as HTMLButtonElement; },
    get toolsModal() { return document.getElementById('tools-modal') as HTMLDivElement; },
    get discussionToolsModal() { return document.getElementById('discussion-tools-modal') as HTMLDivElement; },
    get closeToolsModal() { return document.getElementById('close-tools-modal') as HTMLSpanElement; },
    get closeDiscussionToolsModal() { return document.getElementById('close-discussion-tools-modal') as HTMLSpanElement; },
    get saveToolsBtn() { return document.getElementById('save-tools-btn') as HTMLButtonElement; },
    get saveDiscussionToolsBtn() { return document.getElementById('save-discussion-tools-btn') as HTMLButtonElement; },
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
    get inputArea() { return document.querySelector('.input-area') as HTMLDivElement; },
    get generatingOverlay() { return document.getElementById('generating-overlay') as HTMLDivElement; },
    get activeToolsIndicator() { return document.getElementById('active-tools-indicator') as HTMLDivElement; },
    
    // Discussion Capabilities Inputs
    // Code Gen Type Radios
    get radioCodeGenFull() { return document.querySelector('input[name="codeGenType"][value="full"]') as HTMLInputElement; },
    get radioCodeGenDiff() { return document.querySelector('input[name="codeGenType"][value="diff"]') as HTMLInputElement; },
    get radioCodeGenNone() { return document.querySelector('input[name="codeGenType"][value="none"]') as HTMLInputElement; },
    
    // FORMATS
    get fmtFullFile() { return document.getElementById('fmt-fullFile') as HTMLInputElement; },
    get fmtInsert() { return document.getElementById('fmt-insert') as HTMLInputElement; },
    get fmtReplace() { return document.getElementById('fmt-replace') as HTMLInputElement; },
    get fmtDelete() { return document.getElementById('fmt-delete') as HTMLInputElement; },

    // File Tools
    get capFileRename() { return document.getElementById('cap-fileRename') as HTMLInputElement; },
    get capFileDelete() { return document.getElementById('cap-fileDelete') as HTMLInputElement; },

    get capFileSelect() { return document.getElementById('cap-fileSelect') as HTMLInputElement; },
    get capFileReset() { return document.getElementById('cap-fileReset') as HTMLInputElement; },

    // Capabilities
    get capImageGen() { return document.getElementById('cap-imageGen') as HTMLInputElement; },
    get capWebSearch() { return document.getElementById('cap-webSearch') as HTMLInputElement; },
    get capArxivSearch() { return document.getElementById('cap-arxivSearch') as HTMLInputElement; },
    get capGitWorkflow() { return document.getElementById('cap-gitWorkflow') as HTMLInputElement; },
    get capGitWorkflowContainer() { return document.getElementById('cap-gitWorkflowContainer') as HTMLDivElement; },

    get modeFunMode() { return document.getElementById('mode-funMode') as HTMLInputElement; },
    get modeHeavyCot() { return document.getElementById('mode-heavyCot') as HTMLInputElement; },
    get capThinkingMode() { return document.getElementById('cap-thinkingMode') as HTMLSelectElement; },
    get inputAreaWrapperDiv() { return document.querySelector('.input-area-wrapper') as HTMLDivElement; },

    // Herd Mode Config (In Modal)
    get capHerdMode() { return document.getElementById('cap-herdMode') as HTMLInputElement; },
    get capHerdRounds() { return document.getElementById('cap-herdRounds') as HTMLInputElement; },
    get herdConfigSection() { return document.getElementById('herd-config-section') as HTMLDivElement; },
    get herdModelsList() { return document.getElementById('herd-models-list') as HTMLDivElement; },

    // Git Menu
    get gitBadgeWrapper() { return document.getElementById('git-badge-wrapper') as HTMLDivElement; },
    get gitMenu() { return document.getElementById('git-menu') as HTMLDivElement; },
    get gitMenuCommit() { return document.getElementById('git-menu-commit') as HTMLDivElement; },
    get gitMenuBranch() { return document.getElementById('git-menu-branch') as HTMLDivElement; },
    get gitMenuMerge() { return document.getElementById('git-menu-merge') as HTMLDivElement; },
    get gitMenuRevert() { return document.getElementById('git-menu-revert') as HTMLDivElement; },

    // Staging Modal (NEW)
    get stagingModal() { return document.getElementById('staging-modal') as HTMLDivElement; },
    get stagingList() { return document.getElementById('staging-list') as HTMLDivElement; },
    get stagingNextBtn() { return document.getElementById('staging-next-btn') as HTMLButtonElement; },
    get stagingCloseBtn() { return document.getElementById('staging-close-btn') as HTMLSpanElement; },

    // Commit Modal
    get commitModal() { return document.getElementById('commit-modal') as HTMLDivElement; },
    get commitMessageInput() { return document.getElementById('commit-message-input') as HTMLTextAreaElement; },
    get commitConfirmBtn() { return document.getElementById('commit-confirm-btn') as HTMLButtonElement; },
    get commitCancelBtn() { return document.getElementById('commit-cancel-btn') as HTMLButtonElement; },

    // History Modal
    get historyModal() { return document.getElementById('history-modal') as HTMLDivElement; },
    get historyList() { return document.getElementById('history-list') as HTMLDivElement; },
    get historyCloseBtn() { return document.getElementById('history-close-btn') as HTMLButtonElement; }
};
