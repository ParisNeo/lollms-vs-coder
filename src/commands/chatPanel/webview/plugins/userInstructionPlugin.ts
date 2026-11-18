import { TagPlugin, PluginContext } from '../pluginSystem.js';
import { dom } from '../dom.js';
import DOMPurify from 'dompurify';
import { marked } from 'marked';

const sanitizer = typeof DOMPurify === 'function' ? (DOMPurify as any)(window) : DOMPurify;

function escapeHtml(text: string): string {
    return String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function parseUserInstructionAttrs(attrStr: string): { title: string; hypothesis: string; type: string } {
    const getAttr = (name: string): string => {
        const m = attrStr.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
        return m ? (m[1] ?? m[2] ?? '').trim() : '';
    };
    return {
        title: getAttr('title'),
        hypothesis: getAttr('hypothesis'),
        type: getAttr('type')
    };
}

function renderUserInstructionCard(attrStr: string, rawBody: string, isClosed: boolean, context: PluginContext, idx: number): string {
    const attrs = parseUserInstructionAttrs(attrStr);
    const title = attrs.title || 'Action Required: User Instruction';
    const isInstrumentation = attrs.type.toLowerCase() === 'instrumentation' || /\[LOLLMS_DEBUG\]|\[DIAG\]|instrument|hypothesis|report.*output/i.test(`${title} ${rawBody}`);
    const badgeLabel = attrs.hypothesis
        ? `Hypothesis: ${attrs.hypothesis}`
        : (isInstrumentation ? 'Diagnostic & Report Back' : 'User Action Required');

    const isStreaming = !isClosed && !context.isFinal;
    const blockId = `user-instr-${context.messageId}-${idx}`;
    const trimmedBody = (rawBody || '').trim();

    let renderedBody = '';
    try {
        renderedBody = sanitizer.sanitize(marked.parse(trimmedBody || '*Preparing instructions...*') as string) as string;
    } catch {
        renderedBody = `<pre style="white-space: pre-wrap;">${escapeHtml(trimmedBody)}</pre>`;
    }

    const encodedRaw = encodeURIComponent(trimmedBody);

    return `
    <div class="user-instruction-card" id="${blockId}" data-raw-instruction="${encodedRaw}">
        <div class="user-instruction-header">
            <div class="user-instruction-title-group">
                <span class="user-instruction-icon">
                    <i class="codicon ${isInstrumentation ? 'codicon-beaker' : 'codicon-megaphone'}"></i>
                </span>
                <div class="user-instruction-headings">
                    <span class="user-instruction-kicker">USER INSTRUCTION</span>
                    <span class="user-instruction-title">${escapeHtml(title)}</span>
                </div>
            </div>
            <div class="user-instruction-badges">
                <span class="user-instruction-badge">${escapeHtml(badgeLabel)}</span>
                ${isStreaming ? '<span class="user-instruction-streaming"><span class="spinner" style="width:10px; height:10px; border-width:1.5px;"></span> Streaming...</span>' : ''}
            </div>
        </div>
        <div class="user-instruction-body markdown-body">
            ${renderedBody}
        </div>
        <div class="user-instruction-footer">
            <span class="user-instruction-hint">
                <i class="codicon codicon-info"></i> Follow the steps above and paste the resulting output back into the chat.
            </span>
            <div class="user-instruction-actions">
                <button type="button" class="code-action-btn secondary-btn copy-user-instruction-btn" data-raw-instruction="${encodedRaw}" title="Copy these instructions to clipboard">
                    <i class="codicon codicon-copy"></i> Copy Instructions
                </button>
                <button type="button" class="code-action-btn apply-btn report-user-instruction-btn" data-title="${escapeHtml(title)}" title="Prepare a reply template in the chat box to paste and report your output">
                    <i class="codicon codicon-reply"></i> Report Output
                </button>
            </div>
        </div>
    </div>`;
}

export const userInstructionPlugin: TagPlugin = {
    id: 'user_instruction',
    tagPattern: /(?:^[ \t]*|(?<=>)[ \t]*)<user_instruction\b([^>]*?)>([\s\S]*?)(?:<\/user_instruction>|$)/gim,
    extractBlocks: (text: string, context: PluginContext) => {
        const blocks: { match: any; start: number; end: number; html: string }[] = [];
        if (!text || typeof text !== 'string') return blocks;

        // Protect fenced code blocks and inline backticks so documentation examples are not rendered as cards
        const protectedRanges: { start: number; end: number }[] = [];
        const fenceRegex = /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\r\n]+`/g;
        let fMatch: RegExpExecArray | null;
        while ((fMatch = fenceRegex.exec(text)) !== null) {
            protectedRanges.push({ start: fMatch.index, end: fMatch.index + fMatch[0].length });
        }

        const isProtected = (idx: number) => protectedRanges.some(r => idx >= r.start && idx < r.end);

        const openRegex = /(?:^[ \t]*|(?<=>)[ \t]*)<user_instruction\b([^>]*)>/gim;
        let match: RegExpExecArray | null;
        let cardIdx = 0;

        while ((match = openRegex.exec(text)) !== null) {
            if (isProtected(match.index)) continue;

            const start = match.index;
            const attrStr = match[1] || '';
            const contentStart = start + match[0].length;
            const closeTag = '</user_instruction>';
            const closeIdx = text.toLowerCase().indexOf(closeTag, contentStart);
            const isClosed = closeIdx !== -1;
            const end = isClosed ? closeIdx + closeTag.length : text.length;
            const inner = isClosed ? text.substring(contentStart, closeIdx) : text.substring(contentStart);

            const html = renderUserInstructionCard(attrStr, inner, isClosed, context, cardIdx++);
            blocks.push({ match, start, end, html });

            if (!isClosed) break;
            openRegex.lastIndex = end;
        }

        return blocks;
    },
    render: (match, context) => {
        const attrStr = match[1] || '';
        const inner = match[2] || '';
        const isClosed = String(match[0] || '').toLowerCase().includes('</user_instruction>');
        return renderUserInstructionCard(attrStr, inner, isClosed, context, context.blockIndex ?? 0);
    },
    initialize: (container: HTMLElement, context: PluginContext) => {
        container.querySelectorAll('.copy-user-instruction-btn').forEach(btn => {
            if (btn.hasAttribute('data-bound')) return;
            btn.setAttribute('data-bound', 'true');
            btn.addEventListener('click', (e: Event) => {
                e.preventDefault();
                e.stopPropagation();
                const btnEl = btn as HTMLButtonElement;
                const raw = decodeURIComponent(btnEl.dataset.rawInstruction || '');
                if (!raw) return;

                context.vscode.postMessage({ command: 'copyToClipboard', text: raw });
                const origHtml = btnEl.innerHTML;
                btnEl.classList.add('success');
                btnEl.innerHTML = '<i class="codicon codicon-check"></i> Copied!';
                setTimeout(() => {
                    btnEl.classList.remove('success');
                    btnEl.innerHTML = origHtml;
                }, 1800);
            });
        });

        container.querySelectorAll('.report-user-instruction-btn').forEach(btn => {
            if (btn.hasAttribute('data-bound')) return;
            btn.setAttribute('data-bound', 'true');
            btn.addEventListener('click', (e: Event) => {
                e.preventDefault();
                e.stopPropagation();
                const btnEl = btn as HTMLButtonElement;
                const title = btnEl.dataset.title || 'User Instruction';
                const input = dom.messageInput;
                if (!input) return;

                const placeholderText = '[Paste output / logs here]';
                const template = `Output for "${title}":\n\`\`\`\n${placeholderText}\n\`\`\`\n`;
                const currentVal = input.value.trim();
                input.value = currentVal ? `${currentVal}\n\n${template}` : template;
                input.style.height = 'auto';
                input.style.height = `${Math.min(150, input.scrollHeight)}px`;
                input.dispatchEvent(new Event('input'));
                input.focus();

                const phIdx = input.value.lastIndexOf(placeholderText);
                if (phIdx !== -1) {
                    input.setSelectionRange(phIdx, phIdx + placeholderText.length);
                }
            });
        });
    }
};

export default userInstructionPlugin;