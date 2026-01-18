import { dom, state, vscode } from "./dom.js";
import { isScrolledToBottom } from "./utils.js";

export function setGeneratingState(isGenerating: boolean) {
    state.isGenerating = isGenerating;

    if (dom.messageInput) {
        dom.messageInput.disabled = isGenerating;
    }

    if(dom.agentModeCheckbox) dom.agentModeCheckbox.disabled = isGenerating;
    if(dom.autoContextCheckbox) dom.autoContextCheckbox.disabled = isGenerating;

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

function createToggleBadge(text: string, activeClass: string, isVisible: boolean, isActive: boolean, onToggle: () => void): HTMLElement | null {
    if (!isVisible) return null;

    const span = document.createElement('span');
    
    // isActive = Mode is actually running/ON
    // isVisible = Mode is allowed/visible in GUI
    
    span.className = `mode-badge ${activeClass} ${isActive ? 'active' : 'inactive'} clickable`;
    span.title = isActive ? `${text} Mode Active (Click to disable)` : `${text} Mode Inactive (Click to enable)`;
    
    const toggle = document.createElement('span');
    toggle.className = `badge-toggle-btn codicon ${isActive ? 'codicon-pass-filled' : 'codicon-circle-large-outline'}`;
    
    const label = document.createElement('span');
    label.className = 'badge-label';
    label.textContent = text;
    
    // Click handles activation toggle
    span.onclick = (e) => {
        e.stopPropagation();
        onToggle();
    };

    span.appendChild(toggle);
    span.appendChild(label);
    
    return span;
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

    if (!state.capabilities) return;
    
    const caps = state.capabilities;
    const guiState = caps.guiState || { agentBadge: true, autoContextBadge: true, herdBadge: true };

    // Agent Mode Badge
    const agentBadge = createToggleBadge('🤖 Agent', 'agent', guiState.agentBadge, caps.agentMode, () => {
        // Toggle ACTIVATION
        vscode.postMessage({ command: 'toggleAgentMode' });
    });
    if (agentBadge) container.appendChild(agentBadge);

    // Auto Context Badge
    const ctxBadge = createToggleBadge('🧠 AutoCtx', 'autocontext', guiState.autoContextBadge, caps.autoContextMode, () => {
        // Toggle ACTIVATION
        vscode.postMessage({ command: 'toggleAutoContext', enabled: !caps.autoContextMode });
    });
    if (ctxBadge) container.appendChild(ctxBadge);

    // Herd Mode Badge
    const herdBadge = createToggleBadge('🐂 Herd', 'herd', guiState.herdBadge, caps.herdMode, () => {
        // Toggle ACTIVATION (Capability)
        vscode.postMessage({ command: 'updateDiscussionCapabilitiesPartial', partial: { herdMode: !caps.herdMode } });
    });
    if (herdBadge) container.appendChild(herdBadge);

    // Git Workflow Badge (Custom Menu)
    if (caps.gitWorkflow) {
        const branchName = state.currentBranch || 'git-workflow';
        
        // Wrapper for positioning
        const wrapper = document.createElement('div');
        wrapper.id = 'git-badge-wrapper';
        wrapper.className = 'badge-wrapper';
        wrapper.style.position = 'relative';

        const badge = document.createElement('span');
        badge.className = 'mode-badge active clickable';
        badge.style.backgroundColor = 'var(--vscode-gitDecoration-modifiedResourceForeground)'; 
        badge.style.color = 'white';
        badge.title = `Current Branch: ${branchName}. Click for actions.`;
        badge.id = 'git-badge';
        
        const icon = document.createElement('span');
        icon.className = 'codicon codicon-git-branch';
        icon.style.marginRight = '4px';
        
        const label = document.createElement('span');
        label.className = 'badge-label';
        label.textContent = branchName;
        
        badge.appendChild(icon);
        badge.appendChild(label);
        
        wrapper.appendChild(badge);
        
        // Create the Menu
        const menu = document.createElement('div');
        menu.id = 'git-menu';
        menu.className = 'custom-menu hidden';
        
        const createMenuItem = (id: string, iconClass: string, text: string) => {
            const item = document.createElement('div');
            item.id = id;
            item.className = 'custom-menu-item';
            item.innerHTML = `<span class="codicon ${iconClass}"></span> ${text}`;
            return item;
        };

        menu.appendChild(createMenuItem('git-menu-branch', 'codicon-git-branch', 'New Branch'));
        menu.appendChild(createMenuItem('git-menu-commit', 'codicon-check', 'Commit'));
        menu.appendChild(createMenuItem('git-menu-merge', 'codicon-git-merge', 'Fuse Branch'));
        menu.appendChild(createMenuItem('git-menu-revert', 'codicon-history', 'Revert / Motion'));

        wrapper.appendChild(menu);
        container.appendChild(wrapper);

        // Toggle logic
        badge.onclick = (e) => {
            e.stopPropagation();
            menu.classList.toggle('visible');
        };

        // Close menu on outside click logic is handled in events.ts
    }
}
