import { dom, state, vscode } from "./dom.js";
import { isScrolledToBottom } from "./utils.js";

function getStatusEmoji(text: string): string {
    const lower = text.toLowerCase();
    if (lower.includes('search') || lower.includes('research')) return '🌍';
    if (lower.includes('title')) return '🏷️';
    if (lower.includes('skill')) return '💡';
    if (lower.includes('context') || lower.includes('file')) return '🧠';
    if (lower.includes('agent')) return '🤖';
    if (lower.includes('analyz')) return '🔬';
    return '✍️';
}

export function renderPendingImages() {
    if (!dom.attachmentPreviewArea) return;
    dom.attachmentPreviewArea.innerHTML = '';
    
    state.pendingImages.forEach((img, idx) => {
        const card = document.createElement('div');
        card.className = 'staged-image-card';
        card.style.backgroundImage = `url(${img.data})`;
        
        const edit = document.createElement('div');
        edit.className = 'edit-btn';
        edit.innerHTML = '<span class="codicon codicon-edit"></span>';
        edit.onclick = () => {
            openImageEditor(idx);
        };

        const remove = document.createElement('div');
        remove.className = 'remove-btn';
        remove.innerHTML = '<span class="codicon codicon-close"></span>';
        remove.onclick = () => {
            state.pendingImages.splice(idx, 1);
            renderPendingImages();
        };
        
        card.appendChild(edit);
        card.appendChild(remove);
        dom.attachmentPreviewArea.appendChild(card);
    });
}

let canvasCtx: CanvasRenderingContext2D | null = null;
let currentEditingIdx: number | null = null;
let isDrawing = false;
let isPanning = false;
let currentTool = 'brush';
let textInputPos = { x: 0, y: 0, w: 0, h: 0 };
let startPos = { x: 0, y: 0 };
let lastPanPos = { x: 0, y: 0 };
let webcamStream: MediaStream | null = null;

// Zoom & Pan State
let viewState = {
    scale: 1,
    offsetX: 0,
    offsetY: 0
};

// Helper to convert screen mouse coords to internal canvas coords
function getTransformedPoint(x: number, y: number) {
    return {
        x: (x - viewState.offsetX) / viewState.scale,
        y: (y - viewState.offsetY) / viewState.scale
    };
}

// Undo/Redo System
let undoStack: string[] = [];
let redoStack: string[] = [];

function saveState() {
    if (!dom.editorCanvas) return;
    undoStack.push(dom.editorCanvas.toDataURL());
    redoStack = []; // Clear redo on new action
    if (undoStack.length > 50) undoStack.shift();
}

function undo() {
    if (undoStack.length < 2) return; // Keep current state
    const current = undoStack.pop()!;
    redoStack.push(current);
    const prev = undoStack[undoStack.length - 1];
    loadState(prev);
}

function redo() {
    if (redoStack.length === 0) return;
    const next = redoStack.pop()!;
    undoStack.push(next);
    loadState(next);
}

function loadState(dataUrl: string) {
    const img = new Image();
    img.onload = () => {
        if (!canvasCtx || !dom.editorCanvas) return;
        // Reset transform to clear the whole physical area
        canvasCtx.setTransform(1, 0, 0, 1, 0, 0);
        canvasCtx.clearRect(0, 0, dom.editorCanvas.width, dom.editorCanvas.height);
        
        // Re-apply current zoom/pan before drawing the background image
        canvasCtx.setTransform(viewState.scale, 0, 0, viewState.scale, viewState.offsetX, viewState.offsetY);
        canvasCtx.drawImage(img, 0, 0);
    };
    img.src = dataUrl;
}

function redrawCanvas() {
    if (undoStack.length > 0) {
        loadState(undoStack[undoStack.length - 1]);
    }
}

export function openImageEditor(index: number | null = null): void {
    currentEditingIdx = index;
    const modal = dom.editorModal;
    const canvas = dom.editorCanvas;
    if (!modal || !canvas) return;

    modal.style.display = 'flex';
    canvasCtx = canvas.getContext('2d');
    
    undoStack = [];
    redoStack = [];

    if (index !== null) {
        const img = new Image();
        img.onload = () => {
            canvas.width = img.width;
            canvas.height = img.height;
            canvasCtx?.drawImage(img, 0, 0);
            saveState(); // Initial state
        };
        img.src = state.pendingImages[index].data;
    } else {
        canvas.width = 800;
        canvas.height = 600;
        if (canvasCtx) {
            canvasCtx.fillStyle = 'white';
            canvasCtx.fillRect(0, 0, canvas.width, canvas.height);
        }
        saveState(); // Initial state
    }

    initCanvasEvents();
}

async function startWebcam() {
    try {
        // Standard browser prompt for camera access
        webcamStream = await navigator.mediaDevices.getUserMedia({ 
            video: { 
                width: { ideal: 1280 }, 
                height: { ideal: 720 },
                facingMode: "user" 
            }, 
            audio: false 
        });
        
        dom.webcamFeed.srcObject = webcamStream;
        dom.webcamContainer.style.display = 'flex';
        
    } catch (err: any) {
        stopWebcam();
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
            vscode.postMessage({ command: 'updateStatus', status: 'Webcam Blocked', type: 'error' });
            
            dom.webcamContainer.style.display = 'flex';
            dom.webcamContainer.innerHTML = ''; // Clear previous

            const wrapper = document.createElement('div');
            wrapper.style.cssText = "padding: 20px; text-align: center; color: white; display: flex; flex-direction: column; align-items: center; gap: 10px;";
            
            const icon = document.createElement('i');
            icon.className = 'codicon codicon-error';
            icon.style.cssText = "font-size: 30px; color: var(--vscode-charts-red);";
            
            const title = document.createElement('p');
            title.innerHTML = '<strong>Camera Access Blocked</strong>';
            
            const text = document.createElement('p');
            text.style.fontSize = '11px';
            text.style.opacity = '0.8';
            text.textContent = 'VS Code permission denied. You must reload the window to reset the permission prompt.';

            const reloadBtn = document.createElement('button');
            reloadBtn.className = 'code-action-btn apply-btn';
            reloadBtn.style.width = '100%';
            reloadBtn.textContent = 'Reload Window (Force Prompt)';
            reloadBtn.onclick = () => {
                vscode.postMessage({
                    command: 'executeLollmsCommand', 
                    details: { command: 'workbench.action.reloadWindow', params: {} }
                });
            };

            const cancelBtn = document.createElement('button');
            cancelBtn.className = 'code-action-btn';
            cancelBtn.style.width = '100%';
            cancelBtn.textContent = 'Cancel';
            cancelBtn.onclick = () => { dom.webcamContainer.style.display = 'none'; };

            wrapper.append(icon, title, text, reloadBtn, cancelBtn);
            dom.webcamContainer.appendChild(wrapper);
        } else {
            vscode.postMessage({ command: 'showError', message: 'Webcam Error: ' + err.message });
        }
    }
}

function stopWebcam() {
    if (webcamStream) {
        webcamStream.getTracks().forEach(track => track.stop());
        webcamStream = null;
    }
    dom.webcamFeed.srcObject = null;
    dom.webcamContainer.style.display = 'none';
}

function captureWebcam() {
    const video = dom.webcamFeed;
    const canvas = dom.editorCanvas;

    if (video.videoWidth === 0) return; // Video not ready
    
    // 1. Setup Canvas dimensions
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    
    // 2. Clear canvas first
    canvasCtx!.fillStyle = "white";
    canvasCtx!.fillRect(0, 0, canvas.width, canvas.height);

    // 3. Draw video frame (mirrored to match preview)
    canvasCtx?.save();
    canvasCtx?.translate(canvas.width, 0);
    canvasCtx?.scale(-1, 1);
    canvasCtx?.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvasCtx?.restore();
    
    // 4. Close the feed
    stopWebcam();
    
    // 5. Notify the user they can now draw or save
    vscode.postMessage({ command: 'updateStatus', status: 'Photo Captured. You can now draw on it or Save.', type: 'info' });
}

function initCanvasEvents() {
    const canvas = dom.editorCanvas;
    if (!canvas || !canvasCtx) return;

    // --- ZOOM LOGIC (Wheel) ---
    canvas.onwheel = (e) => {
        e.preventDefault();
        const zoomSpeed = 0.0015;
        const delta = -e.deltaY;
        const factor = Math.pow(1.1, delta / 100);
        
        const newScale = Math.min(Math.max(viewState.scale * factor, 0.1), 10);
        
        // Zoom relative to mouse position
        const mouse = { x: e.offsetX, y: e.offsetY };
        viewState.offsetX = mouse.x - (mouse.x - viewState.offsetX) * (newScale / viewState.scale);
        viewState.offsetY = mouse.y - (mouse.y - viewState.offsetY) * (newScale / viewState.scale);
        viewState.scale = newScale;

        redrawCanvas();
    };

    canvas.onmousedown = (e) => {
        // Middle button (1) or Space+Left triggers Pan
        if (e.button === 1 || (e.button === 0 && (window as any).isSpaceDown)) {
            isPanning = true;
            lastPanPos = { x: e.clientX, y: e.clientY };
            canvas.style.cursor = 'grabbing';
            return;
        }

        if (dom.editorTextInput.style.display === 'block') {
            commitTextToCanvas();
        }

        const pt = getTransformedPoint(e.offsetX, e.offsetY);
        startPos = pt;
        isDrawing = true;

        if (currentTool === 'brush') {
            canvasCtx!.setTransform(viewState.scale, 0, 0, viewState.scale, viewState.offsetX, viewState.offsetY);
            canvasCtx!.beginPath();
            canvasCtx!.moveTo(pt.x, pt.y);
            canvasCtx!.strokeStyle = (document.getElementById('editor-color') as HTMLInputElement).value;
            canvasCtx!.lineWidth = parseInt((document.getElementById('editor-width') as HTMLInputElement).value) / viewState.scale;
            canvasCtx!.lineCap = 'round';
            canvasCtx!.lineJoin = 'round';
        }
    };

    canvas.onmousemove = (e) => {
        if (isPanning) {
            const dx = e.clientX - lastPanPos.x;
            const dy = e.clientY - lastPanPos.y;
            viewState.offsetX += dx;
            viewState.offsetY += dy;
            lastPanPos = { x: e.clientX, y: e.clientY };
            redrawCanvas();
            return;
        }

        if (!isDrawing) return;

        const pt = getTransformedPoint(e.offsetX, e.offsetY);

        if (currentTool === 'brush') {
            canvasCtx!.lineTo(pt.x, pt.y);
            canvasCtx!.stroke();
        } else if (currentTool === 'text') {
            redrawCanvas();
            canvasCtx!.setLineDash([5 / viewState.scale, 5 / viewState.scale]);
            canvasCtx!.strokeStyle = 'gray';
            canvasCtx!.lineWidth = 1 / viewState.scale;
            canvasCtx!.strokeRect(startPos.x, startPos.y, pt.x - startPos.x, pt.y - startPos.y);
            canvasCtx!.setLineDash([]);
        }
    };

    canvas.onmouseup = (e) => {
        if (isPanning) {
            isPanning = false;
            canvas.style.cursor = 'crosshair';
            return;
        }

        if (!isDrawing) return;
        isDrawing = false;

        const pt = getTransformedPoint(e.offsetX, e.offsetY);

        if (currentTool === 'brush') {
            saveState();
        } else if (currentTool === 'text') {
            const width = Math.abs(pt.x - startPos.x);
            const height = Math.abs(pt.y - startPos.y);
            const x = Math.min(startPos.x, pt.x);
            const y = Math.min(startPos.y, pt.y);

            if (width > 5 && height > 5) {
                // Convert back to screen coords for the input box placement
                const screenPos = {
                    x: x * viewState.scale + viewState.offsetX,
                    y: y * viewState.scale + viewState.offsetY,
                    w: width * viewState.scale,
                    h: height * viewState.scale
                };
                showTextInput(x, y, width, height, screenPos);
            }
        }
    };
    
    const brushTool = document.getElementById('tool-brush');
    if (brushTool) {
        brushTool.onclick = (e) => {
            e.preventDefault();
            currentTool = 'brush';
        };
    }

    const textTool = document.getElementById('tool-text');
    if (textTool) {
        textTool.onclick = (e) => {
            e.preventDefault();
            currentTool = 'text';
        };
    }

    const undoBtn = document.getElementById('editor-undo');
    if (undoBtn) undoBtn.onclick = undo;

    const redoBtn = document.getElementById('editor-redo');
    if (redoBtn) redoBtn.onclick = redo;

    if (dom.toolWebcam) {
        dom.toolWebcam.onclick = (e) => {
            e.preventDefault();
            startWebcam();
        };
    }

    if (dom.webcamCaptureBtn) {
        dom.webcamCaptureBtn.onclick = captureWebcam;
    }

    if (dom.webcamCancelBtn) {
        dom.webcamCancelBtn.onclick = stopWebcam;
    }
    
    dom.editorClearBtn.onclick = () => {
        canvasCtx!.fillStyle = 'white';
        canvasCtx!.fillRect(0, 0, canvas.width, canvas.height);
    };

    dom.editorCancelBtn.onclick = () => {
        dom.editorModal.style.display = 'none';
    };

    dom.editorSaveBtn.onclick = () => {
        // Ensure any active text is drawn before capturing the data URL
        commitTextToCanvas();

        const dataUrl = canvas.toDataURL('image/png');
        if (currentEditingIdx !== null) {
            state.pendingImages[currentEditingIdx].data = dataUrl;
        } else {
            state.pendingImages.push({ name: `drawing_${Date.now()}.png`, data: dataUrl });
        }
        dom.editorModal.style.display = 'none';
        renderPendingImages();
    };
}

function commitTextToCanvas() {
    const input = dom.editorTextInput;
    if (input.style.display === 'block' && input.value.trim() !== '') {
        const fontSize = parseInt(input.style.fontSize);
        canvasCtx!.fillStyle = input.style.color;
        canvasCtx!.font = `${fontSize}px sans-serif`;
        canvasCtx!.textBaseline = 'top';

        wrapTextToCanvas(
            canvasCtx!, 
            input.value, 
            textInputPos.x, 
            textInputPos.y, 
            textInputPos.w, 
            fontSize * 1.2
        );
        saveState();
    }
    input.style.display = 'none';
}

function wrapTextToCanvas(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number, lineHeight: number) {
    const words = text.split(' ');
    let line = '';

    for (let n = 0; n < words.length; n++) {
        const testLine = line + words[n] + ' ';
        const metrics = ctx.measureText(testLine);
        const testWidth = metrics.width;
        if (testWidth > maxWidth && n > 0) {
            ctx.fillText(line, x, y);
            line = words[n] + ' ';
            y += lineHeight;
        } else {
            line = testLine;
        }
    }
    ctx.fillText(line, x, y);
}

function showTextInput(x: number, y: number, w: number, h: number, screenPos: any) {
    const input = dom.editorTextInput;
    textInputPos = { x, y, w, h };
    
    input.style.display = 'block';
    input.style.left = `${dom.editorCanvas.offsetLeft + screenPos.x}px`;
    input.style.top = `${dom.editorCanvas.offsetTop + screenPos.y}px`;
    input.style.width = `${screenPos.w}px`;
    input.style.height = `${screenPos.h}px`;
    
    input.style.color = (document.getElementById('editor-color') as HTMLInputElement).value;
    input.style.fontSize = `${(document.getElementById('editor-font-size') as HTMLInputElement).value}px`;
    input.value = '';
    
    // Switch tool UI back to brush immediately so next click validates
    currentTool = 'brush'; 
    
    setTimeout(() => input.focus(), 10);

    input.onkeydown = (e) => {
        if (e.key === 'Enter' && e.ctrlKey) {
            commitTextToCanvas();
        } else if (e.key === 'Escape') {
            input.style.display = 'none';
            loadState(undoStack[undoStack.length - 1]); // Clean up the preview box
        }
    };
}

export function setGeneratingState(isGenerating: boolean, statusText?: string) {
    if (state.isGenerating === isGenerating && !statusText) return;
    
    state.isGenerating = isGenerating;

    if (statusText) {
        if (dom.statusText) dom.statusText.textContent = statusText;
        
        // --- STEP TIMELINE LOGIC ---
        const dots = document.querySelectorAll('.step-dot');
        const lowerStatus = statusText.toLowerCase();
        let activeIdx = 0;

        if (lowerStatus.includes('plan') || lowerStatus.includes('analyz')) activeIdx = 0;
        else if (lowerStatus.includes('search') || lowerStatus.includes('librarian') || lowerStatus.includes('web')) activeIdx = 1;
        else if (lowerStatus.includes('generat') || lowerStatus.includes('writing')) activeIdx = 2;
        else if (lowerStatus.includes('apply') || lowerStatus.includes('finish')) activeIdx = 3;

        dots.forEach((dot, i) => {
            dot.classList.toggle('active', i <= activeIdx);
        });
    }

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
        const statusEl = document.getElementById('generating-status-text');
        
        if (statusEl && statusText) {
            const emoji = getStatusEmoji(statusText);
            statusEl.textContent = `${emoji} ${statusText}`;

            // Check if we are in an "Application" phase to update the Stop button
            const isApplying = statusText.includes("Applying") || 
                               statusText.includes("Repairing") || 
                               statusText.includes("Librarian");
            
            if (dom.stopButton) {
                dom.stopButton.textContent = isApplying ? "Stop Application" : "Stop Generation";
            }
        }

        // Hide metrics initially when starting a new process (e.g. searching)
        // They will be shown by updateGenerationMetrics once streaming starts
        const metricsEl = document.getElementById('generating-metrics');
        if (metricsEl && !statusText?.includes('...')) {
             metricsEl.style.display = 'none';
        }
    }

    if (!isGenerating) {
        if (dom.generatingOverlay) dom.generatingOverlay.style.display = 'none';
        if (dom.inputAreaWrapper) {
            dom.inputAreaWrapper.style.display = 'block';
            dom.inputAreaWrapper.style.pointerEvents = 'auto';
            dom.inputAreaWrapper.style.opacity = '1';
        }
        if (dom.inputArea) dom.inputArea.classList.remove('disabled');

        if (dom.messagesDiv && !isScrolledToBottom(dom.messagesDiv)) {
            dom.scrollToBottomBtn.style.display = 'flex';
        } else {
            dom.scrollToBottomBtn.style.display = 'none';
        }
        
        if (dom.messageInput) {
            dom.messageInput.disabled = false;
            dom.messageInput.focus();
        }
    } else {
        dom.scrollToBottomBtn.style.display = 'none';
        if (dom.inputArea) dom.inputArea.classList.add('disabled');
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

/**
 * Renders the list of Response Profiles inside the Discussion Settings modal.
 */
export function renderProfilesInModal() {
    const container = document.getElementById('modal-profiles-container');
    const selector = document.getElementById('modal-default-profile-select') as HTMLSelectElement;
    if (!selector || !state.profiles) return;

    // Clear and repopulate the dropdown seen in your screenshot
    selector.innerHTML = '';

    const currentProfileId = state.capabilities?.responseProfileId || 'balanced';

    state.profiles.forEach((p, idx) => {
        // 1. Update Selector (Dropdown)
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name + (p.id === currentProfileId ? " (Active)" : "");
        opt.selected = p.id === currentProfileId;
        selector.appendChild(opt);

        // 2. Create Profile Management Row (List)
        if (container) {
            if (idx === 0) container.innerHTML = ''; // Clear only on first item

            const item = document.createElement('div');
            item.className = 'profile-list-item';
            item.style.cssText = "display: flex; align-items: center; gap: 8px; padding: 6px 10px; background: var(--vscode-list-hoverBackground); border-radius: 4px; border: 1px solid var(--vscode-widget-border); margin-bottom: 4px;";
            
            item.innerHTML = `
                <div style="flex:1; min-width:0;">
                    <div style="font-weight: 600; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${p.name}</div>
                    <div style="font-size: 10px; opacity: 0.7; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${p.description}</div>
                </div>
                <button class="icon-btn edit-p-btn" data-idx="${idx}" title="Edit"><i class="codicon codicon-edit"></i></button>
                <button class="icon-btn remove-p-btn" data-idx="${idx}" title="Delete" style="color: var(--vscode-errorForeground);"><i class="codicon codicon-trash"></i></button>
            `;
            container.appendChild(item);
        }
    });

    // Delegate Events
    container.querySelectorAll('.edit-p-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const idx = parseInt((btn as HTMLElement).dataset.idx || '0', 10);
            openProfileEditor(idx);
        });
    });

    container.querySelectorAll('.remove-p-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const idx = parseInt((btn as HTMLElement).dataset.idx || '0', 10);
            if (state.profiles[idx].id === 'balanced') {
                 vscode.postMessage({ command: 'showError', message: 'Cannot delete the base balanced profile.' });
                 return;
            }
            state.profiles.splice(idx, 1);
            renderProfilesInModal();
        });
    });
}

let currentEditingProfileIdx = -1;

function openProfileEditor(idx: number = -1) {
    const editor = document.getElementById('modal-profile-editor');
    const container = document.getElementById('modal-profiles-container');
    if (!editor || !container) return;

    currentEditingProfileIdx = idx;
    const p = idx === -1 ? { name: '', description: '', systemPrompt: '', prefix: '' } : state.profiles[idx];

    (document.getElementById('modal-p-name') as HTMLInputElement).value = p.name;
    (document.getElementById('modal-p-desc') as HTMLInputElement).value = p.description;
    (document.getElementById('modal-p-prefix') as HTMLInputElement).value = p.prefix || '';
    (document.getElementById('modal-p-prompt') as HTMLTextAreaElement).value = p.systemPrompt;

    editor.style.display = 'block';
    container.style.display = 'none';
}

// Global exposure for events.ts
(window as any).closeProfileEditor = () => {
    const editor = document.getElementById('modal-profile-editor');
    const container = document.getElementById('modal-profiles-container');
    if (editor && container) {
        editor.style.display = 'none';
        container.style.display = 'flex';
    }
};

(window as any).saveProfileFromModal = () => {
    const name = (document.getElementById('modal-p-name') as HTMLInputElement).value;
    const desc = (document.getElementById('modal-p-desc') as HTMLInputElement).value;
    const prefix = (document.getElementById('modal-p-prefix') as HTMLInputElement).value;
    const prompt = (document.getElementById('modal-p-prompt') as HTMLTextAreaElement).value;

    if (!name || !prompt) {
        vscode.postMessage({ command: 'showError', message: 'Name and System Instructions are required.' });
        return;
    }

    const newProfile: ResponseProfile = {
        id: currentEditingProfileIdx === -1 ? `custom_${Date.now()}` : state.profiles[currentEditingProfileIdx].id,
        name,
        description: desc,
        prefix,
        systemPrompt: prompt
    };

    if (currentEditingProfileIdx === -1) {
        state.profiles.push(newProfile);
    } else {
        state.profiles[currentEditingProfileIdx] = newProfile;
    }

    (window as any).closeProfileEditor();
    renderProfilesInModal();
};

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
    // Robust merge: ensures new keys (like debugBadge) exist even if guiState was saved previously
    const guiState = {
        agentBadge: true,
        debugBadge: true,
        autoContextBadge: true,
        herdBadge: true,
        webSearchBadge: true,
        autoSkillBadge: true,
        ...(caps.guiState || {})
    };

    // Initialize capability UI elements
    if (dom.capHerdMode) dom.capHerdMode.checked = caps.herdMode || false;
    if (dom.capHerdParallelGeneration) dom.capHerdParallelGeneration.checked = !!caps.herdParallelGeneration;
    if (dom.capHerdRounds) dom.capHerdRounds.value = caps.herdRounds?.toString() || '2';
    if (dom.agentModeCheckbox) dom.agentModeCheckbox.checked = !!caps.agentMode;
    if (dom.autoContextCheckbox) dom.autoContextCheckbox.checked = !!caps.autoContextMode;
    if (dom.contextAggressionSelect) dom.contextAggressionSelect.value = caps.contextAggression || 'respect';
    if (dom.herdModeCheckbox) dom.herdModeCheckbox.checked = !!caps.herdMode;
    if (dom.herdConfigSection) {
        dom.herdConfigSection.style.display = caps.herdMode ? 'block' : 'none';
    }

    // Render Dynamic Model Pool Selection inside herd config (if present)
    if (dom.herdModelsList && caps.herdParticipantModels) {
        const globalPool = (window as any).herdDynamicModelPool || [];
        const activeModels = caps.herdParticipantModels;

        dom.herdModelsList.innerHTML = globalPool.map((m: any) => `
            <div class="checkbox-container" style="border:none; background:transparent; padding:2px 0;">
                <input type="checkbox" value="${m.model}" class="herd-pool-check" ${activeModels.includes(m.model) || activeModels.length === 0 ? 'checked' : ''}>
                <label style="font-size:10px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${m.model}</label>
            </div>
        `).join('');
    }

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
        configItem.innerHTML = `<span class="codicon codicon-settings"></span> Configure Styles...`;
        configItem.onclick = (e) => {
            e.stopPropagation();
            // Open the Discussion Settings modal directly
            if (dom.discussionToolsModal) {
                dom.discussionToolsModal.classList.add('visible');
                renderProfilesInModal(); // Refresh the list
            }
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
    // --- THEME: THINKING & REASONING ---
    const thinkingGroup = document.createElement('div');
    thinkingGroup.className = 'badge-group';
    thinkingGroup.innerHTML = '<span class="badge-group-label">Logic</span>';
    container.appendChild(thinkingGroup);

    const thinkBadge = createToggleBadge(
        '🧠 Think', 
        'thinking', 
        true, 
        caps.thinkingMode, 
        () => {
            vscode.postMessage({ 
                command: 'updateDiscussionCapabilitiesPartial', 
                partial: { thinkingMode: !caps.thinkingMode } 
            });
        }
    );
    if (thinkBadge) {
        if (caps.thinkingMode) {
            thinkBadge.classList.add('active');
            thinkBadge.style.backgroundColor = 'var(--thinking-color)';
            thinkBadge.style.color = 'white';
        }
        thinkingGroup.appendChild(thinkBadge);
    }

    if (guiState.agentBadge || guiState.debugBadge || caps.herdMode) {
        const taskGroup = document.createElement('div');
        taskGroup.className = 'badge-group';
        taskGroup.innerHTML = '<span class="badge-group-label">Task</span>';
        container.appendChild(taskGroup);

        const agentBadge = createToggleBadge('🤖 Agent', 'agent', guiState.agentBadge, caps.agentMode, () => {
            vscode.postMessage({ command: 'toggleAgentMode' });
        });
        if (agentBadge) taskGroup.appendChild(agentBadge);

        const debugBadge = createToggleBadge('🐞 Debug', 'thinking', guiState.debugBadge, caps.debugMode, () => {
            vscode.postMessage({ 
                command: 'updateDiscussionCapabilitiesPartial', 
                partial: { debugMode: !caps.debugMode } 
            });
        });
        if (debugBadge) {
            if (caps.debugMode) {
                debugBadge.style.backgroundColor = 'var(--vscode-charts-red)';
                debugBadge.style.color = 'white';
            } else {
                // Ensure default style if inactive
                debugBadge.style.backgroundColor = '';
                debugBadge.style.color = '';
            }
            taskGroup.appendChild(debugBadge);
        }

        const herdBadge = createToggleBadge('🐂 Multi-Agent', 'herd', guiState.herdBadge, caps.herdMode, () => {
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
                // Execute auto-context with current prompt but PRESERVE it in the input zone
                // The user may want to review selected files before sending the actual message
                const prompt = dom.messageInput ? dom.messageInput.value : "";
                vscode.postMessage({ command: 'runAutoContext', prompt: prompt });
                // Note: Intentionally NOT clearing dom.messageInput.value - the prompt stays visible
            }
        );
        if (ctxBadge) {
            const label = ctxBadge.querySelector('.badge-label');
            const toggle = ctxBadge.querySelector('.badge-toggle-btn');

            if (caps.disableProjectContext) {
                // PRIORITY 1: MUTED STATE (Red)
                ctxBadge.classList.remove('inactive');
                ctxBadge.classList.add('active');
                ctxBadge.style.setProperty('background-color', 'var(--vscode-charts-red)', 'important');
                ctxBadge.style.setProperty('color', 'white', 'important');
                ctxBadge.title = "Context is currently MUTED. Files won't be sent to AI.";
                if (label) label.textContent = '🧠 Context Muted';
                if (toggle) {
                    toggle.classList.remove('codicon-circle-large-outline', 'codicon-pass-filled');
                    toggle.classList.add('codicon-mute');
                }
            } else {
                // PRIORITY 2: NORMAL STATE (Respects toggle)
                ctxBadge.style.backgroundColor = "";
                ctxBadge.style.color = "";
                
                if (caps.autoContextMode) {
                    ctxBadge.classList.remove('inactive');
                    ctxBadge.classList.add('active');
                    if (toggle) {
                        toggle.classList.remove('codicon-circle-large-outline', 'codicon-mute');
                        toggle.classList.add('codicon-pass-filled');
                    }
                } else {
                    ctxBadge.classList.remove('active');
                    ctxBadge.classList.add('inactive');
                    if (toggle) {
                        toggle.classList.remove('codicon-pass-filled', 'codicon-mute');
                        toggle.classList.add('codicon-circle-large-outline');
                    }
                }

                if (label) label.textContent = '🧠 AutoCtx';
                ctxBadge.title = caps.autoContextMode ? "Auto-Context Active (Click to disable)" : "Auto-Context Inactive (Click to enable)";
            }
            knowledgeGroup.appendChild(ctxBadge);
        }

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
            webBadge.classList.add('webSearch-indicator');
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
        const lastHash = state.lastCommitHash;
        
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
        
        const iconEl = document.createElement('span');
        iconEl.className = 'codicon codicon-git-branch';
        iconEl.style.marginRight = '4px';
        
        const label = document.createElement('span');
        label.className = 'badge-label';
        label.textContent = branchName;
        
        badge.appendChild(iconEl);
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
        
        if (state.lastCommitHash) {
            const lastHash = state.lastCommitHash;
            const copyItem = document.createElement('div');
            copyItem.className = 'custom-menu-item';
            copyItem.style.borderTop = '1px solid var(--vscode-menu-separatorBackground)';
            copyItem.innerHTML = `<span class="codicon codicon-copy"></span> Copy Last Hash (${lastHash.substring(0,7)})`;
            copyItem.onclick = () => {
                vscode.postMessage({ command: 'copyToClipboard', text: lastHash });
            };
            menu.appendChild(copyItem);
        }

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

// Global exposure for events.ts
(window as any).closeProfileEditor = () => {
    const editor = document.getElementById('modal-profile-editor');
    const container = document.getElementById('modal-profiles-container');
    if (editor && container) {
        editor.style.display = 'none';
        container.style.display = 'flex';
    }
};

(window as any).saveProfileFromModal = () => {
    const name = (document.getElementById('modal-p-name') as HTMLInputElement).value;
    const desc = (document.getElementById('modal-p-desc') as HTMLInputElement).value;
    const prefix = (document.getElementById('modal-p-prefix') as HTMLInputElement).value;
    const prompt = (document.getElementById('modal-p-prompt') as HTMLTextAreaElement).value;

    if (!name || !prompt) {
        vscode.postMessage({ command: 'showError', message: 'Name and System Instructions are required.' });
        return;
    }

    const newProfile: ResponseProfile = {
        id: currentEditingProfileIdx === -1 ? `custom_${Date.now()}` : state.profiles[currentEditingProfileIdx].id,
        name,
        description: desc,
        prefix,
        systemPrompt: prompt
    };

    if (currentEditingProfileIdx === -1) {
        state.profiles.push(newProfile);
    } else {
        state.profiles[currentEditingProfileIdx] = newProfile;
    }

    (window as any).closeProfileEditor();
    renderProfilesInModal();
};

/**
 * Renders matched files hierarchy into a tree.
 */
export function renderFileSearchResults(container: HTMLElement, results: any[], query: string) {
    if (!results || results.length === 0) {
        container.innerHTML = '<div style="opacity:0.6; text-align:center; padding: 40px;"><i class="codicon codicon-search-stop" style="font-size:24px; display:block; margin-bottom:10px;"></i>No matches found.</div>';
        return;
    }

    // Prepare highlight terms (AND logic)
    const highlightQuery = query.replace(/ext:\w+/g, '').replace(/[-|]/g, ' ').trim();
    const terms = highlightQuery.split(/\s+/).filter(t => t.length > 1);

    container.innerHTML = results.map(res => {
        let hPath = sanitizer.sanitize(res.path);
        let hSnippet = sanitizer.sanitize(res.snippet);
        
        terms.forEach(t => {
            const reg = new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
            hPath = hPath.replace(reg, '<mark class="search-highlight">$1</mark>');
            hSnippet = hSnippet.replace(reg, '<mark class="search-highlight">$1</mark>');
        });

        const isIncluded = res.isAlreadyIncluded;
        const lineBadge = res.line ? `<span style="opacity:0.5; font-family:monospace; margin-right:8px;">${res.line}:</span>` : '';

        return `
            <div class="search-result-item file-search-item ${isIncluded ? 'already-in-context' : ''}" 
                 data-path="${res.path}" data-was-included="${isIncluded}">
                <div class="search-result-title" style="display:flex; align-items:center; justify-content:space-between;">
                    <div style="display:flex; align-items:center; gap:8px; flex:1; min-width:0;">
                        <input type="checkbox" value="${res.path}" class="file-search-check" 
                            ${isIncluded ? 'checked' : ''} 
                            onclick="event.stopPropagation()">
                        <span class="codicon codicon-file-code" style="color:var(--vscode-symbolIcon-fileForeground);"></span>
                        <span class="title-text" style="overflow:hidden; text-overflow:ellipsis; font-weight:600; font-size: 12px;">${hPath}</span>
                    </div>
                    <div style="display:flex; gap:8px;">
                         ${isIncluded ? '<span class="already-included-badge"><i class="codicon codicon-check"></i> ACTIVE</span>' : `
                            <button class="code-action-btn quick-add-def" title="Add Definitions Only (Save Tokens)" data-path="${res.path}" style="height:18px; font-size:9px; padding:0 5px;">
                                <i class="codicon codicon-symbol-class"></i> DEFS ONLY
                            </button>
                         `}
                    </div>
                </div>
                <div class="search-result-snippet" style="
                    margin: 6px 0 0 24px; 
                    padding: 6px 10px; 
                    background: var(--vscode-textCodeBlock-background); 
                    border-radius: 4px; 
                    font-family: var(--vscode-editor-font-family);
                    font-size: 11px;
                    border: 1px solid var(--vscode-widget-border);
                    white-space: pre-wrap;
                    display: flex;
                ">${lineBadge}<div style="flex:1;">${hSnippet}</div></div>
            </div>
        `;
    }).join('');

    // Logic for the quick "DEFS ONLY" button
    container.querySelectorAll('.quick-add-def').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const path = (btn as HTMLElement).dataset.path;
            // Send command with empty first arg (uri) and path in the array arg (uris)
            vscode.postMessage({ command: 'executeLollmsCommand', details: { command: 'lollms-vs-coder.setContextDefinitionsOnly', params: [null, [{ path: path, scheme: 'file' }]] }});
            btn.innerHTML = '<i class="codicon codicon-check"></i> ADDED';
            btn.classList.add('applied');
        });
    });

    // Toggle checkboxes on row click
    container.querySelectorAll('.file-search-item').forEach(item => {
        item.addEventListener('click', (e) => {
            if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).closest('button')) return;
            const cb = item.querySelector('.file-search-check') as HTMLInputElement;
            cb.checked = !cb.checked;
            item.classList.toggle('selected', cb.checked);
        });
    });
}
/** @deprecated Use renderFileSearchResults for list view */
export function renderFileSearchTree(container: HTMLElement, files: string[]) {
    if (!files || files.length === 0) {
        container.innerHTML = '<div style="opacity:0.6; text-align:center; padding: 20px;">No files match your query.</div>';
        return;
    }

    // Build the nested tree object
    const root: any = { children: {} };
    files.forEach(f => {
        const parts = f.split(/[\\/]/);
        let current = root;
        parts.forEach((part, i) => {
            if (!current.children[part]) {
                current.children[part] = { 
                    name: part, 
                    path: parts.slice(0, i + 1).join('/'),
                    children: {}, 
                    isFile: i === parts.length - 1 
                };
            }
            current = current.children[part];
        });
    });

    const renderNode = (node: any, parentElement: HTMLElement) => {
        const sortedKeys = Object.keys(node.children).sort((a, b) => {
            const nodeA = node.children[a];
            const nodeB = node.children[b];
            if (nodeA.isFile !== nodeB.isFile) return nodeA.isFile ? 1 : -1;
            return a.localeCompare(b);
        });

        const ul = document.createElement('ul');
        ul.className = 'skills-tree-list'; // Reuse existing tree styles
        ul.style.paddingLeft = '16px';

        sortedKeys.forEach(key => {
            const child = node.children[key];
            const li = document.createElement('li');
            li.className = 'skills-tree-item';
            li.style.listStyle = 'none';

            if (child.isFile) {
                li.innerHTML = `
                    <div class="skill-node">
                        <input type="checkbox" value="${child.path}" class="file-search-check" id="search-f-${child.path}">
                        <label for="search-f-${child.path}" style="font-size: 12px; cursor: pointer;">
                            <span class="codicon codicon-file"></span> ${child.name}
                        </label>
                    </div>`;
            } else {
                const details = document.createElement('details');
                details.open = true;
                const summary = document.createElement('summary');
                summary.className = 'skill-summary';
                
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.className = 'folder-search-check';
                checkbox.addEventListener('change', (e) => {
                    const checked = (e.target as HTMLInputElement).checked;
                    li.querySelectorAll('.file-search-check, .folder-search-check').forEach((cb: any) => cb.checked = checked);
                });

                const label = document.createElement('span');
                label.className = 'skill-folder-label';
                label.innerHTML = `<span class="codicon codicon-folder"></span> ${child.name}`;

                summary.appendChild(document.createElement('span')).className = 'folder-handle codicon';
                summary.appendChild(checkbox);
                summary.appendChild(label);
                details.appendChild(summary);

                const childrenContainer = document.createElement('div');
                renderNode(child, childrenContainer);
                details.appendChild(childrenContainer);
                li.appendChild(details);
            }
            ul.appendChild(li);
        });
        parentElement.appendChild(ul);
    };

    container.innerHTML = '';
    renderNode(root, container);
}

/**
 * Filters the skills tree based on a search query.
 */
export function filterSkillsTree(query: string) {
    const container = dom.skillsTreeContainer;
    if (!container) return;

    const searchTerm = query.toLowerCase().trim();
    const items = container.querySelectorAll('.skills-tree-item');

    if (!searchTerm) {
        // Reset: Show all and collapse folders
        items.forEach((item: any) => {
            item.style.display = '';
            const details = item.querySelector('details');
            if (details) details.open = false;
        });
        return;
    }

    // First pass: Hide everything
    items.forEach((item: any) => item.style.display = 'none');

    // Second pass: Show matches and their parent chains
    items.forEach((item: any) => {
        const label = item.textContent?.toLowerCase() || "";
        if (label.includes(searchTerm)) {
            let current = item;
            // Show this item and walk up the tree to show all parents
            while (current && current !== container) {
                current.style.display = '';
                if (current.tagName === 'DETAILS') {
                    current.open = true;
                }
                current = current.parentElement;
            }
            
            // If it's a folder that matched, show all its children too
            const children = item.querySelectorAll('.skills-tree-item');
            children.forEach((child: any) => child.style.display = '');
        }
    });
}

export function renderSkillsTree(container: HTMLElement, node: any, activeSkillIds: string[] = []) {
    if (!node.children || node.children.length === 0) return;

    const fragment = document.createDocumentFragment();

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

    fragment.appendChild(ul);
    container.appendChild(fragment);
}

export function renderDiscussionSearchResults(results: any[], query: string) {
    const container = dom.discussionSearchResults;
    if (!container) return;

    if (results.length === 0) {
        container.innerHTML = '<div style="opacity:0.6; text-align:center; padding: 40px;">No matching discussions found for this criteria.</div>';
        return;
    }

    // Prepare highlighting regex (handles wildcards for the UI display)
    const highlightPattern = query.replace(/[.+^${}()|[\]\\]/g, '\\$&')
                                  .replace(/\*/g, '.*')
                                  .replace(/\?/g, '.');
    const hRegex = new RegExp(`(${highlightPattern})`, 'gi');

    container.innerHTML = results.map(res => {
        const highlightedSnippet = res.snippet.replace(hRegex, '<span class="search-highlight">$1</span>');
        const highlightedTitle = res.title.replace(hRegex, '<span class="search-highlight">$1</span>');
        const dateStr = new Date(res.timestamp).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
        
        return `
            <div class="search-result-item" data-id="${res.id}" title="Double-click to open">
                <div class="search-result-title">
                    <span class="title-text">${highlightedTitle}</span>
                    <span class="search-result-date">${dateStr}</span>
                </div>
                <div class="search-result-snippet">${highlightedSnippet}</div>
                <div style="font-size: 9px; opacity: 0.4; margin-top: 4px;">ID: ${res.id}</div>
            </div>
        `;
    }).join('');

    // Handle single click for selection visual, double click for navigation
    container.querySelectorAll('.search-result-item').forEach(item => {
        const jumpTo = () => {
            const id = (item as HTMLElement).dataset.id;
            vscode.postMessage({ command: 'switchDiscussion', discussionId: id });
            dom.discussionSearchModal.classList.remove('visible');
        };

        item.addEventListener('dblclick', (e) => {
            e.preventDefault();
            jumpTo();
        });

        // Also allow single click for convenience but with a small delay or button
        item.addEventListener('click', (e) => {
            // Highlight selected item
            container.querySelectorAll('.search-result-item').forEach(i => i.style.backgroundColor = '');
            (item as HTMLElement).style.backgroundColor = 'var(--vscode-list-activeSelectionBackground)';
            (item as HTMLElement).style.color = 'var(--vscode-list-activeSelectionForeground)';
        });
    });
}
// Add this function to src/commands/chatPanel/webview/ui.ts

/**
 * Renders web search results inside the active tab of the Web Discovery modal.
 */
export function renderWebSearchResults(action: string, results: any[]) {
    const tabId = `tab-${action}`;
    const container = document.getElementById(tabId);
    if (!container) return;

    // Reset button state immediately
    const submitBtn = container.querySelector('.web-submit-btn') as HTMLButtonElement;
    if (submitBtn) {
        submitBtn.innerHTML = (action === 'google' || action === 'ddg' || action === 'github') ? 'Search Again' : 'Search';
        submitBtn.disabled = false;
        submitBtn.style.width = ''; // Reset explicit width from events.ts
    } else {
        // Fallback: search for any button in the flex container if specific class finding failed
        const anyBtn = container.querySelector('button');
        if (anyBtn) {
            anyBtn.innerHTML = 'Search';
            anyBtn.disabled = false;
        }
    }

    let resultsList = container.querySelector('.web-search-results') as HTMLElement;
    if (!resultsList) {
        resultsList = document.createElement('div');
        resultsList.className = 'web-search-results';
        submitBtn?.insertAdjacentElement('beforebegin', resultsList);
    }

    if (!results || results.length === 0) {
        resultsList.innerHTML = '<div style="padding:10px; opacity:0.6;">No results found.</div>';
        return;
    }

    resultsList.innerHTML = results.map((res, idx) => `
        <div class="web-search-item" data-url="${res.url}">
            <div style="display:flex; align-items: flex-start; gap:10px;">
                <input type="checkbox" class="web-result-check" id="web-res-${action}-${idx}" value="${res.url}" style="margin-top: 3px;">
                <label for="web-res-${action}-${idx}" style="flex:1; min-width:0;">
                    <div class="web-result-title">${res.title}</div>
                    <div class="web-result-url">${res.url}</div>
                </label>
            </div>
        </div>
    `).join('');

    // Add "Add Selected" button if it doesn't exist
    let addBtn = container.querySelector('.web-add-selected-btn') as HTMLButtonElement;
    if (!addBtn) {
        addBtn = document.createElement('button');
        addBtn.className = 'code-action-btn apply-btn web-add-selected-btn';
        addBtn.style.width = '100%';
        addBtn.style.marginTop = '10px';
        addBtn.innerHTML = '<span class="codicon codicon-add"></span> Add Selected to Context';
        resultsList.insertAdjacentElement('afterend', addBtn);
        
        addBtn.onclick = () => {
            const selected = Array.from(resultsList.querySelectorAll('input:checked')).map((el: any) => el.value);
            if (selected.length > 0) {
                vscode.postMessage({ command: 'addWebPagesToContext', urls: selected });
                dom.webModal.classList.remove('visible');
            } else {
                vscode.postMessage({ command: 'showError', message: 'Please select at least one result.' });
            }
        };
    }
    addBtn.style.display = 'flex';
}
// Add this inside the updateDiscussionCapabilities logic or as an init listener
export function initAutomationUI() {
    const autoApply = document.getElementById('cap-autoApply') as HTMLInputElement;
    const subOptions = document.getElementById('automation-sub-options') as HTMLElement;

    if (autoApply && subOptions) {
        const updateVisibility = () => {
            subOptions.style.opacity = autoApply.checked ? "1" : "0.5";
            subOptions.style.pointerEvents = autoApply.checked ? "auto" : "none";
        };
        autoApply.addEventListener('change', updateVisibility);
        updateVisibility(); // Initial state
    }
}
export function renderContextUsage(usage: any[]) {
    const container = dom.usageListContainer;
    if (!container) return;

    if (!usage || usage.length === 0) {
        container.innerHTML = '<div style="padding:20px; opacity:0.6; text-align:center;">No files included in context.</div>';
        return;
    }

    const sizeMatch = (dom.tokenCountLabel?.textContent || "").match(/\/ ([\d\s,.]+)/);
    const contextSize = sizeMatch ? parseInt(sizeMatch[1].replace(/\D/g, '')) : 128000;

    let html = `
        <div class="usage-dashboard-header" style="margin-bottom: 25px; background: var(--vscode-editor-inactiveSelectionBackground); padding: 15px; border-radius: 8px; border: 1px solid var(--vscode-widget-border);">
            <div style="display:flex; justify-content:space-between; margin-bottom: 10px; font-weight:bold; font-size: 14px;">
                <span>Total Token Load</span>
                <span id="usage-total-label">Calculating...</span>
            </div>
            <div class="token-progress-container" style="height: 12px; margin-bottom: 5px;">
                <div id="usage-modal-bar" class="token-progress-bar"></div>
            </div>
        </div>
    `;

    const renderTable = (files: any[], title: string, icon: string) => {
        if (files.length === 0) return "";
        return `
            <div style="margin-bottom: 30px;">
                <h3 style="border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 8px;">
                    <i class="codicon ${icon}"></i> ${title} (${files.length})
                </h3>
                <table style="width:100%; border-collapse:collapse; font-size:12px;">
                    <tbody id="usage-table-${icon.includes('globe') ? 'extra' : 'project'}">
                        ${files.map(item => `
                            <tr data-path="${item.path}" style="border-bottom: 1px solid var(--vscode-widget-border);">
                                <td style="padding:10px 8px; max-width:300px;">
                                    <div style="font-weight: 500; overflow:hidden; text-overflow:ellipsis;">${item.path.split('/').pop()}</div>
                                    <div style="font-size: 10px; opacity: 0.5; overflow:hidden; text-overflow:ellipsis;">${item.path}</div>
                                </td>
                                <td style="padding:10px 8px; width: 120px;">
                                    <div style="display:flex; flex-direction:column; gap:4px;">
                                        <span class="file-token-label" style="font-weight:bold;">...</span>
                                        <div class="token-progress-container" style="height:4px; width:100%;">
                                            <div class="token-progress-bar file-usage-bar" style="width:0%"></div>
                                        </div>
                                    </div>
                                </td>
                                <td style="padding:10px 8px; text-align:right; width:40px;">
                                    <button class="icon-btn" onclick="window.vscode.postMessage({command:'removeFileFromContext', path:'${item.path}'});" title="Remove"><i class="codicon codicon-trash"></i></button>
                                </td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        `;
    };

    const projectFiles = usage.filter(f => !f.isExtra);
    const extraFiles = usage.filter(f => f.isExtra);

    container.innerHTML = html + renderTable(projectFiles, "Project Files", "codicon-root-folder") + renderTable(extraFiles, "Research & External", "codicon-globe");
}

export function updateContextFileUsage(filePath: string, tokens: number) {
    const row = document.querySelector(`tr[data-path="${filePath}"]`);
    if (!row) return;

    const label = row.querySelector('.file-token-label');
    const bar = row.querySelector('.file-usage-bar') as HTMLElement;
    
    const sizeMatch = (dom.tokenCountLabel?.textContent || "").match(/\/ ([\d\s,.]+)/);
    const contextSize = sizeMatch ? parseInt(sizeMatch[1].replace(/\D/g, '')) : 128000;

    if (label) label.textContent = tokens.toLocaleString();
    if (bar) {
        const pct = Math.min((tokens / contextSize) * 100, 100);
        bar.style.width = `${pct}%`;
        bar.className = 'token-progress-bar file-usage-bar ' + (pct > 20 ? 'range-warning' : 'range-safe');
    }

    // Update global total label
    const allLabels = Array.from(document.querySelectorAll('.file-token-label'));
    let total = 0;
    let pending = false;
    allLabels.forEach(l => {
        if (l.textContent === '...') pending = true;
        else total += parseInt(l.textContent?.replace(/,/g, '') || '0');
    });

    const totalLabel = document.getElementById('usage-total-label');
    if (totalLabel) totalLabel.textContent = `${total.toLocaleString()} / ${contextSize.toLocaleString()}${pending ? ' (Calculating...)' : ''}`;
    
    updateProgressBar(document.getElementById('usage-modal-bar'), total, contextSize);
}

/**
 * Updates a progress bar with segmented color logic.
 */
export function updateProgressBar(element: HTMLElement | null, current: number, total: number) {
    if (!element) return;

    const percentage = Math.min((current / total) * 100, 100);
    element.style.width = `${percentage}%`;

    element.classList.remove('range-safe', 'range-warning', 'range-danger');

    const ratio = current / total;
    if (ratio > 1.0) {
        element.classList.add('range-danger');
    } else if (ratio > 0.7) {
        element.classList.add('range-warning');
    } else {
        element.classList.add('range-safe');
    }
}

