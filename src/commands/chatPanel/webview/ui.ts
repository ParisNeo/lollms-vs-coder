import { dom, state } from "./dom.js";
import { EditorView } from "@codemirror/view";
import { editableCompartment } from "./main.js";

export function setGeneratingState(isGenerating: boolean) {
    if (state.editor) {
        state.editor.dispatch({
            effects: editableCompartment.reconfigure(EditorView.editable.of(!isGenerating))
        });
    }

    if(dom.agentModeCheckbox) dom.agentModeCheckbox.disabled = isGenerating;
    if(dom.agentModeToggle) dom.agentModeToggle.classList.toggle('disabled', isGenerating);
    if(dom.modelSelector) dom.modelSelector.disabled = isGenerating;
    if(dom.attachButton) dom.attachButton.disabled = isGenerating;
    if(dom.executeButton) dom.executeButton.disabled = isGenerating;
    if(dom.setEntryPointButton) dom.setEntryPointButton.disabled = isGenerating;
    if(dom.debugRestartButton) dom.debugRestartButton.disabled = isGenerating;

    dom.sendButton.style.display = isGenerating ? 'none' : 'flex';
    dom.stopButton.style.display = isGenerating ? 'flex' : 'none';
    
    if (dom.inputArea) dom.inputArea.classList.toggle('disabled', isGenerating);
    if (dom.generatingOverlay) dom.generatingOverlay.style.display = isGenerating ? 'flex' : 'none';

    if (!isGenerating) {
        dom.scrollToBottomBtn.style.display = 'none';
        if (state.editor) state.editor.focus();
    }
}
