import { dom, state } from "./dom.js";
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
