import { EditorView } from "@codemirror/view";

export interface VsCodeApi {
    postMessage(message: any): void;
    getState(): any;
    setState(state: any): void;
}

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

export interface ResponseProfile {
    id: string;
    name: string;
    description: string;
    systemPrompt: string;
    prefix?: string;
}

export interface DiscussionCapabilities {
    generationFormats: {
        fullFile: boolean;
        diff: boolean;
        aider: boolean;
    };
    allowedFormats: {
        fullFile: boolean;
        insert: boolean;
        replace: boolean;
        delete: boolean;
    };
    responseProfileId: string;
    language: string;
    voice: string;
    explainCode: boolean;
    fileRename: boolean;
    fileDelete: boolean;
    fileSelect: boolean;
    fileReset: boolean;
    imageGen: boolean;
    enableTTS: boolean;
    enableSTT: boolean;
    webSearch: boolean;
    distillWebResults: boolean;
    antiPromptInjection: boolean;
    searchInCacheFirst: boolean;
    searchSources: {
        google: boolean;
        arxiv: boolean;
        wikipedia: boolean;
        stackoverflow: boolean;
        youtube: boolean;
        github: boolean;
    };
    gitWorkflow: boolean;
    herdMode: boolean;
    herdParallelGeneration: boolean;
    thinkingMode: boolean;
    thinkingBudget?: number;
    herdOrchestratorModel?: string;
    herdParticipantModels?: string[];
    herdCriticEnabled?: boolean;
    agentMode: boolean;
    debugMode: boolean;
    verifierMode: boolean;
    maxDebugSteps: number;
    autoFix: boolean;
    autoBranch: boolean;
    maxFixRetries: number;
    autoApply: boolean;
    autoContextMode: boolean;
    autoSkillMode: boolean;
    autoToolMode: boolean;
    disableProjectContext: boolean;
    ttftTimeout: number;
    interTokenTimeout: number;
    selectedFolders?: string[];
    folderSettings?: Record<string, { tree: boolean, content: boolean }>;
    contextAggression: 'respect' | 'none' | 'minimal' | 'signatures';
    clipboardInsertRole: 'user' | 'assistant';
    guiState?: {
        agentBadge: boolean;
        debugBadge: boolean;
        autoContextBadge: boolean;
        herdBadge: boolean;
        webSearchBadge?: boolean;
        autoSkillBadge?: boolean;
    };
}

export const state: {
    searchMatches: HTMLElement[],
    currentMatchIndex: number,
    isInspectorEnabled: boolean,
    streamingMessages: { [key: string]: { buffer: string, timer: any } },
    isGenerating: boolean,
    appliedState: Record<string, Record<number, number[]>>, // Persistent applied hunks
    matrixStats: Record<string, { tree: number, files: number }>, // Per-folder token stats
    usageData: { project: any[], extra: any[] },
    currentUsageSort: { column: 'name' | 'tokens', direction: 'asc' | 'desc' },
    lastContextData: { context: string, files: string[], skills: any[], tools: any[], diagrams: any[], briefing: string, skillIds?: string[] } | null,
    capabilities: DiscussionCapabilities | null,
    currentBranch: string,
    lastCommitHash: string,
    currentPersonalityId: string,
    currentModelName: string,
    personalities: [],
    agentProfiles: [],
    profiles: [],
    pendingImages: []
} = {
    searchMatches: [],
    currentMatchIndex: -1,
    isInspectorEnabled: false,
    streamingMessages: {},
    isGenerating: false,
    appliedState: {},
    usageData: { project: [], extra: [] },
    currentUsageSort: { column: 'tokens', direction: 'desc' }, // Default to biggest first
    lastContextData: null,
    capabilities: null,
    currentBranch: '',
    lastCommitHash: '',
    currentPersonalityId: 'default_coder',
    currentModelName: 'Loading...',
    personalities: [],
    profiles: [],
    pendingImages: []
};

export const dom = {
    get personalitySelector() { return document.getElementById('personality-selector') as HTMLSelectElement; },
    get messagesDiv() { return document.getElementById('messages') as HTMLDivElement; },
    get chatMessagesContainer() { return document.getElementById('chat-messages-container') as HTMLDivElement; },
    get agentPlanZone() { return document.getElementById('agent-plan-zone') as HTMLDivElement; },
    get planResizer() { return document.getElementById('plan-resizer') as HTMLDivElement; },
    get chatContentWrapper() { return document.querySelector('.chat-content-wrapper') as HTMLDivElement; },
    get thinkingIndicator() { return document.getElementById('thinking-indicator') as HTMLDivElement; },
    get webSearchIndicator() { return document.getElementById('websearch-indicator') as HTMLDivElement; },
    get messageInput() { return document.getElementById('messageInput') as HTMLTextAreaElement; },
    get sendButton() { return document.getElementById('sendButton') as HTMLButtonElement; },
    get stopButton() { return document.getElementById('stopButton') as HTMLButtonElement; },
    get moreActionsButton() { return document.getElementById('moreActionsButton') as HTMLButtonElement; },
    get moreActionsMenu() { return document.getElementById('more-actions-menu') as HTMLDivElement; },
    get attachButton() { return document.getElementById('attachButton') as HTMLButtonElement; },
    get importSkillsButton() { return document.getElementById('importSkillsButton') as HTMLButtonElement; },
    get copyFullPromptButton() { return document.getElementById('copyFullPromptButton') as HTMLButtonElement; },
    get copySystemPromptButton() { return document.getElementById('copySystemPromptButton') as HTMLButtonElement; },
    get copyTreeAndContentButton() { return document.getElementById('copyTreeAndContentButton') as HTMLButtonElement; },
    get executeButton() { return document.getElementById('executeButton') as HTMLButtonElement; },
    get setEntryPointButton() { return document.getElementById('setEntryPointButton') as HTMLButtonElement; },
    get debugRestartButton() { return document.getElementById('debugRestartButton') as HTMLButtonElement; },
    get showDebugLogButton() { return document.getElementById('showDebugLogButton') as HTMLButtonElement; },
    get fileInput() { return document.getElementById('fileInput') as HTMLInputElement; },
    
    get agentModeCheckbox() { return document.getElementById('agentModeCheckbox') as HTMLInputElement; },
    get autoContextCheckbox() { return document.getElementById('autoContextCheckbox') as HTMLInputElement; },
    get autoSkillCheckbox() { return document.getElementById('autoSkillCheckbox') as HTMLInputElement; },
    get testModeCheckbox() { return document.getElementById('testModeCheckbox') as HTMLInputElement; },
    get docsModeCheckbox() { return document.getElementById('docsModeCheckbox') as HTMLInputElement; },
    get contextAggressionSelect() { return document.getElementById('modal-context-aggression') as HTMLSelectElement; },
    get herdModeCheckbox() { return document.getElementById('herdModeCheckbox') as HTMLInputElement; },
    get activeBadges() { return document.getElementById('active-badges') as HTMLDivElement; },
    
    get subMenuTriggers() { return document.querySelectorAll('.has-submenu'); },
    get backButtons() { return document.querySelectorAll('.back-btn'); },
    
    get modelSelector() { return document.getElementById('model-selector') as HTMLSelectElement; },
    get refreshModelsBtn() { return document.getElementById('refresh-models-btn') as HTMLButtonElement; },
    get contextContainer() { return document.getElementById('context-container') as HTMLDivElement; },
    get attachmentsContainer() { return document.getElementById('attachments-container') as HTMLDivElement; },
    get welcomeMessage() { return document.getElementById('welcome-message') as HTMLDivElement; },
    get scrollToBottomBtn() { return document.getElementById('scrollToBottomBtn') as HTMLButtonElement; },
    get usageModal() { return document.getElementById('usage-modal') as HTMLDivElement; },
    get usageListContainer() { return document.getElementById('usage-list-container') as HTMLDivElement; },
    get usageCloseBtn() { return document.getElementById('usage-close-btn') as HTMLSpanElement; },
    get usageRefreshBtn() { return document.getElementById('usage-refresh-btn') as HTMLButtonElement; },
    get tokenProgressBar() { return document.getElementById('token-progress-bar') as HTMLDivElement; },
    get tokenProgressContainer() { return document.getElementById('token-progress-container') as HTMLDivElement; },
    get tokenCountLabel() { return document.getElementById('token-count-label') as HTMLSpanElement; },
    get refreshContextBtn() { return document.getElementById('refresh-context-btn') as HTMLButtonElement; },
    get cancelTokensBtn() { return document.getElementById('cancel-tokens-btn') as HTMLButtonElement; },
    get contextStatusContainer() { return document.getElementById('context-status-container') as HTMLDivElement; },
    get contextLoadingSpinner() { return document.getElementById('context-loading-spinner') as HTMLDivElement; },
    get searchBar() { return document.getElementById('search-bar') as HTMLDivElement; },
    get searchButton() { return document.getElementById('searchButton') as HTMLButtonElement; },
    get searchInput() { return document.getElementById('searchInput') as HTMLInputElement; },
    get searchResultsCount() { return document.getElementById('search-results-count') as HTMLSpanElement; },
    get searchPrevBtn() { return document.getElementById('search-prev') as HTMLButtonElement; },
    get searchNextBtn() { return document.getElementById('search-next') as HTMLButtonElement; },
    get searchCloseBtn() { return document.getElementById('search-close') as HTMLButtonElement; },
    get agentToolsButton() { return document.getElementById('agentToolsButton') as HTMLButtonElement; },
    get agentSettingsModal() { return document.getElementById('agent-settings-modal') as HTMLDivElement; },
    get toolsModal() { return document.getElementById('agent-settings-modal') as HTMLDivElement; },
    get closeAgentSettingsModal() { return document.getElementById('close-agent-settings-modal') as HTMLSpanElement; },
    get closeToolsModal() { return document.getElementById('close-agent-settings-modal') as HTMLSpanElement; },
    get closeDiscussionToolsModal() { return document.getElementById('close-discussion-tools-modal') as HTMLSpanElement; },
    get saveToolsBtn() { return document.getElementById('save-agent-settings-btn') as HTMLButtonElement; },
    get saveDiscussionToolsBtn() { return document.getElementById('save-discussion-tools-btn') as HTMLButtonElement; },
    get toolsListDiv() { return document.getElementById('tools-list') as HTMLDivElement; },
    get attachmentPreviewArea() { return document.getElementById('attachment-preview-area') as HTMLDivElement; },
    get addDrawingButton() { return document.getElementById('addDrawingButton') as HTMLButtonElement; },
    get editorModal() { return document.getElementById('image-editor-modal') as HTMLDivElement; },
    get editorCanvas() { return document.getElementById('image-editor-canvas') as HTMLCanvasElement; },
    get editorSaveBtn() { return document.getElementById('editor-save') as HTMLButtonElement; },
    get editorCancelBtn() { return document.getElementById('editor-cancel') as HTMLButtonElement; },
    get editorClearBtn() { return document.getElementById('editor-clear') as HTMLButtonElement; },
    get editorTextInput() { return document.getElementById('canvas-text-input') as HTMLInputElement; },
    get toolWebcam() { return document.getElementById('tool-webcam') as HTMLButtonElement; },
    get webcamContainer() { return document.getElementById('webcam-container') as HTMLDivElement; },
    get webcamFeed() { return document.getElementById('webcam-feed') as HTMLVideoElement; },
    get webcamCaptureBtn() { return document.getElementById('webcam-capture') as HTMLButtonElement; },
    get webcamCancelBtn() { return document.getElementById('webcam-cancel') as HTMLButtonElement; },
    get addUserMessageBtn() { return document.getElementById('add-user-message-btn') as HTMLButtonElement; },
    get addAiMessageBtn() { return document.getElementById('add-ai-message-btn') as HTMLButtonElement; },
    get copyContextButton() { return document.getElementById('copyContextButton') as HTMLButtonElement; },
    get statusLabel() { return document.getElementById('status-label') as HTMLDivElement; },
    get hudMatrixBtn() { return document.getElementById('hud-matrix-btn') as HTMLButtonElement; },
    get statusText() { return document.getElementById('status-text') as HTMLSpanElement; },
    get statusSpinner() { return document.getElementById('status-spinner') as HTMLDivElement; },
    get tokenCountingOverlay() { return document.getElementById('token-counting-overlay') as HTMLDivElement; },
    get tokenCountingText() { return document.querySelector('#token-counting-overlay span') as HTMLSpanElement; },
    get inputAreaWrapper() { return document.querySelector('.input-area-wrapper') as HTMLDivElement; },
    get inputArea() { return document.querySelector('.input-area') as HTMLDivElement; },
    get generatingOverlay() { return document.getElementById('generating-overlay') as HTMLDivElement; },
    get activeToolsIndicator() { return document.getElementById('active-tools-indicator') as HTMLDivElement; },
    
    get capForceFullCode() { return document.getElementById('cap-forceFullCode') as HTMLInputElement; },
    get capAllowFullFallback() { return document.getElementById('cap-allowFullFallback') as HTMLInputElement; },
    get capExplainCode() { return document.getElementById('cap-explainCode') as HTMLInputElement; },
    get capAutoFix() { return document.getElementById('cap-autoFix') as HTMLInputElement; },
    get capAutoApply() { return document.getElementById('cap-autoApply') as HTMLInputElement; },
    get capAutoBranch() { return document.getElementById('cap-autoBranch') as HTMLInputElement; },
    get capAddPedagogicalInstruction() { return document.getElementById('cap-addPedagogicalInstruction') as HTMLInputElement; },
    get capForceFullCodePath() { return document.getElementById('cap-forceFullCodePath') as HTMLInputElement; },
    get capProjectMemory() { return document.getElementById('cap-projectMemoryEnabled') as HTMLInputElement; },
    get capDebugMode() { return document.getElementById('cap-debugMode') as HTMLInputElement; },
    get capMaxDebugSteps() { return document.getElementById('cap-maxDebugSteps') as HTMLInputElement; },
    get capClipboardRole() { return document.getElementById('cap-clipboardInsertRole') as HTMLSelectElement; },

    get allowedFormats() { return document.querySelector('.checkbox-grid') as HTMLElement; },
    get fmtFullFile() { return document.getElementById('fmt-fullFile') as HTMLInputElement; },

    get fmtInsert() { return document.getElementById('fmt-insert') as HTMLInputElement; },
    get fmtReplace() { return document.getElementById('fmt-replace') as HTMLInputElement; },
    get fmtDelete() { return document.getElementById('fmt-delete') as HTMLInputElement; },

    get capFileRename() { return document.getElementById('cap-fileRename') as HTMLInputElement; },
    get capFileDelete() { return document.getElementById('cap-fileDelete') as HTMLInputElement; },
    get capFileSelect() { return document.getElementById('cap-fileSelect') as HTMLInputElement; },
    get capFileReset() { return document.getElementById('cap-fileReset') as HTMLInputElement; },

    get capImageGen() { return document.getElementById('cap-imageGen') as HTMLInputElement; },
    get capEnableImages() { return document.getElementById('cap-enableImages') as HTMLInputElement; },
    get capUseImageModeForDocs() { return document.getElementById('cap-useImageModeForDocs') as HTMLInputElement; },
    get capWebSearch() { return document.getElementById('cap-webSearch') as HTMLInputElement; },
    get capDistillWebResults() { return document.getElementById('cap-distillWebResults') as HTMLInputElement; },
    get capAntiPromptInjection() { return document.getElementById('cap-antiPromptInjection') as HTMLInputElement; },
    get capSearchInCacheFirst() { return document.getElementById('cap-searchInCacheFirst') as HTMLInputElement; },
    get capArxivSearch() { return document.getElementById('cap-arxivSearch') as HTMLInputElement; },
    get capGitWorkflow() { return document.getElementById('cap-gitWorkflow') as HTMLInputElement; },
    get capGitWorkflowContainer() { return document.getElementById('cap-gitWorkflowContainer') as HTMLDivElement; },

    get modeFunMode() { return document.getElementById('mode-funMode') as HTMLInputElement; },
    get inputAreaWrapperDiv() { return document.querySelector('.input-area-wrapper') as HTMLDivElement; },

    get capHerdMode() { return document.getElementById('cap-herdMode') as HTMLInputElement; },
    get capHerdRounds() { return document.getElementById('cap-herdRounds') as HTMLInputElement; },
    get capHerdPreCount() { return document.getElementById('cap-herdPreCount') as HTMLInputElement; },
    get capHerdPostCount() { return document.getElementById('cap-herdPostCount') as HTMLInputElement; },
    get capHerdOrchestrator() { return document.getElementById('cap-herdOrchestrator') as HTMLSelectElement; },
    get capHerdParticipants() { return document.getElementById('herd-models-list') as HTMLDivElement; },
    get capHerdCritic() { return document.getElementById('cap-herdCritic') as HTMLInputElement; },
    get capHerdParallelGeneration() { return document.getElementById('cap-herdParallelGeneration') as HTMLInputElement; },
    get herdConfigSection() { return document.getElementById('herd-config-section') as HTMLDivElement; },
    get herdModelsList() { return document.getElementById('herd-models-list') as HTMLDivElement; },

    get gitBadgeWrapper() { return document.getElementById('git-badge-wrapper') as HTMLDivElement; },
    get gitMenu() { return document.getElementById('git-menu') as HTMLDivElement; },
    get gitMenuCommit() { return document.getElementById('git-menu-commit') as HTMLDivElement; },
    get gitMenuBranch() { return document.getElementById('git-menu-branch') as HTMLDivElement; },
    get gitMenuMerge() { return document.getElementById('git-menu-merge') as HTMLDivElement; },
    get gitMenuRevert() { return document.getElementById('git-menu-revert') as HTMLDivElement; },

    get stagingModal() { return document.getElementById('staging-modal') as HTMLDivElement; },
    get stagingList() { return document.getElementById('staging-list') as HTMLDivElement; },
    get stagingNextBtn() { return document.getElementById('staging-next-btn') as HTMLButtonElement; },
    get stagingCloseBtn() { return document.getElementById('staging-close-btn') as HTMLSpanElement; },

    get commitModal() { return document.getElementById('commit-modal') as HTMLDivElement; },
    get commitMessageInput() { return document.getElementById('commit-message-input') as HTMLTextAreaElement; },
    get commitConfirmBtn() { return document.getElementById('commit-confirm-btn') as HTMLButtonElement; },
    get commitCancelBtn() { return document.getElementById('commit-cancel-btn') as HTMLButtonElement; },

    get historyModal() { return document.getElementById('history-modal') as HTMLDivElement; },
    get historyList() { return document.getElementById('history-list') as HTMLDivElement; },
    get historyCloseBtn() { return document.getElementById('history-close-btn') as HTMLButtonElement; },

    // File Search Modal
    get fileSearchModal() { return document.getElementById('file-search-modal') as HTMLDivElement; },
    get fileSearchInput() { return document.getElementById('file-search-input') as HTMLInputElement; },
    get fileSearchResults() { return document.getElementById('file-search-results') as HTMLDivElement; },
    get fileSearchAddBtn() { return document.getElementById('file-search-add-btn') as HTMLButtonElement; },
    get fileSearchCloseBtn() { return document.getElementById('file-search-close-btn') as HTMLSpanElement; },
    get fileSearchSelectAll() { return document.getElementById('file-search-select-all') as HTMLInputElement; },

    // Skills Modal Elements
    get skillsModal() { return document.getElementById('skills-modal') as HTMLDivElement; },
    get skillsSearchInput() { return document.getElementById('skills-search-input') as HTMLInputElement; },
    get skillsTreeContainer() { return document.getElementById('skills-tree-container') as HTMLDivElement; },
    get skillsImportBtn() { return document.getElementById('skills-import-btn') as HTMLButtonElement; },
    get skillsCloseBtn() { return document.getElementById('skills-close-btn') as HTMLSpanElement; },

    // Web Discovery
    get webContextBtn() { return document.getElementById('web-context-btn') as HTMLButtonElement; },
    get webModal() { return document.getElementById('web-modal') as HTMLDivElement; },
    get webModalCloseBtn() { return document.getElementById('web-modal-close-btn') as HTMLSpanElement; },
    get webTabBtns() { return document.querySelectorAll('.web-tab-btn'); },
    get webTabContents() { return document.querySelectorAll('.web-tab-content'); },
    get webSubmitBtns() { return document.querySelectorAll('.web-submit-btn'); },

    // Mission Briefing Modal
    get missionBriefingModal() { return document.getElementById('mission-briefing-modal') as HTMLDivElement; },
    get missionBriefingCloseBtn() { return document.getElementById('mission-briefing-close-btn') as HTMLSpanElement; },
    get briefingUploadBtn() { return document.getElementById('briefing-upload-btn') as HTMLButtonElement; },
    get briefingClipboardBtn() { return document.getElementById('briefing-clipboard-btn') as HTMLButtonElement; },
    get briefingContentInput() { return document.getElementById('briefing-content-input') as HTMLTextAreaElement; },
    get briefingDnaPreview() { return document.getElementById('briefing-dna-preview') as HTMLDivElement; },
    get briefingClearBtn() { return document.getElementById('briefing-clear-btn') as HTMLButtonElement; },
    get briefingSaveBtn() { return document.getElementById('briefing-save-btn') as HTMLButtonElement; },

    // Global Discussion Search
    get discussionSearchModal() { return document.getElementById('discussion-search-modal') as HTMLDivElement; },
    get discussionSearchInput() { return document.getElementById('discussion-search-input') as HTMLInputElement; },
    get discussionSearchRunBtn() { return document.getElementById('discussion-search-run-btn') as HTMLButtonElement; },
    get discussionSearchResults() { return document.getElementById('discussion-search-results') as HTMLDivElement; },
    get discussionSearchCloseBtn() { return document.getElementById('discussion-search-close-btn') as HTMLSpanElement; },

    // Raw Code Preview
    get rawCodeModal() { return document.getElementById('raw-code-modal') as HTMLDivElement; },
    get rawCodeDisplay() { return document.getElementById('raw-code-display') as HTMLElement; },
    get rawCodeFilename() { return document.getElementById('raw-code-filename') as HTMLElement; },
    get rawCodeCloseBtn() { return document.getElementById('raw-code-close-btn') as HTMLSpanElement; },
    get rawSearchInput() { return document.getElementById('raw-search-input') as HTMLInputElement; },
    get rawSearchCount() { return document.getElementById('raw-search-count') as HTMLElement; },
    get rawSearchPrev() { return document.getElementById('raw-search-prev') as HTMLButtonElement; },
    get rawSearchNext() { return document.getElementById('raw-search-next') as HTMLButtonElement; },
    get copySearchBtn() { return document.getElementById('copy-search-btn') as HTMLButtonElement; },
    get copyReplaceBtn() { return document.getElementById('copy-replace-btn') as HTMLButtonElement; },
    get copyRawBtn() { return document.getElementById('copy-raw-btn') as HTMLButtonElement; },
    get rawFixAiBtn() { return document.getElementById('raw-fix-ai-btn') as HTMLButtonElement; },
    get markAppliedBtn() { return document.getElementById('mark-applied-btn') as HTMLButtonElement; },
    get searchSelectionBtn() { return document.getElementById('search-selection-btn') as HTMLButtonElement; },
    get rawSearchResultsMini() { return document.getElementById('raw-search-results') as HTMLDivElement; },
    get bulkDeleteSkillsRunBtn() { return document.getElementById('bulk-delete-skills-run-btn') as HTMLButtonElement; },
    get bulkDeleteSkillsList() { return document.getElementById('bulk-delete-skills-list') as HTMLDivElement; },

    // Context Viewer Modal
    get contextViewerModal() { return document.getElementById('context-viewer-modal') as HTMLDivElement; },
    get contextViewerDisplay() { return document.getElementById('context-viewer-display') as HTMLDivElement; },
    get contextViewerTitle() { return document.getElementById('context-viewer-title') as HTMLElement; },
    get contextViewerCloseBtn() { return document.getElementById('context-viewer-close-btn') as HTMLSpanElement; },
    get contextViewerCopyBtn() { return document.getElementById('context-viewer-copy-btn') as HTMLButtonElement; },
    get contextViewerDoneBtn() { return document.getElementById('context-viewer-done-btn') as HTMLButtonElement; },

    // Workspace Matrix Modal
    get matrixModal() { return document.getElementById('workspace-matrix-modal') as HTMLDivElement; },
    get matrixRowsContainer() { return document.getElementById('matrix-rows-container') as HTMLDivElement; },
    get matrixCloseBtn() { return document.getElementById('matrix-close-btn') as HTMLSpanElement; },
    get matrixDoneBtn() { return document.getElementById('matrix-done-btn') as HTMLButtonElement; }
    };
