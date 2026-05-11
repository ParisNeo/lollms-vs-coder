import { TagPlugin } from '../pluginSystem';

export const imageGenPlugin: TagPlugin = {
    id: 'generate_image',
    tagPattern: /<generate_image\s+([^>]*?)>([\s\S]*?)<\/generate_image>/gi,
    render: (match, context) => {
        const attrStr = match[1];
        const prompt = match[2].trim();
        const attrs: any = {};
        attrStr.replace(/(\w+)=["']([^"']*)["']/g, (_: any, k: string, v: string) => (attrs[k] = v, ''));

        const path = attrs.path || "generated_asset.png";
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
            <div style="display:flex; gap:10px; padding: 8px 12px; background: var(--vscode-editor-inactiveSelectionBackground); border-bottom: 1px solid var(--vscode-widget-border);">
                <div style="flex:1;">
                    <label style="font-size:9px; font-weight:bold; opacity:0.7; display:block;">FOLDER</label>
                    <input type="text" class="asset-folder-input" value="${folder}" style="width:100%; background:transparent; border:none; color:var(--vscode-foreground); font-size:11px;">
                </div>
                <div style="flex:2;">
                    <label style="font-size:9px; font-weight:bold; opacity:0.7; display:block;">FILENAME</label>
                    <input type="text" class="asset-name-input" value="${filename}" style="width:100%; background:transparent; border:none; color:var(--vscode-foreground); font-size:11px; font-weight:bold;">
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
                const finalPath = (folder === '.' || !folder) ? name : `${folder}/${name}`;

                btn.innerHTML = '<div class="spinner"></div> Generating...';
                btn.disabled = true;

                context.vscode.postMessage({
                    command: 'generateImage',
                    prompt: decodeURIComponent((btn as HTMLElement).dataset.prompt || ''),
                    filePath: finalPath,
                    buttonId: btn.id
                });
            };
        });
    }
};