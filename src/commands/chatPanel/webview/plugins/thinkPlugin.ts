import { TagPlugin, PluginContext } from '../pluginSystem.js';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

const sanitizer = typeof DOMPurify === 'function' ? (DOMPurify as any)(window) : DOMPurify;

export const thinkPlugin: TagPlugin = {
    id: 'think_tag',
    tagPattern: /<think>/i,
    extractBlocks: (text: string, context: PluginContext) => {
        const blocks: { html: string; start: number; end: number }[] = [];
        if (!text || typeof text !== 'string') return blocks;

        const openTags = ['<think>', '<thinking>', '<thought>', '<analysis>', '<reasoning>'];
        const closeTags = ['</think>', '</thinking>', '</thought>', '</analysis>', '</reasoning>'];

        let searchPos = 0;
        let thinkIndex = 0;

        while (searchPos < text.length) {
            let earliestOpenIdx = -1;
            let matchedOpenTag = '';

            for (const ot of openTags) {
                const idx = text.toLowerCase().indexOf(ot, searchPos);
                if (idx !== -1 && (earliestOpenIdx === -1 || idx < earliestOpenIdx)) {
                    earliestOpenIdx = idx;
                    matchedOpenTag = ot;
                }
            }

            if (earliestOpenIdx === -1) break;

            const contentStart = earliestOpenIdx + matchedOpenTag.length;
            const matchingCloseTag = matchedOpenTag.replace('<', '</');

            let closeIdx = text.toLowerCase().indexOf(matchingCloseTag, contentStart);
            let isClosed = true;
            let blockEnd = -1;

            if (closeIdx !== -1) {
                blockEnd = closeIdx + matchingCloseTag.length;
            } else {
                for (const ct of closeTags) {
                    const cIdx = text.toLowerCase().indexOf(ct, contentStart);
                    if (cIdx !== -1 && (closeIdx === -1 || cIdx < closeIdx)) {
                        closeIdx = cIdx;
                        blockEnd = cIdx + ct.length;
                    }
                }
            }

            if (closeIdx === -1) {
                isClosed = context.isFinal;
                blockEnd = text.length;
            }

            const rawThought = (closeIdx !== -1 ? text.substring(contentStart, closeIdx) : text.substring(contentStart)).trim();
            const parsedMarkdown = sanitizer.sanitize(marked.parse(rawThought || "*Thinking...*"));

            const iconHtml = isClosed 
                ? '<span class="codicon codicon-circuit-board thought-status-icon"></span>' 
                : '<span class="spinner thought-status-icon" style="width:10px; height:10px; border-width:2px; margin-right:6px; color: var(--thinking-color, #9b59b6); display: inline-block;"></span>';

            const cardId = `think-block-${context.messageId}-${thinkIndex++}`;

            const html = `
<div class="plan-scratchpad" id="${cardId}" data-closed="${isClosed ? 'true' : 'false'}" style="margin: 8px 0 12px 0; border-left: 3px solid var(--thinking-color, #9b59b6); box-sizing: border-box;">
    <details style="border: none; background: transparent; margin: 0; box-shadow: none;">
        <summary class="scratchpad-header" style="color: var(--thinking-color, #9b59b6); display: flex; align-items: center; justify-content: space-between; width: 100%; box-sizing: border-box; padding: 6px 12px; list-style: none; cursor: pointer;">
            <div style="display: flex; align-items: center; gap: 6px;">
                ${iconHtml}
                <span style="font-weight: bold;" class="thought-title-label">🧠 Thought &amp; Reasoning${!isClosed ? ' (Live)...' : ''}</span>
            </div>
            <span class="think-duration" style="font-size: 10px; opacity: 0.6; margin-left: auto; padding-right: 12px;">${isClosed ? '' : 'thinking...'}</span>
        </summary>
        <div class="scratchpad-content markdown-body" style="padding: 10px 15px; font-size:11.5px; opacity:0.95; line-height: 1.5; background:rgba(0,0,0,0.08); border-radius:0 0 6px 6px;">
            ${parsedMarkdown}
        </div>
    </details>
</div>`;

            blocks.push({
                html,
                start: earliestOpenIdx,
                end: blockEnd
            });

            searchPos = blockEnd;
        }

        return blocks;
    },
    render: () => ''
};

export default thinkPlugin;