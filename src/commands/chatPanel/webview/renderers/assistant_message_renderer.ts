import { vscode, state } from '../dom.js';
import { renderMessageContent, stripThinkingTags } from '../messageRenderer.js';

export function renderAssistantMessage(messageId: string, rawContent: any, isFinal: boolean) {
    const safeMessageId = String(messageId || '');
    if (!safeMessageId) return;

    const wrapper = document.querySelector(`.message-wrapper[data-message-id='${safeMessageId}']`) as HTMLElement;
    if (!wrapper) return;

    const bodyDiv = wrapper.querySelector('.message-body') as HTMLElement;
    if (!bodyDiv) return;

    // Detect message role accurately
    const isUser = safeMessageId.startsWith('user_') || wrapper.querySelector('.message')?.classList.contains('user-message');
    const isLibrarianReport = (typeof rawContent === 'string' && rawContent.startsWith('Librarian agent report:')) || safeMessageId.startsWith('lib_report_');
    const isContextShield = safeMessageId.startsWith('verification_notice_') || (typeof rawContent === 'string' && rawContent.startsWith('Librarian Verification Notice:')) || wrapper.dataset.personalityName?.includes('Context Shield');
    const isLibrarian = !isContextShield && (isLibrarianReport || safeMessageId.startsWith('governor_') || safeMessageId.startsWith('librarian_') || wrapper.dataset.personalityName?.includes('Governor') || wrapper.dataset.personalityName?.includes('Librarian'));
    const isSystem = !isLibrarian && !isContextShield && (safeMessageId.startsWith('error_') || safeMessageId.startsWith('system_') || wrapper.querySelector('.message')?.classList.contains('system-message'));

    const msgDiv = wrapper.querySelector('.message') as HTMLElement;

    // Update avatar icon and color theme for Librarian or Context Shield
    if (isContextShield) {
        const avatarDiv = wrapper.querySelector('.message-avatar') as HTMLElement;
        if (avatarDiv) {
            avatarDiv.innerHTML = '<span class="codicon codicon-shield" style="color:var(--vscode-charts-blue)"></span>';
            avatarDiv.style.backgroundColor = 'rgba(0, 122, 204, 0.1)';
            avatarDiv.style.border = '1px solid var(--vscode-charts-blue)';
        }
        if (msgDiv) {
            msgDiv.style.borderLeftColor = 'var(--vscode-charts-blue)';
        }
    } else if (isLibrarian) {
        const avatarDiv = wrapper.querySelector('.message-avatar') as HTMLElement;
        if (avatarDiv) {
            avatarDiv.innerHTML = '<span class="codicon codicon-library" style="color:var(--vscode-charts-orange)"></span>';
            avatarDiv.style.backgroundColor = 'rgba(214, 122, 13, 0.18)';
            avatarDiv.style.border = '1px solid var(--vscode-charts-orange)';
        }
        if (msgDiv) {
            msgDiv.classList.add('librarian-message');
            msgDiv.style.borderLeftColor = 'var(--vscode-charts-orange)';
        }
    }

    // Check if we need to initialize the layout
    let layout = bodyDiv.querySelector('.assistant-layout');
    if (!layout) {
        bodyDiv.innerHTML = ''; // Clear prior shells

        // Build dynamic action buttons depending on the message role
        const collapseActionBtn = `<button class="msg-action-btn collapse-msg-action-btn" title="Collapse / Expand Message"><i class="codicon codicon-fold"></i></button>`;
        const editButton = `<button class="msg-action-btn edit-msg-btn" title="Edit Message"><i class="codicon codicon-edit"></i></button>`;
        const copyButton = `<button class="msg-action-btn copy-msg-btn" title="Copy Message"><i class="codicon codicon-copy"></i></button>`;
        const deleteButton = `<button class="msg-action-btn delete-msg-btn" title="Delete Message"><i class="codicon codicon-trash"></i></button>`;

        const middleButton = isUser 
            ? `<button class="msg-action-btn regenerate-msg-btn" title="Regenerate Response"><i class="codicon codicon-sync"></i></button>`
            : ((isSystem || isLibrarian) ? '' : `<button class="msg-action-btn run-monitor-btn" title="Run App & Monitor Logs"><i class="codicon codicon-play"></i></button>`);

        // Floating Message Actions HUD
        const actions = document.createElement('div');
        actions.className = 'message-actions';
        actions.innerHTML = (isSystem || isLibrarian) ? `${collapseActionBtn}${copyButton}${deleteButton}` : `${collapseActionBtn}${editButton}${copyButton}${middleButton}${deleteButton}`;
        bodyDiv.appendChild(actions);

        // Header Metadata with Collapse Toggle
        const header = document.createElement('div');
        header.className = 'message-header';

        const collapseBtn = document.createElement('button');
        collapseBtn.className = 'msg-collapse-btn';
        collapseBtn.title = 'Collapse / Expand this message';
        collapseBtn.innerHTML = '<i class="codicon codicon-chevron-down"></i>';

        const roleSpan = document.createElement('span');
        roleSpan.className = 'role-name';
        if (isContextShield) {
            roleSpan.textContent = '🛡️ Context Shield (Target File Audit)';
            roleSpan.style.color = 'var(--vscode-charts-blue)';
            roleSpan.style.fontWeight = 'bold';
        } else if (isLibrarian) {
            roleSpan.textContent = '📚 Lead Librarian (Scout Report)';
            roleSpan.style.color = 'var(--vscode-charts-orange)';
            roleSpan.style.fontWeight = 'bold';
        } else if (isUser) {
            roleSpan.textContent = 'You';
        } else if (isSystem) {
            roleSpan.textContent = 'System Alert';
            roleSpan.style.color = 'var(--vscode-charts-red)';
            roleSpan.style.fontWeight = 'bold';
        } else {
            const personaLabel = wrapper.dataset.personalityName || 'Lollms Coder';
            roleSpan.textContent = `${personaLabel} (Assistant)`;
        }

        const previewPill = document.createElement('span');
        previewPill.className = 'collapsed-msg-preview';
        previewPill.style.display = 'none';

        header.appendChild(collapseBtn);
        header.appendChild(roleSpan);
        header.appendChild(previewPill);
        bodyDiv.appendChild(header);

        // Target Content Container
        layout = document.createElement('div');
        layout.className = 'assistant-layout message-content';
        layout.id = `content-${messageId}`;
        bodyDiv.appendChild(layout);

        const updateCollapseState = (forceCollapse?: boolean, scrollIntoView: boolean = false) => {
            const isCollapsed = forceCollapse !== undefined 
                ? (forceCollapse ? (wrapper.classList.add('collapsed-message'), true) : (wrapper.classList.remove('collapsed-message'), false))
                : wrapper.classList.toggle('collapsed-message');

            collapseBtn.innerHTML = `<i class="codicon ${isCollapsed ? 'codicon-chevron-right' : 'codicon-chevron-down'}"></i>`;

            if (isCollapsed) {
                previewPill.innerHTML = '';
                const fileBlocks = wrapper.querySelectorAll('.file-mutation-card, details.code-collapsible');
                const fileCount = fileBlocks.length;

                let pillHtml = '';
                if (fileCount > 0) {
                    const applyBtn = wrapper.querySelector('.apply-all-btn');
                    const isAllApplied = applyBtn?.classList.contains('undo-all-btn');
                    pillHtml += `<span class="collapsed-badge files" style="background:rgba(0,122,204,0.18); color:var(--vscode-charts-blue); border:1px solid rgba(0,122,204,0.35); padding:1px 6px; border-radius:10px; font-size:10px;"><i class="codicon codicon-file-code"></i> ${fileCount} file${fileCount > 1 ? 's' : ''} ${isAllApplied ? '(Applied)' : '(Pending)'}</span>`;
                }
                if (isLibrarian) {
                    pillHtml += `<span class="collapsed-badge lib" style="background:rgba(214,122,13,0.18); color:var(--vscode-charts-orange); border:1px solid rgba(214,122,13,0.35); padding:1px 6px; border-radius:10px; font-size:10px;"><i class="codicon codicon-library"></i> Librarian Report</span>`;
                }

                let textSnippet = "";
                try {
                    const parsed = wrapper.querySelector('.message') ? JSON.parse((wrapper.querySelector('.message') as HTMLElement).dataset.originalContent || '""') : "";
                    const rawStr = typeof parsed === 'string' ? parsed : (Array.isArray(parsed) ? parsed.map((p: any) => p.text || '').join(' ') : '');
                    textSnippet = rawStr.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 50);
                } catch {}

                if (textSnippet && !isLibrarian && fileCount === 0) {
                    pillHtml += `<span style="opacity:0.65; font-style:italic; font-size:10.5px; max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">"${textSnippet}..."</span>`;
                }

                previewPill.innerHTML = pillHtml;
                previewPill.style.display = 'inline-flex';
                previewPill.style.alignItems = 'center';
                previewPill.style.gap = '6px';
                previewPill.style.marginLeft = '8px';

                // --- QUICK-ACTION BUTTONS ON COLLAPSED BAR ---
                // 1. Apply All / Undo All
                const applyAllBtn = wrapper.querySelector('.apply-all-btn') as HTMLButtonElement;
                if (applyAllBtn) {
                    const isUndo = applyAllBtn.classList.contains('undo-all-btn');
                    const quickApply = document.createElement('button');
                    quickApply.className = `code-action-btn ${isUndo ? 'secondary-btn' : 'apply-btn'} collapsed-quick-apply`;
                    quickApply.style.cssText = 'height: 20px; font-size: 9.5px; padding: 0 8px; font-weight: bold; margin-left: 4px;';
                    quickApply.innerHTML = isUndo 
                        ? '<i class="codicon codicon-discard"></i> Undo All' 
                        : '<i class="codicon codicon-check-all"></i> Apply All';
                    quickApply.onclick = (e) => {
                        e.stopPropagation();
                        applyAllBtn.click();
                    };
                    previewPill.appendChild(quickApply);
                }

                // 2. Copy Files Content
                const copyAllBtn = wrapper.querySelector('.copy-all-turn-context-btn, .copy-files-to-clipboard-btn') as HTMLButtonElement;
                if (copyAllBtn) {
                    const quickCopy = document.createElement('button');
                    quickCopy.className = 'code-action-btn secondary-btn collapsed-quick-copy';
                    quickCopy.style.cssText = 'height: 20px; font-size: 9.5px; padding: 0 8px; font-weight: bold; margin-left: 2px;';
                    quickCopy.innerHTML = '<i class="codicon codicon-copy"></i> Copy Files';
                    quickCopy.title = "Copy all files content to clipboard as <file> blocks";
                    quickCopy.onclick = (e) => {
                        e.stopPropagation();
                        copyAllBtn.click();
                    };
                    previewPill.appendChild(quickCopy);
                }

                // 3. Execute All Actions (Peeks/Context/Unmutes/Tools)
                const executeAllBtn = wrapper.querySelector('.execute-all-actions-btn') as HTMLButtonElement;
                if (executeAllBtn && !executeAllBtn.disabled) {
                    const quickExec = document.createElement('button');
                    quickExec.className = 'code-action-btn apply-btn collapsed-quick-exec';
                    quickExec.style.cssText = 'height: 20px; font-size: 9.5px; padding: 0 8px; font-weight: bold; margin-left: 2px; background: var(--vscode-charts-purple, #9b59b6) !important; color: white !important;';
                    quickExec.innerHTML = '<i class="codicon codicon-play"></i> Run Actions';
                    quickExec.title = "Execute all pending actions in this message";
                    quickExec.onclick = (e) => {
                        e.stopPropagation();
                        executeAllBtn.click();
                    };
                    previewPill.appendChild(quickExec);
                }

                // 4. Add Files to Context
                const addFilesBtn = wrapper.querySelector('.context-expansion-block .add-btn:not(.applied), .add-files-to-context-btn:not(.applied)') as HTMLButtonElement;
                if (addFilesBtn && !addFilesBtn.disabled && !wrapper.querySelector('.collapsed-quick-exec')) {
                    const quickAdd = document.createElement('button');
                    quickAdd.className = 'code-action-btn apply-btn collapsed-quick-add';
                    quickAdd.style.cssText = 'height: 20px; font-size: 9.5px; padding: 0 8px; font-weight: bold; margin-left: 2px;';
                    quickAdd.innerHTML = '<i class="codicon codicon-add"></i> Add to Context';
                    quickAdd.title = "Add requested files to context";
                    quickAdd.onclick = (e) => {
                        e.stopPropagation();
                        addFilesBtn.click();
                    };
                    previewPill.appendChild(quickAdd);
                }

                // 5. Unmute Files
                const unmuteBtn = wrapper.querySelector('.unmute-files-block .unmute-btn:not(.applied), [data-action-type="unmute"] .unmute-btn:not(.applied)') as HTMLButtonElement;
                if (unmuteBtn && !unmuteBtn.disabled && !wrapper.querySelector('.collapsed-quick-exec')) {
                    const quickUnmute = document.createElement('button');
                    quickUnmute.className = 'code-action-btn apply-btn collapsed-quick-unmute';
                    quickUnmute.style.cssText = 'height: 20px; font-size: 9.5px; padding: 0 8px; font-weight: bold; margin-left: 2px; background: var(--vscode-charts-green) !important; color: white !important;';
                    quickUnmute.innerHTML = '<i class="codicon codicon-eye"></i> Unmute Files';
                    quickUnmute.title = "Unmute requested files";
                    quickUnmute.onclick = (e) => {
                        e.stopPropagation();
                        unmuteBtn.click();
                    };
                    previewPill.appendChild(quickUnmute);
                }

                if (scrollIntoView) {
                    wrapper.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                }
            } else {
                previewPill.style.display = 'none';
            }
        };

        // Attach toggleCollapse to wrapper for bottom button access
        (wrapper as any).toggleCollapse = (forceCollapse?: boolean, scrollIntoView: boolean = true) => {
            updateCollapseState(forceCollapse, scrollIntoView);
        };

        collapseBtn.onclick = (e) => {
            e.stopPropagation();
            updateCollapseState();
        };

        actions.querySelector('.collapse-msg-action-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            updateCollapseState();
        });

        header.ondblclick = (e) => {
            if ((e.target as HTMLElement).closest('button')) return;
            updateCollapseState();
        };

        // Bind events
        actions.querySelector('.edit-msg-btn')?.addEventListener('click', () => {
            const msgDiv = wrapper.querySelector('.message') as HTMLElement;
            if (msgDiv && (window as any).startEdit) (window as any).startEdit(msgDiv, messageId, isUser ? 'user' : 'assistant');
        });
        actions.querySelector('.copy-msg-btn')?.addEventListener('click', () => {
            let textToCopy = "";
            const msgDiv = wrapper.querySelector('.message') as HTMLElement;
            if (msgDiv && msgDiv.dataset.originalContent) {
                try {
                    const parsed = JSON.parse(msgDiv.dataset.originalContent);
                    if (typeof parsed === 'string') textToCopy = parsed;
                    else if (Array.isArray(parsed)) textToCopy = parsed.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n');
                    else textToCopy = String(parsed);
                } catch {
                    textToCopy = msgDiv.dataset.originalContent;
                }
            }
            if (!textToCopy) {
                const contentEl = wrapper.querySelector('.message-content');
                textToCopy = contentEl ? (contentEl.textContent || '') : '';
            }

            vscode.postMessage({ command: 'copyToClipboard', text: textToCopy });

            const copyIcon = actions.querySelector('.copy-msg-btn i, .copy-msg-btn .codicon');
            if (copyIcon) {
                const origClass = copyIcon.className;
                copyIcon.className = 'codicon codicon-check';
                setTimeout(() => { copyIcon.className = origClass; }, 2000);
            }
        });
        actions.querySelector('.regenerate-msg-btn')?.addEventListener('click', () => {
            vscode.postMessage({ command: 'regenerateFromMessage', messageId });
        });
        actions.querySelector('.run-monitor-btn')?.addEventListener('click', () => {
            vscode.postMessage({ command: 'runAndMonitorApp', messageId });
        });
        actions.querySelector('.delete-msg-btn')?.addEventListener('click', () => {
            vscode.postMessage({ command: 'requestDeleteMessage', messageId });
        });
    }

    renderMessageContent(messageId, rawContent, isFinal);
}
