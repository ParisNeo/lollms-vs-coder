import { dom, state, vscode } from "./dom.js";
import { isScrolledToBottom } from "./utils.js";

export function setGeneratingState(isGenerating: boolean) {
    state.isGenerating = isGenerating;

    if (dom.messageInput) {
        dom.messageInput.disabled = isGenerating;
    }

    if(dom.agentModeCheckbox) dom.agentModeCheckbox.disabled = isGenerating;
    if(dom.agentModeToggle) dom.agentModeToggle.classList.toggle('disabled', isGenerating);
    
    // Also toggle Auto Context
    if(dom.autoContextCheckbox) dom.autoContextCheckbox.disabled = isGenerating;
    if(dom.autoContextToggle) dom.autoContextToggle.classList.toggle('disabled', isGenerating);

    if(dom.modelSelector) dom.modelSelector.disabled = isGenerating;
    if(dom.attachButton) dom.attachButton.disabled = isGenerating;
    if(dom.executeButton) dom.executeButton.disabled = isGenerating;
    if(dom.setEntryPointButton) dom.setEntryPointButton.disabled = isGenerating;
    if(dom.debugRestartButton) dom.debugRestartButton.disabled = isGenerating;

    // Toggle the input container visibility completely
    if (dom.inputAreaWrapper) {
        dom.inputAreaWrapper.style.display = isGenerating ? 'none' : 'block';
    }

    // Toggle the generating overlay
    if (dom.generatingOverlay) {
        dom.generatingOverlay.style.display = isGenerating ? 'flex' : 'none';
    }

    if (!isGenerating) {
        if (dom.messagesDiv && !isScrolledToBottom(dom.messagesDiv)) {
            dom.scrollToBottomBtn.style.display = 'flex';
        } else {
            dom.scrollToBottomBtn.style.display = 'none';
        }
        
        if (dom.messageInput) dom.messageInput.focus();
    } else {
        dom.scrollToBottomBtn.style.display = 'none';
    }
}

export function updateBadges() {
    const container = dom.activeBadges;
    if (!container) return;
    
    // Clear current badges
    container.innerHTML = '';

    // Model Badge (Always show)
    if (dom.modelSelector && dom.modelSelector.value) {
        const model = dom.modelSelector.value;
        const span = document.createElement('span');
        span.className = 'mode-badge model';
        span.title = 'Current Model';
        span.textContent = model;
        container.appendChild(span);
    }

    // Agent Mode
    if (dom.agentModeCheckbox && dom.agentModeCheckbox.checked) {
        const span = document.createElement('span');
        span.className = 'mode-badge agent';
        span.title = 'Agent Mode Active';
        span.textContent = '🤖 Agent';
        container.appendChild(span);
    }

    // Auto Context
    if (dom.autoContextCheckbox && dom.autoContextCheckbox.checked) {
        const span = document.createElement('span');
        span.className = 'mode-badge autocontext clickable';
        span.title = 'Auto Context Active - Click to Run Now';
        span.textContent = '🧠 AutoCtx';
        
        // Add Click Listener
        span.addEventListener('click', (e) => {
            e.stopPropagation(); // Prevent bubbling issues
            const prompt = dom.messageInput ? dom.messageInput.value : '';
            vscode.postMessage({ command: 'runAutoContext', prompt });
        });
        
        container.appendChild(span);
    }

    // Herd Mode
    if (dom.herdModeCheckbox && dom.herdModeCheckbox.checked) {
        const span = document.createElement('span');
        span.className = 'mode-badge herd';
        span.title = 'Herd Mode Active';
        span.textContent = '🐂 Herd';
        container.appendChild(span);
    }
}
