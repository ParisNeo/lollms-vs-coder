import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const getEnvironmentDetailsTool: ToolDefinition = {
    name: "get_environment_details",
    description: "Gets versions of common development tools (Python, Node, npm, Git).",
    isAgentic: false,
    isDefault: true,
    parameters: [],
    async execute(params: {}, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        const commands = {
            python: 'python --version',
            node: 'node --version',
            npm: 'npm --version',
            git: 'git --version'
        };
        let detailsOutput = 'Environment Details:\n';
        const promises = Object.entries(commands).map(async ([tool, command]) => {
            if (signal.aborted) return `- ${tool}: Cancelled`;
            const result = await env.agentManager.runCommand(command, signal);
            if (signal.aborted) return `- ${tool}: Cancelled`;
            
            const output = result.output.replace(/STDOUT:|STDERR:/g, '').trim();
            if (result.success && output) {
                return `- ${tool}: ${output.split('\n')[0]}`; // Take first line
            } else {
                return `- ${tool}: Not found or error`;
            }
        });

        const results = await Promise.all(promises);
        detailsOutput += results.join('\n');
        return { success: true, output: detailsOutput };
    }
};
