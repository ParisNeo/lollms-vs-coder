import { TagPlugin, PluginContext } from '../pluginSystem';

export const imageAssetPlugin: TagPlugin = {
    id: 'edit_image_asset',
    tagPattern: /<edit_image_asset>([\s\S]*?)<\/edit_image_asset>/gi,

    render: (match, context) => {
        console.log(`[Plugin:Image] Match found in message ${context.messageId}`);
        const inner = match[1];
        
        // Helper to extract nested XML content
        const extract = (tag: string) => {
            const regex = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i');
            const m = inner.match(regex);
            return m ? m[1].trim() : "";
        };

        // Handle multiple input files (blending support)
        const inputFiles: string[] = [];
        const inputFileRegex = /<input_file>([\s\S]*?)<\/input_file>/gi;
        let fileMatch;
        while ((fileMatch = inputFileRegex.exec(inner)) !== null) {
            inputFiles.push(fileMatch[1].trim());
        }

        const prompt = extract('prompt');
        const inputFilesFound = inputFiles.length > 0;

        // If the AI just typed <edit_image_asset> without any internal tags,
        // treat it as a mention (plain text) and return null to the orchestrator.
        if (!inputFilesFound || !prompt) {
            return null; 
        }

        const outputFile = extract('output_file') || "edited_asset.png";
        const lastSlash = outputFile.lastIndexOf('/');
        const folder = lastSlash !== -1 ? outputFile.substring(0, lastSlash) : '.';
        const filename = lastSlash !== -1 ? outputFile.substring(lastSlash + 1) : outputFile;
        
        // --- DYNAMIC DIMENSIONS ---
        // Look for <width> and <height> tags if provided by the AI
        const targetWidth = extract('width') || "1024";
        const targetHeight = extract('height') || "1024";

        // Use a predictable ID based on message and a hash of the prompt to avoid collisions
        const blockId = `img-edit-${context.messageId}`;

        // 1. ASSET RESOLUTION: Trigger background loading for source thumbnails
        inputFiles.forEach((path, idx) => {
            const thumbId = `src-thumb-${context.messageId}-${idx}`;
            setTimeout(() => {
                context.vscode.postMessage({ command: 'resolveImageUri', path, targetId: thumbId });
            }, 50 * idx);
        });

        const sourcesHtml = inputFiles.map((p, idx) => `
            <div class="staged-image-card" id="src-thumb-${context.messageId}-${idx}" 
                 style="width: 60px; height: 60px; flex-shrink: 0; ${idx === 0 ? 'border: 2px solid var(--vscode-charts-blue);' : ''}" 
                 title="${idx === 0 ? 'PRIMARY SUBJECT' : 'STYLE REFERENCE'}: ${p}">
                ${idx === 0 ? '<div style="position:absolute; top:-5px; left:-5px; background:var(--vscode-charts-blue); color:white; font-size:8px; padding:1px 4px; border-radius:4px; z-index:10;">SUBJECT</div>' : ''}
                <div class="spinner"></div>
            </div>`).join('');

        return `
        <div class="generation-block asset-editor-block" id="${blockId}" data-block-id="${blockId}">
            <div class="generation-header">
                <span class="summary-lang-label"><span class="codicon codicon-wand"></span> Propose Image Edit</span>
                <div class="code-actions">
                    <button class="code-action-btn apply-btn generate-btn" 
                        id="btn-${blockId}"
                        data-prompt="${encodeURIComponent(prompt)}" 
                        data-output-path="${outputFile}" 
                        data-input-paths='${JSON.stringify(inputFiles)}'
                        title="Execute AI Image Modification">
                        <span class="codicon codicon-sparkle"></span> Generate Version
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
                    <input type="number" class="asset-width-input" value="${targetWidth}" style="width:100%; background:transparent; border:none; color:var(--vscode-foreground); font-size:11px;">
                </div>
                <div>
                    <label style="font-size:9px; font-weight:bold; opacity:0.7; display:block;">HEIGHT</label>
                    <input type="number" class="asset-height-input" value="${targetHeight}" style="width:100%; background:transparent; border:none; color:var(--vscode-foreground); font-size:11px;">
                </div>
            </div>
            <div class="generation-body" style="padding: 12px;">
                <div style="flex:1;">
                    <label style="font-size:9px; font-weight:bold; opacity:0.7; display:block;">TARGET FOLDER</label>
                    <input type="text" class="asset-folder-input" value="${folder}" style="width:100%; background:transparent; border:none; color:var(--vscode-foreground); font-size:11px;">
                </div>
                <div style="flex:2;">
                    <label style="font-size:9px; font-weight:bold; opacity:0.7; display:block;">FILENAME</label>
                    <input type="text" class="asset-name-input" value="${filename}" style="width:100%; background:transparent; border:none; color:var(--vscode-foreground); font-size:11px; font-weight:bold;">
                </div>
            </div>
            <div class="generation-body" style="padding: 12px;">
                <div style="display: flex; gap: 8px; overflow-x: auto; margin-bottom: 12px; padding-bottom: 4px;">
                    ${sourcesHtml}
                </div>

                <p style="font-size:11px; opacity:0.8; margin-bottom:8px; line-height: 1.4;">
                    <i class="codicon codicon-info" style="font-size: 10px;"></i> 
                    <strong>Instruction:</strong> ${prompt}
                </p>

                <div class="image-results-gallery" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; margin-top: 15px; border-top: 1px solid var(--vscode-widget-border); padding-top: 15px;">
                    <!-- New versions appear here -->
                </div>
            </div>
        </div>`;
    },

    initialize: (container, context) => {
        container.querySelectorAll('.generate-btn').forEach(btn => {
            (btn as HTMLButtonElement).onclick = () => {
                const d = (btn as HTMLElement).dataset;
                const block = btn.closest('.asset-editor-block') as HTMLElement;

                const folder = (block.querySelector('.asset-folder-input') as HTMLInputElement).value;
                const name = (block.querySelector('.asset-name-input') as HTMLInputElement).value;
                const width = (block.querySelector('.asset-width-input') as HTMLInputElement).value;
                const height = (block.querySelector('.asset-height-input') as HTMLInputElement).value;

                const finalOutputPath = (folder === '.' || !folder) ? name : `${folder}/${name}`;

                btn.innerHTML = '<div class="spinner"></div> Processing...';
                btn.disabled = true;

                context.vscode.postMessage({
                    command: 'runTool',
                    tool: 'edit_image_asset',
                    buttonId: btn.id,
                    params: {
                        paths: JSON.parse(d.inputPaths || '[]'),
                        prompt: decodeURIComponent(d.prompt || ''),
                        output_path: finalOutputPath,
                        output_size: `${width}x${height}`
                    }
                });
            };
        });
    }
};