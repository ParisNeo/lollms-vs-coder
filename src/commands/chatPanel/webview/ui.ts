import { dom, state, vscode } from "./dom.js";
import { isScrolledToBottom } from "./utils.js";
import DOMPurify from 'dompurify';

const sanitizer = typeof DOMPurify === 'function' ? (DOMPurify as any)(window) : DOMPurify;

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
        if (!img.data) return; // Skip invalid entries
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

/**
 * Launches the visual editor for a specific data URI (e.g. from a generated block)
 */
(window as any).openImageEditorFromData = (dataUrl: string, filename: string) => {
    const modal = dom.editorModal;
    const canvas = dom.editorCanvas;
    if (!modal || !canvas) return;

    modal.style.display = 'flex';
    canvasCtx = canvas.getContext('2d');

    // We treat this as a "New" edit index -1 so saving appends to pendingImages 
    // unless you want to overwrite the specific file (which would require extension-side write)
    currentEditingIdx = null; 

    const img = new Image();
    img.onload = () => {
        canvas.width = img.width;
        canvas.height = img.height;
        canvasCtx?.drawImage(img, 0, 0);
        saveState();
    };
    img.src = dataUrl;
    initCanvasEvents();
};

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
    canvas.addEventListener('wheel', (e: WheelEvent) => {
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
    }, { passive: false });
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

export function setGeneratingState(isGenerating: boolean, statusText?: string, showRaiseHand: boolean = false) {
    // Update internal state
    state.isGenerating = isGenerating;

    // Toggle global "Genie Presence" class
    if (state.capabilities?.agentMode) {
        document.body.classList.add('agent-mode-active');
    } else {
        document.body.classList.remove('agent-mode-active');
    }

    const raiseHandBtn = document.getElementById('raiseHandButton');
    if (raiseHandBtn) {
        // Force visibility based on the flag provided by the extension
        raiseHandBtn.style.setProperty('display', (isGenerating && showRaiseHand) ? 'flex' : 'none', 'important');
    }

    if (statusText) {
        const topStatus = document.getElementById('status-text');
        if (topStatus) topStatus.textContent = statusText;
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

    // --- GLOBAL BUTTON LOCKDOWN ---
    const actionableButtons = document.querySelectorAll('.apply-btn, .lollms-command-btn, .code-action-btn, .msg-action-btn, .summarize-context-btn, .open-context-btn, .remove-context-btn');
    actionableButtons.forEach((btn: any) => {
        if (isGenerating) {
            if (!btn.dataset.originalHtml) {
                btn.dataset.originalHtml = btn.innerHTML;
                btn.innerHTML = '<div class="spinner"></div>';
            }
            btn.disabled = true;
            btn.style.pointerEvents = 'none';
            btn.style.opacity = '0.5';
        } else {
            if (btn.dataset.originalHtml) {
                btn.innerHTML = btn.dataset.originalHtml;
                delete btn.dataset.originalHtml;
            }
            btn.disabled = false;
            btn.style.pointerEvents = 'auto';
            btn.style.opacity = '1';
        }
    });

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
        
        // --- INJECT HIGH-FIDELITY ORB ---
        const orbContainer = dom.generatingOverlay.querySelector('.ai-orb-container');
        if (orbContainer) {
            orbContainer.innerHTML = `
                <div class="genie-orb-portal">
                    <div class="orb-ring-outer"></div>
                    <div class="orb-ring-inner"></div>
                    <div class="orb-core"></div>
                </div>
            `;
        }
        const statusEl = document.getElementById('generating-status-text');
        const raiseHandBtn = document.getElementById('raiseHandButton');
        const stopBtn = document.getElementById('stopButton');

        if (raiseHandBtn) {
            raiseHandBtn.style.display = showRaiseHand ? 'flex' : 'none';
        }

        if (stopBtn) {
            // The stop button should only be visible while generating
            stopBtn.style.display = isGenerating ? 'flex' : 'none';
        }

        if (statusEl && statusText) {
            const emoji = getStatusEmoji(statusText);
            statusEl.textContent = `${emoji} ${statusText}`;

            // Context-aware button labeling
            const lowerStatus = statusText.toLowerCase();
            const isApplying = lowerStatus.includes("apply") || lowerStatus.includes("repair") || lowerStatus.includes("writ");
            const isSearching = lowerStatus.includes("search") || lowerStatus.includes("librarian");
            const isThinking = lowerStatus.includes("reason") || lowerStatus.includes("plan");

            if (dom.stopButton) {
                const btnLabel = dom.stopButton.querySelector('span');
                if (btnLabel) {
                    if (isApplying) btnLabel.textContent = "STOP APPLICATION";
                    else if (isSearching) btnLabel.textContent = "STOP SEARCH";
                    else if (isThinking) btnLabel.textContent = "STOP REASONING";
                    else btnLabel.textContent = "STOP GENERATION";
                }
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

/**
 * Detects if the menu will go off-screen and flips it if necessary.
 */
function adjustMenuPosition(trigger: HTMLElement, menu: HTMLElement) {
    // Reset classes first
    menu.classList.remove('open-up');

    // Temporarily show to measure
    menu.style.display = 'flex';
    menu.style.visibility = 'hidden';

    const menuRect = menu.getBoundingClientRect();
    const triggerRect = trigger.getBoundingClientRect();
    const viewportHeight = window.innerHeight;

    // Check if opening DOWN would hit the bottom of the screen
    const spaceBelow = viewportHeight - triggerRect.bottom;
    const needsFlip = spaceBelow < menuRect.height && triggerRect.top > menuRect.height;

    if (needsFlip) {
        menu.classList.add('open-up');
    }

    // Restore state
    menu.style.display = '';
    menu.style.visibility = '';
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
    
    if (onExecute) {
        span.title = isActive 
            ? `${text} Mode Active.\nClick the badge to Execute manually.\nClick the circle to Deactivate.`
            : `${text} Mode Inactive.\nClick to Enable and Execute.`;
    } else {
        span.title = isActive ? `${text} Mode Active (Click to disable)` : `${text} Mode Inactive (Click to enable)`;
    }
    
    const toggle = document.createElement('span');
    toggle.className = `badge-toggle-btn codicon ${isActive ? 'codicon-pass-filled' : 'codicon-circle-large-outline'}`;
    
    toggle.onclick = (e) => {
        e.stopPropagation();
        onToggle();
    };

    // Standard Left Click: Execute if available, else Toggle
    span.onclick = (e) => {
        e.stopPropagation();
        if (onExecute) {
            if (!isActive) {
                onToggle();
            }
            setTimeout(onExecute, isActive ? 0 : 50);
        } else {
            onToggle();
        }
    };

    // Right Click: Execute Shortcut (Fallback)
    if (onExecute) {
        span.oncontextmenu = (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!isActive) {
                onToggle();
            }
            setTimeout(onExecute, isActive ? 0 : 50);
        };
    }

    const label = document.createElement('span');
    label.className = 'badge-label';
    label.textContent = text;

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

export function updateBadges() {
    // RESILIENT TARGETING: Look for the container in the Fused Dashboard
    const container = document.getElementById('active-badges');
    if (!container || !state.capabilities) return;

    const caps = state.capabilities;
    container.innerHTML = '';

    const isAgentMode = caps.agentMode === true;

    // Set high-level presence on body for HUD-aware styling
    document.body.classList.toggle('agent-mode-active', isAgentMode);

    // --- GROUP A: INFRASTRUCTURE ---
    if (true) {
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
    if (!isAgentMode && state.personalities && state.personalities.length > 0) {
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
                const isOpening = !menu.classList.contains('visible');
                document.querySelectorAll('.custom-menu').forEach(m => m.classList.remove('visible'));

                if (isOpening) {
                    adjustMenuPosition(pBadge, menu);
                    menu.classList.add('visible');
                }
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
        testBadge: true,
        docsBadge: true,
        ...(caps.guiState || {})
    };

    // Initialize capability UI elements
    if (dom.capHerdMode) dom.capHerdMode.checked = caps.herdMode || false;
    if (dom.capHerdParallelGeneration) dom.capHerdParallelGeneration.checked = !!caps.herdParallelGeneration;
    if (dom.capHerdRounds) dom.capHerdRounds.value = caps.herdRounds?.toString() || '2';
    if (dom.capProjectMemory) dom.capProjectMemory.checked = caps.projectMemoryEnabled !== false;
    const economyCheck = document.getElementById('cap-tokenEconomyMode');
    if (economyCheck) economyCheck.checked = !!caps.tokenEconomyMode;
    if (dom.agentModeCheckbox) dom.agentModeCheckbox.checked = caps.agentMode;
    if (dom.autoContextCheckbox) dom.autoContextCheckbox.checked = caps.autoContextMode;
    if (dom.contextAggressionSelect) dom.contextAggressionSelect.value = caps.contextAggression || 'respect';
    if (dom.capGitWorkflow) dom.capGitWorkflow.checked = !!caps.gitWorkflow;
    if (dom.capEnableTTS) dom.capEnableTTS.checked = !!caps.enableTTS;
    if (dom.capEnableSTT) dom.capEnableSTT.checked = !!caps.enableSTT;
    if (dom.herdModeCheckbox) dom.herdModeCheckbox.checked = !!caps.herdMode;
    if (dom.herdConfigSection) {
        dom.herdConfigSection.style.display = caps.herdMode ? 'block' : 'none';
    }

    // Initialize TTS/STT capability UI elements
    const ttsCheck = document.getElementById('cap-enableTTS') as HTMLInputElement;
    if (ttsCheck) ttsCheck.checked = !!caps.enableTTS;
    const sttCheck = document.getElementById('cap-enableSTT') as HTMLInputElement;
    if (sttCheck) sttCheck.checked = !!caps.enableSTT;

    const sttBtn = document.getElementById('sttButton');
    if (sttBtn) {
        sttBtn.style.display = caps.enableSTT ? 'flex' : 'none';
    }

    // Render Dynamic Model Pool Selection inside herd config (if present)
    if (dom.herdModelsList) {
        const globalPool = (window as any).herdDynamicModelPool || [];
        const activeModels = caps.herdParticipantModels || [];

        dom.herdModelsList.innerHTML = globalPool.map((m: any) => `
            <div class="checkbox-container" style="border:none; background:transparent; padding:2px 0;">
                <input type="checkbox" value="${m.model}" class="herd-pool-check" ${activeModels.includes(m.model) ? 'checked' : ''}>
                <label style="font-size:10px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${m.model}</label>
            </div>
        `).join('');
    }

    // Response Profile Badge (Mode)
    const currentProfileId = caps.responseProfileId || 'balanced';
    const currentProfile = state.profiles.find(p => p.id === currentProfileId) || state.profiles[0];
    
    // REDUNDANT IN AGENT MODE: Hide Profile/Personality as the Agent uses a fixed Architect protocol
    if (currentProfile && !caps.agentMode) {
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
        
        // 1. Manual Entry Option
        const manualItem = document.createElement('div');
        manualItem.className = 'custom-menu-item';
        manualItem.style.borderBottom = '1px solid var(--vscode-menu-separatorBackground)';
        manualItem.style.paddingBottom = '8px';
        manualItem.style.marginBottom = '4px';
        manualItem.innerHTML = `<span class="codicon codicon-edit"></span> Enter model name manually...`;
        manualItem.onclick = (e) => {
            e.stopPropagation();
            const manualName = prompt("Enter model name/id (e.g. ollama/mistral):");
            if (manualName) {
                vscode.postMessage({ command: 'updateDiscussionModel', model: manualName.trim() });
                // We also trigger a token refresh because the model changed
                vscode.postMessage({ command: 'calculateTokens' });
            }
            menu.classList.remove('visible');
        };
        menu.appendChild(manualItem);

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
                renderProfilesInModal(); // Refresh the profiles list
                
                // REFRESH VOICES
                if (typeof (window as any).refreshVoiceList === 'function') {
          (window as any).refreshVoiceList();
                }
            }
            menu.classList.remove('visible');
        };
        menu.appendChild(configItem);

        modeBadge.onclick = (e) => {
            e.stopPropagation();
            const isOpening = !menu.classList.contains('visible');
            document.querySelectorAll('.custom-menu').forEach(m => m.classList.remove('visible'));

            if (isOpening) {
                adjustMenuPosition(modeBadge, menu);
                menu.classList.add('visible');
            }
        };

        wrapper.appendChild(modeBadge);
        wrapper.appendChild(menu);
        infraGroup.appendChild(wrapper);
    }

    // --- THEME: TASK & TEAM ---
    // --- THEME: THINKING & REASONING ---
    // Suppress Reasoning/Task/Research groups in Agent Mode to reduce clutter
    if (!caps.agentMode) {
    const thinkingGroup = document.createElement('div');
    thinkingGroup.className = 'badge-group';
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
    }

    // --- GROUP B: TASK (Workflow & Modes) ---
    if (guiState.agentBadge || (!isAgentMode && (guiState.debugBadge || caps.herdMode || caps.testMode))) {
        const workerGroup = document.createElement('div');
        workerGroup.className = 'badge-group';
        container.appendChild(workerGroup);

        const isBuilder = caps.workerType === 'builder';
        const workerBadge = createToggleBadge(
            isBuilder ? '🏗️ Builder' : '💬 Discuss',
            isBuilder ? 'agent' : 'autocontext', 
            true,
            true,
            () => {
                const nextType = isBuilder ? 'discussion' : 'builder';
                vscode.postMessage({ 
                    command: 'updateDiscussionCapabilitiesPartial', 
                    partial: { 
                        workerType: nextType,
                        // Builder is single-turn (no Genie loop)
                        agentMode: false 
                    } 
                });
            }
        );
        if (workerBadge) {
            workerBadge.title = isBuilder 
                ? "Builder Mode: Agentic sequential execution. Git-bound." 
                : "Discussion Mode: Iterative Q&A with manual patches.";
            workerGroup.appendChild(workerBadge);
        }
        // --- NEW: AGENT MISSION PROFILE SELECTOR (Now standalone) ---
        if (isAgentMode && state.agentProfiles && state.agentProfiles.length > 0) {
            const currentProfileId = state.capabilities?.activeAgentProfileId || 'software_architect';
            const currentProfile = state.agentProfiles.find(p => p.id === currentProfileId) || state.agentProfiles[0];

            if (currentProfile) {
                const wrapper = document.createElement('div');
                wrapper.className = 'badge-wrapper';
                wrapper.style.position = 'relative';

                const genieBadge = document.createElement('span');
                genieBadge.className = 'mode-badge active clickable';
                genieBadge.style.backgroundColor = 'var(--vscode-charts-orange)';
                genieBadge.style.color = 'white';
                genieBadge.title = `Genie Mission: ${currentProfile.name}. Click to change protocol.`;
                genieBadge.innerHTML = `<span class="codicon codicon-target"></span> <span class="badge-label">${currentProfile.name}</span>`;

                const menu = document.createElement('div');
                menu.className = 'custom-menu';
                menu.id = 'genie-profile-menu';

                state.agentProfiles.forEach(p => {
                    const item = document.createElement('div');
                    item.className = 'custom-menu-item';
                    const icon = (p.id === currentProfileId) ? 'codicon-check' : 'codicon-symbol-property';
                    item.innerHTML = `<span class="codicon ${icon}"></span> ${p.name}`;

                    if (p.id === currentProfileId) {
                        item.style.fontWeight = 'bold';
                        item.style.color = 'var(--vscode-textLink-foreground)';
                    }

                    item.onclick = (e) => {
                        e.stopPropagation();
                        vscode.postMessage({ 
                            command: 'updateDiscussionCapabilitiesPartial', 
                            partial: { activeAgentProfileId: p.id } 
                        });
                        menu.classList.remove('visible');
                    };
                    menu.appendChild(item);
                });

                genieBadge.onclick = (e) => {
                    e.stopPropagation();
                    const isOpening = !menu.classList.contains('visible');
                    document.querySelectorAll('.custom-menu').forEach(m => m.classList.remove('visible'));

                    if (isOpening) {
                        adjustMenuPosition(genieBadge, menu);
                        menu.classList.add('visible');
                    }
                };

                wrapper.appendChild(genieBadge);
                wrapper.appendChild(menu);
                container.appendChild(wrapper); // Add directly to main container
            }
        }

        const taskGroup = document.createElement('div');
        taskGroup.className = 'badge-group hud-options-parent';
        container.appendChild(taskGroup);

        // 1. CREATE THE SIMPLER TOGGLE BADGE
        const optionsBadge = document.createElement('span');
        optionsBadge.className = 'mode-badge active clickable';
        optionsBadge.style.background = 'var(--vscode-editorWidget-background)';
        optionsBadge.innerHTML = `<span class="codicon codicon-settings-gear"></span> <span class="badge-label">PROTOCOL</span>`;
        taskGroup.appendChild(optionsBadge);

        // 2. CREATE THE HIDDEN CONTAINER
        const optionsPopup = document.createElement('div');
        optionsPopup.className = 'hud-options-popup';
        taskGroup.appendChild(optionsPopup);

        const agentBadge = createToggleBadge(
            '🤖 Agent',
            'agent',
            guiState.agentBadge,
            caps.agentMode,
            () => {
                vscode.postMessage({ command: 'toggleAgentMode' });
            }
        );
        if (agentBadge) optionsPopup.appendChild(agentBadge);

        const debugBadge = createToggleBadge(
            '🐞 Debug', 
            'thinking', 
            guiState.debugBadge, 
            caps.debugMode, 
            () => {
                vscode.postMessage({ 
                    command: 'updateDiscussionCapabilitiesPartial', 
                    partial: { debugMode: !caps.debugMode } 
                });
            },
            () => {
                const prompt = dom.messageInput ? dom.messageInput.value : "";
                vscode.postMessage({ command: 'runDebugAgent', prompt: prompt });
            }
        );
        if (debugBadge) {
            if (caps.debugMode) {
                debugBadge.style.backgroundColor = 'var(--vscode-charts-red)';
                debugBadge.style.color = 'white';
            }
            optionsPopup.appendChild(debugBadge);
        }

        const verifierBadge = createToggleBadge(
            '🛡️ Verifier',
            'verifier',
            true, 
            caps.verifierMode,
            () => {
                vscode.postMessage({
                    command: 'updateDiscussionCapabilitiesPartial',
                    partial: { verifierMode: !caps.verifierMode }
                });
            }
        );
        if (verifierBadge) optionsPopup.appendChild(verifierBadge);

        const testBadge = createToggleBadge(
            '🧪 Test',
            'test',
            guiState.testBadge !== false,
            caps.testMode,
            () => {
                vscode.postMessage({
                    command: 'updateDiscussionCapabilitiesPartial',
                    partial: { testMode: !caps.testMode }
                });
            }
        );
        if (testBadge) {
            if (caps.testMode) {
                testBadge.style.backgroundColor = '#e84393';
                testBadge.style.color = 'white';
            }
            optionsPopup.appendChild(testBadge);
        }

        const docsBadge = createToggleBadge(
            '📖 Docs',
            'docs',
            guiState.docsBadge !== false,
            caps.documentationMode,
            () => {
                vscode.postMessage({
                    command: 'updateDiscussionCapabilitiesPartial',
                    partial: { documentationMode: !caps.documentationMode }
                });
            }
        );

        const gitWorkflowBadge = createToggleBadge(
            '🐙 Git',
            'git',
            true,
            caps.gitAutoWorkflow,
            () => {
                vscode.postMessage({
                    command: 'updateDiscussionCapabilitiesPartial',
                    partial: { gitAutoWorkflow: !caps.gitAutoWorkflow }
                });
            }
        );
        if (gitWorkflowBadge) {
            if (caps.gitAutoWorkflow) {
                gitWorkflowBadge.style.backgroundColor = 'var(--vscode-gitDecoration-modifiedResourceForeground)';
                gitWorkflowBadge.style.color = 'white';
            }
            optionsPopup.appendChild(gitWorkflowBadge);
        }
        if (docsBadge) {
            if (caps.documentationMode) {
                docsBadge.style.backgroundColor = '#00b894';
                docsBadge.style.color = 'white';
            }
            optionsPopup.appendChild(docsBadge);
        }

        const herdBadge = createToggleBadge('🐂 Multi-Agent', 'herd', guiState.herdBadge, caps.herdMode, () => {
            vscode.postMessage({ command: 'updateDiscussionCapabilitiesPartial', partial: { herdMode: !caps.herdMode } });
        });
        if (herdBadge) optionsPopup.appendChild(herdBadge);
    }

    // --- THEME: DNA & MEMORY ---
    if (!isAgentMode) {
        const memoryGroup = document.createElement('div');
        memoryGroup.className = 'badge-group hud-options-parent';
        container.appendChild(memoryGroup);

        const memRoot = document.createElement('span');
        memRoot.className = 'mode-badge active clickable';
        memRoot.style.background = caps.projectMemoryEnabled ? 'var(--vscode-charts-purple)' : 'var(--vscode-editorWidget-background)';
        memRoot.innerHTML = `<span class="codicon codicon-chip"></span> <span class="badge-label">DNA</span>`;
        memoryGroup.appendChild(memRoot);

        const memPopup = document.createElement('div');
        memPopup.className = 'hud-options-popup';
        memoryGroup.appendChild(memPopup);

        const memBadge = createToggleBadge(
            '🧠 Project Memory', 
            'thinking', 
            true, 
            caps.projectMemoryEnabled, 
            () => {
                vscode.postMessage({ 
                    command: 'updateDiscussionCapabilitiesPartial', 
                    partial: { projectMemoryEnabled: !caps.projectMemoryEnabled } 
                });
            }
        );
        if (memBadge) memPopup.appendChild(memBadge);
    }

    // --- THEME: KNOWLEDGE (Librarian/Skills) ---
    if (!isAgentMode && (guiState.autoContextBadge || guiState.autoSkillBadge !== false)) {
        const knowledgeGroup = document.createElement('div');
        knowledgeGroup.className = 'badge-group hud-options-parent';
        container.appendChild(knowledgeGroup);

        const knRoot = document.createElement('span');
        knRoot.className = 'mode-badge active clickable';
        knRoot.style.background = 'var(--vscode-editorWidget-background)';
        knRoot.innerHTML = `<span class="codicon codicon-library"></span> <span class="badge-label">KNOWLEDGE</span>`;
        knowledgeGroup.appendChild(knRoot);

        const knPopup = document.createElement('div');
        knPopup.className = 'hud-options-popup';
        knowledgeGroup.appendChild(knPopup);

        const ctxBadge = createToggleBadge(
            '🧠 Librarian (AutoContext)',
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
        if (ctxBadge) knPopup.appendChild(ctxBadge);

        const skillBadge = createToggleBadge(
            '💡 AutoSkill (Optimization)',
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
        if (skillBadge) knPopup.appendChild(skillBadge);
    }

    // --- THEME: RESEARCH (Web Search) ---
    if (!isAgentMode && guiState.webSearchBadge !== false) {
        const researchGroup = document.createElement('div');
        researchGroup.className = 'badge-group hud-options-parent';
        container.appendChild(researchGroup);

        const resRoot = document.createElement('span');
        resRoot.className = 'mode-badge active clickable';
        resRoot.style.background = caps.webSearch ? 'var(--vscode-charts-blue)' : 'var(--vscode-editorWidget-background)';
        resRoot.innerHTML = `<span class="codicon codicon-globe"></span> <span class="badge-label">RESEARCH</span>`;
        researchGroup.appendChild(resRoot);

        const resPopup = document.createElement('div');
        resPopup.className = 'hud-options-popup';
        researchGroup.appendChild(resPopup);

        const webBadge = createToggleBadge(
            '🌍 Web Search Agent', 'web', 
            true, 
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
            resPopup.appendChild(webBadge);
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
            const isOpening = !menu.classList.contains('visible');
            document.querySelectorAll('.custom-menu').forEach(m => m.classList.remove('visible'));

            if (isOpening) {
                adjustMenuPosition(badge, menu);
                menu.classList.add('visible');
            }
        };
        }
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
            if (!t) return;
            const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const reg = new RegExp(`(${escaped})`, 'gi');
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

export function renderSkillsTree(container: HTMLElement, node: any, discussionSkills: string[] = [], projectSkills: string[] = []) {
    if (node.id === 'root') {
        // Add header for the columns
        const header = document.createElement('div');
        header.style.cssText = "display: flex; justify-content: flex-end; padding: 0 10px 8px 10px; border-bottom: 1px solid var(--vscode-widget-border); margin-bottom: 10px;";
        header.innerHTML = `
            <div style="display: flex; gap: 20px;">
                <span style="font-size: 9px; font-weight: 800; opacity: 0.6;">CHAT</span>
                <span style="font-size: 9px; font-weight: 800; opacity: 0.6;">PROJECT</span>
            </div>
        `;
        container.appendChild(header);
    }

    if (!node.children || node.children.length === 0) return;

    const ul = document.createElement('ul');
    ul.className = 'skills-tree-list';

    node.children.sort((a: any, b: any) => {
        if (a.isSkill === b.isSkill) return a.label.localeCompare(b.label);
        return a.isSkill ? 1 : -1;
    }).forEach((child: any) => {
        const li = document.createElement('li');
        li.className = 'skills-tree-item';

        const controlsHtml = `
            <div class="skill-controls" style="display: flex; gap: 20px; flex-shrink: 0;">
                <label class="switch" style="width: 24px; height: 14px;">
                    <input type="checkbox" value="${child.id}" class="skill-discussion-checkbox ${child.isSkill ? '' : 'bundle-discussion'}" ${discussionSkills.includes(child.id) ? 'checked' : ''}>
                    <span class="slider" style="border-radius: 14px;"></span>
                </label>
                <label class="switch" style="width: 24px; height: 14px;">
                    <input type="checkbox" value="${child.id}" class="skill-project-checkbox ${child.isSkill ? '' : 'bundle-project'}" ${projectSkills.includes(child.id) ? 'checked' : ''}>
                    <span class="slider" style="border-radius: 14px;"></span>
                </label>
            </div>
        `;

        if (child.isSkill) {
            const displayLabel = child.label.replace(/SOURCE OF TRUTH:\s*/gi, '').trim();
            const div = document.createElement('div');
            div.className = 'skill-node';
            div.style.cssText = "display: flex; justify-content: space-between; align-items: center; width: 100%;";
            div.innerHTML = `
                <label title="${child.description || ''}" style="flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                    <span class="codicon codicon-bookmark"></span> 💎 ${displayLabel}
                </label>
                ${controlsHtml}
            `;
            li.appendChild(div);
        } else {
            const details = document.createElement('details');
            details.open = false;
            const summary = document.createElement('summary');
            summary.className = 'skill-summary';
            summary.style.cssText = "display: flex; justify-content: space-between; align-items: center; width: 100%;";

            summary.innerHTML = `
                <div style="display: flex; align-items: center; flex: 1; min-width: 0;">
                    <span class="folder-handle codicon"></span>
                    <span class="skill-folder-label" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                        <span class="codicon codicon-folder"></span> ${child.label}
                    </span>
                </div>
                ${controlsHtml}
            `;

            // Cascade Logic
            summary.querySelectorAll('input').forEach(input => {
                input.addEventListener('change', (e) => {
                    const type = input.classList.contains('bundle-discussion') ? '.skill-discussion-checkbox' : '.skill-project-checkbox';
                    const checked = (e.target as HTMLInputElement).checked;
                    li.querySelectorAll(type).forEach((cb: any) => cb.checked = checked);
                });
            });

            details.appendChild(summary);
            const childrenContainer = document.createElement('div');
            childrenContainer.className = 'skill-children';
            renderSkillsTree(childrenContainer, child, discussionSkills, projectSkills);
            details.appendChild(childrenContainer);
            li.appendChild(details);
        }
        ul.appendChild(li);
    });

    container.appendChild(ul);
}

/**
 * Categorizes and renders the Agent Tools list with an advanced grid UI.
 */
export function renderAdvancedToolsList(allTools: any[], toolPolicies: Record<string, string>) {
    const container = dom.toolsListDiv;
    if (!container) return;

    // 1. Setup Header, Profiles & Search
    container.innerHTML = `
        <div style="margin-bottom: 16px; position: sticky; top: 0; background: var(--vscode-editorWidget-background); z-index: 10; padding-bottom: 10px; display: flex; flex-direction: column; gap: 12px;">
            <div style="display: flex; flex-direction: column; gap: 6px;">
                <label style="font-size: 10px; font-weight: 800; opacity: 0.6; text-transform: uppercase;">Security Profiles</label>
                <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px;">
                    <button class="code-action-btn" id="profile-restrictive" title="Deactivate all critical tools">🛡️ Restrictive</button>
                    <button class="code-action-btn" id="profile-cautious" title="Sensitive tools require manual approval">⚖️ Cautious</button>
                    <button class="code-action-btn" id="profile-trust" title="All tools run autonomously">🚀 Full Trust</button>
                </div>
            </div>
            <div class="input-container" style="border-radius: 4px;">
                <i class="codicon codicon-search" style="margin-right: 8px; opacity: 0.7;"></i>
                <input type="text" id="tool-search-input" placeholder="Search tools by name or capability..." style="font-size: 12px; background: transparent;">
            </div>
        </div>
        <div id="tool-categories-root"></div>
    `;

    // --- Profile Logic ---
    const applyProfile = (level: 'restrictive' | 'cautious' | 'trust') => {
        const selects = container.querySelectorAll('.tool-policy-select') as NodeListOf<HTMLSelectElement>;
        selects.forEach(select => {
            const card = select.closest('.tool-card') as HTMLElement;
            const isSensitive = card?.querySelector('.badge-perm-shell') || card?.querySelector('.badge-perm-fs');

            if (level === 'restrictive') {
                select.value = isSensitive ? 'disabled' : 'autonomous';
            } else if (level === 'cautious') {
                select.value = isSensitive ? 'manual' : 'autonomous';
            } else {
                select.value = 'autonomous';
            }
            // Trigger visual update for the card
            card?.classList.toggle('active', select.value !== 'disabled');
        });
    };

    document.getElementById('profile-restrictive')!.onclick = () => applyProfile('restrictive');
    document.getElementById('profile-cautious')!.onclick = () => applyProfile('cautious');
    document.getElementById('profile-trust')!.onclick = () => applyProfile('trust');

    const root = document.getElementById('tool-categories-root')!;

    // 2. Define Categories
    const categories: Record<string, { label: string, icon: string, tools: any[] }> = {
        'filesystem': { label: 'File System & Context', icon: 'files', tools: [] },
        'execution': { label: 'Code Execution & Shell', icon: 'terminal', tools: [] },
        'research': { label: 'Research & Discovery', icon: 'globe', tools: [] },
        'knowledge': { label: 'RLM & Memory', icon: 'chip', tools: [] },
        'internal': { label: 'Infrastructure & Planning', icon: 'hubot', tools: [] },
        'mcp': { label: 'External MCP Tools', icon: 'plug', tools: [] }
    };

    // 3. Map Tools to Categories
    allTools.forEach(tool => {
        const toolName = tool.name.toLowerCase();
        const group = (tool.permissionGroup || '').toLowerCase();

        if (toolName.startsWith('mcp_') || toolName.includes('_mcp_')) categories.mcp.tools.push(tool);
        else if (group.includes('filesystem') || toolName.includes('file')) categories.filesystem.tools.push(tool);
        else if (group.includes('shell') || toolName.includes('run_') || toolName.includes('exec')) categories.execution.tools.push(tool);
        else if (group.includes('internet') || toolName.includes('search') || toolName.includes('scrape')) categories.research.tools.push(tool);
        else if (toolName.includes('memory') || toolName.includes('knowledge') || toolName.includes('repl')) categories.knowledge.tools.push(tool);
        else categories.internal.tools.push(tool);
    });

    // 4. Render Sections
    Object.entries(categories).forEach(([key, cat]) => {
        if (cat.tools.length === 0) return;

        const section = document.createElement('div');
        section.className = 'tool-category-section';
        section.dataset.category = key;

        section.innerHTML = `
            <div class="tool-category-header">
                <i class="codicon codicon-${cat.icon}"></i>
                <span>${cat.label}</span>
            </div>
            <div class="tool-grid">
                ${cat.tools.map(tool => {
                    const sensitiveGroups = ['shell_execution', 'filesystem_write'];
                    const isSensitive = tool.permissionGroup && sensitiveGroups.includes(tool.permissionGroup);

                    // Default to autonomous for safe tools, manual for sensitive ones
                    const policy = toolPolicies[tool.name] || (isSensitive ? 'manual' : 'autonomous');
                    const isEnabled = policy !== 'disabled';

                    let permClass = '';
                    if (tool.permissionGroup === 'shell_execution') permClass = 'badge-perm-shell';
                    if (tool.permissionGroup === 'internet_access') permClass = 'badge-perm-net';
                    if (tool.permissionGroup === 'filesystem_write') permClass = 'badge-perm-fs';


                    return `
                    <div class="tool-card ${isEnabled ? 'active' : ''}" data-name="${tool.name.toLowerCase()}" data-desc="${tool.description.toLowerCase()}">
                        <div class="tool-card-header">
                            <div class="tool-name-container">
                                <div class="tool-card-name">${tool.name}</div>
                                <div class="tool-badge-row">
                                    <span class="tool-mini-badge">${tool.isAgentic ? 'Agentic' : 'Utility'}</span>
                                    ${tool.permissionGroup ? `<span class="tool-mini-badge ${permClass}">${tool.permissionGroup.replace('_', ' ')}</span>` : ''}
                                </div>
                            </div>
                            <div class="tool-policy-selector">
                                <select class="tool-policy-select" data-tool="${tool.name}" style="font-size: 10px; padding: 2px; height: 22px; width: 90px; border-radius: 4px;">
                                    <option value="disabled" ${policy === 'disabled' ? 'selected' : ''}>🚫 Disabled</option>
                                    <option value="manual" ${policy === 'manual' ? 'selected' : ''}>🛡️ Manual</option>
                                    <option value="autonomous" ${policy === 'autonomous' ? 'selected' : ''}>🤖 Auto</option>
                                </select>
                            </div>
                        </div>
                        <div class="tool-card-description">${tool.description}</div>
                    </div>`;
                }).join('')}
            </div>
        `;
        root.appendChild(section);
    });

    // 5. Card UI Sync Logic
    container.querySelectorAll('.tool-policy-select').forEach((el: any) => {
        el.onchange = () => {
            const card = el.closest('.tool-card');
            card?.classList.toggle('active', el.value !== 'disabled');
        };
    });

    // 6. Search Filtering Logic
    const searchInput = document.getElementById('tool-search-input') as HTMLInputElement;
    searchInput.addEventListener('input', (e) => {
        const q = (e.target as HTMLInputElement).value.toLowerCase();
        document.querySelectorAll('.tool-card').forEach((card: any) => {
            const match = card.dataset.name.includes(q) || card.dataset.desc.includes(q);
            card.style.display = match ? 'flex' : 'none';
        });

        // Hide empty categories
        document.querySelectorAll('.tool-category-section').forEach((sec: any) => {
            const hasVisible = Array.from(sec.querySelectorAll('.tool-card')).some((c: any) => c.style.display !== 'none');
            sec.style.display = hasVisible ? 'block' : 'none';
        });
    });
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

    // Update state model
    state.usageData.project = usage.filter(f => !f.isExtra).map(f => ({ ...f, tokens: 0 }));
    state.usageData.extra = usage.filter(f => f.isExtra).map(f => ({ ...f, tokens: 0 }));

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

    const renderTableSection = (type: 'project' | 'extra', title: string, icon: string) => {
        const count = state.usageData[type].length;
        if (count === 0) return "";
        
        return `
            <div style="margin-bottom: 30px;">
                <div class="usage-section-header">
                    <div class="section-title"><i class="codicon ${icon}"></i> ${title} (${count})</div>
                    <div class="usage-sort-controls">
                        <button class="sort-btn ${state.currentUsageSort.column === 'name' ? 'active' : ''}" data-col="name" title="Sort by Name">
                            <i class="codicon codicon-sort-alphabetically"></i>
                        </button>
                        <button class="sort-btn ${state.currentUsageSort.column === 'tokens' ? 'active' : ''}" data-col="tokens" title="Sort by Size">
                            <i class="codicon codicon-graph-line"></i>
                        </button>
                        <div class="sort-divider"></div>
                        <button class="sort-btn direction-btn" title="Toggle Direction">
                            <i class="codicon ${state.currentUsageSort.direction === 'asc' ? 'codicon-arrow-up' : 'codicon-arrow-down'}"></i>
                        </button>
                    </div>
                </div>
                <table style="width:100%; border-collapse:collapse; font-size:12px;">
                    <tbody id="usage-table-${type}">
                        ${renderUsageRows(type, contextSize)}
                    </tbody>
                </table>
            </div>
        `;
    };

    container.innerHTML = html + renderTableSection('project', "Project Files", "codicon-root-folder") + renderTableSection('extra', "Research & External", "codicon-globe");

    // Add Bulk Action Bar
    const actionBar = document.createElement('div');
    actionBar.style.cssText = "position: sticky; bottom: 0; background: var(--vscode-editorWidget-background); padding: 10px; border-top: 1px solid var(--vscode-widget-border); display: flex; justify-content: space-between; align-items: center;";
    actionBar.innerHTML = `
        <div style="display:flex; gap:10px; align-items:center;">
            <input type="checkbox" id="usage-master-check" title="Select All">
            <span id="usage-selected-count" style="font-size:11px; opacity:0.7;">0 selected</span>
        </div>
        <button id="usage-bulk-remove-btn" class="code-action-btn delete-btn" disabled style="width:auto; height:28px; padding: 0 12px;">
            <i class="codicon codicon-trash"></i> Remove Selected
        </button>
    `;
    container.appendChild(actionBar);

    // Master Checkbox Logic
    const master = document.getElementById('usage-master-check') as HTMLInputElement;
    const bulkBtn = document.getElementById('usage-bulk-remove-btn') as HTMLButtonElement;
    const countLabel = document.getElementById('usage-selected-count');

    const updateUI = () => {
        const checked = container.querySelectorAll('.usage-row-check:checked').length;
        bulkBtn.disabled = checked === 0;
        if (countLabel) countLabel.textContent = `${checked} selected`;
    };

    master.onchange = () => {
        container.querySelectorAll('.usage-row-check').forEach((cb: any) => cb.checked = master.checked);
        updateUI();
    };

    container.addEventListener('change', (e) => {
        if ((e.target as HTMLElement).classList.contains('usage-row-check')) updateUI();
    });

    bulkBtn.onclick = () => {
        const paths = Array.from(container.querySelectorAll('.usage-row-check:checked')).map((cb: any) => cb.value);
        vscode.postMessage({ command: 'bulkRemoveFiles', paths });
        dom.usageModal.classList.remove('visible');
    };

    // Re-attach listeners for sort buttons
    container.querySelectorAll('.sort-btn').forEach(btn => {
        btn.onclick = (e) => {
            const col = (btn as HTMLElement).dataset.col as 'name' | 'tokens';
            if (col) {
                if (state.currentUsageSort.column === col) {
                    state.currentUsageSort.direction = state.currentUsageSort.direction === 'asc' ? 'desc' : 'asc';
                } else {
                    state.currentUsageSort.column = col;
                }
            } else if ((btn as HTMLElement).classList.contains('direction-btn')) {
                state.currentUsageSort.direction = state.currentUsageSort.direction === 'asc' ? 'desc' : 'asc';
            }
            
            refreshUsageDisplay(contextSize);
        };
    });

    container.onclick = (e) => {
        const target = e.target as HTMLElement;
        const btn = target.closest('.remove-usage-item-btn') as HTMLButtonElement;
        if (btn && btn.dataset.path) {
            vscode.postMessage({ command: 'removeFileFromContext', path: btn.dataset.path });
            const row = btn.closest('tr');
            if (row) row.style.opacity = '0.3';
        }
    };
}

function renderUsageRows(type: 'project' | 'extra', contextSize: number): string {
    const sorted = [...state.usageData[type]].sort((a, b) => {
        const dir = state.currentUsageSort.direction === 'asc' ? 1 : -1;
        if (state.currentUsageSort.column === 'name') {
            return dir * a.path.localeCompare(b.path);
        } else {
            return dir * ((a.tokens || 0) - (b.tokens || 0));
        }
    });

    return sorted.map(item => {
        const tokens = item.tokens || 0;
        const pct = Math.min((tokens / contextSize) * 100, 100);
        const barClass = pct > 20 ? 'range-warning' : 'range-safe';
        
        return `
            <tr data-path="${item.path}" style="border-bottom: 1px solid var(--vscode-widget-border);">
                <td style="padding:10px 8px; width: 30px;">
                    <input type="checkbox" class="usage-row-check" value="${item.path}">
                </td>
                <td style="padding:10px 8px; max-width:300px;">
                    <div style="font-weight: 500; overflow:hidden; text-overflow:ellipsis;">${item.path.split('/').pop()}</div>
                    <div style="font-size: 10px; opacity: 0.5; overflow:hidden; text-overflow:ellipsis;">${item.path}</div>
                </td>
                <td style="padding:10px 8px; width: 120px;">
                    <div style="display:flex; flex-direction:column; gap:4px;">
                        <span class="file-token-label" style="font-weight:bold;">${tokens > 0 ? tokens.toLocaleString() : '...'}</span>
                        <div class="token-progress-container" style="height:4px; width:100%;">
                            <div class="token-progress-bar file-usage-bar ${barClass}" style="width:${pct}%"></div>
                        </div>
                    </div>
                </td>
                <td style="padding:10px 8px; text-align:right; width:40px;">
                    <button class="icon-btn remove-usage-item-btn" data-path="${item.path}" title="Remove from context">
                        <i class="codicon codicon-trash"></i>
                    </button>
                </td>
            </tr>
        `;
    }).join('');
}

function refreshUsageDisplay(contextSize: number) {
    const projectBody = document.getElementById('usage-table-project');
    const extraBody = document.getElementById('usage-table-extra');
    
    if (projectBody) projectBody.innerHTML = renderUsageRows('project', contextSize);
    if (extraBody) extraBody.innerHTML = renderUsageRows('extra', contextSize);

    // Update active state of sort buttons
    document.querySelectorAll('.sort-btn').forEach((btn: any) => {
        if (btn.dataset.col) {
            btn.classList.toggle('active', btn.dataset.col === state.currentUsageSort.column);
        } else if (btn.classList.contains('direction-btn')) {
            const icon = btn.querySelector('i');
            if (icon) {
                icon.className = `codicon ${state.currentUsageSort.direction === 'asc' ? 'codicon-sort-numeric-up' : 'codicon-sort-numeric-down'}`;
            }
        }
    });
}

export function updateContextFileUsage(filePath: string, tokens: number) {
    // 1. Update State Model
    let item = state.usageData.project.find(i => i.path === filePath) || state.usageData.extra.find(i => i.path === filePath);
    if (item) item.tokens = tokens;

    // 2. Direct DOM update for responsiveness
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
/**
 * Renders the Workspace Access Matrix rows inside the HUD modal.
 */
export function renderWorkspaceMatrix() {
    const container = dom.matrixRowsContainer;
    const workspaceFolders = (window as any).workspaceFolders || [];
    const folderSettings = state.capabilities?.folderSettings || {};

    if (!container) return;
    container.innerHTML = '';

    if (workspaceFolders.length === 0) {
        container.innerHTML = '<div style="padding: 20px; opacity: 0.5; text-align: center;">No workspace folders open.</div>';
        return;
    }

    workspaceFolders.forEach((f: any) => {
        const uriKey = typeof f.uri === 'string' ? f.uri : (f.uri as any).toString();
        const settings = folderSettings[uriKey] || { tree: true, content: true };
        const stats = state.matrixStats?.[uriKey] || { tree: 0, files: 0 };

        const row = document.createElement('div');
        row.className = 'ws-matrix-row';
        row.dataset.uri = uriKey;
        row.style.cssText = "display: flex; align-items: center; justify-content: space-between; padding: 10px 16px; border-bottom: 1px solid var(--vscode-widget-border); gap: 15px;";

        row.innerHTML = `
            <div style="display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0;">
                <span class="codicon codicon-root-folder" style="opacity: 0.6; font-size: 16px;"></span>
                <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 800;">${f.name}</span>
            </div>
            <div style="display: flex; gap: 8px;">
                <button class="matrix-toggle-btn ${settings.tree ? 'active' : 'inactive'}" 
                        data-type="tree" 
                        style="display: flex; align-items: center; gap: 6px; font-size: 10px; padding: 4px 12px; border-radius: 4px; border: 1px solid var(--vscode-widget-border); cursor: pointer; transition: all 0.1s;
                        background: ${settings.tree ? 'var(--vscode-button-background)' : 'var(--vscode-button-secondaryBackground)'}; 
                        color: ${settings.tree ? 'var(--vscode-button-foreground)' : 'var(--vscode-button-secondaryForeground)'};"
                        title="${settings.tree ? 'Hide project structure (Tree)' : 'Include project structure (Tree)'}">
                        <i class="codicon ${settings.tree ? 'codicon-check' : 'codicon-circle-slash'}"></i>
                        <span>Tree</span>
                        <span class="token-mini-badge" style="background: rgba(0,0,0,0.3); padding: 1px 5px; border-radius: 4px; font-weight: 800; font-family: var(--vscode-editor-font-family);">${stats.tree.toLocaleString()}</span>
                </button>
                <button class="matrix-toggle-btn ${settings.content ? 'active' : 'inactive'}" 
                        data-type="content" 
                        style="display: flex; align-items: center; gap: 6px; font-size: 10px; padding: 4px 12px; border-radius: 4px; border: 1px solid var(--vscode-widget-border); cursor: pointer; transition: all 0.1s;
                        background: ${settings.content ? 'var(--vscode-button-background)' : 'var(--vscode-button-secondaryBackground)'}; 
                        color: ${settings.content ? 'var(--vscode-button-foreground)' : 'var(--vscode-button-secondaryForeground)'};"
                        title="${settings.content ? 'Mute file contents (Files)' : 'Include file contents (Files)'}">
                        <i class="codicon ${settings.content ? 'codicon-check' : 'codicon-circle-slash'}"></i>
                        <span>Content</span>
                        ${stats.files > 0 ? `<span class="token-mini-badge" style="background: rgba(0,0,0,0.3); padding: 1px 5px; border-radius: 4px; font-weight: 800; font-family: var(--vscode-editor-font-family);">${stats.files.toLocaleString()}</span>` : ''}
                </button>
            </div>
        `;

        // Attach listeners to buttons
        row.querySelectorAll('.matrix-toggle-btn').forEach(btn => {
            (btn as HTMLElement).onclick = (e) => {
                e.stopPropagation();
                const type = (btn as HTMLElement).dataset.type as 'tree' | 'content';
                const currentSettings = JSON.parse(JSON.stringify(state.capabilities?.folderSettings || {}));
                const nodeSettings = currentSettings[uriKey] || { tree: true, content: true };

                // Toggle setting
                nodeSettings[type] = !nodeSettings[type];

                vscode.postMessage({ 
                    command: 'updateDiscussionCapabilitiesPartial', 
                    partial: { folderSettings: { ...currentSettings, [uriKey]: nodeSettings } } 
                });

                // IMMEDIATE UI REFRESH: Trigger token calculation to update the bar
                vscode.postMessage({ command: 'calculateTokens' });
            };
        });

        container.appendChild(row);
    });
}

let currentStagingChanges: any[] = [];
let currentStagingIdx = 0;

export async function openStagingRevamp(messageId: string, changes: any[]) {
    currentStagingChanges = changes;
    currentStagingIdx = 0;

    const modal = document.getElementById('staging-revamp-modal');
    const list = document.getElementById('staging-files-list');
    if (!modal || !list) return;

    modal.classList.add('visible');
    renderStagingList();
    loadStagingDiff(0);
}

function renderStagingList() {
    const list = document.getElementById('staging-files-list')!;
    list.innerHTML = currentStagingChanges.map((c, i) => `
        <div class="staging-file-item ${i === currentStagingIdx ? 'active' : ''}" onclick="window.loadStagingDiff(${i})">
            <div class="status-dot ${c.isValid ? 'valid' : 'invalid'}" title="${c.isValid ? 'Ready to patch' : 'Error: Search block not found'}"></div>
            <div style="flex:1; min-width:0;">
                <div style="font-size:12px; font-weight:bold; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${c.path.split('/').pop()}</div>
                <div style="font-size:9px; opacity:0.6; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${c.path}</div>
            </div>
            ${c.isApplied ? '<i class="codicon codicon-check" style="color:var(--vscode-charts-green)"></i>' : ''}
        </div>
    `).join('');

    const stats = document.getElementById('staging-stats');
    const validCount = currentStagingChanges.filter(c => c.isValid).length;
    if (stats) stats.textContent = `${validCount} / ${currentStagingChanges.length} files valid`;
}

async function loadStagingDiff(index: number) {
    currentStagingIdx = index;
    renderStagingList();
    const change = currentStagingChanges[index];
    const container = document.getElementById('staging-diff-content')!;
    container.innerHTML = '<div style="padding:20px; opacity:0.5;">Calculating diff...</div>';

    // We request the current file content from the extension to show a real diff
    vscode.postMessage({ 
        command: 'requestFileContentForDiff', 
        path: change.path,
        changeIndex: index 
    });
}

(window as any).loadStagingDiff = loadStagingDiff;

// Listen for the content returned by extension
window.addEventListener('message', event => {
    const m = event.data;
    if (m.command === 'provideFileContentForDiff') {
        renderVisualDiff(m.currentContent, currentStagingChanges[m.changeIndex].content);
    }
});

function renderVisualDiff(oldText: string, patch: string) {
    const container = document.getElementById('staging-diff-content')!;
    // Simple line-based diff for the review UI
    const oldLines = oldText.split('\n');
    let html = '';

    // If it's an Aider block, we extract the SEARCH/REPLACE
    const aiderMatch = patch.match(/<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>> REPLACE/);

    if (aiderMatch) {
        const searchLines = aiderMatch[1].split('\n');
        const replaceLines = aiderMatch[2].split('\n');

        // This is a simplified "Review" render. In a real app we'd use a diff library.
        // But for pedagogical purposes, showing the block we are replacing is better.
        html += `<div style="padding:10px; background:var(--vscode-editor-inactiveSelectionBackground); font-size:10px; opacity:0.7;">--- SEARCH BLOCK ---</div>`;
        searchLines.forEach(l => html += `<div class="diff-line removed"><span class="diff-line-num">-</span>${sanitizer.sanitize(l)}</div>`);
        html += `<div style="padding:10px; background:var(--vscode-editor-inactiveSelectionBackground); font-size:10px; opacity:0.7;">+++ REPLACE BLOCK ---</div>`;
        replaceLines.forEach(l => html += `<div class="diff-line added"><span class="diff-line-num">+</span>${sanitizer.sanitize(l)}</div>`);
    } else {
        // Full file rewrite
        patch.split('\n').forEach((l, i) => {
            html += `<div class="diff-line added"><span class="diff-line-num">${i+1}</span>${sanitizer.sanitize(l)}</div>`;
        });
    }
    container.innerHTML = html;
}

export function updateProgressBar(container: HTMLElement | null, current: number, total: number, segments?: any) {
    if (!container) return;

    if (segments && total > 0) {
        container.innerHTML = '';
        // Add 'memory' to the visual segments list
        const types = ['system', 'tree', 'skills', 'memory', 'files', 'history', 'images'];

        types.forEach(type => {
            const count = segments[type] || 0;
            if (count > 0) {
                const segDiv = document.createElement('div');
                segDiv.className = `token-bar-segment segment-${type}`;
                // CRITICAL: Ensure dataset and attribute are synced for the event listener
                segDiv.dataset.type = type;
                segDiv.setAttribute('data-type', type);
                const pct = (count / total) * 100;
                segDiv.style.width = `${pct}%`;
                segDiv.title = `${type.toUpperCase()}: ${count.toLocaleString()} tokens`;
                container.appendChild(segDiv);
            }
        });

        // FIX: The legend is now in the main top-controls area.
        // We prevent duplication by selecting from the static DOM instead of parent.
        let legend = document.getElementById('token-bar-legend');
        if (legend) {
            legend.style.display = 'flex';
        } else if (!container.parentElement?.querySelector('.token-legend')) {
            legend = document.createElement('div');
            legend.className = 'token-legend';
            legend.innerHTML = `
                <div class="legend-item" data-type="system" title="View Processed System Prompt">
                    <div class="legend-dot segment-system"></div>System
                </div>
                <div class="legend-item" data-type="tree" title="View Project Tree Structure">
                    <div class="legend-dot segment-tree"></div>Trees
                </div>
                <div class="legend-item" data-type="skills" title="View Active Skills">
                    <div class="legend-dot segment-skills"></div>Skills
                </div>
                <div class="legend-item" data-type="memory" title="View Project Memory">
                    <div class="legend-dot segment-memory"></div>Memory
                </div>
                <div class="legend-item" data-type="files" title="View Detailed File Usage">
                    <div class="legend-dot segment-files"></div>Files
                </div>
                <div class="legend-item" data-type="chat" title="View History Context">
                    <div class="legend-dot segment-history"></div>Chat
                </div>
                <div class="legend-item" data-type="images"><div class="legend-dot segment-images"></div>Images</div>
            `;

            // Use robust event listeners instead of raw onclick attributes
            legend.querySelectorAll('.legend-item').forEach(item => {
                (item as HTMLElement).onclick = () => {
                    const type = (item as HTMLElement).dataset.type;
                    if (type && type !== 'images') {
                        vscode.postMessage({
                            command: 'executeLollmsCommand', 
                            details: { command: 'lollms-vs-coder.viewFullContext', params: type }
                        });
                    }
                };
            });
            container.parentElement?.appendChild(legend);
        }
    } else {
        // Fallback for single bar use (e.g. usage modal)
        container.innerHTML = `<div class="token-bar-segment segment-files" style="width: ${Math.min((current/total)*100, 100)}%"></div>`;
    }

    const ratio = current / total;
    container.style.borderColor = ratio > 1.0 ? 'var(--vscode-charts-red)' : '';
}
