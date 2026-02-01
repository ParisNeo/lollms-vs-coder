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

    if (dom.inputAreaWrapper) {
        dom.inputAreaWrapper.style.display = isGenerating ? 'none' : 'block';
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
        
        if (dom.messageInput && dom.inputAreaWrapper && dom.inputAreaWrapper.style.display !== 'none') {
            dom.messageInput.focus();
        }
    } else {
        dom.scrollToBottomBtn.style.display = 'none';
    }
}

function createToggleBadge(
    text: string, 
    activeClass: string, 
    isVisible: boolean, 
    isActive: boolean, 
    onToggle: () => void,
    onExecute?: () => void
): HTMLElement | null {
    if (!isVisible) return null;

    const span = document.createElement('span');
    span.className = `mode-badge ${activeClass} ${isActive ? 'active' : 'inactive'} clickable`;
    
    if (isActive && onExecute) {
        span.title = `${text}: Click checkmark to Deactivate.\nClick badge to Execute with current input.`;
    } else {
        span.title = isActive ? `${text} Mode Active (Click to disable)` : `${text} Mode Inactive (Click to enable)`;
    }
    
    const toggle = document.createElement('span');
    toggle.className = `badge-toggle-btn codicon ${isActive ? 'codicon-pass-filled' : 'codicon-circle-large-outline'}`;
    
    const label = document.createElement('span');
    label.className = 'badge-label';
    label.textContent = text;
    
    toggle.onclick = (e) => {
        e.stopPropagation();
        onToggle();
    };

    span.onclick = (e) => {
        e.stopPropagation();
        if (isActive && onExecute) {
            onExecute();
        } else {
            onToggle();
        }
    };

    span.appendChild(toggle);
    span.appendChild(label);
    
    return span;
}

export function updateBadges() {
    const container = dom.activeBadges;
    if (!container) return;
    
    container.innerHTML = '';

    if (dom.modelSelector && dom.modelSelector.value) {
        const model = dom.modelSelector.value;
        const span = document.createElement('span');
        span.className = 'mode-badge model';
        span.title = 'Current Model';
        span.textContent = model;
        container.appendChild(span);
    }

    if (state.personalities && state.personalities.length > 0) {
        const currentP = state.personalities.find(p => p.id === state.currentPersonalityId);
        if (currentP) {
            const wrapper = document.createElement('div');
            wrapper.className = 'badge-wrapper';
            wrapper.style.position = 'relative';

            const pBadge = document.createElement('span');
            pBadge.id = 'personality-badge';
            pBadge.className = 'mode-badge personality clickable';
            pBadge.title = `Active Personality: ${currentP.name}. Click to switch.`;
            pBadge.innerHTML = `<span class="codicon codicon-account"></span> <span class="badge-label">${currentP.name}</span>`;
            
            const menu = document.createElement('div');
            menu.id = 'personality-menu';
            menu.className = 'custom-menu hidden';
            
            state.personalities.forEach((p: any) => {
                const item = document.createElement('div');
                item.className = 'custom-menu-item p-menu-item';
                item.dataset.pid = p.id;
                
                const icon = (p.id === state.currentPersonalityId) ? 'codicon-check' : 'codicon-account';
                item.innerHTML = `<span class="codicon ${icon}"></span> ${p.name}`;
                
                if (p.id === state.currentPersonalityId) {
                    item.style.fontWeight = 'bold';
                    item.style.color = 'var(--vscode-textLink-foreground)';
                }
                
                item.onclick = (e: MouseEvent) => {
                    e.stopPropagation();
                    vscode.postMessage({ command: 'updateDiscussionPersonality', personalityId: p.id });
                    menu.classList.remove('visible');
                };
                
                menu.appendChild(item);
            });

            pBadge.onclick = (e) => {
                e.stopPropagation();
                document.querySelectorAll('.custom-menu').forEach(m => {
                    if (m.id !== 'personality-menu') m.classList.remove('visible');
                });
                menu.classList.toggle('visible');
            };

            wrapper.appendChild(pBadge);
            wrapper.appendChild(menu);
            container.appendChild(wrapper);
        }
    }

    if (!state.capabilities) return;
    
    const caps = state.capabilities;
    const guiState = caps.guiState || { agentBadge: true, autoContextBadge: true, herdBadge: true };

    const styleSpan = document.createElement('span');
    const styleIcon = caps.responseMode === 'silent' ? 'codicon-mute' : (caps.responseMode === 'pedagogical' ? 'codicon-mortar-board' : 'codicon-law');
    styleSpan.className = `mode-badge active clickable`;
    styleSpan.style.backgroundColor = 'var(--vscode-button-secondaryBackground)';
    styleSpan.style.color = 'var(--vscode-button-secondaryForeground)';
    styleSpan.title = `Active Response Style: ${caps.responseMode.toUpperCase()}`;
    styleSpan.innerHTML = `<span class="codicon ${styleIcon}"></span> <span class="badge-label">${caps.responseMode.charAt(0).toUpperCase() + caps.responseMode.slice(1)}</span>`;
    styleSpan.onclick = (e) => {
        e.stopPropagation();
        const mainView = document.getElementById('menu-main');
        const styleView = document.getElementById('menu-response-style');
        if (mainView && styleView && dom.moreActionsMenu) {
            mainView.classList.add('hidden');
            styleView.classList.remove('hidden');
            dom.moreActionsMenu.classList.add('visible');
        }
    };
    container.appendChild(styleSpan);

    const agentBadge = createToggleBadge('🤖 Agent', 'agent', guiState.agentBadge, caps.agentMode, () => {
        vscode.postMessage({ command: 'toggleAgentMode' });
    });
    if (agentBadge) container.appendChild(agentBadge);

    const ctxBadge = createToggleBadge(
        '🧠 AutoCtx', 
        'autocontext', 
        guiState.autoContextBadge, 
        caps.autoContextMode, 
        () => {
            vscode.postMessage({ command: 'toggleAutoContext', enabled: !caps.autoContextMode });
        },
        () => {
            const prompt = dom.messageInput ? dom.messageInput.value : "";
            vscode.postMessage({ command: 'runAutoContext', prompt: prompt });
        }
    );
    if (ctxBadge) container.appendChild(ctxBadge);

    const herdBadge = createToggleBadge('🐂 Herd', 'herd', guiState.herdBadge, caps.herdMode, () => {
        vscode.postMessage({ command: 'updateDiscussionCapabilitiesPartial', partial: { herdMode: !caps.herdMode } });
    });
    if (herdBadge) container.appendChild(herdBadge);

    if (caps.gitWorkflow) {
        const branchName = state.currentBranch || 'git-workflow';
        
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
        
        const menu = document.createElement('div');
        menu.id = 'git-menu';
        menu.className = 'custom-menu hidden';
        
        const createMenuItem = (id: string, iconClass: string, text: string, command: string, params?: any) => {
            const item = document.createElement('div');
            item.id = id;
            item.className = 'custom-menu-item';
            item.innerHTML = `<span class="codicon ${iconClass}"></span> ${text}`;
            
            item.onclick = (e: MouseEvent) => {
                e.stopPropagation();
                if (command.startsWith('lollms-vs-coder')) {
                    vscode.postMessage({ command: 'executeLollmsCommand', details: { command: command, params: params } });
                } else {
                    vscode.postMessage({ command: command, ...params });
                }
                menu.classList.remove('visible');
            };

            return item;
        };

        menu.appendChild(createMenuItem('git-menu-branch', 'codicon-git-branch', 'New Branch', 'lollms-vs-coder.createGitBranch'));
        menu.appendChild(createMenuItem('git-menu-switch', 'codicon-arrow-swap', 'Switch Branch', 'lollms-vs-coder.switchGitBranch'));
        menu.appendChild(createMenuItem('git-menu-commit', 'codicon-check', 'Commit', 'requestCommitStaging'));
        menu.appendChild(createMenuItem('git-menu-merge', 'codicon-git-merge', 'Fuse Branch', 'lollms-vs-coder.mergeGitBranch'));
        menu.appendChild(createMenuItem('git-menu-revert', 'codicon-history', 'Revert / Motion', 'requestGitHistory'));

        wrapper.appendChild(menu);
        container.appendChild(wrapper);

        badge.onclick = (e) => {
            e.stopPropagation();
            document.querySelectorAll('.custom-menu').forEach(m => {
                if (m.id !== 'git-menu') m.classList.remove('visible');
            });
            menu.classList.toggle('visible');
        };
    }
}
