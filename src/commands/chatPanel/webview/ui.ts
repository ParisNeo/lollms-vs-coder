import { dom } from "./dom.js";

export function setGeneratingState(isGenerating: boolean) {
    dom.messageInput.disabled = isGenerating;
    dom.agentModeCheckbox.disabled = isGenerating;
    dom.agentModeToggle.classList.toggle('disabled', isGenerating);
    dom.modelSelector.disabled = isGenerating;
    dom.attachButton.disabled = isGenerating;
    dom.executeButton.disabled = isGenerating;
    dom.setEntryPointButton.disabled = isGenerating;
    dom.debugRestartButton.disabled = isGenerating;

    dom.sendButton.style.display = isGenerating ? 'none' : 'flex';
    dom.stopButton.style.display = isGenerating ? 'flex' : 'none';
    
    if (!isGenerating) {
        dom.scrollToBottomBtn.style.display = 'none';
    }
}
