import { TagPlugin } from '../pluginSystem';

export const imageGenPlugin: TagPlugin = {
    id: 'generate_image',
    toolName: 'generate_image',
    tagPattern: /<generate_image\s+([^>]*?)>([\s\S]*?)<\/generate_image>/gi,
    render: (input, context) => {
        let prompt = "";
        let path = "generated_asset.png";
        let width = 1024;
        let height = 1024;
        let chroma_key = "pure green #00FF00";

        if (Array.isArray(input)) {
            // XML Mode (Discussion)
            const attrStr = input[1];
            prompt = input[2].trim();
            const attrs: any = {};
            attrStr.replace(/(\w+)=["']([^"']*)["']/g, (_: any, k: string, v: string) => (attrs[k] = v, ''));
            path = attrs.path || path;
            width = parseInt(attrs.width) || 1024;
            height = parseInt(attrs.height) || 1024;
            chroma_key = attrs.chroma_key || chroma_key;
        } else {
            // JSON Mode (Agent)
            const params = input.params || {};
            prompt = params.prompt || "";
            path = params.file_path || path;
            width = params.width || 1024;
            height = params.height || 1024;
            chroma_key = params.chroma_key || chroma_key;
        }

        const blockId = `img-gen-${context.messageId}-${Math.random().toString(36).substring(7)}`;
        const lastSlash = path.lastIndexOf('/');
        const folder = lastSlash !== -1 ? path.substring(0, lastSlash) : '.';
        const filename = lastSlash !== -1 ? path.substring(lastSlash + 1) : path;

        return `
        <div class="generation-block asset-gen-block" id="${blockId}" data-block-id="${blockId}">
            <div class="generation-header">
                <span class="summary-lang-label"><span class="codicon codicon-device-camera"></span> Propose New Image</span>
                <div class="code-actions">
                    <button class="code-action-btn apply-btn generate-btn" 
                        id="btn-${blockId}"
                        data-prompt="${encodeURIComponent(prompt)}" 
                        data-block-id="${blockId}">
                        <span class="codicon codicon-sparkle"></span> Generate
                    </button>
                </div>
            </div>
            <div style="display:grid; grid-template-columns: 1fr 1fr 60px 60px; gap:8px; padding: 8px 12px; background: var(--vscode-editor-inactiveSelectionBackground); border-bottom: 1px solid var(--vscode-widget-border);">
                <div>
                    <label style="font-size:9px; font-weight:bold; opacity:0.7; display:block;">FOLDER</label>
                    <input type="text" class="asset-folder-input" value="${folder}" style="width:100%; background:transparent; border:none; color:var(--vscode-foreground); font-size:11px;">
                </div>
                <div>
                    <label style="font-size:9px; font-weight:bold; opacity:0.7; display:block;">FILENAME</label>
                    <input type="text" class="asset-name-input" value="${filename}" style="width:100%; background:transparent; border:none; color:var(--vscode-foreground); font-size:11px; font-weight:bold;">
                </div>
                <div>
                    <label style="font-size:9px; font-weight:bold; opacity:0.7; display:block;">WIDTH</label>
                    <input type="number" class="asset-width-input" value="${width}" style="width:100%; background:transparent; border:none; color:var(--vscode-foreground); font-size:11px;">
                </div>
                <div>
                    <label style="font-size:9px; font-weight:bold; opacity:0.7; display:block;">HEIGHT</label>
                    <input type="number" class="asset-height-input" value="${height}" style="width:100%; background:transparent; border:none; color:var(--vscode-foreground); font-size:11px;">
                </div>
                <div style="grid-column: span 2;">
                    <label style="font-size:9px; font-weight:bold; opacity:0.7; display:block;">CHROMA KEY</label>
                    <input type="text" class="asset-key-input" value="${chroma_key}" style="width:100%; background:transparent; border:none; color:var(--vscode-charts-green); font-size:11px; font-weight:bold;">
                </div>
                </div>
            <div class="generation-body" style="padding: 12px;">
                <p style="font-size:11px; opacity:0.8;"><strong>Prompt:</strong> ${prompt}</p>
                <div id="gallery-${blockId}" class="image-results-gallery" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; margin-top: 10px;"></div>
            </div>
        </div>`;
    },
    initialize: (container, context) => {
        container.querySelectorAll('.generate-btn').forEach(btn => {
            (btn as HTMLButtonElement).onclick = () => {
                const block = btn.closest('.asset-gen-block') as HTMLElement;
                const folder = (block.querySelector('.asset-folder-input') as HTMLInputElement).value;
                const name = (block.querySelector('.asset-name-input') as HTMLInputElement).value;
                const width = (block.querySelector('.asset-width-input') as HTMLInputElement).value;
                const height = (block.querySelector('.asset-height-input') as HTMLInputElement).value;

                const finalPath = (folder === '.' || !folder) ? name : `${folder}/${name}`;

                btn.innerHTML = '<div class="spinner"></div> Generating...';
                btn.disabled = true;

                const chromaKey = (block.querySelector('.asset-key-input') as HTMLInputElement).value;

                context.vscode.postMessage({
                    command: 'generateImage',
                    prompt: decodeURIComponent((btn as HTMLElement).dataset.prompt || ''),
                    filePath: finalPath,
                    width: width,
                    height: height,
                    chroma_key: chromaKey,
                    buttonId: btn.id
                });
            };
        });
    }
};