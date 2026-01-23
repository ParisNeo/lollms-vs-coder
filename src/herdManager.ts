import * as vscode from 'vscode';
import { LollmsAPI, ChatMessage } from './lollmsAPI';
import { ContextManager } from './contextManager';
import { PersonalityManager } from './personalityManager';
import { HerdParticipant, DynamicModelEntry } from './utils';
import { AgentManager } from './agentManager';

export class HerdManager {
    constructor(
        private lollmsAPI: LollmsAPI,
        private contextManager: ContextManager,
        private personalityManager: PersonalityManager,
        private agentManager?: AgentManager
    ) {}

    public async planDynamicHerd(
        userPrompt: string, 
        modelPool: DynamicModelEntry[], 
        leaderModel: string,
        signal: AbortSignal
    ): Promise<{ pre: HerdParticipant[], post: HerdParticipant[] } | null> {
        if (modelPool.length === 0) return null;

        const poolDesc = modelPool.map(m => `- ${m.model}: ${m.description}`).join('\n');
        
        const planningPrompt = `You are a Team Architect AI. Your goal is to assemble an expert AI team to solve the user's problem.

**USER PROBLEM:**
"${userPrompt}"

**AVAILABLE AI MODELS:**
${poolDesc}

**INSTRUCTIONS:**
1. Analyze the problem. Determine what kind of experts are needed.
2. Create 2-3 personas for the **Phase 1: Research & Brainstorming** (Pre-Answer).
3. Create 2-3 personas for the **Phase 3: Review & Refinement** (Post-Answer).
4. Assign each persona to the most suitable model from the available list.
5. Write a specialized system prompt for each persona.

**OUTPUT FORMAT:**
Return ONLY a valid JSON object with this structure:
\`\`\`json
{
  "preAnswer": [
    { "name": "Role Name", "model": "ModelID", "systemPrompt": "You are...", "allowExecution": true/false }
  ],
  "postAnswer": [
    { "name": "Role Name", "model": "ModelID", "systemPrompt": "You are...", "allowExecution": true/false }
  ]
}
\`\`\`
`;
        try {
            const response = await this.lollmsAPI.sendChat([
                { role: 'system', content: "You are a JSON-speaking Team Architect." },
                { role: 'user', content: planningPrompt }
            ], null, signal, leaderModel);

            const jsonMatch = response.match(/```json\s*([\s\S]+?)\s*```/) || response.match(/\{[\s\S]*\}/);
            if (!jsonMatch) return null;
            
            const plan = JSON.parse(jsonMatch[1] || jsonMatch[0]);
            
            const mapToParticipant = (p: any): HerdParticipant => ({
                model: p.model,
                personality: 'dynamic_persona',
                name: p.name,
                systemPrompt: p.systemPrompt,
                allowExecution: p.allowExecution || false
            });

            return {
                pre: (plan.preAnswer || plan.preCode).map(mapToParticipant),
                post: (plan.postAnswer || plan.postCode).map(mapToParticipant)
            };

        } catch (error) {
            console.error("Dynamic Herd Planning Failed:", error);
            return null;
        }
    }

    public async run(
        userPrompt: string,
        brainstormingParticipants: HerdParticipant[],
        refinementParticipants: HerdParticipant[],
        rounds: number,
        leaderModel: string,
        contextText: string,
        onStatusUpdate: (status: string) => void,
        onUpdateMessage: (content: string) => Promise<void>,
        signal: AbortSignal,
        chatHistory: ChatMessage[] = []
    ): Promise<string> {
        
        let debateHistory = "";
        let uiOutput = `### 🐂 Herd Mode Active\n\n`;
        
        const appendToUI = async (text: string) => {
            uiOutput += text;
            await onUpdateMessage(uiOutput);
        };

        // --- PHASE 1: RESEARCH & BRAINSTORMING ---
        debateHistory += `## User Request\n${userPrompt}\n\n`;
        await appendToUI(`#### Phase 1: Brainstorming (Pre-Answer)\n\n`);

        for (let round = 1; round <= rounds; round++) {
            if (signal.aborted) break;
            
            let allReady = true;
            let roundLogHtml = ""; 

            for (const participant of brainstormingParticipants) {
                if (signal.aborted) break;
                
                const { model, personality: personalityId } = participant;
                
                let personaName = participant.name || personalityId;
                let personaPrompt = participant.systemPrompt;

                if (!personaPrompt) {
                    const persona = this.personalityManager.getPersonality(personalityId);
                    personaName = persona ? persona.name : personalityId;
                    personaPrompt = persona ? persona.systemPrompt : "You are an expert AI assistant.";
                }

                onStatusUpdate(`Phase 1 (Round ${round}): ${personaName} thinking...`);

                let executionContext = "";
                if (participant.allowExecution) {
                    executionContext = `\n\n**OPTIONAL EXECUTION:**\nYou can verify hypotheses by executing code in the environment. 
To execute a command, output it within \`<execute>command</execute>\` tags. 
The system will run the command and provide you with the output, then you can refine your response.
Suppress potential threats; do not run commands that could damage the environment.`;
                }

                const buildPrompt = (extra?: string) => `${personaPrompt}${executionContext}${extra ? '\n\n' + extra : ''}

You are a participating expert in a Brainstorming session.
The user wants to achieve: "${userPrompt}".

**YOUR TASK:**
1. Analyze the request, context, and ideas from other agents (Debate History).
2. Challenge weak points or suggest improvements.
3. Bring your specific expertise (${personaName}) to the table.
4. If you believe the current direction is solid and you have nothing to add, output \`<ready/>\`.

**DEBATE HISTORY:**
${debateHistory || "(No history yet)"}

**PROJECT CONTEXT:**
${contextText}
`;

                try {
                    let response = await this.lollmsAPI.sendChat([
                        { role: 'system', content: buildPrompt() }
                    ], null, signal, model);

                    if (signal.aborted) break;

                    // --- EXECUTION LOOP ---
                    if (participant.allowExecution && response.includes('<execute>')) {
                        const execMatch = response.match(/<execute>([\s\S]*?)<\/execute>/);
                        if (execMatch && this.agentManager) {
                            const command = execMatch[1].trim();
                            onStatusUpdate(`${personaName} executing: ${command}...`);
                            
                            const result = await this.agentManager.runCommand(command, signal);
                            const resultText = `\n\n[EXECUTION RESULT]\nCommand: ${command}\nOutput:\n${result.output}`;
                            
                            // Re-prompt with result
                            response = await this.lollmsAPI.sendChat([
                                { role: 'system', content: buildPrompt(`You executed a command and got this result: ${resultText}. Now provide your final contribution for this round based on this verification.`) }
                            ], null, signal, model);
                        }
                    }

                    const isReady = response.includes('<ready/>');
                    if (!isReady) allReady = false;

                    const cleanResponse = response.replace('<ready/>', '').trim();
                    if (cleanResponse) {
                        const entry = `#### [${personaName}] (Round ${round})\n${cleanResponse}\n\n`;
                        debateHistory += entry;
                        roundLogHtml += `\n\n---\n\n##### 🧠 ${personaName} (${model})\n\n${cleanResponse}`;
                    } else if (isReady) {
                        roundLogHtml += `\n\n---\n\n✅ **${personaName}** is ready.`;
                    }

                } catch (error: any) {
                    roundLogHtml += `\n\n---\n\n❌ Error with ${personaName}: ${error.message}`;
                }
            }

            if (roundLogHtml) {
                await appendToUI(`
<details>
<summary>Round ${round} (Analysis)</summary>

${roundLogHtml}

</details>
`);
            }

            if (allReady && round > 1) {
                await appendToUI(`\n*Consensus reached in Round ${round}.*\n`);
                break;
            }
        }

        // --- PHASE 2: DRAFTING (LEADER) ---
        if (signal.aborted) return debateHistory;
        
        onStatusUpdate("Phase 2: Leader drafting solution...");
        await appendToUI(`\n#### Phase 2: Leader Synthesis\n`);

        let draftSolution = "";
        
        const leaderSystemPrompt = `You are the Leader Agent.
Your team has finished brainstorming. Synthesize their ideas and create a concrete Draft Response.

**USER OBJECTIVE:** ${userPrompt}

**BRAINSTORMING TRANSCRIPT:**
${debateHistory}

**PROJECT CONTEXT:**
${contextText}
`;

        try {
            draftSolution = await this.lollmsAPI.sendChat([
                { role: 'system', content: leaderSystemPrompt }
            ], null, signal, leaderModel);

            await appendToUI(`
<details open>
<summary>📝 Draft Solution</summary>

${draftSolution}

</details>
`);

        } catch (error: any) {
            await appendToUI(`\n❌ Leader failed to draft: ${error.message}`);
            return debateHistory;
        }

        // --- PHASE 3: REFINEMENT (POST-ANSWER) ---
        if (signal.aborted) return debateHistory;
        
        await appendToUI(`\n#### Phase 3: Critique & Refinement (Post-Answer)\n`);

        let reviewHistory = "";

        for (let round = 1; round <= rounds; round++) {
            if (signal.aborted) break;
            
            let allReady = true;
            let roundLogHtml = "";

            for (const participant of refinementParticipants) {
                if (signal.aborted) break;
                
                const { model, personality: personalityId } = participant;
                
                let personaName = participant.name || personalityId;
                let personaPrompt = participant.systemPrompt;

                if (!personaPrompt) {
                    const persona = this.personalityManager.getPersonality(personalityId);
                    personaName = persona ? persona.name : personalityId;
                    personaPrompt = persona ? persona.systemPrompt : "You are a code reviewer.";
                }

                onStatusUpdate(`Phase 3 (Round ${round}): ${personaName} reviewing...`);

                const systemPrompt = `${personaPrompt}

You are a Reviewer in a Refinement session.
The Leader has produced a Draft Solution.

**DRAFT SOLUTION:**
${draftSolution}

**REVIEW HISTORY:**
${reviewHistory || "(None)"}

**YOUR TASK:**
1. Critique the draft for accuracy, quality, and completeness.
2. If the draft looks perfect, output \`<ready/>\`.
`;

                try {
                    const response = await this.lollmsAPI.sendChat([
                        { role: 'system', content: systemPrompt }
                    ], null, signal, model);

                    if (signal.aborted) break;

                    const isReady = response.includes('<ready/>');
                    if (!isReady) allReady = false;

                    const cleanResponse = response.replace('<ready/>', '').trim();
                    
                    if (cleanResponse) {
                        const entry = `#### [${personaName}] Critique (Round ${round})\n${cleanResponse}\n\n`;
                        reviewHistory += entry;
                        roundLogHtml += `\n\n---\n\n##### 🛡️ ${personaName}\n\n${cleanResponse}`;
                    } else if (isReady) {
                        roundLogHtml += `\n\n---\n\n✅ **${personaName}** approves the draft.`;
                    }

                } catch (error: any) {
                    roundLogHtml += `\n\n---\n\n❌ Reviewer error: ${error.message}`;
                }
            }

            if (roundLogHtml) {
                await appendToUI(`
<details>
<summary>Round ${round} (Critique)</summary>

${roundLogHtml}

</details>
`);
            }

            if (allReady) {
                await appendToUI(`\n*Draft approved in Round ${round}.*\n`);
                break;
            }
        }

        // --- PHASE 4: FINAL ANSWER ---
        return `**HERD PROCESS COMPLETE**

**Phase 1 (Brainstorming Ideas):**
${debateHistory}

**Phase 2 (Draft Solution):**
${draftSolution}

**Phase 3 (Critiques & Reviews):**
${reviewHistory}

**FINAL INSTRUCTION FOR LEADER:**
Synthesize everything above. Produce the **Final Answer** addressing all critiques.
Use the standard file creation formats if code is required.`;
    }

    private formatChatHistory(history: ChatMessage[]): string {
        if (!Array.isArray(history)) return "";
        return history.map(m => {
            let content = m.content;
            if (Array.isArray(content)) {
                content = content.map(c => c.type === 'text' ? c.text : '[Image]').join('\n');
            }
            return `**${m.role.toUpperCase()}:** ${content}`;
        }).join('\n\n');
    }
}
