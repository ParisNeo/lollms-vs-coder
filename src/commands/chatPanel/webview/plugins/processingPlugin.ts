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
        if (/<div\b[^>]*\bprocessing-body\b/i.test(block) && !/<\/div>\s*(?:<\/details>\s*)?$/i.test(block.trimEnd())) {
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
        } else if (trimmedBody && isPreformatted) {
            const sanitizedBody = sanitizer.sanitize(trimmedBody);
            block = block.substring(0, bodyMatch.index!) + `${divOpen}${sanitizedBody}${divClose}`;
        }
    }

    return block;
}

export function findBalancedProcessingBlockRanges(
    text: string,
    excludedRanges: { start: number; end: number }[] = []
): { start: number; end: number }[] {
    const ranges: { start: number; end: number }[] = [];
    if (!text || typeof text !== 'string') return ranges;

    const isExcluded = (offset: number) => excludedRanges.some(r => offset >= r.start && offset < r.end);
    const procOpenRegex = /^<details\b[^>]*\bclass=["'][^"']*\bprocessing-block\b[^"']*["'][^>]*>/i;
    const detailsOpenRegex = /^<details\b[^>]*>/i;
    const detailsCloseRegex = /^<\/details\s*>/i;

    let openFence: { char: string; len: number } | null = null;
    let activeBlock: { start: number; depth: number } | null = null;

    let lineStart = 0;
    const len = text.length;
    while (lineStart < len) {
        const nlIdx = text.indexOf('\n', lineStart);
        const nextLineStart = nlIdx === -1 ? len : nlIdx + 1;
        const lineEnd = (nlIdx === -1 ? len : nlIdx) - (nlIdx > lineStart && text[nlIdx - 1] === '\r' ? 1 : 0);
        const lineText = text.slice(lineStart, lineEnd);

        if (!activeBlock && isExcluded(lineStart)) {
            lineStart = nextLineStart;
            continue;
        }

        const fm = lineText.match(/^[ \t]*(`{3,}|~{3,})(.*)$/);
        if (openFence) {
            if (fm && fm[1][0] === openFence.char && fm[1].length >= openFence.len && (fm[2] || '').trim() === '') {
                openFence = null;
            }
            lineStart = nextLineStart;
            continue;
        }

        if (fm) {
            const marker = fm[1];
            const ch = marker[0];
            const trailing = (fm[2] || '').trim();
            const isInline = ch === '`' && trailing.includes(marker);
            if (!isInline) {
                openFence = { char: ch, len: marker.length };
                lineStart = nextLineStart;
                continue;
            }
        }

        let col = 0;
        while (col < lineText.length) {
            if (lineText[col] === '`') {
                let t = 0;
                while (col + t < lineText.length && lineText[col + t] === '`') t++;
                let i = col + t;
                let endCol = -1;
                while (i < lineText.length) {
                    if (lineText[i] === '`') {
                        let c = 0;
                        while (i + c < lineText.length && lineText[i + c] === '`') c++;
                        if (c === t) { endCol = i + c; break; }
                        i += c;
                    } else {
                        i++;
                    }
                }
                col = endCol !== -1 ? endCol : col + t;
                continue;
            }

            if (lineText[col] === '<') {
                const absOffset = lineStart + col;
                const slice = lineText.slice(col);

                if (!activeBlock) {
                    if (!isExcluded(absOffset)) {
                        const pm = slice.match(procOpenRegex);
                        if (pm) {
                            activeBlock = { start: absOffset, depth: 1 };
                            col += pm[0].length;
                            continue;
                        }
                    }
                } else {
                    const cm = slice.match(detailsCloseRegex);
                    if (cm) {
                        activeBlock.depth--;
                        col += cm[0].length;
                        if (activeBlock.depth === 0) {
                            ranges.push({ start: activeBlock.start, end: lineStart + col });
                            activeBlock = null;
                        }
                        continue;
                    }
                    const om = slice.match(detailsOpenRegex);
                    if (om) {
                        activeBlock.depth++;
                        col += om[0].length;
                        continue;
                    }
                }
            }
            col++;
        }

        lineStart = nextLineStart;
    }

    if (activeBlock) {
        ranges.push({ start: activeBlock.start, end: len });
    }

    return ranges;
}

export const processingPlugin: TagPlugin = {
    id: 'processing_blocks',
    extractBlocks: (text: string, _context: PluginContext) => {
        const blocks: { html: string; start: number; end: number }[] = [];
        if (!text || typeof text !== 'string') return blocks;

        const ranges = findBalancedProcessingBlockRanges(text);
        for (const r of ranges) {
            const rawBlock = text.substring(r.start, r.end);
            const html = renderProcessingBlock(rawBlock);
            if (html) {
                blocks.push({ html, start: r.start, end: r.end });
            }
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