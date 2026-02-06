import { dom, vscode, state } from './dom.js';

// Type definitions for globals
declare const l10n: { [key: string]: string };

console.log("DEBUG: Lollms-VS-Coder Webview script starting...");

// Global Error Handler
window.onerror = function (msg, source, lineno, colno, error) {
    console.error("Global Webview Error:", msg, error);
    vscode.postMessage({
        command: 'showError',
        message: `Client Error: ${msg} (${source}:${lineno})`
    });
    return false;
};

// Libraries
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import mermaid from 'mermaid';
import Prism from 'prismjs';

// --- PrismJS Dependencies ---
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
import 'prismjs/components/prism-batch';
import 'prismjs/components/prism-lua';
import 'prismjs/components/prism-php';
import 'prismjs/components/prism-r';
import 'prismjs/components/prism-swift';
import 'prismjs/components/prism-kotlin';
import 'prismjs/components/prism-ruby';
import 'prismjs/components/prism-dart';
import 'prismjs/components/prism-docker';
import 'prismjs/components/prism-makefile';
import 'prismjs/components/prism-nginx';
import 'prismjs/components/prism-http';
import 'prismjs/components/prism-latex';
import 'prismjs/components/prism-perl';
import 'prismjs/components/prism-sass';
import 'prismjs/components/prism-scss';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-tsx';
import { updateBadges } from './ui.js';

// Initialize DOMPurify
const sanitizer = typeof DOMPurify === 'function' ? (DOMPurify as any)(window) : DOMPurify;

// Make libraries available globally
(window as any).marked = marked;
(window as any).DOMPurify = sanitizer;
(window as any).mermaid = mermaid;
(window as any).Prism = Prism;

// --- Initialize Mermaid ---
try {
    mermaid.initialize({ 
        startOnLoad: false,
        theme: 'dark', 
        securityLevel: 'loose',
        fontFamily: 'var(--vscode-font-family)'
    });
} catch(e) { 
    console.warn("Mermaid init error:", e); 
}

// Logic Imports
import { initEventHandlers } from './events.js'; 
import { handleExtensionMessage } from './extensionMessageHandler.js';

// Add to global scope
(window as any).saveSkill = (encodedContent: string, scope: 'global' | 'local', encodedTitle?: string) => {
    const content = decodeURIComponent(encodedContent);
    let name = encodedTitle ? decodeURIComponent(encodedTitle) : "New Skill";
    
    // If name is still default and not provided in title, try regex
    if (name === "New Skill" && !encodedTitle) {
         const nameMatch = content.match(/^#\s+(.*)/m);
         if (nameMatch) name = nameMatch[1].trim();
    }
    
    // Try to extract description
    const lines = content.split('\n');
    let desc = "Generated skill";
    // Find first non-empty line that isn't a header or code block fence
    const descLine = lines.find((l) => {
        const t = l.trim();
        return t.length > 0 && !t.startsWith('```') && !t.startsWith('#');
    });
    if (descLine) desc = descLine.trim();

    vscode.postMessage({ 
        command: 'saveGeneratedSkill', 
        skillData: { name, description: desc, content, scope } 
    });
};


// --- Initialization ---
(function() {
    try {
        if (!(window as any).vscode) {
            throw new Error("VS Code API missing on window object.");
        }

        window.addEventListener('message', handleExtensionMessage);
        
        document.addEventListener('DOMContentLoaded', () => {
            console.log("DEBUG: DOMContentLoaded.");
            
            if (typeof l10n !== 'undefined' && dom.welcomeMessage) {
                const title = dom.welcomeMessage.querySelector('#welcome-title');
                if(title) title.innerHTML = l10n.welcomeTitle || "Welcome";
                
                const item1 = dom.welcomeMessage.querySelector('#welcome-item-1');
                if(item1) item1.innerHTML = l10n.welcomeItem1 || "Item 1";
                
                const item2 = dom.welcomeMessage.querySelector('#welcome-item-2');
                if(item2) item2.innerHTML = l10n.welcomeItem2 || "Item 2";
                
                const item3 = dom.welcomeMessage.querySelector('#welcome-item-3');
                if(item3) item3.innerHTML = l10n.welcomeItem3 || "Item 3";
                
                const item4 = dom.welcomeMessage.querySelector('#welcome-item-4');
                if(item4) item4.innerHTML = l10n.welcomeItem4 || "Item 4";
                
                if(dom.contextLoadingSpinner) {
                     const textSpan = dom.contextLoadingSpinner.querySelector('#loading-files-text');
                     if(textSpan) textSpan.textContent = l10n.progressLoadingFiles || "Loading...";
                }
                
                if(dom.refreshContextBtn) dom.refreshContextBtn.title = l10n.tooltipRefreshContext || "Refresh";
            }

            try {
                marked.setOptions({ breaks: true, gfm: true });
            } catch (e) { console.warn("Marked init:", e); }

            // Initialize Event Handlers
            initEventHandlers();

            // Notify extension that webview is ready
            vscode.postMessage({ command: 'webview-ready' });
        });

    } catch (e: any) {
        console.error("Main Init Error:", e);
        if((window as any).vscode) {
            (window as any).vscode.postMessage({ command: 'showError', message: 'Init Error: ' + e.message });
        }
    }
})();
