import { TagPlugin, PluginContext } from '../pluginSystem';

export const imageAssetPlugin: TagPlugin = {
    id: 'edit_image_asset',
    toolName: 'edit_image_asset',
    tagPattern: /<edit_image_asset\s*([^>]*?)>([\s\S]*?)<\/edit_image_asset>/gi,

    render: (input, context) => {
        let prompt = "";
        let inputFiles: string[] = [];
        let outputFile = "edited_asset.png";
        let width = 1024;
        let height = 1024;
        let chroma_key = "pure green #00FF00";

        if (Array.isArray(input)) {
            // XML Mode (Discussion)
            const attrPart = input[1] || "";
            const inner = input[2] || "";

            const attrs: Record<string, string> = {};
            const attrMatches = attrPart.matchAll(/(\w+)=["']([^"']*)["']/g);
            for (const m of attrMatches) attrs[m[1].toLowerCase()] = m[2];

            const extract = (tag: string) => {
                const m = inner.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'));
                return m ? m[1].trim() : "";
            };

            const inputFileRegex = /<input_file>([\s\S]*?)<\/input_file>/gi;
            let fileMatch;
            while ((fileMatch = inputFileRegex.exec(inner)) !== null) inputFiles.push(fileMatch[1].trim());

            prompt = extract('prompt');
            outputFile = extract('output_file') || outputFile;
            width = parseInt(attrs.width) || 1024;
            height = parseInt(attrs.height) || 1024;
            chroma_key = attrs.chroma_key || chroma_key;
        } else {
            // JSON Mode (Agent)
            const params = input.params || {};
            prompt = params.prompt || "";
            inputFiles = params.paths || [];
            outputFile = params.output_path || outputFile;
            width = params.width || 1024;
            height = params.height || 1024;
            chroma_key = params.chroma_key || chroma_key;
        }

        if (inputFiles.length === 0 || !prompt) return null; 

        const lastSlash = outputFile.lastIndexOf('/');
        const folder = lastSlash !== -1 ? outputFile.substring(0, lastSlash) : '.';
        const filename = lastSlash !== -1 ? outputFile.substring(lastSlash + 1) : outputFile;
        const blockId = `img-edit-${context.messageId}`;

        // Asset Resolution logic...
        inputFiles.forEach((path, idx) => {
            const thumbId = `src-thumb-${context.messageId}-${idx}`;
            setTimeout(() => {
                context.vscode.postMessage({ command: 'resolveImageUri', path, targetId: thumbId });
            }, 50 * idx);
        });

        const sourcesHtml = inputFiles.map((p, idx) => `
            <div class="staged-image-card" id="src-thumb-${context.messageId}-${idx}" 
                 style="width: 60px; height: 60px; flex-shrink: 0; ${idx === 0 ? 'border: 2px solid var(--vscode-charts-blue);' : ''}">
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
                        data-inputs='${JSON.stringify(inputFiles)}'
                        title="Execute AI Image Modification">
                        <span class="codicon codicon-sparkle"></span> Edit
                    </button>
                </div>
            </div>
            <div style="display:grid; grid-template-columns: 1fr 1fr 80px 80px; gap:8px; padding: 8px 12px; background: var(--vscode-editor-inactiveSelectionBackground); border-bottom: 1px solid var(--vscode-widget-border);">
                <div>
                    <label style="font-size:9px; font-weight:bold; opacity:0.7; display:block;">FOLDER</label>
                    <input type="text" class="asset-folder-input" value="${folder}" style="width:100%; background:transparent; border:none; color:var(--vscode-foreground); font-size:11px;">
                </div>
                <div>
                    <label style="font-size:9px; font-weight:bold; opacity:0.7; display:block;">FILENAME</label>
                    <input type="text" class="asset-name-input" value="${filename}" style="width:100%; background:transparent; border:none; color:var(--vscode-foreground); font-size:11px; font-weight:bold;">
                </div>
                <div>
                    <label style="font-size:9px; font-weight:bold; opacity:0.7; display:block;">TARGET WIDTH</label>
                    <input type="number" class="asset-width-input" value="${width}" style="width:100%; background:rgba(0,0,0,0.2); border:1px solid var(--vscode-widget-border); color:var(--vscode-charts-blue); font-size:11px; font-weight:bold; outline:none; border-radius:4px; padding:2px 4px;">
                </div>
                <div>
                    <label style="font-size:9px; font-weight:bold; opacity:0.7; display:block;">TARGET HEIGHT</label>
                    <input type="number" class="asset-height-input" value="${height}" style="width:100%; background:rgba(0,0,0,0.2); border:1px solid var(--vscode-widget-border); color:var(--vscode-charts-blue); font-size:11px; font-weight:bold; outline:none; border-radius:4px; padding:2px 4px;">
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
                <div class="image-results-gallery" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; margin-top: 15px; border-top: 1px solid var(--vscode-widget-border); padding-top: 15px;"></div>
            </div>
        </div>`;
    },

    initialize: (container, context) => {
        container.querySelectorAll('.generate-btn').forEach(btn => {
            const button = btn as HTMLButtonElement;
            button.onclick = (e) => {
                e.stopPropagation();
                
                const block = button.closest('.asset-editor-block') as HTMLElement;
                if (!block) return;

                // 1. Get live values from inputs
                const folder = (block.querySelector('.asset-folder-input') as HTMLInputElement).value.trim();
                const name = (block.querySelector('.asset-name-input') as HTMLInputElement).value.trim();
                const widthInput = (block.querySelector('.asset-width-input') as HTMLInputElement).value;
                const heightInput = (block.querySelector('.asset-height-input') as HTMLInputElement).value;

                // 2. Parse numbers
                const w = parseInt(widthInput, 10) || 1024;
                const h = parseInt(heightInput, 10) || 1024;

                // 3. Retrieve static data from data-attributes
                const prompt = decodeURIComponent(button.getAttribute('data-prompt') || '');
                const inputs = JSON.parse(button.getAttribute('data-inputs') || '[]');

                const finalOutputPath = (folder === '.' || !folder) ? name : `${folder}/${name}`;

                button.innerHTML = '<div class="spinner"></div> Processing...';
                button.disabled = true;

                context.vscode.postMessage({
                    command: 'runTool',
                    tool: 'edit_image_asset',
                    buttonId: button.id,
                    params: {
                        paths: inputs,
                        prompt: prompt,
                        output_path: finalOutputPath,
                        width: w,
                        height: h,
                        verify: true
                    }
                });
            };
        });
    }
};
