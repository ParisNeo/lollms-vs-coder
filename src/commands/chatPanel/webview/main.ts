// Type definitions for globals
interface VsCodeApi {
    postMessage(message: any): void;
    getState(): any;
    setState(state: any): void;
}
declare const acquireVsCodeApi: () => VsCodeApi;
declare const l10n: { [key: string]: string };
declare const mermaid: any;
declare const DOMPurify: any;
declare const marked: any;
declare const Prism: any;

import { initEventHandlers } from './events';
import { handleExtensionMessage } from './extensionMessageHandler';
import { dom } from './dom';

// Global state
export const vscode: VsCodeApi = acquireVsCodeApi();
export const state: {
    searchMatches: HTMLElement[],
    currentMatchIndex: number,
    isInspectorEnabled: boolean,
    streamingMessages: { [key: string]: { buffer: string, timer: NodeJS.Timeout | null } },
} = {
    searchMatches: [],
    currentMatchIndex: -1,
    isInspectorEnabled: false,
    streamingMessages: {},
};

document.addEventListener('DOMContentLoaded', () => {
    console.log("Lollms-VS-Coder Webview DOM Loaded. Initializing...");
    // Populate UI with translated strings on load
    (dom.welcomeMessage.querySelector('#welcome-title') as HTMLElement).innerHTML = l10n.welcomeTitle;
    (dom.welcomeMessage.querySelector('#welcome-item-1') as HTMLElement).innerHTML = l10n.welcomeItem1;
    (dom.welcomeMessage.querySelector('#welcome-item-2') as HTMLElement).innerHTML = l10n.welcomeItem2;
    (dom.welcomeMessage.querySelector('#welcome-item-3') as HTMLElement).innerHTML = l10n.welcomeItem3;
    (dom.welcomeMessage.querySelector('#welcome-item-4') as HTMLElement).innerHTML = l10n.welcomeItem4;
    (dom.contextLoadingSpinner.querySelector('#loading-files-text') as HTMLElement).textContent = l10n.progressLoadingFiles;
    dom.refreshContextBtn.title = l10n.tooltipRefreshContext;

    initEventHandlers();
    window.addEventListener('message', handleExtensionMessage);
    
    // Signal to the extension that the webview is ready to receive data
    vscode.postMessage({ command: 'webview-ready' });
    
    console.log("Lollms-VS-Coder Webview Initialized and sent ready signal.");

    const isDarkTheme = document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast');
    mermaid.initialize({
        startOnLoad: false,
        theme: isDarkTheme ? 'dark' : 'default',
        securityLevel: 'loose'
    });
});
