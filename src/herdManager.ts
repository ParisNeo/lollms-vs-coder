import * as vscode from 'vscode';
import { LollmsAPI, ChatMessage } from './lollmsAPI';
import { ContextManager } from './contextManager';
import { PersonalityManager } from './personalityManager';
import { HerdParticipant, DynamicModelEntry } from './utils';
import { AgentManager } from './agentManager';

const SCRATCHPAD_WORD_LIMIT  = 80;  // ~3-5 sentences — opening position only
const DISCUSSION_WORD_LIMIT  = 60;  // ~2-4 sentences — one idea per turn
const API_CALL_DELAY_MS      = 500; // pause between calls — Ollama is single-threaded
const MAX_CONSECUTIVE_FAILS  = 2;   // skip a participant after this many consecutive errors

interface ResolvedParticipant {
    name: string;
    model: string;
    prompt: string;
    allowExecution: boolean;
}

interface DiscussionTurn {
    participantName: string;
    model: string;
    content: string;
}

export class HerdManager {
    constructor(
        private lollmsAPI: LollmsAPI,
        private contextManager: ContextManager,
        private personalityManager: PersonalityManager,
        private agentManager?: AgentManager
    ) {}

    // ── DYNAMIC PLANNING ────────────────────────────────────────────────────────

    public async planDynamicHerd(
        userPrompt: string,
        modelPool: DynamicModelEntry[],
        leaderModel: string,
        signal: AbortSignal
    ): Promise<{ pre: HerdParticipant[], post: HerdParticipant[] } | null> {
        if (modelPool.length === 0) return null;

        const poolDesc = modelPool.map(m => `- \`${m.model}\`: ${m.description}`).join('\n');

        const planningPrompt = `You are a Software Team Architect AI. Your job is to assign sharp, opinionated code-review personas to a set of AI models, then form two panels to tackle a coding problem.

**USER PROBLEM:**
"${userPrompt}"

**AVAILABLE MODELS (you MUST use these exact model IDs — no others):**
${poolDesc}

**PERSONA ARCHETYPES — pick the most fitting ones given the problem:**
- **Architect**: Focuses on system design, abstractions, modularity, and long-term maintainability.
- **Skeptic**: Challenges assumptions, pokes holes in proposals, demands evidence and edge-case handling.
- **Security Auditor**: Hunts for vulnerabilities, injection risks, auth flaws, and unsafe defaults.
- **Performance Engineer**: Obsesses over complexity, memory usage, bottlenecks, and scalability.
- **DX Champion**: Advocates for readability, naming, documentation, and developer ergonomics.
- **Pragmatist**: Cuts scope ruthlessly, ships the simplest thing that works, resists over-engineering.

**RULES:**
1. Assign 2-3 personas for preAnswer (brainstorm panel — debate the approach BEFORE a solution is written).
2. Assign 2-3 personas for postAnswer (review panel — critique the solution AFTER it is written).
3. Each persona must use exactly one model ID from the list above, verbatim.
4. System prompts: 3-4 sentences, first-person, opinionated. Not a neutral helper.
5. Set allowExecution: true only for personas that benefit from running code (Security Auditor, Performance Engineer).
6. Output ONLY valid JSON inside a code block — no prose outside it.

**OUTPUT FORMAT:**
\`\`\`json
{
  "preAnswer": [
    {
      "name": "Persona Name",
      "model": "exact-model-id",
      "systemPrompt": "I am the [role]. I believe [strong stance]. I always [behaviour]. I will [contribution].",
      "allowExecution": false
    }
  ],
  "postAnswer": [
    {
      "name": "Persona Name",
      "model": "exact-model-id",
      "systemPrompt": "I am the [role]. I believe [strong stance]. I always [behaviour]. I will [contribution].",
      "allowExecution": false
    }
  ]
}
\`\`\``;

        try {
            const response = await this.lollmsAPI.sendChat([
                { role: 'system', content: "You are a JSON-only Team Architect. Output valid JSON and nothing else." },
                { role: 'user', content: planningPrompt }
            ], null, signal, leaderModel);

            const jsonMatch = response.match(/```json\s*([\s\S]+?)\s*```/) || response.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                console.warn("planDynamicHerd: no JSON in response, using fallback.");
                return this.buildFallbackHerd(modelPool);
            }

            let plan: any;
            try {
                plan = JSON.parse(jsonMatch[1] || jsonMatch[0]);
            } catch {
                console.warn("planDynamicHerd: JSON parse failed, using fallback.");
                return this.buildFallbackHerd(modelPool);
            }

            const validModelIds = new Set(modelPool.map(m => m.model));
            const mapToParticipant = (p: any): HerdParticipant => {
                // Snap invalid model IDs to a real one rather than dropping the persona
                if (!validModelIds.has(p.model)) {
                    p.model = modelPool[Math.floor(Math.random() * modelPool.length)].model;
                }
                return {
                    model: p.model,
                    personality: 'dynamic_persona',
                    name: p.name || 'Expert',
                    systemPrompt: p.systemPrompt || "You are an expert code reviewer with strong opinions.",
                    allowExecution: p.allowExecution || false
                };
            };

            const pre  = (plan.preAnswer  || plan.preCode  || []).map(mapToParticipant) as HerdParticipant[];
            const post = (plan.postAnswer || plan.postCode || []).map(mapToParticipant) as HerdParticipant[];

            if (pre.length === 0 && post.length === 0) {
                return this.buildFallbackHerd(modelPool);
            }

            return { pre, post };

        } catch (error) {
            console.error("Dynamic Herd Planning Failed:", error);
            return this.buildFallbackHerd(modelPool);
        }
    }

    /**
     * Hard-coded fallback when the leader model fails to plan.
     * Distributes four classic code-review archetypes across the available models.
     */
    private buildFallbackHerd(modelPool: DynamicModelEntry[]): { pre: HerdParticipant[], post: HerdParticipant[] } {
        const pick = (idx: number) => modelPool[idx % modelPool.length].model;

        const pre: HerdParticipant[] = [
            {
                model: pick(0),
                personality: 'dynamic_persona',
                name: 'Architect',
                systemPrompt: "I am the Architect. I care deeply about clean abstractions, separation of concerns, and long-term maintainability. I challenge any design that couples things that should be independent, and I always ask: what happens when requirements change?",
                allowExecution: false
            },
            {
                model: pick(1),
                personality: 'dynamic_persona',
                name: 'Skeptic',
                systemPrompt: "I am the Skeptic. I assume every proposed solution has a hidden flaw. I probe edge cases, question assumptions, and demand that claims be backed by concrete evidence or working code. Nothing ships until it survives my questions.",
                allowExecution: false
            },
            {
                model: pick(2),
                personality: 'dynamic_persona',
                name: 'Pragmatist',
                systemPrompt: "I am the Pragmatist. I ship. I cut scope ruthlessly and resist over-engineering at every turn. If a simpler solution exists, I will find it. I push back hard on complexity that doesn't justify itself.",
                allowExecution: false
            }
        ];

        const post: HerdParticipant[] = [
            {
                model: pick(0),
                personality: 'dynamic_persona',
                name: 'Security Auditor',
                systemPrompt: "I am the Security Auditor. I read every line of code looking for injection risks, unsafe defaults, missing auth checks, and data leakage. I will not approve anything until the full attack surface is understood and addressed.",
                allowExecution: true
            },
            {
                model: pick(1),
                personality: 'dynamic_persona',
                name: 'Performance Engineer',
                systemPrompt: "I am the Performance Engineer. I think in Big-O notation, memory allocations, and cache misses. I flag every algorithm that won't scale and every abstraction that hides a hidden runtime cost.",
                allowExecution: true
            }
        ];

        return { pre, post };
    }


    // ── MAIN RUN ────────────────────────────────────────────────────────────────

    public async run(
        userPrompt: string,
        brainstormingParticipants: HerdParticipant[],
        refinementParticipants: HerdParticipant[],
        maxRounds: number,
        leaderModel: string,
        contextText: string,
        onStatusUpdate: (status: string) => void,
        onUpdateMessage: (content: string) => Promise<void>,
        signal: AbortSignal,
        chatHistory: ChatMessage[] = []
    ): Promise<string> {

        const safeUpdate = typeof onUpdateMessage === 'function' ? onUpdateMessage : async (_: string) => {};
        const safeStatus = typeof onStatusUpdate === 'function' ? onStatusUpdate : (_: string) => {};

        let uiOutput = `### 🐂 Herd Discussion\n\n`;
        const appendToUI = async (text: string) => {
            uiOutput += text;
            await safeUpdate(uiOutput);
        };

        const discussants = (Array.isArray(brainstormingParticipants) ? brainstormingParticipants : []).map(p => this.resolve(p));
        const reviewers   = (Array.isArray(refinementParticipants)   ? refinementParticipants   : []).map(p => this.resolve(p));
        const allNames    = [...discussants, ...reviewers].map(p => p.name).join(', ');

        if (discussants.length === 0) {
            await appendToUI("❌ No brainstorming participants provided.\n");
            return "Herd aborted: no participants.";
        }


        // ── TEAM ROSTER ────────────────────────────────────────────────────────────
        // Show the assembled team immediately so the user knows who is participating
        // and what angle each agent brings — transparency by construction.

        const renderRoster = (
            members: ResolvedParticipant[],
            emoji: string,
            label: string
        ): string => {
            if (members.length === 0) return "";
            const rows = members.map(p =>
                `| ${emoji} **${p.name}** | \`${p.model}\` | ${p.prompt.split('.')[0].replace(/^I am the?\s*/i, '').trim()}. |`
            ).join('\n');
            return `**${label}**\n| Role | Model | Stance |\n|------|-------|--------|\n${rows}\n\n`;
        };

        await appendToUI(
            renderRoster(discussants, '🧠', 'Brainstorming Panel') +
            renderRoster(reviewers,   '🛡️', 'Review Panel') +
            `> *Leader: \`${leaderModel}\`*\n\n---\n\n`
        );

        // ── STEP 1: PARALLEL SCRATCHPADS ───────────────────────────────────────
        // Each agent writes privately and simultaneously — no one sees the others.
        // This prevents anchoring: every agent forms a genuine independent position.

        await appendToUI(`#### 🗒️ Private Scratchpads\n\n`);
        safeStatus("Agents forming independent positions…");

        // Sequential scratchpads — Ollama is single-threaded; parallel calls cause
        // 500 errors and 'tool_calls' variable crashes. Each agent writes one at a time.
        // The privacy guarantee is preserved: each prompt contains NO prior scratchpad content.
        const scratchpadResults: { participant: ResolvedParticipant; content: string }[] = [];

        for (const participant of discussants) {
            if (signal.aborted) break;

            const systemPrompt = `${participant.prompt}

You are about to join a group discussion. Before it begins, write your private opening position.

**PROBLEM:** ${userPrompt}

**CONTEXT:** ${contextText}

**RULES — NON-NEGOTIABLE:**
- Hard limit: ${SCRATCHPAD_WORD_LIMIT} words. Stop mid-sentence if you must.
- State your angle and your single biggest concern. Nothing else.
- No summaries, no hedging, no "on the other hand". Pick a stance and defend it.
- This is a scratchpad, not a report. Be blunt.`;

            try {
                safeStatus(`${participant.name} writing private position…`);
                await new Promise(r => setTimeout(r, API_CALL_DELAY_MS));
                let content = await this.lollmsAPI.sendChat([
                    { role: 'system', content: systemPrompt }
                ], null, signal, participant.model);

                content = this.truncateToWordLimit(content.trim(), SCRATCHPAD_WORD_LIMIT);
                scratchpadResults.push({ participant, content });
            } catch (error: any) {
                scratchpadResults.push({ participant, content: `*(error: ${error.message})*` });
            }
        }

        // Order is already preserved since we iterate discussants sequentially
        const orderedScratchpads = scratchpadResults;

        // Render as collapsed blocks — user can expand, but agents see all on reveal
        for (const { participant, content } of orderedScratchpads) {
            await appendToUI(
`<details>
<summary>🗒️ ${participant.name} — private scratchpad</summary>

${content}

</details>
`
            );
        }

        // Build the reveal block shown to all agents at discussion start
        const revealBlock = orderedScratchpads
            .map(({ participant, content }) => `**${participant.name}:** ${content}`)
            .join('\n\n');

        // ── STEP 2: OPEN DISCUSSION ─────────────────────────────────────────────
        // Everyone now sees all scratchpads simultaneously.
        // Agents react, challenge, build — keeping each turn short.

        if (signal.aborted) return this.buildFinalPrompt(userPrompt, [], "", []);

        await appendToUI(`\n#### 💬 Discussion\n\n`);

        const discussionTurns: DiscussionTurn[] = [];

        const getDiscussionTurn = async (
            participant: ResolvedParticipant
        ): Promise<{ content: string; isReady: boolean }> => {

            const transcript = this.renderTranscript(discussionTurns);

            const systemPrompt = `${participant.prompt}

You are in a live group discussion with: ${allNames}.
Goal: collectively solve the user's problem through debate. The thinking happens between you, not inside you.

**PROBLEM:** ${userPrompt}

**CONTEXT:** ${contextText}

**EVERYONE'S OPENING POSITIONS (revealed simultaneously):**
${revealBlock}

**DISCUSSION SO FAR:**
${transcript || "(You are the first to speak after the reveal.)"}

**RULES — NON-NEGOTIABLE:**
- Hard limit: ${DISCUSSION_WORD_LIMIT} words. Stop mid-sentence if you must.
- React to what was just said. Address someone by name if you're challenging or building on their point.
- One idea per message. Make it sharp and specific.
- No preamble, no sign-offs, no summaries. Just speak.
- Only write <ready/> (nothing else) if the discussion has genuinely concluded and you have nothing to add.`;

            let response = await this.lollmsAPI.sendChat([
                { role: 'system', content: systemPrompt }
            ], null, signal, participant.model);

            if (signal.aborted) return { content: "", isReady: true };

            // Execution loop (optional capability)
            if (participant.allowExecution && response.includes('<execute>') && this.agentManager) {
                const execMatch = response.match(/<execute>([\s\S]*?)<\/execute>/);
                if (execMatch) {
                    const command = execMatch[1].trim();
                    safeStatus(`${participant.name} executing: ${command}…`);
                    const result = await this.agentManager.runCommand(command, signal);
                    const injected = `${systemPrompt}\n\n**EXECUTION RESULT for \`${command}\`:**\n${result.output}\n\nNow give your reply in ${DISCUSSION_WORD_LIMIT} words or fewer.`;
                    response = await this.lollmsAPI.sendChat([
                        { role: 'system', content: injected }
                    ], null, signal, participant.model);
                }
            }

            const isReady = response.trim() === '<ready/>' || (response.includes('<ready/>') && response.replace(/<ready\/>/g, '').trim().length === 0);
            const content = this.truncateToWordLimit(response.replace(/<ready\/>/g, '').trim(), DISCUSSION_WORD_LIMIT);
            return { content, isReady };
        };

        // Track consecutive failures per participant — skip those that keep crashing
        const discussionFailures = new Map<string, number>(discussants.map(p => [p.name, 0]));

        for (let round = 1; round <= maxRounds; round++) {
            if (signal.aborted) break;

            let allReady = true;

            for (const participant of discussants) {
                if (signal.aborted) break;

                // Skip participants that have hit the failure threshold
                if ((discussionFailures.get(participant.name) ?? 0) >= MAX_CONSECUTIVE_FAILS) {
                    continue;
                }

                safeStatus(`${participant.name} responding…`);

                // Breathing room between calls — essential for single-threaded backends
                await new Promise(r => setTimeout(r, API_CALL_DELAY_MS));

                try {
                    const { content, isReady } = await getDiscussionTurn(participant);
                    discussionFailures.set(participant.name, 0); // reset on success
                    if (!isReady) allReady = false;

                    if (content) {
                        discussionTurns.push({ participantName: participant.name, model: participant.model, content });
                        await appendToUI(`**🧠 ${participant.name}:** ${content}\n\n`);
                    } else if (isReady) {
                        await appendToUI(`*✅ ${participant.name} has nothing to add.*\n\n`);
                    }
                } catch (error: any) {
                    const fails = (discussionFailures.get(participant.name) ?? 0) + 1;
                    discussionFailures.set(participant.name, fails);
                    if (fails >= MAX_CONSECUTIVE_FAILS) {
                        await appendToUI(`*⚠️ ${participant.name} is unresponsive — skipping for remaining rounds.*\n\n`);
                    } else {
                        await appendToUI(`*⚠️ ${participant.name} failed (attempt ${fails}/${MAX_CONSECUTIVE_FAILS}): ${error.message}*\n\n`);
                    }
                }
            }

            if (allReady && round > 1) {
                await appendToUI(`*Discussion closed after ${round} rounds.*\n`);
                break;
            }

            if (round < maxRounds) await appendToUI(`---\n\n`);
        }

        // ── STEP 3: LEADER SYNTHESIS ────────────────────────────────────────────
        // Only the leader is allowed to write at length here.

        if (signal.aborted) return this.buildFinalPrompt(userPrompt, discussionTurns, "", []);

        safeStatus("Leader synthesising…");
        await appendToUI(`\n#### 📝 Leader Synthesis\n\n`);

        let draftSolution = "";

        try {
            draftSolution = await this.lollmsAPI.sendChat([{
                role: 'system',
                content: `You are the Leader Agent. Your team has just debated the problem.
Synthesise their discussion into a concrete, detailed solution. Be thorough — this is the one place where full detail is expected.

**USER OBJECTIVE:** ${userPrompt}

**OPENING POSITIONS:**
${revealBlock}

**DISCUSSION:**
${this.renderTranscript(discussionTurns)}

**CONTEXT:** ${contextText}

Write the Draft Solution now.`
            }], null, signal, leaderModel);

            await appendToUI(draftSolution + "\n");
        } catch (error: any) {
            await appendToUI(`\n❌ Leader synthesis failed: ${error.message}\n`);
            return this.buildFinalPrompt(userPrompt, discussionTurns, "", []);
        }

        // ── STEP 4: REVIEW DISCUSSION ───────────────────────────────────────────
        // Reviewers also discuss briefly — same brevity rules.

        if (signal.aborted || reviewers.length === 0) {
            return this.buildFinalPrompt(userPrompt, discussionTurns, draftSolution, []);
        }

        await appendToUI(`\n#### 🛡️ Review\n\n`);

        const reviewTurns: DiscussionTurn[] = [];

        const getReviewTurn = async (
            reviewer: ResolvedParticipant
        ): Promise<{ content: string; isReady: boolean }> => {

            const systemPrompt = `${reviewer.prompt}

You are reviewing a proposed solution with: ${reviewers.map(r => r.name).join(', ')}.

**DRAFT SOLUTION:**
${draftSolution}

**REVIEW SO FAR:**
${this.renderTranscript(reviewTurns) || "(You are the first reviewer.)"}

**RULES — NON-NEGOTIABLE:**
- Hard limit: ${DISCUSSION_WORD_LIMIT} words. Stop mid-sentence if you must.
- Flag one specific issue OR confirm one specific strength. Not both.
- Address other reviewers by name if you're building on their point.
- No preamble, no summaries. Just speak.
- Only write <ready/> (nothing else) if the draft is solid and issues are covered.`;

            const response = await this.lollmsAPI.sendChat([
                { role: 'system', content: systemPrompt }
            ], null, signal, reviewer.model);

            const isReady = response.trim() === '<ready/>' || (response.includes('<ready/>') && response.replace(/<ready\/>/g, '').trim().length === 0);
            const content = this.truncateToWordLimit(response.replace(/<ready\/>/g, '').trim(), DISCUSSION_WORD_LIMIT);
            return { content, isReady };
        };

        const reviewFailures = new Map<string, number>(reviewers.map(r => [r.name, 0]));

        for (let round = 1; round <= maxRounds; round++) {
            if (signal.aborted) break;

            let allReady = true;

            for (const reviewer of reviewers) {
                if (signal.aborted) break;

                if ((reviewFailures.get(reviewer.name) ?? 0) >= MAX_CONSECUTIVE_FAILS) {
                    continue;
                }

                safeStatus(`${reviewer.name} reviewing…`);

                await new Promise(r => setTimeout(r, API_CALL_DELAY_MS));

                try {
                    const { content, isReady } = await getReviewTurn(reviewer);
                    reviewFailures.set(reviewer.name, 0);
                    if (!isReady) allReady = false;

                    if (content) {
                        reviewTurns.push({ participantName: reviewer.name, model: reviewer.model, content });
                        await appendToUI(`**🛡️ ${reviewer.name}:** ${content}\n\n`);
                    } else if (isReady) {
                        await appendToUI(`*✅ ${reviewer.name} approves.*\n\n`);
                    }
                } catch (error: any) {
                    await appendToUI(`*❌ ${reviewer.name}: ${error.message}*\n\n`);
                }
            }

            if (allReady) {
                await appendToUI(`*Review closed after ${round} rounds.*\n`);
                break;
            }

            if (round < maxRounds) await appendToUI(`---\n\n`);
        }

        return this.buildFinalPrompt(userPrompt, discussionTurns, draftSolution, reviewTurns);
    }

    // ── HELPERS ─────────────────────────────────────────────────────────────────

    private resolve(p: HerdParticipant): ResolvedParticipant {
        if (p.systemPrompt) {
            return {
                name: p.name || p.personality,
                prompt: p.systemPrompt,
                model: p.model,
                allowExecution: p.allowExecution || false
            };
        }
        const persona = this.personalityManager.getPersonality(p.personality);
        return {
            name: persona ? persona.name : p.personality,
            prompt: persona ? persona.systemPrompt : "You are an expert AI assistant.",
            model: p.model,
            allowExecution: p.allowExecution || false
        };
    }

    private renderTranscript(turns: DiscussionTurn[]): string {
        if (turns.length === 0) return "";
        return turns.map(t => `**${t.participantName}:** ${t.content}`).join('\n\n');
    }

    /** Hard word-count truncation with ellipsis if cut. */
    private truncateToWordLimit(text: string, limit: number): string {
        const words = text.split(/\s+/);
        if (words.length <= limit) return text;
        return words.slice(0, limit).join(' ') + '…';
    }

    private buildFinalPrompt(
        userPrompt: string,
        discussionTurns: DiscussionTurn[],
        draftSolution: string,
        reviewTurns: DiscussionTurn[]
    ): string {
        return `**HERD DISCUSSION COMPLETE**

**Discussion:**
${this.renderTranscript(discussionTurns) || "(none)"}

**Draft Solution:**
${draftSolution || "(none)"}

**Review:**
${this.renderTranscript(reviewTurns) || "(none)"}

**FINAL INSTRUCTION FOR LEADER:**
Produce the definitive Final Answer incorporating all review points.
Use standard file creation formats if code is required.`;
    }

    private formatChatHistory(history: ChatMessage[]): string {
        if (!Array.isArray(history)) return "";
        return history.map(m => {
            let content = m.content;
            if (Array.isArray(content)) {
                content = content.map((c: any) => c.type === 'text' ? c.text : '[Image]').join('\n');
            }
            return `**${m.role.toUpperCase()}:** ${content}`;
        }).join('\n\n');
    }
}