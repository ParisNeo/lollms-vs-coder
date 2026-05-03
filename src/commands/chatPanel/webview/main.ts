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
import { setGeneratingState, updateBadges, renderPendingImages, openImageEditor, filterSkillsTree, renderWorkspaceMatrix } from './ui.js';

// Initialize DOMPurify
const sanitizer = typeof DOMPurify === 'function' ? (DOMPurify as any)(window) : DOMPurify;

// Make libraries available globally
(window as any).marked = marked;
(window as any).DOMPurify = sanitizer;
(window as any).mermaid = mermaid;
(window as any).Prism = Prism;
(window as any).renderPendingImages = renderPendingImages;
(window as any).openImageEditor = openImageEditor;
(window as any).filterSkillsTree = filterSkillsTree;

// --- Initialize Mermaid ---
try {
    mermaid.initialize({ 
        startOnLoad: false,
        theme: 'dark', 
        securityLevel: 'strict',
        fontFamily: 'var(--vscode-font-family)'
    });
} catch(e) { 
    console.warn("Mermaid init error:", e); 
}

// Logic Imports
import { initEventHandlers } from './events.js'; 
import { handleExtensionMessage } from './extensionMessageHandler.js';

// --- Local Voice Logic (HAL9000 Style) ---
let isListening = false;
let isSpeakingEnabled = false;
const recognition = 'SpeechRecognition' in window || 'webkitSpeechRecognition' in window 
    ? new ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition)() 
    : null;

if (recognition) {
    // Set to continuous so it stays active until manually stopped
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onresult = (event: any) => {
        // Update language based on current capabilities before starting
        const preferredLang = state.capabilities?.language;
        recognition.lang = (preferredLang && preferredLang !== 'auto') ? preferredLang : 'en-US';
        let finalTranscript = '';
        for (let i = event.resultIndex; i < event.results.length; ++i) {
            if (event.results[i].isFinal) {
                finalTranscript += event.results[i][0].transcript;
            }
        }

        const input = document.getElementById('messageInput') as HTMLTextAreaElement;
        if (input && finalTranscript) {
            // Append the new text to whatever is already there
            const separator = input.value.length > 0 ? ' ' : '';
            input.value += separator + finalTranscript;
            input.dispatchEvent(new Event('input'));
        }
    };

    recognition.onerror = (event: any) => {
        console.error("STT Error:", event.error);
        isListening = false;
        document.getElementById('sttButton')?.classList.remove('active');
    };

    recognition.onend = () => {
        // If it ended but we didn't manually stop it (e.g. timeout), restart it if isListening is still true
        if (isListening) {
            try { recognition.start(); } catch(e) {}
        } else {
            document.getElementById('sttButton')?.classList.remove('active');
        }
    };
}

// Remove the global TTS button reference as it's being deleted from UI
document.getElementById('ttsButton')?.remove();

// Track the button currently showing a spinner
let activeSpeakButton: HTMLElement | null = null;
let originalSpeakButtonHtml: string = '';

function resetActiveSpeakButton() {
    if (activeSpeakButton) {
        activeSpeakButton.innerHTML = originalSpeakButtonHtml;
        activeSpeakButton.classList.remove('speaking');
        activeSpeakButton = null;
    }
}

// Expose speak and reset to the extension message handler and events
(window as any).halSpeak = speakText;
(window as any).resetActiveSpeakButton = resetActiveSpeakButton;

function speakText(text: string, force: boolean = false, triggerButton?: HTMLElement) {
    // 1. Global deactivation check
    if (!state.capabilities?.enableTTS && !force) {
        console.log("TTS is disabled in settings. Skipping speech.");
        return;
    }

    // 2. If clicking the SAME button that is already speaking, treat as "Stop"
    if (triggerButton && triggerButton === activeSpeakButton) {
        window.speechSynthesis.cancel();
        resetActiveSpeakButton();
        return;
    }

    // 3. Stop any current speech
    window.speechSynthesis.cancel();
    resetActiveSpeakButton();
    
    const utterance = new SpeechSynthesisUtterance(text);
    const voices = window.speechSynthesis.getVoices();
    
    if (voices.length === 0) {
        console.warn("TTS: No OS voices available yet.");
        return;
    }

    const preferredVoiceName = state.capabilities?.voice;
    const preferredLang = state.capabilities?.language || 'en';

    // 4. Voice Selection Logic
    if (preferredVoiceName && preferredVoiceName !== 'default') {
        const selected = voices.find(v => v.name === preferredVoiceName);
        if (selected) utterance.voice = selected;
    } else if (preferredLang !== 'auto') {
        // Find best match for the specific language code (e.g., 'en' or 'en-US')
        const langVoice = voices.find(v => v.lang.toLowerCase().startsWith(preferredLang.toLowerCase()));
        if (langVoice) {
            utterance.voice = langVoice;
            utterance.lang = langVoice.lang;
        } else {
            utterance.lang = preferredLang;
        }
    }
    if (preferredLang && preferredLang !== 'auto') {
        utterance.lang = preferredLang;
    }

    utterance.rate = 0.9; 
    utterance.pitch = 0.8;

    if (triggerButton) {
        activeSpeakButton = triggerButton;
        originalSpeakButtonHtml = triggerButton.innerHTML;
        
        // Immediate visual feedback (don't wait for engine start)
        triggerButton.innerHTML = '<div class="spinner"></div>';
        triggerButton.classList.add('speaking');

        utterance.onend = () => {
            resetActiveSpeakButton();
        };

        utterance.onerror = (e) => {
            console.error("TTS Error:", e);
            resetActiveSpeakButton();
        };
    }

    window.speechSynthesis.speak(utterance);
}

/**
 * Aggressively populates the voice selection list.
 */
function populateVoiceList() {
    const voiceSelect = document.getElementById('modal-voice') as HTMLSelectElement;
    if (!voiceSelect) return;

    let voices = window.speechSynthesis.getVoices();
    const current = state.capabilities?.voice;

    // Filter out duplicates and empty names
    const uniqueVoices = voices.filter((v, index, self) => 
        v.name && self.findIndex(t => t.name === v.name) === index
    );

    if (uniqueVoices.length === 0) {
        // If empty, it might still be loading. Re-try in a bit.
        return;
    }

    voiceSelect.innerHTML = '<option value="default">System Default</option>';
    uniqueVoices.forEach(v => {
        const opt = document.createElement('option');
        opt.value = v.name;
        opt.textContent = `${v.name} (${v.lang})`;
        if (v.name === current) opt.selected = true;
        voiceSelect.appendChild(opt);
    });
}

// Expose to global so UI can trigger a refresh when modal opens
(window as any).refreshVoiceList = populateVoiceList;

// Event fired when browser/OS updates the voice registry
if (window.speechSynthesis) {
    window.speechSynthesis.onvoiceschanged = populateVoiceList;
    // Initial attempt
    populateVoiceList();
}

// Attach listeners
document.getElementById('sttButton')?.addEventListener('click', () => {
    if (!recognition) {
        vscode.postMessage({ command: 'showError', message: "Speech recognition is not supported by your OS or VS Code environment." });
        return;
    }
    if (isListening) {
        isListening = false;
        recognition.stop();
    } else {
        // Ensure language is synced with capability before starting
        const preferredLang = state.capabilities?.language;
        recognition.lang = (preferredLang && preferredLang !== 'auto') ? preferredLang : 'en-US';
        
        isListening = true;
        document.getElementById('sttButton')?.classList.add('active');
        recognition.start();
    }
});

document.getElementById('ttsButton')?.addEventListener('click', () => {
    isSpeakingEnabled = !isSpeakingEnabled;
    const btn = document.getElementById('ttsButton');
    btn?.classList.toggle('active', isSpeakingEnabled);
    if (!isSpeakingEnabled) window.speechSynthesis.cancel();
});


// Add to global scope
(window as any).saveSkill = (encodedContent: string, scope: 'global' | 'local', encodedTitle?: string, encodedDesc?: string, encodedCat?: string) => {
    const content = decodeURIComponent(encodedContent);
    const name = encodedTitle ? decodeURIComponent(encodedTitle) : "New Skill";
    const description = encodedDesc ? decodeURIComponent(encodedDesc) : "";
    const category = encodedCat ? decodeURIComponent(encodedCat) : "";

    vscode.postMessage({ 
        command: 'saveGeneratedSkill', 
        skillData: { 
            name, 
            description, 
            content, 
            category,
            scope 
        } 
    });
};

(window as any).generateImageFromTag = (prompt: string, path: string, w: string, h: string, btnId: string) => {
    const btn = document.getElementById(btnId) as HTMLButtonElement;
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<div class="spinner"></div> Generating...';
    }
    vscode.postMessage({
        command: 'generateImage',
        prompt: decodeURIComponent(prompt),
        filePath: decodeURIComponent(path),
        width: w,
        height: h,
        buttonId: btnId
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
            
            const strings = (window as any).l10n || {};
            
            if (dom.welcomeMessage) {
                const title = dom.welcomeMessage.querySelector('#welcome-title');
                if(title) title.innerHTML = strings.welcomeTitle || "Welcome to Lollms VS Coder";
                
                const item1 = dom.welcomeMessage.querySelector('#welcome-item-1');
                if(item1) item1.innerHTML = strings.welcomeItem1 || "Add files to context by right-clicking them in the explorer.";
                
                const item2 = dom.welcomeMessage.querySelector('#welcome-item-2');
                if(item2) item2.innerHTML = strings.welcomeItem2 || "Use 🤖 Agent Mode for complex multi-step tasks.";
                
                const item3 = dom.welcomeMessage.querySelector('#welcome-item-3');
                if(item3) item3.innerHTML = strings.welcomeItem3 || "Toggle 🧠 Auto-Context to let the AI find relevant code for you.";
                
                const item4 = dom.welcomeMessage.querySelector('#welcome-item-4');
                if(item4) item4.innerHTML = strings.welcomeItem4 || "Check the 🔌 API status in the context header.";
                
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
