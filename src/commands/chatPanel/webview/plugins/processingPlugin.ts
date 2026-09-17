import { TagPlugin } from '../pluginSystem';

export const processingPlugin: TagPlugin = {
    id: 'processing_blocks',
    tagPattern: /<details class="processing-block">([\s\S]*?)<\/details>/gi,
    render: (match) => {
        const fullBlock = match[0];
        // Inject a copy button into the summary header if not already present
        if (!fullBlock.includes('copy-processing-btn')) {
            return fullBlock.replace(
                /<\/summary>/i,
                ` <button class="code-action-btn secondary-btn copy-processing-btn" title="Copy output to clipboard" style="margin-left: auto; height: 20px; font-size: 10px; padding: 0 6px; display: inline-flex; align-items: center; gap: 4px;"><i class="codicon codicon-copy"></i> Copy Output</button></summary>`
            );
        }
        return fullBlock;
    },
    initialize: (container, context) => {
        container.querySelectorAll('.processing-block').forEach((block: any) => {
            const summary = block.querySelector('summary');
            if (summary && !summary.hasAttribute('data-bound')) {
                summary.setAttribute('data-bound', 'true');
                summary.addEventListener('click', (e: MouseEvent) => {
                    if ((e.target as HTMLElement).closest('.copy-processing-btn')) return;
                    const isOpen = block.hasAttribute('open');
                    if (isOpen) {
                        block.removeAttribute('open');
                    } else {
                        block.setAttribute('open', '');
                    }
                });
            }

            const copyBtn = block.querySelector('.copy-processing-btn');
            if (copyBtn && !copyBtn.hasAttribute('data-bound')) {
                copyBtn.setAttribute('data-bound', 'true');
                copyBtn.addEventListener('click', (e: MouseEvent) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const body = block.querySelector('.processing-body');
                    const text = body ? (body.textContent || body.innerText || '').trim() : '';

                    if (text) {
                        context.vscode.postMessage({ command: 'copyToClipboard', text });
                        const btnEl = copyBtn as HTMLElement;
                        const origHtml = btnEl.innerHTML;
                        btnEl.innerHTML = '<i class="codicon codicon-check"></i> Copied!';
                        setTimeout(() => { btnEl.innerHTML = origHtml; }, 2000);
                    }
                });
            }
        });
    }
};