/**
 * chatPanelMessageHandler — canonical host-side module for the EMBEDDED agent mode wire protocol.
 *
 * ## Wire protocol (locked — Phase 2/3 contract)
 * - Host → Webview: `agentQuestion {messageId, question, options, isAgentZone}`
 *   and `setAgentMode {isActive}`.
 * - Webview → Host: `answerAgentQuestion {messageId, answer}`, `setAgentMode {isActive}`,
 *   and `agentAbort` (forward-compat).
 * - Pre-existing transport: `updateMessage {messageId, newContent, isFinal}` carries the
 *   accumulated `<agent_round>` fences for the SAME messageId (APPEND_TAG accumulate
 *   semantics in ChatPanel.updateMessageContent).
 *
 * ## Fence grammar (single source of parity with the webview parser)
 *   <agent_round type="plan|tool|exec|verify|question" title="…" status="running|done|failed">
 *     …markdown/fenced content…
 *   </agent_round>
 *   Emitted by {@link buildAgentRoundBlock}; parsed webview-side in messageRenderer.ts.
 *
 * ## Integration SEAM (documented — to be applied when chatPanel.ts is next unmuted)
 *   `ChatPanel._setWebviewMessageListener` must PREPEND, before its own switch:
 *     if (await handleAgentWebviewMessage(message, createAgentMessageContext(this))) return;
 *   Inline `requestUserInput` implementations should use
 *   `registerPendingAgentQuestion` + `postAgentQuestion` instead of modal input
 *   (VS Code input boxes), so agent questions render inside the SAME answer block.
 *
 * This module is standalone: zero imports from chatPanel.ts (no circular deps), zero
 * module-load side effects, and never throws on ill-typed input.
 */
import * as vscode from 'vscode';

export type AgentRoundType = 'plan' | 'tool' | 'exec' | 'verify' | 'question';
export type AgentRoundStatus = 'running' | 'done' | 'failed';

/** XML-attribute escaper for round titles (& < > " '). */
export function escapeXmlAttr(s: string): string {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/**
 * Pure builder for the canonical agent-round fence. Grammar parity with the
 * webview-side parser (messageRenderer.parseAgentRoundAttrs) is mandatory.
 */
export function buildAgentRoundBlock(
    type: AgentRoundType,
    title: string,
    status: AgentRoundStatus,
    content: string
): string {
    const safeType: AgentRoundType = (['plan', 'tool', 'exec', 'verify', 'question'] as const).includes(type as any) ? type : 'tool';
    const safeStatus: AgentRoundStatus = (['running', 'done', 'failed'] as const).includes(status as any) ? status : 'done';
    return `\n<agent_round type="${safeType}" title="${escapeXmlAttr(title || '')}" status="${safeStatus}">\n${content ?? ''}\n</agent_round>`;
}

export interface AgentQuestionRequest {
    messageId: string;
    question: string;
    options: string[];
    isAgentZone: boolean;
    resolve: (answer: string) => void;
    createdAt: number;
}

/** Module-private pending question registry keyed by messageId (last-write-wins). */
const pendingAgentQuestions = new Map<string, AgentQuestionRequest>();

export function registerPendingAgentQuestion(
    messageId: string,
    question: string,
    options: string[],
    isAgentZone: boolean,
    resolve: (answer: string) => void
): void {
    if (typeof messageId !== 'string' || !messageId || typeof resolve !== 'function') return;
    pendingAgentQuestions.set(messageId, {
        messageId,
        question: typeof question === 'string' ? question : '',
        options: Array.isArray(options) ? options.filter(o => typeof o === 'string') : [],
        isAgentZone: isAgentZone === true,
        resolve,
        createdAt: Date.now()
    });
}

export function hasPendingAgentQuestion(messageId: string): boolean {
    return typeof messageId === 'string' && pendingAgentQuestions.has(messageId);
}

/** Resolves + deletes the pending question. Returns false if unknown or answer missing. */
export function resolveAgentQuestion(messageId: string, answer: string): boolean {
    if (typeof messageId !== 'string' || typeof answer !== 'string' || answer.trim() === '') return false;
    const req = pendingAgentQuestions.get(messageId);
    if (!req) return false;
    pendingAgentQuestions.delete(messageId);
    try {
        req.resolve(answer);
    } catch {
        // Resolver errors must never propagate into the dispatcher.
    }
    return true;
}

/** Abort cleanup: with an id discards that entry; without an id discards all. Returns count. */
export function discardPendingAgentQuestion(messageId?: string): number {
    if (typeof messageId === 'string' && messageId) {
        return pendingAgentQuestions.delete(messageId) ? 1 : 0;
    }
    const count = pendingAgentQuestions.size;
    pendingAgentQuestions.clear();
    return count;
}

/** Host → webview: renders the inline question card inside the same answer bubble. */
export function postAgentQuestion(
    webview: vscode.Webview,
    req: { messageId: string; question: string; options: string[]; isAgentZone: boolean }
): void {
    if (!webview || typeof req?.messageId !== 'string') return;
    try {
        void webview.postMessage({
            command: 'agentQuestion',
            messageId: req.messageId,
            question: typeof req.question === 'string' ? req.question : '',
            options: Array.isArray(req.options) ? req.options : [],
            isAgentZone: req.isAgentZone === true
        });
    } catch {
        // Webview may be disposed mid-turn; never throw.
    }
}

/** Host → webview: flips the embedded agent-mode state chip (zero chrome swap). */
export function postSetAgentMode(webview: vscode.Webview, isActive: boolean): void {
    if (!webview) return;
    try {
        void webview.postMessage({ command: 'setAgentMode', isActive: isActive === true });
    } catch {
        // Webview may be disposed; never throw.
    }
}

export interface AgentMessageHostContext {
    webview: vscode.Webview;
    onAgentModeChanged?: (isActive: boolean) => void | Promise<void>;
    onAgentQuestionAnswered?: (messageId: string, answer: string) => void | Promise<void>;
    onAgentAbort?: () => void | Promise<void>;
}

/**
 * Pure dispatcher for agent-related webview messages.
 * Returns true when the message was consumed; false means "not an agent message —
 * the caller must continue its own switch".
 */
export async function handleAgentWebviewMessage(
    message: any,
    ctx: AgentMessageHostContext
): Promise<boolean> {
    if (!message || typeof message !== 'object' || typeof message.command !== 'string') return false;

    switch (message.command) {
        case 'answerAgentQuestion': {
            const ok = resolveAgentQuestion(message.messageId, message.answer);
            if (ok) {
                await ctx?.onAgentQuestionAnswered?.(String(message.messageId), String(message.answer));
            }
            return true;
        }
        case 'setAgentMode': {
            await ctx?.onAgentModeChanged?.(message.isActive === true);
            return true;
        }
        case 'agentAbort': {
            discardPendingAgentQuestion();
            await ctx?.onAgentAbort?.();
            return true;
        }
        default:
            return false;
    }
}

/**
 * Defensive adapter building an {@link AgentMessageHostContext} over a chat panel.
 * All wiring is optional-chained — the module must never hard-depend on panel internals.
 */
export function createAgentMessageContext(panel: {
    webview: vscode.Webview;
    agentManager?: any;
    discussionManager?: any;
}): AgentMessageHostContext {
    const webview = panel?.webview;
    const agentManager = panel?.agentManager;
    const discussionManager = panel?.discussionManager;

    return {
        webview,
        onAgentModeChanged: async (isActive: boolean) => {
            // Embedded agent mode: capability flip + chip sync only; the HUD chrome never changes.
            agentManager?.updateAgentMode?.(isActive);
            if (!isActive && agentManager?.getIsActive?.() && agentManager?.toggleAgentMode) {
                // Fall back to the toggle path when updateAgentMode is unavailable.
                agentManager.toggleAgentMode();
            }
            try {
                const discussionManagerAny = discussionManager as any;
                const current = discussionManagerAny?.currentDiscussion ?? discussionManagerAny?.getCurrentDiscussion?.();
                if (current?.capabilities) {
                    current.capabilities.agentMode = isActive;
                }
            } catch {
                // Discussion state sync is best-effort.
            }
        },
        onAgentQuestionAnswered: (_messageId: string, _answer: string) => {
            // Q&A round emission is handled by the caller (chatPanel appendAgentRound).
        },
        onAgentAbort: () => {
            discardPendingAgentQuestion();
        }
    };
}