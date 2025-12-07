import { dom } from "./dom.js";
import { isScrolledToBottom } from "./utils.js";

export function setGeneratingState(isGenerating: boolean) {
    if (dom.messageInput) {
        dom.messageInput.disabled = isGenerating;
    }

    if(dom.agentModeCheckbox) dom.agentModeCheckbox.disabled = isGenerating;
    if(dom.agentModeToggle) dom.agentModeToggle.classList.toggle('disabled', isGenerating);
    if(dom.modelSelector) dom.modelSelector.disabled = isGenerating;
    if(dom.attachButton) dom.attachButton.disabled = isGenerating;
    if(dom.executeButton) dom.executeButton.disabled = isGenerating;
    if(dom.setEntryPointButton) dom.setEntryPointButton.disabled = isGenerating;
    if(dom.debugRestartButton) dom.debugRestartButton.disabled = isGenerating;

    // Toggle the input container and the generating overlay
    if (dom.inputArea) {
        // Use class for visual disabling instead of hiding
        dom.inputArea.classList.toggle('disabled', isGenerating);
        // Ensure it is visible (in case it was hidden by previous logic or other states)
        dom.inputArea.style.display = 'flex';
    }
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
    
    // Ensure Send Button is always flex (visible) when input area is shown
    if (dom.sendButton) dom.sendButton.style.display = 'flex';
}
