import { TagPlugin, PluginContext } from '../pluginSystem';
import DOMPurify from 'dompurify';
import { marked } from 'marked';

const sanitizer = typeof DOMPurify === 'function' ? (DOMPurify as any)(window) : DOMPurify;

function renderProcessingBlock(rawBlock: string): string {
    let block = rawBlock;

    if (!block.trimEnd().endsWith('</details>')) {
        if (block.includes('<pre') && !block.includes('</pre>')) {
            block += '</pre>';
        }
        if (block.includes('<div class="processing-body"') && !block.includes('</div>')) {
            block += '</div>';
        }
        block += '</details>';
    }

    if (!block.includes('copy-processing-btn')) {
        block = block.replace(
            /<\/summary>/i,
            ` <button class="code-action-btn secondary-btn copy-processing-btn" title="Copy output to clipboard" style="margin-left: auto; height: 20px; font-size: 10px; padding: 0 6px; display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0;"><i class="codicon codicon-copy"></i> Copy Output</button></summary>`
        );
    }

    block = block.replace(
        /<summary([^>]*)>/i,
        (full, attrs) => {
            if (/style=/i.test(attrs)) {
                return `<summary${attrs.replace(/style=["']([^"']*)["']/i, (_m: string, s: string) => `style="${s}; display: flex; align-items: center; gap: 6px;"`)}>`;
            }
            return `<summary${attrs} style="display: flex; align-items: center; gap: 6px;">`;
        }
    );

    const bodyMatch = block.match(/(<div\b[^>]*class=["'][^"']*\bprocessing-body\b[^"']*["'][^>]*>)([\s\S]*?)(<\/div>\s*<\/details>\s*$)/i);
    if (bodyMatch) {
        const divOpen = bodyMatch[1];
        const bodyInner = bodyMatch[2];
        const divClose = bodyMatch[3];
        const trimmedBody = bodyInner.trim();

        const isPreformatted =
            trimmedBody.startsWith('<pre') ||
            divOpen.includes('pre-wrap') ||
            trimmedBody.startsWith('<div');

        if (trimmedBody && !isPreformatted) {
            try {
                const parsedHtml = sanitizer.sanitize(marked.parse(trimmedBody) as string);
                block = block.substring(0, bodyMatch.index!) + `${divOpen}${parsedHtml}${divClose}`;
            } catch {
                // Keep original content if markdown parsing fails
            }
        }
    }

    return block;
}

export const processingPlugin: TagPlugin = {
    id: 'processing_blocks',
    extractBlocks: (text: string, _context: PluginContext) => {
        const blocks: { html: string; start: number; end: number }[] = [];
        if (!text || typeof text !== 'string') return blocks;

        const openRegex = /<details\b[^>]*\bclass=["'][^"']*\bprocessing-block\b[^"']*["'][^>]*>/gi;
        let match: RegExpExecArray | null;

        while ((match = openRegex.exec(text)) !== null) {
            const start = match.index;
            const cursor = start + match[0].length;
            let depth = 1;

            const tagFinder = /<\/?details\b[^>]*>/gi;
            tagFinder.lastIndex = cursor;
            let tMatch: RegExpExecArray | null;
            let end = -1;

            while ((tMatch = tagFinder.exec(text)) !== null) {
                if (tMatch[0].toLowerCase().startsWith('</')) {
                    depth--;
                    if (depth === 0) {
                        end = tMatch.index + tMatch[0].length;
                        break;
                    }
                } else {
                    depth++;
                }
            }

            if (end === -1) {
                end = text.length;
            }

            const rawBlock = text.substring(start, end);
            const html = renderProcessingBlock(rawBlock);
            if (html) {
                blocks.push({ html, start, end });
            }
            openRegex.lastIndex = end;
        }

        return blocks;
    },
    render: (match) => {
        return renderProcessingBlock(match[0]);
    },
    initialize: (container, context) => {
        container.querySelectorAll('.processing-block').forEach((block: any) => {
            const summary = block.querySelector(':scope > summary');
            if (summary && !summary.hasAttribute('data-bound')) {
                summary.setAttribute('data-bound', 'true');
                summary.addEventListener('click', (e: MouseEvent) => {
                    if ((e.target as HTMLElement).closest('.copy-processing-btn')) return;
                    e.preventDefault();
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