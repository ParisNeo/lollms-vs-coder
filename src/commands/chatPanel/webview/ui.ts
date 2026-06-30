import { dom, state, vscode } from "./dom.js";
import { isScrolledToBottom, applySearchReplace } from "./utils.js";
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

/**
 * Opens a full-screen high-fidelity zoom of the clicked image.
 */
export function openImageZoom(src: string) {
    const overlay = document.getElementById('image-zoom-overlay');
    const displayImg = document.getElementById('zoomed-image-display') as HTMLImageElement;
    
    if (overlay && displayImg) {
        displayImg.src = src;
        overlay.classList.add('active');
        
        // Add one-time listener for ESC key
        const escListener = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                closeImageZoom();
                document.removeEventListener('keydown', escListener);
            }
        };
        document.addEventListener('keydown', escListener);
    }
}

/**
 * Closes the zoom overlay.
 */
export function closeImageZoom() {
    const overlay = document.getElementById('image-zoom-overlay');
    if (overlay) {
        overlay.classList.remove('active');
    }
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
let currentTool = 'select'; // Default to select mode (PPTX Style)
let textInputPos = { x: 0, y: 0, w: 0, h: 0 };
let startPos = { x: 0, y: 0 };
let currentDragPos = { x: 0, y: 0 }; // Track real-time drag coordinates
let lastPanPos = { x: 0, y: 0 };
let webcamStream: MediaStream | null = null;

// Zoom & Pan State
let viewState = {
    scale: 1,
    offsetX: 0,
    offsetY: 0
};

// Layered Vector Shapes (PPTX Style)
interface VectorShape {
    id: string;
    type: 'arrow' | 'rect' | 'oval' | 'text' | 'brush' | 'spline';
    x: number;
    y: number;
    w: number;
    h: number;
    text?: string;
    color: string;
    width: number;
    arrowType?: 'single' | 'dual';
    cx?: number; // Control point X for splines
    cy?: number; // Control point Y for splines
    points?: {x: number, y: number}[]; // For brush
}

let annotationShapes: VectorShape[] = [];
let selectedShape: VectorShape | null = null;
let isDraggingShape = false;
let isResizingShape = false;
let resizeHandle: string | null = null; // 'nw', 'ne', 'se', 'sw', 'n', 's', 'e', 'w', 'control'
let dragOffset = { x: 0, y: 0 };
let baseImage: HTMLImageElement | null = null;

const HANDLE_SIZE = 8;
const SNAP_THRESHOLD = 15; // Snapping threshold in pixels

// Helper to convert screen mouse coords to internal canvas coords
function getTransformedPoint(x: number, y: number) {
    return {
        x: (x - viewState.offsetX) / viewState.scale,
        y: (y - viewState.offsetY) / viewState.scale
    };
}

// Undo/Redo System for Vector Layers
let undoStack: string[] = []; // JSON strings of annotationShapes
let redoStack: string[] = [];

function saveState() {
    undoStack.push(JSON.stringify(annotationShapes));
    redoStack = []; 
    if (undoStack.length > 50) undoStack.shift();
}

function undo() {
    if (undoStack.length < 2) return; 
    const current = undoStack.pop()!;
    redoStack.push(current);
    const prev = undoStack[undoStack.length - 1];
    annotationShapes = JSON.parse(prev);
    redrawCanvas();
}

function redo() {
    if (redoStack.length === 0) return;
    const next = redoStack.pop()!;
    undoStack.push(next);
    annotationShapes = JSON.parse(next);
    redrawCanvas();
}

function drawArrow(ctx: CanvasRenderingContext2D, fromx: number, fromy: number, tox: number, toy: number, color: string, width: number, arrowType: 'single' | 'dual' = 'single') {
    const headlen = 15; 
    const angle = Math.atan2(toy - fromy, tox - fromx);

    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';

    // Draw main line
    ctx.beginPath();
    ctx.moveTo(fromx, fromy);
    ctx.lineTo(tox, toy);
    ctx.stroke();

    // Draw target arrow head
    ctx.beginPath();
    ctx.moveTo(tox, toy);
    ctx.lineTo(tox - headlen * Math.cos(angle - Math.PI / 6), toy - headlen * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(tox - headlen * Math.cos(angle + Math.PI / 6), toy - headlen * Math.sin(angle + Math.PI / 6));
    ctx.closePath();
    ctx.fill();

    // Draw source arrow head if dual
    if (arrowType === 'dual') {
        ctx.beginPath();
        ctx.moveTo(fromx, fromy);
        ctx.lineTo(fromx + headlen * Math.cos(angle - Math.PI / 6), fromy + headlen * Math.sin(angle - Math.PI / 6));
        ctx.lineTo(fromx + headlen * Math.cos(angle + Math.PI / 6), fromy + headlen * Math.sin(angle + Math.PI / 6));
        ctx.closePath();
        ctx.fill();
    }
}

function drawSplineArrow(ctx: CanvasRenderingContext2D, fromx: number, fromy: number, cx: number, cy: number, tox: number, toy: number, color: string, width: number, arrowType: 'single' | 'dual' = 'single') {
    const headlen = 15;

    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';

    // Draw quadratic Bezier curve
    ctx.beginPath();
    ctx.moveTo(fromx, fromy);
    ctx.quadraticCurveTo(cx, cy, tox, toy);
    ctx.stroke();

    // Calculate tangents for arrow heads at end-points of Bezier curve
    // Derivative of Q(t) = (1-t)^2*P0 + 2(1-t)t*P1 + t^2*P2 is:
    // Q'(t) = 2(1-t)(P1 - P0) + 2t(P2 - P1)

    // At t = 1 (target end)
    const angleEnd = Math.atan2(toy - cy, tox - cx);
    ctx.beginPath();
    ctx.moveTo(tox, toy);
    ctx.lineTo(tox - headlen * Math.cos(angleEnd - Math.PI / 6), toy - headlen * Math.sin(angleEnd - Math.PI / 6));
    ctx.lineTo(tox - headlen * Math.cos(angleEnd + Math.PI / 6), toy - headlen * Math.sin(angleEnd + Math.PI / 6));
    ctx.closePath();
    ctx.fill();

    // At t = 0 (source end) if dual
    if (arrowType === 'dual') {
        const angleStart = Math.atan2(cy - fromy, cx - fromx);
        ctx.beginPath();
        ctx.moveTo(fromx, fromy);
        ctx.lineTo(fromx + headlen * Math.cos(angleStart - Math.PI / 6), fromy + headlen * Math.sin(angleStart - Math.PI / 6));
        ctx.lineTo(fromx + headlen * Math.cos(angleStart + Math.PI / 6), fromy + headlen * Math.sin(angleStart + Math.PI / 6));
        ctx.closePath();
        ctx.fill();
    }
}

function getSelectionHandles(shape: VectorShape) {
    const x = shape.x;
    const y = shape.y;
    const w = shape.w;
    const h = shape.h;

    // Normalize bounding box dimensions to support negative widths/heights
    const x1 = w < 0 ? x + w : x;
    const x2 = w < 0 ? x : x + w;
    const y1 = h < 0 ? y + h : y;
    const y2 = h < 0 ? y : y + h;
    const midX = x1 + (x2 - x1) / 2;
    const midY = y1 + (y2 - y1) / 2;

    const baseHandles: any = {
        nw: { x: x1, y: y1 },
        n:  { x: midX, y: y1 },
        ne: { x: x2, y: y1 },
        e:  { x: x2, y: midY },
        se: { x: x2, y: y2 },
        s:  { x: midX, y: y2 },
        sw: { x: x1, y: y2 },
        w:  { x: x1, y: midY }
    };

    // If it's a spline, we also expose its control point handle
    if (shape.type === 'spline' && shape.cx !== undefined && shape.cy !== undefined) {
        baseHandles.control = { x: shape.cx, y: shape.cy };
    }

    return baseHandles;
}

/**
 * Iterates through all other shapes to find if the active coordinate is close to any of their selection handles.
 * If a match is found within SNAP_THRESHOLD, returns the snapped coordinates; otherwise returns original.
 */
function getSnappedPoint(pt: { x: number, y: number }, excludeId?: string): { x: number, y: number, snapped: boolean } {
    for (const shape of annotationShapes) {
        if (excludeId && shape.id === excludeId) continue;

        // Grab all handles of the candidate shape
        const handles = getSelectionHandles(shape);
        for (const key in handles) {
            const h = handles[key];
            const dist = Math.sqrt((pt.x - h.x) ** 2 + (pt.y - h.y) ** 2);
            if (dist <= SNAP_THRESHOLD) {
                return { x: h.x, y: h.y, snapped: true };
            }
        }
    }
    return { x: pt.x, y: pt.y, snapped: false };
}

function redrawCanvas() {
    if (!canvasCtx || !dom.editorCanvas) return;

    // 1. Reset transform and clear
    canvasCtx.setTransform(1, 0, 0, 1, 0, 0);
    canvasCtx.fillStyle = '#1e1e1e'; // Background gap color
    canvasCtx.fillRect(0, 0, dom.editorCanvas.width, dom.editorCanvas.height);

    // 2. Set current zoom/pan transform
    canvasCtx.setTransform(viewState.scale, 0, 0, viewState.scale, viewState.offsetX, viewState.offsetY);

    // 3. Draw Base Image
    if (baseImage && baseImage.complete) {
        canvasCtx.drawImage(baseImage, 0, 0);
    }

    // 4. Draw Vector Layers (Shapes)
    annotationShapes.forEach(shape => {
        canvasCtx!.save();

        const x1 = shape.w < 0 ? shape.x + shape.w : shape.x;
        const y1 = shape.h < 0 ? shape.y + shape.h : shape.y;
        const absW = Math.abs(shape.w);
        const absH = Math.abs(shape.h);

        if (shape === selectedShape) {
            // Highlight selected shape (PPTX Style)
            canvasCtx!.strokeStyle = 'var(--vscode-charts-orange)';
            canvasCtx!.lineWidth = 1.5 / viewState.scale;
            canvasCtx!.setLineDash([4 / viewState.scale, 4 / viewState.scale]);
            canvasCtx!.strokeRect(x1 - 4, y1 - 4, absW + 8, absH + 8);
            canvasCtx!.setLineDash([]);

            // Draw bounding handles for resizing
            const handles = getSelectionHandles(shape);
            canvasCtx!.fillStyle = '#ffffff';
            canvasCtx!.strokeStyle = 'var(--vscode-charts-orange)';
            canvasCtx!.lineWidth = 1 / viewState.scale;

            const halfHandle = (HANDLE_SIZE / 2) / viewState.scale;
            const sideHandle = HANDLE_SIZE / viewState.scale;

            for (const key in handles) {
                const h = (handles as any)[key];
                canvasCtx!.fillRect(h.x - halfHandle, h.y - halfHandle, sideHandle, sideHandle);
                canvasCtx!.strokeRect(h.x - halfHandle, h.y - halfHandle, sideHandle, sideHandle);
            }
        }

        canvasCtx!.strokeStyle = shape.color;
        canvasCtx!.fillStyle = shape.color;
        canvasCtx!.lineWidth = shape.width;

        if (shape.type === 'rect') {
            canvasCtx!.strokeRect(shape.x, shape.y, shape.w, shape.h);
        } else if (shape.type === 'oval') {
            canvasCtx!.beginPath();
            const cx = shape.x + shape.w / 2;
            const cy = shape.y + shape.h / 2;
            const rx = Math.abs(shape.w) / 2;
            const ry = Math.abs(shape.h) / 2;
            canvasCtx!.ellipse(cx, cy, rx, ry, 0, 0, 2 * Math.PI);
            canvasCtx!.stroke();
        } else if (shape.type === 'arrow') {
            drawArrow(canvasCtx!, shape.x, shape.y, shape.x + shape.w, shape.y + shape.h, shape.color, shape.width, shape.arrowType || 'single');
        } else if (shape.type === 'spline') {
            const ctrlX = shape.cx !== undefined ? shape.cx : (shape.x + shape.w / 2);
            const ctrlY = shape.cy !== undefined ? shape.cy : (shape.y + shape.h / 2 - 40);
            drawSplineArrow(canvasCtx!, shape.x, shape.y, ctrlX, ctrlY, shape.x + shape.w, shape.y + shape.h, shape.color, shape.width, shape.arrowType || 'single');
        } else if (shape.type === 'text' && shape.text) {
            canvasCtx!.font = `${shape.width * 5}px sans-serif`;
            canvasCtx!.textBaseline = 'top';

            // Text Wrapping within vector boundary width
            const words = shape.text.split(' ');
            let line = '';
            let lineY = shape.y;
            const lineHeight = shape.width * 5.8;
            const maxW = Math.abs(shape.w);

            for (let n = 0; n < words.length; n++) {
                const testLine = line + words[n] + ' ';
                const metrics = canvasCtx!.measureText(testLine);
                if (metrics.width > maxW && n > 0) {
                    canvasCtx!.fillText(line, shape.x, lineY);
                    line = words[n] + ' ';
                    lineY += lineHeight;
                } else {
                    line = testLine;
                }
            }
            canvasCtx!.fillText(line, shape.x, lineY);
        } else if (shape.type === 'brush' && shape.points) {
            canvasCtx!.beginPath();
            canvasCtx!.lineCap = 'round';
            canvasCtx!.lineJoin = 'round';
            shape.points.forEach((p, idx) => {
                if (idx === 0) canvasCtx!.moveTo(p.x, p.y);
                else canvasCtx!.lineTo(p.x, p.y);
            });
            canvasCtx!.stroke();
        }

        canvasCtx!.restore();
    });

    // 5. Draw Real-time Dashed Preview of the active shape being dragged
    if (isDrawing && ['rect', 'oval', 'arrow', 'dual_arrow', 'spline_arrow', 'spline_dual_arrow', 'text'].includes(currentTool)) {
        canvasCtx!.save();
        const activeColor = (document.getElementById('editor-color') as HTMLInputElement).value;
        const activeWidth = parseInt((document.getElementById('editor-width') as HTMLInputElement).value) / viewState.scale;

        canvasCtx!.strokeStyle = activeColor;
        canvasCtx!.lineWidth = activeWidth;
        canvasCtx!.setLineDash([6 / viewState.scale, 4 / viewState.scale]); // Dashed line styling

        const w = currentDragPos.x - startPos.x;
        const h = currentDragPos.y - startPos.y;

        if (currentTool === 'rect' || currentTool === 'text') {
            canvasCtx!.strokeRect(startPos.x, startPos.y, w, h);
        } else if (currentTool === 'oval') {
            canvasCtx!.beginPath();
            const cx = startPos.x + w / 2;
            const cy = startPos.y + h / 2;
            const rx = Math.abs(w) / 2;
            const ry = Math.abs(h) / 2;
            canvasCtx!.ellipse(cx, cy, rx, ry, 0, 0, 2 * Math.PI);
            canvasCtx!.stroke();
        } else if (['arrow', 'dual_arrow'].includes(currentTool)) {
            // Apply real-time snapping to other handles while drawing
            const snapRes = getSnappedPoint(currentDragPos, undefined);
            const finalW = snapRes.x - startPos.x;
            const finalH = snapRes.y - startPos.y;

            drawArrow(canvasCtx!, startPos.x, startPos.y, startPos.x + finalW, startPos.y + finalH, activeColor, activeWidth, currentTool === 'dual_arrow' ? 'dual' : 'single');

            // Draw a tiny visual indicator at snap site if snapped
            if (snapRes.snapped) {
                canvasCtx!.fillStyle = 'var(--vscode-charts-green)';
                canvasCtx!.beginPath();
                canvasCtx!.arc(snapRes.x, snapRes.y, 5 / viewState.scale, 0, 2 * Math.PI);
                canvasCtx!.fill();
            }
        } else if (['spline_arrow', 'spline_dual_arrow'].includes(currentTool)) {
            const snapRes = getSnappedPoint(currentDragPos, undefined);
            const finalW = snapRes.x - startPos.x;
            const finalH = snapRes.y - startPos.y;

            // Generate an automatic arched control point
            const midX = startPos.x + finalW / 2;
            const midY = startPos.y + finalH / 2 - 40;

            drawSplineArrow(canvasCtx!, startPos.x, startPos.y, midX, midY, startPos.x + finalW, startPos.y + finalH, activeColor, activeWidth, currentTool === 'spline_dual_arrow' ? 'dual' : 'single');

            if (snapRes.snapped) {
                canvasCtx!.fillStyle = 'var(--vscode-charts-green)';
                canvasCtx!.beginPath();
                canvasCtx!.arc(snapRes.x, snapRes.y, 5 / viewState.scale, 0, 2 * Math.PI);
                canvasCtx!.fill();
            }
        }

        canvasCtx!.restore();
    }

    // Update Delete button visibility
    const delBtn = document.getElementById('editor-delete-shape');
    if (delBtn) {
        delBtn.style.display = selectedShape ? 'inline-flex' : 'none';
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
    annotationShapes = [];
    selectedShape = null;

    const onImageLoaded = (img: HTMLImageElement) => {
        baseImage = img;
        canvas.width = img.width;
        canvas.height = img.height;
        viewState = { scale: 1, offsetX: 0, offsetY: 0 };
        saveState(); // Initial empty state
        redrawCanvas();
    };

    if (index !== null) {
        const img = new Image();
        img.onload = () => onImageLoaded(img);
        img.src = state.pendingImages[index].data;
    } else {
        // Create blank white canvas
        const img = new Image();
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = 800;
        tempCanvas.height = 600;
        const tempCtx = tempCanvas.getContext('2d')!;
        tempCtx.fillStyle = 'white';
        tempCtx.fillRect(0, 0, 800, 600);

        img.onload = () => onImageLoaded(img);
        img.src = tempCanvas.toDataURL();
    }

    initCanvasEvents();
}

export function fitImageToScreen(): void {
    if (!baseImage || !dom.editorCanvas) return;
    const canvas = dom.editorCanvas;

    // Fit scale with a 5% margin
    const scaleX = canvas.width / baseImage.width;
    const scaleY = canvas.height / baseImage.height;
    const scale = Math.min(scaleX, scaleY) * 0.95;

    // Centering offsets
    const offsetX = (canvas.width - baseImage.width * scale) / 2;
    const offsetY = (canvas.height - baseImage.height * scale) / 2;

    viewState = { scale, offsetX, offsetY };
    redrawCanvas();
}

export function zoomCanvas(zoomIn: boolean): void {
    if (!dom.editorCanvas) return;
    const canvas = dom.editorCanvas;
    const factor = zoomIn ? 1.2 : 0.8;
    const newScale = Math.min(Math.max(viewState.scale * factor, 0.1), 10);

    // Zoom relative to the center of the canvas
    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;

    viewState.offsetX = centerX - (centerX - viewState.offsetX) * (newScale / viewState.scale);
    viewState.offsetY = centerY - (centerY - viewState.offsetY) * (newScale / viewState.scale);
    viewState.scale = newScale;

    redrawCanvas();
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

    // --- ZOOM LOGIC ---
    canvas.addEventListener('wheel', (e: WheelEvent) => {
        if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
        }
        const delta = -e.deltaY;
        const factor = Math.pow(1.1, delta / 100);
        const newScale = Math.min(Math.max(viewState.scale * factor, 0.1), 10);

        const mouse = { x: e.offsetX, y: e.offsetY };
        viewState.offsetX = mouse.x - (mouse.x - viewState.offsetX) * (newScale / viewState.scale);
        viewState.offsetY = mouse.y - (mouse.y - viewState.offsetY) * (newScale / viewState.scale);
        viewState.scale = newScale;

        redrawCanvas();
    }, { passive: false });

    canvas.onmousedown = (e) => {
        // Space+Left click, Middle click, or Pan Tool triggers Pan
        if (e.button === 1 || (e.button === 0 && (currentTool === 'pan' || (window as any).isSpaceDown))) {
            isPanning = true;
            lastPanPos = { x: e.clientX, y: e.clientY };
            canvas.style.cursor = 'grabbing';
            return;
        }

        if (dom.editorTextInput.style.display === 'block') {
            commitTextToCanvas();
        }

        const pt = getTransformedPoint(e.offsetX, e.offsetY);

        // Apply snap-to-handle mechanics when initiating a line/arrow to wire nodes together
        let activeStartPos = pt;
        if (['arrow', 'dual_arrow', 'spline_arrow', 'spline_dual_arrow'].includes(currentTool)) {
            const snapRes = getSnappedPoint(pt, undefined);
            if (snapRes.snapped) {
                activeStartPos = { x: snapRes.x, y: snapRes.y };
            }
        }
        startPos = activeStartPos;

        // 1. SELECT/MOVE/RESIZE MODE (PowerPoint Style)
        if (currentTool === 'select') {
            if (selectedShape) {
                // Check if we clicked on any resize handles of the currently selected shape first
                const handles = getSelectionHandles(selectedShape);
                const clickRadius = (HANDLE_SIZE * 1.5) / viewState.scale;

                for (const key in handles) {
                    const h = (handles as any)[key];
                    const dist = Math.sqrt((pt.x - h.x) ** 2 + (pt.y - h.y) ** 2);
                    if (dist <= clickRadius) {
                        isResizingShape = true;
                        resizeHandle = key;
                        redrawCanvas();
                        return;
                    }
                }
            }

            // Find if clicked inside any shape bounding box (reverse order for top-most)
            const clicked = [...annotationShapes].reverse().find(shape => {
                const x1 = shape.w < 0 ? shape.x + shape.w : shape.x;
                const x2 = shape.w < 0 ? shape.x : shape.x + shape.w;
                const y1 = shape.h < 0 ? shape.y + shape.h : shape.y;
                const y2 = shape.h < 0 ? shape.y : shape.y + shape.h;

                // For splines, expand selection bounds to cover the control point
                if (shape.type === 'spline' && shape.cx !== undefined && shape.cy !== undefined) {
                    const minX = Math.min(x1, shape.cx);
                    const maxX = Math.max(x2, shape.cx);
                    const minY = Math.min(y1, shape.cy);
                    const maxY = Math.max(y2, shape.cy);
                    return pt.x >= minX && pt.x <= maxX && pt.y >= minY && pt.y <= maxY;
                }

                return pt.x >= x1 && pt.x <= x2 && pt.y >= y1 && pt.y <= y2;
            });

            if (clicked) {
                selectedShape = clicked;
                isDraggingShape = true;
                dragOffset.x = pt.x - clicked.x;
                dragOffset.y = pt.y - clicked.y;
            } else {
                selectedShape = null; // Clicked on background
            }
            redrawCanvas();
            return;
        }

        // 2. CREATION MODES
        isDrawing = true;
        if (currentTool === 'brush') {
            const brushShape: VectorShape = {
                id: `shape_${Date.now()}`,
                type: 'brush',
                x: pt.x,
                y: pt.y,
                w: 0,
                h: 0,
                color: (document.getElementById('editor-color') as HTMLInputElement).value,
                width: parseInt((document.getElementById('editor-width') as HTMLInputElement).value) / viewState.scale,
                points: [pt]
            };
            annotationShapes.push(brushShape);
            selectedShape = brushShape;
        }
    };

    canvas.onmousemove = (e) => {
        const pt = getTransformedPoint(e.offsetX, e.offsetY);
        currentDragPos = pt; // Always update real-time cursor coordinate

        if (isPanning) {
            const dx = e.clientX - lastPanPos.x;
            const dy = e.clientY - lastPanPos.y;
            viewState.offsetX += dx;
            viewState.offsetY += dy;
            lastPanPos = { x: e.clientX, y: e.clientY };
            redrawCanvas();
            return;
        }

        if (isDraggingShape && selectedShape) {
            selectedShape.x = pt.x - dragOffset.x;
            selectedShape.y = pt.y - dragOffset.y;
            redrawCanvas();
            return;
        }

        if (isResizingShape && selectedShape) {
            // Apply real-time snapping when resizing arrow or spline terminal points
            const isLineLike = ['arrow', 'spline'].includes(selectedShape.type);
            const snapRes = isLineLike ? getSnappedPoint(pt, selectedShape.id) : { x: pt.x, y: pt.y };

            const x = selectedShape.x;
            const y = selectedShape.y;
            const w = selectedShape.w;
            const h = selectedShape.h;

            if (resizeHandle === 'control' && selectedShape.type === 'spline') {
                selectedShape.cx = pt.x;
                selectedShape.cy = pt.y;
            } else if (resizeHandle === 'se') {
                selectedShape.w = snapRes.x - x;
                selectedShape.h = snapRes.y - y;
            } else if (resizeHandle === 'nw') {
                selectedShape.x = snapRes.x;
                selectedShape.y = snapRes.y;
                selectedShape.w = (x + w) - snapRes.x;
                selectedShape.h = (y + h) - snapRes.y;
            } else if (resizeHandle === 'ne') {
                selectedShape.y = snapRes.y;
                selectedShape.w = snapRes.x - x;
                selectedShape.h = (y + h) - snapRes.y;
            } else if (resizeHandle === 'sw') {
                selectedShape.x = snapRes.x;
                selectedShape.w = (x + w) - snapRes.x;
                selectedShape.h = snapRes.y - y;
            } else if (resizeHandle === 'e') {
                selectedShape.w = snapRes.x - x;
            } else if (resizeHandle === 'w') {
                selectedShape.x = snapRes.x;
                selectedShape.w = (x + w) - snapRes.x;
            } else if (resizeHandle === 's') {
                selectedShape.h = snapRes.y - y;
            } else if (resizeHandle === 'n') {
                selectedShape.y = snapRes.y;
                selectedShape.h = (y + h) - snapRes.y;
            }
            redrawCanvas();
            return;
        }

        if (!isDrawing) return;

        if (currentTool === 'brush' && selectedShape && selectedShape.points) {
            selectedShape.points.push(pt);
            redrawCanvas();
        } else if (['rect', 'oval', 'arrow'].includes(currentTool)) {
            // Re-render canvas to draw the real-time dashed preview
            redrawCanvas();
        }
    };

    canvas.onmouseup = (e) => {
        if (isPanning) {
            isPanning = false;
            canvas.style.cursor = currentTool === 'pan' ? 'grab' : 'crosshair';
            return;
        }

        if (isDraggingShape) {
            isDraggingShape = false;
            saveState();
            return;
        }

        if (isResizingShape) {
            isResizingShape = false;
            resizeHandle = null;
            saveState();
            return;
        }

        if (!isDrawing) return;
        isDrawing = false;

        const pt = getTransformedPoint(e.offsetX, e.offsetY);

        if (currentTool === 'brush') {
            saveState();
        } else if (['rect', 'oval', 'arrow', 'dual_arrow', 'spline_arrow', 'spline_dual_arrow'].includes(currentTool)) {
            // Apply final snap logic to terminal point
            const isLineLike = ['arrow', 'dual_arrow', 'spline_arrow', 'spline_dual_arrow'].includes(currentTool);
            const snapRes = isLineLike ? getSnappedPoint(pt, undefined) : { x: pt.x, y: pt.y };

            const w = snapRes.x - startPos.x;
            const h = snapRes.y - startPos.y;

            if (Math.abs(w) > 4 || Math.abs(h) > 4) {
                const isSpline = currentTool.startsWith('spline');
                const isDual = currentTool.includes('dual');
                const shapeType = isSpline ? 'spline' : (currentTool.includes('arrow') ? 'arrow' : currentTool);

                const shape: VectorShape = {
                    id: `shape_${Date.now()}`,
                    // @ts-ignore
                    type: shapeType,
                    x: startPos.x,
                    y: startPos.y,
                    w,
                    h,
                    color: (document.getElementById('editor-color') as HTMLInputElement).value,
                    width: parseInt((document.getElementById('editor-width') as HTMLInputElement).value) / viewState.scale
                };

                if (isLineLike) {
                    shape.arrowType = isDual ? 'dual' : 'single';
                }

                if (isSpline) {
                    // Set an arched control point halfway along the line as default
                    shape.cx = startPos.x + w / 2;
                    shape.cy = startPos.y + h / 2 - 45;
                }

                annotationShapes.push(shape);
                selectedShape = shape;
                saveState();
            }
            redrawCanvas();
        } else if (currentTool === 'text') {
            const width = Math.abs(pt.x - startPos.x);
            const height = Math.abs(pt.y - startPos.y);
            const x = Math.min(startPos.x, pt.x);
            const y = Math.min(startPos.y, pt.y);

            if (width > 5 && height > 5) {
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

    // --- TOOLBAR CLICKS (PPTX STYLING) ---
    const bindTool = (id: string, tool: string) => {
        const el = document.getElementById(id);
        if (el) {
            el.onclick = (e) => {
                e.preventDefault();
                currentTool = tool;
                selectedShape = null;
                document.querySelectorAll('#vector-tools .code-action-btn').forEach(b => b.classList.remove('active'));
                el.classList.add('active');

                if (tool === 'pan') {
                    canvas.style.cursor = 'grab';
                } else if (tool === 'select') {
                    canvas.style.cursor = 'default';
                } else {
                    canvas.style.cursor = 'crosshair';
                }
                redrawCanvas();
            };
        }
    };

    bindTool('tool-select', 'select');
    bindTool('tool-pan', 'pan');
    bindTool('tool-brush', 'brush');
    bindTool('tool-text', 'text');
    bindTool('tool-rect', 'rect');
    bindTool('tool-oval', 'oval');
    bindTool('tool-arrow', 'arrow');
    bindTool('tool-dual-arrow', 'dual_arrow');
    bindTool('tool-spline-arrow', 'spline_arrow');
    bindTool('tool-spline-dual-arrow', 'spline_dual_arrow');

    // Default to active brush tool on init
    const brushBtn = document.getElementById('tool-brush');
    if (brushBtn) brushBtn.classList.add('active');

    // ⌨️ GLOBAL KEYBOARD UNDO/REDO LISTENERS
    const handleShortcuts = (e: KeyboardEvent) => {
        if (dom.editorModal.style.display === 'flex') {
            // Bypass if user is actively writing text inside the canvas textarea
            if (document.activeElement === dom.editorTextInput) {
                return;
            }
            if (e.ctrlKey || e.metaKey) {
                if (e.key === 'z' || e.key === 'Z') {
                    e.preventDefault();
                    e.stopPropagation();
                    undo();
                } else if (e.key === 'y' || e.key === 'Y') {
                    e.preventDefault();
                    e.stopPropagation();
                    redo();
                }
            }
        }
    };
    window.removeEventListener('keydown', handleShortcuts);
    window.addEventListener('keydown', handleShortcuts);

    // Zoom Buttons
    const zoomInBtn = document.getElementById('editor-zoom-in');
    if (zoomInBtn) zoomInBtn.onclick = () => zoomCanvas(true);

    const zoomOutBtn = document.getElementById('editor-zoom-out');
    if (zoomOutBtn) zoomOutBtn.onclick = () => zoomCanvas(false);

    const zoomFitBtn = document.getElementById('editor-zoom-fit');
    if (zoomFitBtn) zoomFitBtn.onclick = () => fitImageToScreen();

    const undoBtn = document.getElementById('editor-undo');
    if (undoBtn) undoBtn.onclick = undo;

    const redoBtn = document.getElementById('editor-redo');
    if (redoBtn) redoBtn.onclick = redo;

    const delBtn = document.getElementById('editor-delete-shape');
    if (delBtn) {
        delBtn.onclick = () => {
            if (selectedShape) {
                annotationShapes = annotationShapes.filter(s => s.id !== selectedShape!.id);
                selectedShape = null;
                saveState();
                redrawCanvas();
            }
        };
    }

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

        // Temporarily clear selection highlights before raster flattening
        const previousSelection = selectedShape;
        selectedShape = null;
        redrawCanvas();

        const dataUrl = canvas.toDataURL('image/png');

        // Restore highlights for continuation
        selectedShape = previousSelection;
        redrawCanvas();

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

        const shape: VectorShape = {
            id: `shape_${Date.now()}`,
            type: 'text',
            x: textInputPos.x,
            y: textInputPos.y,
            w: textInputPos.w,
            h: textInputPos.h,
            text: input.value,
            color: input.style.color,
            width: fontSize / 5 // Scale factor
        };

        annotationShapes.push(shape);
        selectedShape = null; // Clear target boundary immediately after committing text
        saveState();
        redrawCanvas();
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

export function showProjectLoader(projectName: string) {
    // Hide standard generating overlay if it's up
    if (dom.generatingOverlay) dom.generatingOverlay.style.display = 'none';

    let loader = document.getElementById('project-loader');
    if (!loader) {
        loader = document.createElement('div');
        loader.id = 'project-loader';
        loader.className = 'project-loader-overlay';
        loader.innerHTML = `
            <div class="loader-blueprint">
                <div class="loader-grid"></div>
                <div class="loader-scan-line"></div>
            </div>
            <div class="loader-content">
                <div class="loader-title">Indexing <strong>${projectName}</strong></div>
                <div class="loader-status" id="loader-status-text">INITIALIZING QUANTUM HUB...</div>
                <div class="loader-stats">
                    <div class="stat-box">
                        <span class="stat-label">FILES DISCOVERED</span>
                        <span class="stat-value" id="loader-stat-files">---</span>
                    </div>
                    <div class="stat-box">
                        <span class="stat-label">CONTEXT LOAD</span>
                        <span class="stat-value" id="loader-stat-tokens">---</span>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(loader);
    }
}

export function hideProjectLoader() {
    const loader = document.getElementById('project-loader');
    if (loader) {
        loader.style.opacity = '0';
        setTimeout(() => loader.remove(), 300);
    }
}

export function updateLoaderStatus(status: string, stats?: { files?: number, tokens?: number }) {
    const statusEl = document.getElementById('loader-status-text');
    if (statusEl) {
        statusEl.textContent = status;
        // Add a slight "glitch" effect to the text when it updates to match the blueprint theme
        statusEl.style.opacity = '0.5';
        setTimeout(() => { statusEl.style.opacity = '1'; }, 50);
    }

    if (stats) {
        if (stats.files !== undefined) {
            const el = document.getElementById('loader-stat-files');
            if (el) el.textContent = stats.files > 0 ? stats.files.toString() : '---';
        }
        if (stats.tokens !== undefined) {
            const el = document.getElementById('loader-stat-tokens');
            if (el) {
                if (stats.tokens === -1) {
                    el.textContent = 'Counting...';
                    el.style.fontSize = '10px';
                } else {
                    el.textContent = `${(stats.tokens / 1000).toFixed(1)}k`;
                    el.style.fontSize = '';
                }
            }
        }
    }
}
export function setCalculatingTokens(isCalculating: boolean, text?: string) {
    const label = document.getElementById('token-count-label');
    const quickRefreshIcon = document.querySelector('#hud-quick-refresh-btn .codicon');

    if (isCalculating) {
        if (label) label.textContent = text || 'Counting...';
        if (quickRefreshIcon) quickRefreshIcon.classList.add('spin');
    } else {
        if (quickRefreshIcon) quickRefreshIcon.classList.remove('spin');
    }
}


export function setGeneratingState(isGenerating: boolean, statusText?: string, showRaiseHand: boolean = false, buttonLabel?: string) {
    // Ensure project loader is cleared if we are starting a real generation
    if (isGenerating) hideProjectLoader();

    const overlay = dom.generatingOverlay;
    if (!overlay) return;
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
        // Keep editable during generation so the user can prepare the next prompt
        dom.messageInput.disabled = false;
    }

    // --- GLOBAL BUTTON LOCKDOWN ---
    // Restrict button lockdown to chat messages (.messages) and the context HUD (#context-container).
    // This explicitly prevents locking the Image Editor modal so you can draw/annotate while a task runs.
    const actionableButtons = document.querySelectorAll('.messages .apply-btn, .messages .lollms-command-btn, .messages .code-action-btn, .messages .msg-action-btn, .messages .summarize-context-btn, .messages .open-context-btn, .messages .remove-context-btn, #context-container button');
    actionableButtons.forEach((btn: any) => {
        if (isGenerating) {
            // Discrete lockdown: disable and fade, but DO NOT replace content with spinners
            btn.disabled = true;
            btn.style.pointerEvents = 'none';
            btn.style.opacity = '0.4'; 
        } else {
            btn.disabled = false;
            btn.style.pointerEvents = 'auto';
            btn.style.opacity = '1';
        }
    });

    if (dom.sendButton) {
        if (isGenerating) {
            dom.sendButton.style.opacity = '0.4';
            dom.sendButton.style.cursor = 'not-allowed';
            dom.sendButton.title = 'Generation in progress...';
        } else {
            dom.sendButton.style.opacity = '';
            dom.sendButton.style.cursor = '';
            dom.sendButton.title = 'Send Message';
        }
    }

    if(dom.agentModeCheckbox) dom.agentModeCheckbox.disabled = isGenerating;

    if(dom.modelSelector) dom.modelSelector.disabled = isGenerating;
    if(dom.attachButton) dom.attachButton.disabled = isGenerating;
    if(dom.executeButton) dom.executeButton.disabled = isGenerating;
    if(dom.setEntryPointButton) dom.setEntryPointButton.disabled = isGenerating;
    if(dom.debugRestartButton) dom.debugRestartButton.disabled = isGenerating;

    if (dom.inputAreaWrapper) {
        dom.inputAreaWrapper.style.display = 'block'; // Always keep input area visible
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
                    if (buttonLabel) {
                        btnLabel.textContent = buttonLabel.toUpperCase();
                    } else {
                        if (isApplying) btnLabel.textContent = "STOP APPLICATION";
                        else if (isSearching) btnLabel.textContent = "STOP SEARCH";
                        else if (isThinking) btnLabel.textContent = "STOP REASONING";
                        else btnLabel.textContent = "STOP GENERATION";
                    }
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
        if (dom.inputArea) dom.inputArea.classList.remove('disabled'); // Keep active during generation
    }
}

/**
 * Detects if the menu will go off-screen and flips it if necessary.
 * Optimized for Sovereign HUD placement at the top of the viewport.
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

    // Logic: Since HUD is at top, priority is to open DOWN.
    // Flip UP only if we are at the bottom of the screen.
    const spaceBelow = viewportHeight - triggerRect.bottom;
    const needsFlip = spaceBelow < menuRect.height && triggerRect.top > menuRect.height;

    if (needsFlip) {
        menu.classList.add('open-up');
        // If HUD is sticky, we might need to manually set top to avoid clipping
        menu.style.top = 'auto';
        menu.style.bottom = '100%';
    } else {
        menu.style.top = '100%';
        menu.style.bottom = 'auto';
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
        e.preventDefault(); // BLOCK <details> toggle
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

/**
 * Reactively updates all Context Expansion blocks in the chat history
 * based on the latest global state. Fixes the "Always Blue" bug.
 */
export function syncExpansionBlocks() {
    const globalState = (window as any).state;
    const globalFiles = globalState?.lastContextData?.files || [];

    // Helper for robust path matching
    const isPathMatch = (pathA: string, pathB: string): boolean => {
        if (!pathA || !pathB) return false;
        const cleanA = pathA.replace(/\\/g, '/').replace(/^\.?\//, '').toLowerCase().trim();
        const cleanB = pathB.replace(/\\/g, '/').replace(/^\.?\//, '').toLowerCase().trim();
        return cleanA === cleanB || cleanA.endsWith('/' + cleanB) || cleanB.endsWith('/' + cleanA);
    };

    const items = document.querySelectorAll('.expansion-file-item');
    console.log(`[UI:Sync] Syncing ${items.length} UI items against ${globalFiles.length} context files.`);

    items.forEach((item: any) => {
        const pathAttr = item.getAttribute('data-path');
        if (!pathAttr) return;

        const isIncluded = globalFiles.some((cf: string) => isPathMatch(cf, pathAttr));

        if (isIncluded) {
            const icon = item.querySelector('.codicon');
            item.style.borderColor = 'var(--vscode-charts-green)';
            item.style.background = 'rgba(15, 157, 88, 0.1)';
            item.style.borderLeft = '4px solid var(--vscode-charts-green)';
            if (icon) {
                icon.className = 'codicon codicon-check';
                icon.style.color = 'var(--vscode-charts-green)';
            }
        }
    });

    // Also update buttons with the same robust matching logic
    document.querySelectorAll('.context-expansion-block').forEach((block: any) => {
        const files = JSON.parse(block.dataset.files || '[]');
        const allIncluded = files.every((f: string) => 
            globalFiles.some((cf: string) => isPathMatch(cf, f))
        );

        const addBtn = block.querySelector('.add-btn') as HTMLButtonElement;
        if (addBtn && allIncluded) {
            addBtn.innerHTML = '<span class="codicon codicon-check"></span> Added to Context';
            addBtn.className = 'code-action-btn applied';
            addBtn.disabled = true;
        }

        const repromptBtn = block.querySelector('.add-reprompt-btn') as HTMLButtonElement;
        if (repromptBtn && allIncluded) {
            repromptBtn.innerHTML = '<span class="codicon codicon-play"></span> Reprompt AI';
            repromptBtn.className = 'code-action-btn apply-btn';
            repromptBtn.disabled = false;
        }
    });
}

/**
 * Global internal image viewer to bypass browser popup blockers.
 */
export function openSovereignZoom(dataUri: string) {
    const overlay = document.getElementById('image-zoom-overlay');
    const display = document.getElementById('zoomed-image-display') as HTMLImageElement;
    if (!overlay || !display) return;

    display.src = dataUri;
    overlay.classList.add('active'); 

    const close = (e?: Event) => {
        if (e) e.stopPropagation();
        closeSovereignZoom();
    };

    overlay.onclick = close;
    const closeBtn = document.getElementById('zoom-close-btn');
    if (closeBtn) closeBtn.onclick = close;

    const copyBtn = document.getElementById('zoom-copy-btn');
    if (copyBtn) {
        copyBtn.onclick = (e) => {
            e.stopPropagation();
            vscode.postMessage({ command: 'copyToClipboard', text: dataUri });
            copyBtn.innerHTML = '<i class="codicon codicon-check"></i> Copied Data';
            setTimeout(() => { copyBtn.innerHTML = '<i class="codicon codicon-copy"></i> Copy Image'; }, 2000);
        };
    }

    // Capture Escape key to close the overlay
    const handleEsc = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
            closeSovereignZoom();
            window.removeEventListener('keydown', handleEsc);
        }
    };
    window.addEventListener('keydown', handleEsc);
}

/**
 * Closes the sovereign zoom overlay and resets its state.
 */
export function closeSovereignZoom() {
    const overlay = document.getElementById('image-zoom-overlay');
    if (overlay) {
        overlay.classList.remove('active');
    }
}

export function updateBadges() {
    // RESILIENT TARGETING: Look for the container in the Fused Dashboard
    const container = document.getElementById('active-badges');

    if (!container) {
        console.warn("[UI] updateBadges: active-badges container not found in DOM.");
        return;
    }

    if (!state.capabilities) return;

    const caps = state.capabilities;
    container.innerHTML = '';

    const isAgentMode = caps.agentMode === true;
    const isAgentActive = caps.agentMode === true;

    // Set high-level presence on body for HUD-aware styling
    document.body.classList.toggle('agent-mode-active', isAgentActive);

    // Hide or display the standard Chat HUD in Agent Mode to prevent clutter
    const chatHud = document.getElementById('fused-context-dashboard');
    if (chatHud) {
        chatHud.style.display = isAgentActive ? 'none' : 'block';
    }

    // --- GROUP A: INFRASTRUCTURE ---
    if (true) {
        const infraGroup = document.createElement('div');
        infraGroup.className = 'badge-group';
        container.appendChild(infraGroup);

        // Model Badge
        if (dom.modelSelector && dom.modelSelector.value) {
            const model = dom.modelSelector.value;
            const span = document.createElement('span');
            span.className = 'mode-badge model clickable';
            span.title = 'Current Model (Click to change)';
            span.innerHTML = `<span class="codicon codicon-hubot"></span> ${model}`;
            span.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (dom.modelSelector) {
                    dom.modelSelector.focus();
                    const event = document.createEvent('MouseEvents');
                    event.initMouseEvent('mousedown', true, true, window, 0, 0, 0, 0, 0, false, false, false, false, 0, null);
                    dom.modelSelector.dispatchEvent(event);
                }
            };
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
                    e.preventDefault(); // BLOCK <details> toggle
                    e.stopPropagation();
                    // Update local state immediately for visual feedback
                    state.currentPersonalityId = p.id;
                    vscode.postMessage({ command: 'updateDiscussionPersonality', personalityId: p.id });
                    updateBadges();
                    menu.classList.remove('visible');
                };
                
                menu.appendChild(item);
            });

            pBadge.onclick = (e) => {
                e.preventDefault(); // BLOCK <details> toggle
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
    if (dom.contextAggressionSelect) dom.contextAggressionSelect.value = caps.contextAggression || 'respect';
    if (dom.capGitWorkflow) dom.capGitWorkflow.checked = !!caps.gitWorkflow;
    if (dom.capEnableTTS) dom.capEnableTTS.checked = !!caps.enableTTS;
    if (dom.capEnableSTT) dom.capEnableSTT.checked = !!caps.enableSTT;
    if (dom.herdModeCheckbox) dom.herdModeCheckbox.checked = !!caps.herdMode;
    if (dom.herdConfigSection) {
        dom.herdConfigSection.style.display = caps.herdMode ? 'block' : 'none';
    }

    const debugConfig = document.getElementById('debug-config-section');
    if (debugConfig) {
        debugConfig.style.display = caps.debugMode ? 'block' : 'none';
    }

    if (dom.capDebugMode) dom.capDebugMode.checked = !!caps.debugMode;
    if (dom.capMaxDebugSteps) dom.capMaxDebugSteps.value = (caps.maxDebugSteps || 10).toString();

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
                 e.preventDefault(); // BLOCK <details> toggle
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
            e.preventDefault(); // BLOCK <details> toggle
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

    // --- GROUNDING COGNITION & AUXILIARY PROTOCOLS (COLLAPSED DROP-DOWN HUB) ---
    const optionsParentGroup = document.createElement('div');
    optionsParentGroup.className = 'badge-group hud-options-parent';
    container.appendChild(optionsParentGroup);

    // 1. Gather all active visual icons representing enabled protocols
    const activeIcons: string[] = [];
    if (caps.thinkingMode) activeIcons.push('🧠');
    if (caps.sparqlEnabled !== false) activeIcons.push('📊');
    if (caps.grepEnabled !== false) activeIcons.push('🔍');
    if (caps.webSearch === true) activeIcons.push('🌍');
    if (caps.projectMemoryEnabled !== false) activeIcons.push('🧬');
    if (caps.autoSkillMode === true) activeIcons.push('💡');
    if (caps.autoApply === true) activeIcons.push('⚡');
    if (caps.debugMode === true) activeIcons.push('🐞');
    if (caps.verifierMode === true) activeIcons.push('🛡️');
    if (caps.testMode === true) activeIcons.push('🧪');
    if (caps.documentationMode === true) activeIcons.push('📖');
    if (caps.gitAutoWorkflow === true) activeIcons.push('🐙');
    if (caps.herdMode === true) activeIcons.push('🐂');

    const iconsLabel = activeIcons.length > 0 ? activeIcons.join(' ') : '⚙️';

    // 2. Render Consolidated Trigger Badge
    const optionsTriggerBadge = document.createElement('span');
    optionsTriggerBadge.className = 'mode-badge active clickable';
    optionsTriggerBadge.style.background = 'var(--vscode-button-secondaryBackground)';
    optionsTriggerBadge.style.color = 'var(--vscode-button-secondaryForeground)';
    optionsTriggerBadge.style.borderColor = 'var(--vscode-widget-border)';
    optionsTriggerBadge.title = `Sovereign HUD Options (Hover/Click to configure protocols)`;
    optionsTriggerBadge.innerHTML = `
        <span class="codicon codicon-settings-gear"></span> 
        <span class="badge-label" style="margin-left: 4px; letter-spacing: 0.5px; font-weight: bold;">HUD: ${iconsLabel}</span>
    `;
    optionsParentGroup.appendChild(optionsTriggerBadge);

    // 3. Render Vertical Options Popup
    const optionsDropdownMenu = document.createElement('div');
    optionsDropdownMenu.className = 'hud-options-popup';
    optionsDropdownMenu.style.cssText = `
        display: none;
        position: absolute;
        top: calc(100% + 5px);
        left: 0;
        z-index: 10001;
        background: var(--vscode-editorWidget-background);
        border: 1px solid var(--vscode-widget-border);
        box-shadow: 0 10px 30px rgba(0,0,0,0.5);
        padding: 10px;
        border-radius: 8px;
        flex-direction: column;
        gap: 8px;
        min-width: 240px;
        max-height: 70vh;
        overflow-y: auto;
    `;
    optionsParentGroup.appendChild(optionsDropdownMenu);

    // Prevent closing details/accordions when clicking inside the popup menu
    optionsDropdownMenu.onclick = (e) => {
        e.stopPropagation();
    };

    // Toggle menu visibility on left click of the trigger badge
    optionsTriggerBadge.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const isVisible = optionsDropdownMenu.style.display === 'flex';
        document.querySelectorAll('.hud-options-popup').forEach((m: any) => m.style.display = 'none');
        optionsDropdownMenu.style.display = isVisible ? 'none' : 'flex';
    };

    // Auto-close menu when clicking anywhere else on window
    const closeMenuHandler = () => {
        optionsDropdownMenu.style.display = 'none';
        window.removeEventListener('click', closeMenuHandler);
    };
    optionsTriggerBadge.addEventListener('click', () => {
        setTimeout(() => window.addEventListener('click', closeMenuHandler), 50);
    });

    // Helper to generate checkboxes inside the options dropdown list
    const appendToggleOption = (label: string, icon: string, checked: boolean, onToggle: () => void) => {
        const optionRow = document.createElement('div');
        optionRow.style.cssText = "display: flex; align-items: center; justify-content: space-between; gap: 15px; padding: 4px 8px; border-radius: 4px; font-size: 12px;";
        optionRow.innerHTML = `
            <div style="display: flex; align-items: center; gap: 8px; opacity: 0.9;">
                <span class="codicon ${icon}"></span>
                <span>${label}</span>
            </div>
            <label class="switch" style="width: 28px; height: 16px; margin: 0; flex-shrink: 0;">
                <input type="checkbox" ${checked ? 'checked' : ''} style="margin: 0; cursor: pointer;">
                <span class="slider" style="border-radius: 16px;"></span>
            </label>
        `;
        optionRow.querySelector('input')!.onchange = (e) => {
            e.stopPropagation();
            onToggle();
        };
        optionsDropdownMenu.appendChild(optionRow);
    };

    // Populate all original options vertical style
    appendToggleOption('🧠 Thinking Mode', 'codicon-circuit-board', !!caps.thinkingMode, () => {
        vscode.postMessage({ command: 'updateDiscussionCapabilitiesPartial', partial: { thinkingMode: !caps.thinkingMode } });
    });
    appendToggleOption('📊 SPARQL Engine', 'codicon-graph', caps.sparqlEnabled !== false, () => {
        vscode.postMessage({ command: 'updateDiscussionCapabilitiesPartial', partial: { sparqlEnabled: caps.sparqlEnabled === false } });
    });
    appendToggleOption('🔍 GREP Indexer', 'codicon-search', caps.grepEnabled !== false, () => {
        vscode.postMessage({ command: 'updateDiscussionCapabilitiesPartial', partial: { grepEnabled: caps.grepEnabled === false } });
    });
    appendToggleOption('🌍 Web Research', 'codicon-globe', !!caps.webSearch, () => {
        vscode.postMessage({ command: 'updateDiscussionCapabilitiesPartial', partial: { webSearch: !caps.webSearch } });
    });
    appendToggleOption('🧬 Project DNA', 'codicon-chip', caps.projectMemoryEnabled !== false, () => {
        vscode.postMessage({ command: 'updateDiscussionCapabilitiesPartial', partial: { projectMemoryEnabled: caps.projectMemoryEnabled === false } });
    });
    appendToggleOption('💡 Skills Library', 'codicon-lightbulb', !!caps.autoSkillMode, () => {
        vscode.postMessage({ command: 'updateDiscussionCapabilitiesPartial', partial: { autoSkillMode: !caps.autoSkillMode } });
    });
    appendToggleOption('⚡ Auto-Apply Blocks', 'codicon-zap', !!caps.autoApply, () => {
        vscode.postMessage({ command: 'updateDiscussionCapabilitiesPartial', partial: { autoApply: !caps.autoApply } });
    });
    appendToggleOption('🐞 Debug Protocol', 'codicon-bug', !!caps.debugMode, () => {
        vscode.postMessage({ command: 'updateDiscussionCapabilitiesPartial', partial: { debugMode: !caps.debugMode } });
    });
    appendToggleOption('🛡️ Verifier Protocol', 'codicon-shield', !!caps.verifierMode, () => {
        vscode.postMessage({ command: 'updateDiscussionCapabilitiesPartial', partial: { verifierMode: !caps.verifierMode } });
    });
    appendToggleOption('🧪 Test Protocol', 'codicon-beaker', !!caps.testMode, () => {
        vscode.postMessage({ command: 'updateDiscussionCapabilitiesPartial', partial: { testMode: !caps.testMode } });
    });
    appendToggleOption('📖 Docs Protocol', 'codicon-book', !!caps.documentationMode, () => {
        vscode.postMessage({ command: 'updateDiscussionCapabilitiesPartial', partial: { documentationMode: !caps.documentationMode } });
    });
    appendToggleOption('🐙 Git Integration', 'codicon-git-branch', !!caps.gitAutoWorkflow, () => {
        vscode.postMessage({ command: 'updateDiscussionCapabilitiesPartial', partial: { gitAutoWorkflow: !caps.gitAutoWorkflow } });
    });
    appendToggleOption('🐂 Multi-Agent (Herd)', 'codicon-organization', !!caps.herdMode, () => {
        vscode.postMessage({ command: 'updateDiscussionCapabilitiesPartial', partial: { herdMode: !caps.herdMode } });
    });

    // --- GROUP C: SOVEREIGN OPERATIONAL MODE (Mutually Exclusive) ---
    const modeGroup = document.createElement('div');
    modeGroup.className = 'badge-group';
    container.appendChild(modeGroup);

    const isAgent = caps.agentMode === true;
    const isDynamic = caps.dynamicMode === true && !isAgent;
    const isAssistant = !isAgent && !isDynamic;

    // A. Assistant Mode (Fully Manual)
    const assistantBadge = createToggleBadge(
        '👤 Assistant',
        'autocontext',
        true,
        isAssistant,
        () => {
            vscode.postMessage({ 
                command: 'updateDiscussionCapabilitiesPartial', 
                partial: { agentMode: false, dynamicMode: false } 
            });
            updateBadges();
        }
    );
    if (assistantBadge) {
        assistantBadge.title = "Assistant Mode: Fully manual execution. AI provides code; you apply and run manually.";
        modeGroup.appendChild(assistantBadge);
    }

    // B. Dynamic Mode (Semi-Automated In-Chat Loop)
    const dynamicBadge = createToggleBadge(
        '🧠 Dynamic',
        'thinking',
        true,
        isDynamic,
        () => {
            vscode.postMessage({ 
                command: 'updateDiscussionCapabilitiesPartial', 
                partial: { agentMode: false, dynamicMode: true } 
            });
            updateBadges();
        }
    );
    if (dynamicBadge) {
        dynamicBadge.title = "Dynamic Mode: Semi-automated. AI runs context updates, research, and queries dynamically inside your chat bubble.";
        if (isDynamic) {
            dynamicBadge.style.backgroundColor = 'var(--vscode-charts-orange)';
            dynamicBadge.style.color = 'white';
        }
        modeGroup.appendChild(dynamicBadge);
    }

    // C. Agent Mode (Fully Automated Sidebar)
    const agentBadge = createToggleBadge(
        '🤖 Agent',
        'agent',
        true,
        isAgent,
        () => {
            vscode.postMessage({ 
                command: 'updateDiscussionCapabilitiesPartial', 
                partial: { agentMode: true, dynamicMode: false } 
            });
            updateBadges();
        }
    );
    if (agentBadge) {
        agentBadge.title = "Agent Mode: Fully autonomous sidebar operator. Plans, writes files, and runs terminal commands.";
        if (isAgent) {
            agentBadge.style.backgroundColor = 'var(--vscode-charts-red)';
            agentBadge.style.color = 'white';
        }
        modeGroup.appendChild(agentBadge);
    }

    // --- AGENT MISSION PROFILE SELECTOR (Only in Agent Mode) ---
    if (isAgent && state.agentProfiles && state.agentProfiles.length > 0) {
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
            container.appendChild(wrapper);
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

    const useRegex = (document.getElementById('skills-search-regex') as HTMLInputElement)?.checked;
    const matchCase = (document.getElementById('skills-search-case') as HTMLInputElement)?.checked;
    const searchTerm = query.trim();

    const items = container.querySelectorAll('.skills-tree-item');

    if (!searchTerm) {
        items.forEach((item: any) => {
            item.style.display = '';
            const details = item.querySelector('details');
            if (details) details.open = false;
        });
        return;
    }

    // 1. Prepare Matcher
    let matcher: (text: string) => boolean;
    try {
        if (useRegex) {
            const regex = new RegExp(searchTerm, matchCase ? '' : 'i');
            matcher = (text) => regex.test(text);
        } else {
            const lowerTerm = matchCase ? searchTerm : searchTerm.toLowerCase();
            matcher = (text) => (matchCase ? text : text.toLowerCase()).includes(lowerTerm);
        }
    } catch (e) {
        console.warn("Invalid regex in skills search");
        return;
    }

    // 2. Hide everything initially
    items.forEach((item: any) => {
        item.style.display = 'none';
        const details = item.querySelector('details');
        if (details) details.open = false;
    });

    // 3. Perform Deep Search
    items.forEach((item: any) => {
        // We only check the label text, not the entire subtree text to avoid "coding" matching everything
        const labelEl = item.querySelector('.skill-node label, .skill-folder-label');
        const textToMatch = labelEl?.textContent || "";

        if (matcher(textToMatch)) {
            // Show this item
            item.style.display = 'block';

            // If the matched item is a folder, show and expand all of its children
            const details = item.querySelector('details');
            if (details) {
                details.open = true;
                const descendants = item.querySelectorAll('.skills-tree-item');
                descendants.forEach((desc: any) => {
                    desc.style.display = 'block';
                    const descDetails = desc.querySelector('details');
                    if (descDetails) descDetails.open = true;
                });
            }

            // Walk up parents to show the path
            let parent = item.parentElement;
            while (parent && parent !== container) {
                if (parent.classList.contains('skills-tree-item')) {
                    parent.style.display = 'block';
                    const parentDetails = parent.querySelector('details');
                    if (parentDetails) parentDetails.open = true;
                }
                parent = parent.parentElement;
            }
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

        // Ensure strictly type-safe inclusion check
        const isDiscussionActive = discussionSkills.some(id => String(id) === String(child.id));
        const isProjectActive = projectSkills.some(id => String(id) === String(child.id));

        const controlsHtml = `
            <div class="skill-controls" style="display: flex; gap: 20px; flex-shrink: 0;">
                <label class="switch" style="width: 24px; height: 14px;" title="Active in this Chat">
                    <input type="checkbox" value="${child.id}" class="skill-discussion-checkbox ${child.isSkill ? '' : 'bundle-discussion'}" ${isDiscussionActive ? 'checked' : ''}>
                    <span class="slider" style="border-radius: 14px;"></span>
                </label>
                <label class="switch" style="width: 24px; height: 14px;" title="Active for the whole Project">
                    <input type="checkbox" value="${child.id}" class="skill-project-checkbox ${child.isSkill ? '' : 'bundle-project'}" ${isProjectActive ? 'checked' : ''}>
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

/**
 * Renders the Tool Picker modal allowing users to equip specific agent capabilities.
 */
/**
 * Renders the Tool Picker modal allowing users to equip specific agent capabilities.
 */
export function renderToolPicker(allTools: any[], discussionTools: string[], projectTools: string[]) {
    const modal = document.getElementById('tool-picker-modal');
    const list = document.getElementById('tool-picker-list');
    const searchInp = document.getElementById('tool-picker-search') as HTMLInputElement;
    if (!modal || !list) return;

    if (searchInp) searchInp.value = '';

    const renderList = (filter = "") => {
        const query = filter.toLowerCase();

        let html = `
            <div style="display: flex; justify-content: flex-end; padding: 0 10px 8px 10px; border-bottom: 1px solid var(--vscode-widget-border); margin-bottom: 10px;">
                <div style="display: flex; gap: 20px;">
                    <span style="font-size: 9px; font-weight: 800; opacity: 0.6;">CHAT</span>
                    <span style="font-size: 9px; font-weight: 800; opacity: 0.6;">PROJECT</span>
                </div>
            </div>
        `;

        html += allTools.map(tool => {
            const inChat = discussionTools.includes(tool.name);
            const inProject = projectTools.includes(tool.name);
            const matches = tool.name.toLowerCase().includes(query) || tool.description.toLowerCase().includes(query);

            return `
                <div class="tool-picker-item ${(inChat || inProject) ? 'selected' : ''}" data-name="${tool.name}" style="display: ${matches ? 'flex' : 'none'}; align-items: center; justify-content: space-between; padding: 8px 12px;">
                    <div style="flex:1; min-width:0; padding-right: 15px;">
                        <div style="font-weight:bold; font-size:12px; color: var(--vscode-foreground);">${tool.name}</div>
                        <div style="font-size:10px; opacity:0.7; line-height:1.4; margin-bottom: 4px;">${tool.description}</div>
                        <div style="font-size:9px; opacity:0.5; font-family:monospace;">
                            Params: [${(tool.parameters || []).map((p: any) => p.name).join(', ')}]
                        </div>
                    </div>
                    <div style="display: flex; gap: 20px; flex-shrink: 0;">
                        <label class="switch" style="width: 24px; height: 14px;">
                            <input type="checkbox" value="${tool.name}" class="tool-chat-check" ${inChat ? 'checked' : ''}>
                            <span class="slider" style="border-radius: 14px;"></span>
                        </label>
                        <label class="switch" style="width: 24px; height: 14px;">
                            <input type="checkbox" value="${tool.name}" class="tool-project-check" ${inProject ? 'checked' : ''}>
                            <span class="slider" style="border-radius: 14px;"></span>
                        </label>
                    </div>
                </div>
            `;
        }).join('');

        list.innerHTML = html;
    };

    renderList();

    if (searchInp) {
        searchInp.oninput = () => renderList(searchInp.value);
        setTimeout(() => searchInp.focus(), 100);
    }

    modal.classList.add('visible');

    const closeBtn = document.getElementById('tool-picker-close-btn');
    if (closeBtn) closeBtn.onclick = () => modal.classList.remove('visible');

    const applyBtn = document.getElementById('tool-picker-apply-btn');
    if (applyBtn) {
        applyBtn.onclick = () => {
            const chatTools = Array.from(list.querySelectorAll('.tool-chat-check:checked')).map((el: any) => el.value);
            const projTools = Array.from(list.querySelectorAll('.tool-project-check:checked')).map((el: any) => el.value);

            vscode.postMessage({ 
                command: 'updateDiscussionCapabilitiesPartial', 
                partial: { 
                    importedTools: chatTools,
                    projectTools: projTools
                } 
            });
            modal.classList.remove('visible');

            if (state.capabilities) {
                state.capabilities.importedTools = chatTools;
            }
            updateBadges();
            vscode.postMessage({ command: 'calculateTokens' });
        };
    }
}
// Expose globally for the message handler
(window as any).renderToolPicker = renderToolPicker;

export function updateContextFileUsage(filePath: string, tokens: number) {
    // 1. Update State Model
    if (!state.usageData || !state.usageData.project) return;

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
    const container = document.getElementById('matrix-rows-container');
    const modal = document.getElementById('workspace-matrix-modal');
    
    if (!container || !modal) {
        console.error("Matrix elements not found in DOM");
        return;
    }

    // Fallback to state if window object is not yet populated
    const workspaceFolders = (window as any).workspaceFolders || (state as any).workspaceFolders || [];

    // Crucial: Use an empty object fallback for settings to prevent undefined errors
    const folderSettings = state.capabilities?.folderSettings || {};

    container.innerHTML = '';
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
(window as any).currentStagingChanges = currentStagingChanges;
(window as any).currentStagingIdx = currentStagingIdx;

/**
 * Opens the Raw Aider Block modal with tabs for each hunk.
 */
/**
 * Opens the Raw Aider Block modal with tabs for each hunk.
 */
// --- PROGRESSIVE HUNK MATCHING STATE MACHINE ---
export let progressiveSearchState: {
    lines: string[];
    currentStartLineIdx: number;
    currentEndLineIdx: number;
    filePath: string;
    messageId: string;
    blockIndex: number;
    hunkIndex: number;
    originalSearchBlock: string;
} | null = null;

export function runProgressiveHunkSearch() {
    if (!progressiveSearchState) return;

    const { lines, currentStartLineIdx, currentEndLineIdx, filePath } = progressiveSearchState;

    if (currentStartLineIdx >= lines.length) {
        // We have exhausted all lines without finding any match
        renderProgressiveSearchFailure();
        return;
    }

    // Isolate current window of lines and join them with space for fast AND-pattern searching
    const queryLines = lines.slice(currentStartLineIdx, currentEndLineIdx + 1);
    const query = queryLines.join(' ').trim();

    if (!query) {
        // If empty line, skip directly to next starting line
        progressiveSearchState.currentStartLineIdx++;
        progressiveSearchState.currentEndLineIdx = progressiveSearchState.currentStartLineIdx;
        runProgressiveHunkSearch();
        return;
    }

    // Show temporary progress status in results panel
    if (dom.rawSearchResultsMini) {
        dom.rawSearchResultsMini.style.display = 'flex';
        dom.rawSearchResultsMini.innerHTML = `
            <div style="padding:15px; text-align:center; opacity:0.7; width:100%;">
                <div class="spinner" style="margin-bottom:8px;"></div>
                <div>Searching: <code>${sanitizer.sanitize(query.substring(0, 40))}${query.length > 40 ? '...' : ''}</code></div>
            </div>
        `;
    }

    // Trigger on-disk grep/findstr search
    vscode.postMessage({
        command: 'requestFileSearch',
        query: query,
        mode: 'content',
        options: { matchCase: true, wholeWord: false, include: filePath }
    });
}

function renderProgressiveSearchFailure() {
    progressiveSearchState = null;
    if (dom.rawSearchResultsMini) {
        dom.rawSearchResultsMini.style.display = 'flex';
        dom.rawSearchResultsMini.innerHTML = `
            <div style="padding:20px; opacity:0.6; text-align:center; width:100%;">
                <i class="codicon codicon-search-stop" style="font-size:24px; display:block; margin-bottom:8px; color:var(--vscode-charts-orange);"></i>
                <strong>No exact match found on disk</strong>
                <div style="font-size:10px; margin-top:4px;">Try selecting a smaller block and clicking <strong>Search Selection</strong>.</div>
            </div>
        `;
    }
}

export function handleProgressiveSearchResults(results: any[]) {
    if (!progressiveSearchState) return;

    const { lines, currentStartLineIdx, currentEndLineIdx, filePath, originalSearchBlock } = progressiveSearchState;
    const matchedCount = results.length;

    if (matchedCount === 1) {
        // Perfect match! Show result, highlight matched query portion, and terminate loop
        const result = results[0];
        const queryText = lines.slice(currentStartLineIdx, currentEndLineIdx + 1).join(' ').trim();
        progressiveSearchState = null; // Clear state machine

        if (dom.rawSearchResultsMini) {
            dom.rawSearchResultsMini.style.display = 'flex';
            dom.rawSearchResultsMini.innerHTML = `
                <div style="font-size: 10px; font-weight: bold; opacity: 0.8; padding: 8px; border-bottom: 1px solid var(--vscode-widget-border); margin-bottom: 5px; color: var(--vscode-charts-green); width:100%;">
                    <i class="codicon codicon-check"></i> EXACT MATCH LOCATED ON DISK
                </div>
                <div class="mini-search-item raw-stitch-result-item" 
                     style="flex-direction:column; align-items:flex-start; gap:4px; padding: 10px; border-bottom: 1px solid var(--vscode-widget-border); cursor:pointer; width:100%; box-sizing:border-box;" 
                     data-path="${result.path}" 
                     data-query="${queryText.replace(/"/g, '&quot;')}"
                     data-line="${result.line}">
                    <div style="display:flex; justify-content:space-between; width:100%; font-size: 11px;">
                        <span style="font-weight:bold; color: var(--vscode-textLink-foreground);">${result.path.split('/').pop()}</span>
                        <span style="opacity:0.6; font-size:10px; font-weight:bold;">Line ${result.line}</span>
                    </div>
                    <div style="font-size:10px; opacity:0.9; font-family:var(--vscode-editor-font-family); white-space:pre; overflow:hidden; text-overflow:ellipsis; width:100%; background:rgba(0,0,0,0.25); padding:4px 8px; border-radius:4px; border:1px solid rgba(255,255,255,0.05); margin-top:4px;">
                        ${sanitizer.sanitize(result.snippet).replace(new RegExp(`(${queryText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<mark class="search-highlight">$1</mark>')}
                    </div>
                    <div style="font-size:9px; opacity:0.5; margin-top:4px;">Click this result to open and automatically highlight in your editor. Then press Ctrl+V to paste the replacement.</div>
                </div>
            `;
        }
    } else if (matchedCount > 1) {
        // Multiple matches: Try adding more lines to increase uniqueness
        if (currentEndLineIdx + 1 < lines.length) {
            progressiveSearchState.currentEndLineIdx++;
            runProgressiveHunkSearch();
        } else {
            // Cannot expand further: Show multiple candidates so user can choose
            const queryText = lines.slice(currentStartLineIdx, currentEndLineIdx + 1).join(' ').trim();
            progressiveSearchState = null; // Clear state machine

            if (dom.rawSearchResultsMini) {
                dom.rawSearchResultsMini.style.display = 'flex';
                dom.rawSearchResultsMini.innerHTML = `
                    <div style="font-size: 10px; font-weight: bold; opacity: 0.8; padding: 8px; border-bottom: 1px solid var(--vscode-widget-border); margin-bottom: 5px; color: var(--vscode-charts-orange); width:100%;">
                        <i class="codicon codicon-warning"></i> MULTIPLE MATCHES DETECTED (${matchedCount})
                    </div>
                ` + results.map((res: any) => `
                    <div class="mini-search-item raw-stitch-result-item" 
                         style="flex-direction:column; align-items:flex-start; gap:4px; padding: 10px; border-bottom: 1px solid var(--vscode-widget-border); cursor:pointer; width:100%; box-sizing:border-box;" 
                         data-path="${res.path}" 
                         data-query="${queryText.replace(/"/g, '&quot;')}"
                         data-line="${res.line}">
                        <div style="display:flex; justify-content:space-between; width:100%; font-size: 11px;">
                            <span style="font-weight:bold; color: var(--vscode-textLink-foreground);">${res.path.split('/').pop()}</span>
                            <span style="opacity:0.6; font-size:10px;">Line ${res.line}</span>
                        </div>
                        <div style="font-size:10px; opacity:0.8; font-family:var(--vscode-editor-font-family); white-space:pre; overflow:hidden; text-overflow:ellipsis; width:100%; background:rgba(0,0,0,0.15); padding:4px; border-radius:4px;">${sanitizer.sanitize(res.snippet)}</div>
                    </div>
                `).join('');
            }
        }
    } else {
        // Zero matches: Match failed with this combination
        if (currentEndLineIdx > currentStartLineIdx) {
            // Sliding anchor: Increment start line index and reset end line to start searching next line individually
            progressiveSearchState.currentStartLineIdx++;
            progressiveSearchState.currentEndLineIdx = progressiveSearchState.currentStartLineIdx;
        } else {
            // Single line search failed: move to next line directly
            progressiveSearchState.currentStartLineIdx++;
            progressiveSearchState.currentEndLineIdx = progressiveSearchState.currentStartLineIdx;
        }
        runProgressiveHunkSearch();
    }
}

export function openRawCodeModal(messageId: string, blockIndex: number, filePath: string, rawCode: string, initialHunkIdx: number = 0) {
    // 🧹 CLEANUP GHOST ELEMENTS: Remove any orphaned action buttons from previous failed renders
    document.querySelectorAll('.modal-footer > button, .raw-block-actions').forEach(el => {
        if (!el.closest('#raw-code-modal')) el.remove();
    });

    const modal = dom.rawCodeModal;
    const tabBar = document.getElementById('modal-hunk-tabs');
    const display = dom.rawCodeDisplay;
    const filenameEl = dom.rawCodeFilename;

    if (!modal || !tabBar || !display) return;

    // Force visible state via class
    modal.classList.add('visible');

    filenameEl.textContent = filePath;
    display.dataset.messageId = messageId;
    display.dataset.blockIndex = String(blockIndex);

    // Extract all hunks
    const aiderRegex = /<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n=======(?:\r?\n(?!>>>>>>> REPLACE)([\s\S]*?))?\r?\n>>>>>>> REPLACE/g;
    const matches = [...rawCode.matchAll(aiderRegex)];

    tabBar.innerHTML = '';

    const switchHunk = (idx: number) => {
        const match = matches[idx];
        display.textContent = match[0];
        display.dataset.hunkIndex = String(idx);

        // Update active tab visual
        tabBar.querySelectorAll('.hunk-tab').forEach((t: any, i) => {
            t.classList.toggle('active', i === idx);
        });

        // Sync "Applied" state of the button inside modal
        const appliedHunks = state.appliedState?.[messageId]?.[blockIndex] || [];
        const isApplied = appliedHunks.includes(idx) || appliedHunks.includes(-1);
        dom.markAppliedBtn.classList.toggle('applied', isApplied);
        dom.markAppliedBtn.innerHTML = isApplied 
            ? '<span class="codicon codicon-check"></span> Applied Manually'
            : '<span class="codicon codicon-check"></span> Mark as Applied Manually';

        // --- AUTOMATED STITCH RESEARCH PROTOCOL ---
        // Automatically find the most plausible insertion site on disk using our progressive search algorithm
        const searchPart = match[1] || "";
        const cleanLines = searchPart.split('\n').map(l => l.trim()).filter(l => l.length > 0);

        if (cleanLines.length > 0) {
            progressiveSearchState = {
                lines: cleanLines,
                currentStartLineIdx: 0,
                currentEndLineIdx: 0,
                filePath: filePath,
                messageId: messageId,
                blockIndex: blockIndex,
                hunkIndex: idx,
                originalSearchBlock: searchPart
            };
            runProgressiveHunkSearch();
        } else {
            renderProgressiveSearchFailure();
        }
    };

    matches.forEach((_, i) => {
        const tab = document.createElement('div');
        tab.className = 'hunk-tab';
        // Add a dot if the hunk is already applied
        const appliedHunks = state.appliedState?.[messageId]?.[blockIndex] || [];
        const isApplied = appliedHunks.includes(i) || appliedHunks.includes(-1);

        tab.innerHTML = `<i class="codicon ${isApplied ? 'codicon-check' : 'codicon-primitive-dot'}"></i> HUNK ${i + 1}`;
        tab.onclick = () => switchHunk(i);
        tabBar.appendChild(tab);
    });

    switchHunk(initialHunkIdx);

    // Clear manual search box when opening
    if (dom.rawSearchInput) dom.rawSearchInput.value = '';

    // Explicitly force layout to absolute center
    modal.style.display = 'flex';
    modal.classList.add('visible');
}

export async function openStagingRevamp(messageId: string, changes: any[]) {
    currentStagingChanges = changes;
    (window as any).currentStagingChanges = changes;
    currentStagingIdx = 0;
    (window as any).currentStagingIdx = 0;

    const modal = document.getElementById('staging-revamp-modal');
    const closeBtn = document.getElementById('staging-revamp-close');
    const applyAllBtn = document.getElementById('staging-apply-all-btn') as HTMLButtonElement;
    const applyOneBtn = document.getElementById('staging-apply-current-btn') as HTMLButtonElement;

    if (!modal) return;

    modal.classList.add('visible');
    renderStagingList();
    loadStagingDiff(0);

    // Modal Close
    const close = () => {
        modal.classList.remove('visible');
        currentStagingChanges = [];
    };
    closeBtn!.onclick = close;

    // Apply CURRENT File Only
    applyOneBtn.onclick = () => {
        const change = currentStagingChanges[currentStagingIdx];
        if (change.isApplied) return;

        applyOneBtn.disabled = true;
        applyOneBtn.innerHTML = '<div class="spinner"></div> Applying...';

        vscode.postMessage({
            command: 'applyFileContent',
            filePath: change.path,
            content: change.content,
            messageId: messageId,
            blockIndex: change.blockIndex,
            hunkIndex: change.hunkIndex,
            options: { silent: true, autoSave: true }
        });
    };

    // Apply ALL VALID Files
    applyAllBtn.onclick = () => {
        const pending = currentStagingChanges.filter(c => !c.isApplied);
        if (pending.length === 0) return;

        applyAllBtn.disabled = true;
        applyAllBtn.innerHTML = '<div class="spinner"></div> Processing Batch...';

        vscode.postMessage({
            command: 'applyAllChanges',
            messageId: messageId,
            changes: pending
        });
    };
}

function renderStagingList() {
    const list = document.getElementById('staging-files-list');
    if (!list) return;

    list.innerHTML = currentStagingChanges.map((c, i) => `
        <div class="staging-file-item ${i === currentStagingIdx ? 'active' : ''} ${c.isApplied ? 'applied' : ''}" 
             data-index="${i}">
            <div style="display:flex; flex-direction:column; flex:1; min-width:0;">
                <div style="font-size:12px; font-weight:bold; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${c.path.split('/').pop()}</div>
                <div style="font-size:9px; opacity:0.6; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${c.path}</div>
            </div>
            <div class="item-status">
                ${c.isApplied 
                    ? '<i class="codicon codicon-check" style="color:var(--vscode-charts-green)"></i>' 
                    : (c.error ? '<i class="codicon codicon-error" style="color:var(--vscode-charts-red)"></i>' : '')}
            </div>
        </div>
    `).join('');

    // CSP-compliant event attachment (no inline onclick handlers)
    list.querySelectorAll('.staging-file-item').forEach((item) => {
        item.addEventListener('click', () => {
            const idx = parseInt((item as HTMLElement).dataset.index || '0', 10);
            loadStagingDiff(idx);
        });
    });

    const stats = document.getElementById('staging-stats');
    const applied = currentStagingChanges.filter(c => c.isApplied).length;
    if (stats) stats.textContent = `${applied} / ${currentStagingChanges.length} applied`;
}

async function loadStagingDiff(index: number) {
    currentStagingIdx = index;
    (window as any).currentStagingIdx = index;
    renderStagingList();

    const change = currentStagingChanges[index];
    const viewer = document.getElementById('staging-diff-content');
    if (!viewer) return;

    viewer.innerHTML = '<div style="padding:40px; text-align:center; opacity:0.5;"><div class="spinner"></div> Reading disk state...</div>';

    // Fetch original content from extension to perform real-time diff comparison
    vscode.postMessage({ 
        command: 'requestFileContentForDiff', 
        path: change.path,
        changeIndex: index 
    });
}

(window as any).loadStagingDiff = loadStagingDiff;

/**
 * Split-View Diff Renderer (Before vs After)
 */
function renderSplitDiff(oldText: string, patch: string) {
    const container = document.getElementById('staging-diff-content');
    if (!container) return;

    

    // 1. Calculate the final state as intended by the patch
    let newText = oldText;
    const aiderRegex = /<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n=======(?:\r?\n(?!>>>>>>> REPLACE)([\s\S]*?))?\r?\n>>>>>>> REPLACE/g;
    const matches = [...patch.matchAll(aiderRegex)];

    if (matches.length > 0) {
        for (const match of matches) {
            const res = applySearchReplace(newText, match[1] || "", match[2] || "");
            if (res.success) newText = res.result;
        }
    } else {
        newText = patch; // Full rewrite case
    }

    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');

    const leftPane = document.createElement('div');
    leftPane.className = 'diff-pane';
    leftPane.innerHTML = '<div class="diff-pane-header">BEFORE (DISK)</div><div class="diff-scroll-container" id="left-diff"></div>';

    const rightPane = document.createElement('div');
    rightPane.className = 'diff-pane';
    rightPane.innerHTML = '<div class="diff-pane-header">AFTER (PROPOSED)</div><div class="diff-scroll-container" id="right-diff"></div>';

    container.innerHTML = '';
    container.appendChild(leftPane);
    container.appendChild(rightPane);

    const leftScroll = leftPane.querySelector('#left-diff')!;
    const rightScroll = rightPane.querySelector('#right-diff')!;

    // Simple side-by-side reconstruction
    // We iterate through both and highlight the changes
    const max = Math.max(oldLines.length, newLines.length);
    let leftHtml = '', rightHtml = '';

    for (let i = 0; i < max; i++) {
        const o = oldLines[i];
        const n = newLines[i];

        if (o === n) {
            leftHtml += `<div class="diff-line"><span class="diff-line-num">${i+1}</span><span class="diff-line-content">${sanitizer.sanitize(o || '')}</span></div>`;
            rightHtml += `<div class="diff-line"><span class="diff-line-num">${i+1}</span><span class="diff-line-content">${sanitizer.sanitize(n || '')}</span></div>`;
        } else {
            // Find if this is a block replacement
            if (o !== undefined) leftHtml += `<div class="diff-line removed"><span class="diff-line-num">${i+1}</span><span class="diff-line-content">${sanitizer.sanitize(o)}</span></div>`;
            else leftHtml += `<div class="diff-line empty-placeholder"><span class="diff-line-num">&nbsp;</span></div>`;

            if (n !== undefined) rightHtml += `<div class="diff-line added"><span class="diff-line-num">${i+1}</span><span class="diff-line-content">${sanitizer.sanitize(n)}</span></div>`;
            else rightHtml += `<div class="diff-line empty-placeholder"><span class="diff-line-num">&nbsp;</span></div>`;
        }
    }

    leftScroll.innerHTML = leftHtml;
    rightScroll.innerHTML = rightHtml;

    // SYNC SCROLLING
    leftScroll.onscroll = () => rightScroll.scrollTop = leftScroll.scrollTop;
    rightScroll.onscroll = () => leftScroll.scrollTop = rightScroll.scrollTop;
}

// Global exposure for event handler
(window as any).renderSplitDiff = renderSplitDiff;

export function updateProgressBar(container: HTMLElement | null, current: number, total: number, segments?: any) {
    if (!container) return;

    if (segments && total > 0) {
        container.innerHTML = '';
        // Ordered array for visual consistency in the bar
        const types = ['system', 'briefing', 'tree', 'skills', 'memory', 'diagrams', 'files', 'history', 'images'];

        types.forEach(type => {
            const count = segments[type] || 0;
            if (count > 0) {
                const segDiv = document.createElement('div');
                segDiv.className = `token-bar-segment segment-${type}`;
                segDiv.dataset.type = type;

                // Calculate percentage based on the AUTHORITATIVE total
                // If sum of counts > total (due to race conditions), we cap at 100% 
                // to prevent the bar from breaking the UI layout.
                const pct = (count / total) * 100;
                segDiv.style.width = `${pct}%`;
                segDiv.title = `${type.toUpperCase()}: ${count.toLocaleString()} tokens (Click to view)`;

                // Segment click handler
                segDiv.onclick = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const contextViewType = type === 'history' ? 'chat' : type;
                    vscode.postMessage({
                        command: 'executeLollmsCommand', 
                        details: { command: 'lollms-vs-coder.viewFullContext', params: contextViewType }
                    });
                };
                container.appendChild(segDiv);
            }
        });

        // 🧬 RENDER CLICKABLE LEGEND
        let legendContainer = document.getElementById('token-bar-legend');
        if (!legendContainer) {
            legendContainer = document.createElement('div');
            legendContainer.id = 'token-bar-legend';
            legendContainer.className = 'token-legend';
            container.parentElement?.after(legendContainer);
        }

        // Force visibility
        legendContainer.style.display = 'flex';

        legendContainer.innerHTML = types.map(type => {
            const count = segments[type] || 0;
            if (count === 0) return '';

            // Clean up the label for the UI
            let label = type.charAt(0).toUpperCase() + type.slice(1);
            if (type === 'files') label = 'Code';
            if (type === 'history') label = 'History';

            // High-density numeric display
            const displayVal = count >= 1000 ? `${(count/1024).toFixed(1)}k` : count;

            return `
                <div class="legend-item" data-type="${type}" title="Analyze ${label} Segment">
                    <div class="legend-dot segment-${type}"></div>
                    <span class="legend-label">${label}</span>
                    <span style="opacity:0.5; margin-left:2px; font-weight:bold;">${displayVal}</span>
                </div>`;
        }).join('');

        // Attach listeners to legend items
        legendContainer.querySelectorAll('.legend-item').forEach(item => {
            (item as HTMLElement).onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                const type = (item as HTMLElement).dataset.type;
                const contextViewType = type === 'history' ? 'chat' : type;
                vscode.postMessage({
                    command: 'executeLollmsCommand',
                    details: { command: 'lollms-vs-coder.viewFullContext', params: contextViewType }
                });
            };
        });
    } else {
        container.innerHTML = `<div class="token-bar-segment segment-files" style="width: ${Math.min((current/total)*100, 100)}%"></div>`;
    }

    const ratio = current / total;
    container.style.borderColor = ratio > 1.0 ? 'var(--vscode-charts-red)' : '';
}
