import { TagPlugin } from '../pluginSystem';

export const assetBundlePlugin: TagPlugin = {
    id: 'asset_bundle',
    tagPattern: /<asset_bundle>([\s\S]*?)<\/asset_bundle>/gi,
    render: (match, context) => {
        const inner = match[1];
        const extract = (tag: string) => {
            const m = inner.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'));
            return m ? m[1].trim() : "";
        };

        const prompt = extract('prompt');
        const rows = extract('rows') || "1";
        const cols = extract('cols') || "1";
        const path = extract('path') || "assets/bundle.png";

        return `
        <div class="generation-block" style="border: 2px solid var(--vscode-charts-purple);">
            <div class="generation-header" style="background: var(--vscode-charts-purple); color: white;">
                <span><i class="codicon codicon-package"></i> PROPOSE ASSET BUNDLE</span>
            </div>
            <div class="generation-body" style="padding: 15px;">
                <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px; margin-bottom:10px;">
                    <div><label>ROWS (MOTIONS)</label><input type="number" class="bundle-rows" value="${rows}"></div>
                    <div><label>COLS (FRAMES)</label><input type="number" class="bundle-cols" value="${cols}"></div>
                </div>
                <p><strong>Prompt:</strong> ${prompt}</p>
                <button class="apply-all-btn trigger-bundle-btn" 
                        data-prompt="${encodeURIComponent(prompt)}"
                        data-path="${path}">
                    ✨ Generate & Symmetrize Bundle
                </button>
            </div>
        </div>`;
    },
    initialize: (container, context) => {
        container.querySelectorAll('.trigger-bundle-btn').forEach(btn => {
            (btn as HTMLElement).onclick = () => {
                const d = (btn as HTMLElement).dataset;
                const rows = (btn.closest('.generation-block')!.querySelector('.bundle-rows') as HTMLInputElement).value;
                const cols = (btn.closest('.generation-block')!.querySelector('.bundle-cols') as HTMLInputElement).value;
                
                context.vscode.postMessage({
                    command: 'runTool',
                    tool: 'build_asset_bundle',
                    params: { 
                        prompt: decodeURIComponent(d.prompt!), 
                        target_path: d.path,
                        rows: parseInt(rows),
                        cols: parseInt(cols)
                    }
                });
            };
        });
    }
};