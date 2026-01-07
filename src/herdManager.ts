import * as vscode from 'vscode';
import { LollmsAPI, ChatMessage } from './lollmsAPI';
import { ContextManager } from './contextManager';
import { PersonalityManager } from './personalityManager';
import { HerdParticipant } from './utils';

export class HerdManager {
    constructor(
        private lollmsAPI: LollmsAPI,
        private contextManager: ContextManager,
        private personalityManager: PersonalityManager
    ) {}

    public async run(
        userPrompt: string,
        participants: HerdParticipant[],
        rounds: number,
        leaderModel: string,
        contextText: string,
        onStatusUpdate: (status: string) => void,
        onMessage: (message: ChatMessage) => Promise<void>,
        onLog: (text: string) => void, // NEW callback for non-persisted logs
        signal: AbortSignal
    ): Promise<string> {
        let debateHistory = "";
        
        // Initial Problem Statement
        debateHistory += `## User Problem\n${userPrompt}\n\n`;

        const participantNames = participants.map(p => `${p.model} (${p.personality})`).join(', ');

        // Create a header message for the Herd Session
        // This one can remain visible in history if desired, or skip. Let's show it as a marker.
        await onMessage({
            role: 'system',
            content: `### 🐂 Herd Mode Activated
**Participants:** ${participantNames}
**Rounds:** ${rounds}
**Leader:** ${leaderModel}
`,
            skipInPrompt: true // Keep history clean for the LLM
        });

        for (let round = 1; round <= rounds; round++) {
            if (signal.aborted) break;
            
            onStatusUpdate(`Herd: Round ${round}/${rounds}`);
            onLog(`🔄 **Round ${round} Begins**`);
            
            for (const participant of participants) {
                if (signal.aborted) break;

                const model = participant.model;
                const personalityId = participant.personality;
                const persona = this.personalityManager.getPersonality(personalityId);
                const personaPrompt = persona ? persona.systemPrompt : "You are an expert AI assistant.";
                const personalityName = persona ? persona.name : personalityId;

                const statusText = `Herd: Round ${round} - ${personalityName} (${model}) thinking...`;
                onStatusUpdate(statusText);
                onLog(`⏳ **${personalityName}** (${model}) is thinking...`);
                
                const systemPrompt = `${personaPrompt}

You are a participating expert in a brainstorming session (Herd Mode).
Your goal is to provide ideas, solutions, or critiques regarding the user's problem based on your specific expertise (Persona: ${personalityName}).
Do NOT write the final implementation code yet unless specifically necessary to demonstrate a point. Focus on conceptual design, potential pitfalls, and architectural suggestions.
Review the history of the debate so far and build upon or challenge previous ideas.

Current Round: ${round} of ${rounds}.
`;

                const debateContext = `**Project Context:**\n${contextText}\n\n**Debate History:**\n${debateHistory}\n\n**User Prompt:**\n${userPrompt}`;
                
                try {
                    const response = await this.lollmsAPI.sendChat([
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: debateContext }
                    ], null, signal, model);

                    if (signal.aborted) break;

                    const contribution = `### [Round ${round}] ${personalityName} (${model})\n${response}\n\n`;
                    debateHistory += contribution;

                    // Stream contribution to chat as a COLLAPSED system message that is skipped in future prompts
                    await onMessage({
                        role: 'system',
                        content: `<details>
<summary><strong>Round ${round}:</strong> ${personalityName} (${model})</summary>
\n${response}\n
</details>`,
                        skipInPrompt: true
                    });

                } catch (error: any) {
                    if (signal.aborted) break;
                    await onMessage({
                        role: 'system',
                        content: `⚠️ **${personalityName} (${model}) failed to contribute:** ${error.message}`,
                        skipInPrompt: true
                    });
                }
            }
        }

        return debateHistory;
    }
}
