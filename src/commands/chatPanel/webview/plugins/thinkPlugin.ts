import { TagPlugin, PluginContext } from '../pluginSystem.js';
import { extractFileBlocks } from './fileOpPlugin.js';
import { findBalancedProcessingBlockRanges } from './processingPlugin.js';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

const sanitizer = typeof DOMPurify === 'function' ? (DOMPurify as any)(window) : DOMPurify;

const OPEN_THINK_RE = /<(think|thinking|thought|analysis|reasoning)\b[^>]*>/gi;
const CLOSE_THINK_RE = /<\/(think|thinking|thought|analysis|reasoning)\s*>/gi;

export function formatThoughtDuration(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) return '';
    const totalSecs = ms / 1000;
    if (totalSecs < 60) {
        return `${Math.max(0.1, totalSecs).toFixed(1)}s`;
    }
    const mins = Math.floor(totalSecs / 60);
    const remSecs = Math.round(totalSecs % 60);
    return `${mins}m ${remSecs}s`;
}

function getMessageWrapper(messageId: string): HTMLElement | null {
    if (typeof document === 'undefined' || !messageId) return null;
    try {
        const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
            ? CSS.escape(messageId)
            : messageId.replace(/["\\]/g, '\\$&');
        return document.querySelector(`.message-wrapper[data-message-id="${escaped}"]`) as HTMLElement | null;
    } catch {
        return null;
    }
}

function getTimingForIndex(
    wrapper: HTMLElement | null,
    thinkIdx: number,
    isClosed: boolean
): { startMs?: number; durationMs?: number } {
    if (!wrapper) return {};

    const liveTimings = (wrapper as any)._thinkTimings as Array<{ start: number; end?: number }> | undefined;
    if (Array.isArray(liveTimings) && liveTimings[thinkIdx]) {
        const t = liveTimings[thinkIdx];
        return {
            startMs: t.start,
            durationMs: t.end !== undefined ? Math.max(0, t.end - t.start) : (isClosed ? Math.max(0, Date.now() - t.start) : undefined)
        };
    }

    if (wrapper.dataset.thinkDurations) {
        try {
            const saved = JSON.parse(wrapper.dataset.thinkDurations);
            if (Array.isArray(saved) && typeof saved[thinkIdx] === 'number') {
                return { durationMs: Math.max(0, saved[thinkIdx]) };
            }
        } catch {}
    }

    if (thinkIdx === 0 && wrapper.dataset.thinkStartTime) {
        const s = parseInt(wrapper.dataset.thinkStartTime, 10);
        const e = wrapper.dataset.thinkEndTime ? parseInt(wrapper.dataset.thinkEndTime, 10) : undefined;
        if (!isNaN(s)) {
            return {
                startMs: s,
                durationMs: e !== undefined && !isNaN(e) ? Math.max(0, e - s) : (isClosed ? Math.max(0, Date.now() - s) : undefined)
            };
        }
    }

    if (!isClosed) {
        const fallbackStart = parseInt(wrapper.dataset.firstTokenTime || wrapper.dataset.startTime || '', 10);
        return { startMs: !isNaN(fallbackStart) ? fallbackStart : Date.now() };
    }

    return {};
}

export const thinkPlugin: TagPlugin = {
    id: 'think_tag',
    tagPattern: /<(?:think|thinking|thought|analysis|reasoning)\b[^>]*>/i,
    extractBlocks: (text: string, context: PluginContext) => {
        const blocks: { html: string; start: number; end: number }[] = [];
        if (!text || typeof text !== 'string') return blocks;

        const fileRanges = extractFileBlocks(text).map(b => ({ start: b.start, end: b.end }));
        const protectedRanges: { start: number; end: number }[] = [
            ...fileRanges,
            ...findBalancedProcessingBlockRanges(text, fileRanges)
        ];

        // Protect fenced code blocks (variable-length backtick/tilde) and inline backticks outside <file>/processing-block
        let openFence: { start: number; char: string; len: number } | null = null;
        let lineStart = 0;
        const len = text.length;
        while (lineStart < len) {
            const nlIdx = text.indexOf('\n', lineStart);
            const nextLineStart = nlIdx === -1 ? len : nlIdx + 1;
            const lineEnd = (nlIdx === -1 ? len : nlIdx) - (nlIdx > lineStart && text[nlIdx - 1] === '\r' ? 1 : 0);
            const lineText = text.slice(lineStart, lineEnd);

            if (!openFence && protectedRanges.some(r => lineStart >= r.start && lineStart < r.end)) {
                lineStart = nextLineStart;
                continue;
            }

            const fm = lineText.match(/^[ \t]*(`{3,}|~{3,})(.*)$/);
            if (openFence) {
                if (fm && fm[1][0] === openFence.char && fm[1].length >= openFence.len && (fm[2] || '').trim() === '') {
                    protectedRanges.push({ start: openFence.start, end: nextLineStart });
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
                    openFence = { start: lineStart, char: ch, len: marker.length };
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
                    if (endCol !== -1) {
                        protectedRanges.push({ start: lineStart + col, end: lineStart + endCol });
                        col = endCol;
                        continue;
                    }
                    col += t;
                    continue;
                }
                col++;
            }
            lineStart = nextLineStart;
        }
        if (openFence) {
            protectedRanges.push({ start: openFence.start, end: len });
        }

        const findContainingProtected = (pos: number) =>
            protectedRanges.find(r => pos >= r.start && pos < r.end);

        const wrapper = getMessageWrapper(context.messageId);
        let searchPos = 0;
        let thinkIndex = 0;

        while (searchPos < text.length) {
            OPEN_THINK_RE.lastIndex = searchPos;
            let openMatch: RegExpExecArray | null = null;
            while ((openMatch = OPEN_THINK_RE.exec(text)) !== null) {
                const inProtected = findContainingProtected(openMatch.index);
                if (inProtected) {
                    OPEN_THINK_RE.lastIndex = inProtected.end;
                    continue;
                }
                break;
            }

            let earliestOpenIdx = openMatch ? openMatch.index : -1;
            let matchedTagName = openMatch ? openMatch[1].toLowerCase() : '';
            let contentStart = openMatch ? openMatch.index + openMatch[0].length : -1;

            if (searchPos === 0 && earliestOpenIdx === -1) {
                CLOSE_THINK_RE.lastIndex = 0;
                let danglingClose: RegExpExecArray | null = null;
                while ((danglingClose = CLOSE_THINK_RE.exec(text)) !== null) {
                    const inProtected = findContainingProtected(danglingClose.index);
                    if (inProtected) {
                        CLOSE_THINK_RE.lastIndex = inProtected.end;
                        continue;
                    }
                    break;
                }
                if (danglingClose) {
                    earliestOpenIdx = 0;
                    matchedTagName = danglingClose[1].toLowerCase();
                    contentStart = 0;
                }
            }

            if (earliestOpenIdx === -1) break;

            CLOSE_THINK_RE.lastIndex = contentStart;
            let closeMatch: RegExpExecArray | null = null;
            let fallbackCloseMatch: RegExpExecArray | null = null;
            while ((closeMatch = CLOSE_THINK_RE.exec(text)) !== null) {
                const inProtected = findContainingProtected(closeMatch.index);
                if (inProtected) {
                    CLOSE_THINK_RE.lastIndex = inProtected.end;
                    continue;
                }
                if (!fallbackCloseMatch) fallbackCloseMatch = closeMatch;
                if (closeMatch[1].toLowerCase() === matchedTagName) {
                    break;
                }
            }
            const chosenClose = closeMatch || fallbackCloseMatch;

            const closeIdx = chosenClose ? chosenClose.index : -1;
            let isClosed = true;
            let blockEnd = chosenClose ? chosenClose.index + chosenClose[0].length : -1;

            if (closeIdx === -1) {
                if (context.isFinal) {
                    const remainingText = text.substring(contentStart);
                    const fileMatch = remainingText.search(/(?:^|\n)[ \t]*<file\b/i);
                    blockEnd = fileMatch !== -1 ? contentStart + fileMatch : text.length;
                    isClosed = true;
                } else {
                    isClosed = false;
                    blockEnd = text.length;
                }
            }

            const rawThought = (closeIdx !== -1
                ? text.substring(contentStart, closeIdx)
                : text.substring(contentStart, blockEnd)).trim();
            const parsedMarkdown = sanitizer.sanitize(marked.parse(rawThought || '*Thinking...*') as string);

            const timing = getTimingForIndex(wrapper, thinkIndex, isClosed);
            const liveElapsedMs = !isClosed && timing.startMs ? Math.max(0, Date.now() - timing.startMs) : undefined;
            const durationStr = isClosed
                ? (timing.durationMs !== undefined ? formatThoughtDuration(timing.durationMs) : '')
                : (liveElapsedMs !== undefined ? formatThoughtDuration(liveElapsedMs) : '');

            const iconHtml = isClosed
                ? '<span class="codicon codicon-circuit-board think-status-icon"></span>'
                : '<span class="spinner think-spinner"></span>';

            const titleText = isClosed
                ? (durationStr ? `Thought for ${durationStr}` : 'Thought Process')
                : 'Thinking...';

            const durationBadgeHtml = isClosed
                ? (durationStr
                    ? `<span class="think-duration" title="Reasoning duration">⏱ ${durationStr}</span>`
                    : '')
                : `<span class="think-duration is-live" data-start-ms="${timing.startMs || Date.now()}" title="Elapsed thinking time">⏱ ${durationStr || '0.1s'}</span>`;

            const cardId = `think-block-${context.messageId}-${thinkIndex}`;
            const detailsId = `think-details-${context.messageId}-${thinkIndex}`;
            thinkIndex++;

            const html = `
<div class="think-block" id="${cardId}" data-closed="${isClosed ? 'true' : 'false'}">
    <details class="think-details" id="${detailsId}">
        <summary class="think-summary">
            <div class="think-summary-left">
                <i class="codicon codicon-chevron-right think-chevron"></i>
                <span class="think-icon-slot">${iconHtml}</span>
                <span class="thought-title-label">${titleText}</span>
            </div>
            <div class="think-summary-right">
                ${durationBadgeHtml}
            </div>
        </summary>
        <div class="think-body markdown-body">
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
    render: () => '',
    initialize: (container: HTMLElement) => {
        container.querySelectorAll('.think-duration.is-live[data-start-ms]').forEach((el: any) => {
            if (el._thinkTimer) return;
            const timer = window.setInterval(() => {
                const block = el.closest('.think-block');
                if (!block || block.getAttribute('data-closed') === 'true' || !el.classList.contains('is-live') || !document.body.contains(el)) {
                    clearInterval(timer);
                    delete el._thinkTimer;
                    return;
                }
                const startMs = parseInt(el.getAttribute('data-start-ms') || '0', 10);
                if (startMs > 0) {
                    el.textContent = `⏱ ${formatThoughtDuration(Math.max(0, Date.now() - startMs))}`;
                }
            }, 250);
            el._thinkTimer = timer;
        });
    }
};

export default thinkPlugin;