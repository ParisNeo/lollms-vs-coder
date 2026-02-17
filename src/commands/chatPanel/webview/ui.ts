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
    if (!isVisible && !isActive) return null;

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

    // --- INFRASTRUCTURE GROUP (Always Visible) ---
    const infraGroup = document.createElement('div');
    infraGroup.className = 'badge-group';
    container.appendChild(infraGroup);

    // Model Badge
    if (dom.modelSelector && dom.modelSelector.value) {
        const model = dom.modelSelector.value;
        const span = document.createElement('span');
        span.className = 'mode-badge model';
        span.title = 'Current Model';
        span.textContent = model;
        infraGroup.appendChild(span);
    }

    // Personality Badge
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
            infraGroup.appendChild(wrapper);
        }
    }

    if (!state.capabilities) return;
    
    const caps = state.capabilities;
    const guiState = caps.guiState || { agentBadge: true, autoContextBadge: true, herdBadge: true, webSearchBadge: true };

    // Response Profile Badge (Mode)
    const currentProfileId = caps.responseProfileId || 'balanced';
    const currentProfile = state.profiles.find(p => p.id === currentProfileId) || state.profiles[0];
    
    if (currentProfile) {
        const wrapper = document.createElement('div');
        wrapper.className = 'badge-wrapper';
        wrapper.style.position = 'relative';

        const modeBadge = document.createElement('span');
        modeBadge.className = 'mode-badge active clickable';
        modeBadge.style.backgroundColor = 'var(--vscode-button-secondaryBackground)';
        modeBadge.style.color = 'var(--vscode-button-secondaryForeground)';
        modeBadge.title = `Current Mode: ${currentProfile.name}\n${currentProfile.description}`;
        modeBadge.innerHTML = `<span class="codicon codicon-settings"></span> <span class="badge-label">${currentProfile.name}</span>`;

        const menu = document.createElement('div');
        menu.id = 'profile-menu';
        menu.className = 'custom-menu hidden';
        
        state.profiles.forEach(p => {
             const item = document.createElement('div');
             item.className = 'custom-menu-item';
             item.innerHTML = `<span class="codicon ${p.id === currentProfileId ? 'codicon-check' : 'codicon-circle-outline'}"></span> ${p.name}`;
             item.onclick = (e: MouseEvent) => {
                 e.stopPropagation();
                 vscode.postMessage({ 
                     command: 'updateDiscussionCapabilitiesPartial', 
                     partial: { responseProfileId: p.id } 
                 });
                 menu.classList.remove('visible');
             };
             menu.appendChild(item);
        });
        
        const configItem = document.createElement('div');
        configItem.className = 'custom-menu-item';
        configItem.style.borderTop = '1px solid var(--vscode-menu-separatorBackground)';
        configItem.style.marginTop = '4px';
        configItem.style.paddingTop = '8px';
        configItem.innerHTML = `<span class="codicon codicon-gear"></span> Configure Modes...`;
        configItem.onclick = (e) => {
            e.stopPropagation();
            vscode.postMessage({ command: 'openSettings' });
            menu.classList.remove('visible');
        };
        menu.appendChild(configItem);

        modeBadge.onclick = (e) => {
            e.stopPropagation();
             document.querySelectorAll('.custom-menu').forEach(m => {
                if (m.id !== 'profile-menu') m.classList.remove('visible');
            });
            menu.classList.toggle('visible');
        };

        wrapper.appendChild(modeBadge);
        wrapper.appendChild(menu);
        infraGroup.appendChild(wrapper);
    }

    // --- THEME: TASK & TEAM ---
    if (guiState.agentBadge || caps.herdMode) {
        const taskGroup = document.createElement('div');
        taskGroup.className = 'badge-group';
        taskGroup.innerHTML = '<span class="badge-group-label">Task</span>';
        container.appendChild(taskGroup);

        const agentBadge = createToggleBadge('🤖 Agent', 'agent', guiState.agentBadge, caps.agentMode, () => {
            vscode.postMessage({ command: 'toggleAgentMode' });
        });
        if (agentBadge) taskGroup.appendChild(agentBadge);

        const herdBadge = createToggleBadge('🐂 Herd', 'herd', guiState.herdBadge, caps.herdMode, () => {
            vscode.postMessage({ command: 'updateDiscussionCapabilitiesPartial', partial: { herdMode: !caps.herdMode } });
        });
        if (herdBadge) taskGroup.appendChild(herdBadge);
    }

    // --- THEME: KNOWLEDGE & RESEARCH ---
    if (guiState.autoContextBadge || guiState.autoSkillBadge !== false || guiState.webSearchBadge !== false) {
        const knowledgeGroup = document.createElement('div');
        knowledgeGroup.className = 'badge-group';
        knowledgeGroup.innerHTML = '<span class="badge-group-label">Knowledge</span>';
        container.appendChild(knowledgeGroup);

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
        if (ctxBadge) knowledgeGroup.appendChild(ctxBadge);

        const skillBadge = createToggleBadge(
            '💡 AutoSkill',
            'autoskill',
            guiState.autoSkillBadge !== false,
            caps.autoSkillMode,
            () => {
                vscode.postMessage({ command: 'updateDiscussionCapabilitiesPartial', partial: { autoSkillMode: !caps.autoSkillMode } });
            },
            () => {
                const prompt = dom.messageInput ? dom.messageInput.value : "";
                vscode.postMessage({ command: 'runAutoSkill', prompt: prompt });
            }
        );
        if (skillBadge) knowledgeGroup.appendChild(skillBadge);

        // Enhanced Web Search Toggle Badge with Activity Log
        const webBadge = createToggleBadge(
            '🌍 Web Search', 'web', 
            guiState.webSearchBadge !== false, 
            caps.webSearch, 
            () => {
                vscode.postMessage({ command: 'updateDiscussionCapabilitiesPartial', partial: { webSearch: !caps.webSearch } });
            },
            () => {
                const text = dom.messageInput.value.trim();
                vscode.postMessage({ command: 'internetHelpSearch', query: text });
                dom.messageInput.value = '';
                dom.messageInput.style.height = 'auto';
            }
        );
        
        if (webBadge) {
            webBadge.classList.add('websearch-indicator');
            const logContainer = document.createElement('div');
            logContainer.id = 'web-search-log';
            logContainer.className = 'websearch-log';
            
            webBadge.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                logContainer.classList.toggle('visible');
            });
            
            knowledgeGroup.appendChild(webBadge);
            knowledgeGroup.appendChild(logContainer);
        }
    }

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

export function renderSkillsTree(container: HTMLElement, node: any, activeSkillIds: string[] = []) {
    if (!node.children || node.children.length === 0) return;

    // Sort: Folders first, then files
    node.children.sort((a: any, b: any) => {
        if (a.isSkill === b.isSkill) return a.label.localeCompare(b.label);
        return a.isSkill ? 1 : -1;
    });

    const ul = document.createElement('ul');
    ul.className = 'skills-tree-list';

    node.children.forEach((child: any) => {
        const li = document.createElement('li');
        li.className = 'skills-tree-item';
        
        if (child.isSkill) {
            // Leaf Node
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'skill-checkbox';
            checkbox.value = child.id;
            checkbox.id = `skill-${child.id}`;
            // FIX: Check if this specific skill is in the active list
            checkbox.checked = activeSkillIds.includes(child.id);

            const label = document.createElement('label');
            label.htmlFor = `skill-${child.id}`;
            label.innerHTML = `<span class="codicon codicon-file-code"></span> ${child.label}`;
            label.title = child.description || '';
            
            const div = document.createElement('div');
            div.className = 'skill-node';
            div.appendChild(checkbox);
            div.appendChild(label);
            li.appendChild(div);
        } else {
            // Bundle Node (Folder)
            const details = document.createElement('details');
            // Packed by default: set to false
            details.open = false; 
            
            const summary = document.createElement('summary');
            summary.className = 'skill-summary';
            
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'bundle-checkbox';
            checkbox.dataset.path = child.id;
            
            // Handle bundle checking (cascade)
            checkbox.addEventListener('change', (e) => {
                const checked = (e.target as HTMLInputElement).checked;
                const childCheckboxes = li.querySelectorAll('input[type="checkbox"]');
                childCheckboxes.forEach((cb: any) => cb.checked = checked);
            });

            const handle = document.createElement('span');
            handle.className = 'folder-handle codicon';

            const labelSpan = document.createElement('span');
            labelSpan.className = 'skill-folder-label';
            labelSpan.innerHTML = `
                <span class="codicon codicon-folder"></span> 
                ${child.label}
            `;
            
            summary.appendChild(handle); // Handle first
            summary.appendChild(checkbox); // Checkbox second
            summary.appendChild(labelSpan); // Label last
            details.appendChild(summary);
            
            // Recursion
            const childrenContainer = document.createElement('div');
            childrenContainer.className = 'skill-children';
            // CRITICAL FIX: Pass the activeSkillIds down to the next level of recursion
            renderSkillsTree(childrenContainer, child, activeSkillIds);
            details.appendChild(childrenContainer);
            
            // UI Improvement: If any child is checked, ensure parent shows state
            // (Wait until after recursion so children checkboxes are created)
            const leafCheckboxes = childrenContainer.querySelectorAll('.skill-checkbox') as NodeListOf<HTMLInputElement>;
            const anyChecked = Array.from(leafCheckboxes).some(cb => cb.checked);
            const allChecked = leafCheckboxes.length > 0 && Array.from(leafCheckboxes).every(cb => cb.checked);
            
            if (allChecked) {
                checkbox.checked = true;
            } else if (anyChecked) {
                checkbox.indeterminate = true;
            }

            li.appendChild(details);
        }
        ul.appendChild(li);
    });

    container.appendChild(ul);
}
