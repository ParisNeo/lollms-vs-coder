import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const reportPlanStatusTool: ToolDefinition = {
    name: "report_plan_status",
    description: "Outputs a visual summary of the current mission progress into the chat. Use this periodically (every 5-10 steps) or after completing a significant sub-goal to keep the user informed of the plan's state.",
    isAgentic: true,
    isDefault: true,
    parameters: [],
    async execute(params: {}, env: ToolExecutionEnv): Promise<{ success: boolean; output: string; }> {
        if (!env.currentPlan) return { success: false, output: "No active plan found to report on." };

        const plan = env.currentPlan;
        const total = plan.tasks.length;
        const completed = plan.tasks.filter(t => t.status === 'completed').length;
        const percent = Math.round((completed / total) * 100);

        // Generate a structured XML tag that the webview will render as a rich card
        const tasksJson = JSON.stringify(plan.tasks.map(t => ({
            desc: t.description,
            status: t.status
        }))).replace(/"/g, '&quot;');

        const tag = `<plan_status 
            objective="${plan.objective.replace(/"/g, '&quot;')}"
            sub_goal="${plan.current_sub_goal.replace(/"/g, '&quot;')}"
            percent="${percent}"
            completed="${completed}"
            total="${total}"
            tasks="${tasksJson}"
        />`;

        return { success: true, output: tag };
    }
};