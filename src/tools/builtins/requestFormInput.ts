import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const requestFormInputTool: ToolDefinition = {
    name: "delegate_to_user",
    description: "Delegates manual tasks to the human user. Use this to provide a checklist of tasks and a structured form for reporting findings. Highly recommended for environment setup (e.g., 'install this driver', 'open browser at port X') or visual verification.",
    isAgentic: true,
    isDefault: true,
    parameters: [
        { name: "title", type: "string", description: "Clear title for the manual mission (e.g., 'Verify Backend Connection').", required: true },
        { name: "tasks_checklist", type: "array", description: "List of strings describing tasks for the user to do (e.g. ['Open localhost:8000', 'Check if logo is visible']).", required: true },
        { name: "reporting_fields", type: "array", description: "Array of field objects for user feedback: {name, type: 'radio'|'select'|'text'|'textarea', label, options: ['Yes','No']}.", required: true },
        { name: "submit_label", type: "string", description: "Label for the finish button (default: 'Tasks Completed').", required: false }
    ],
    async execute(params: { title: string, tasks_checklist: string[], reporting_fields: any[], submit_label?: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!env.agentManager) return { success: false, output: "Agent Manager not found." };

        // 1. Construct the Header & Checklist
        let formXml = `<lollms_form id="manual_task_${Date.now()}" title="${params.title.replace(/"/g, '&quot;')}" description="Please perform the following steps manually and report the status below:">\n`;

        // Add tasks as un-editable checkboxes for the user to 'check off' as they work
        params.tasks_checklist.forEach((task, idx) => {
            formXml += `  <input type="checkbox" name="task_${idx}" label="${task.replace(/"/g, '&quot;')}" />\n`;
        });

        formXml += `  <input type="section" label="Mission Feedback" />\n`;

        // Add reporting fields
        params.reporting_fields.forEach(f => {
            const label = f.label.replace(/"/g, '&quot;');
            if (f.type === 'radio' || f.type === 'select') {
                const options = f.options.join(',');
                formXml += `  <input type="${f.type}" name="${f.name}" label="${label}" options="${options}" />\n`;
            } else {
                formXml += `  <input type="${f.type}" name="${f.name}" label="${label}" />\n`;
            }
        });

        const btnLabel = params.submit_label || "Mission Finished: Report Back";
        formXml += `  <submit label="${btnLabel}" />\n`;
        formXml += `</lollms_form>`;

        // 2. Trigger the UI request
        if (!env.agentManager || !env.agentManager.ui) {
            return { success: false, output: "UI context missing." };
        }

        try {
            // Ensure the overlay description updates to tell the user a form is waiting
            env.agentManager.ui.updateGeneratingState(); 

            // This blocks the agent loop until the user submits the form in the webview
            const response = await env.agentManager.ui.requestUserInput(formXml, signal, { isAgentZone: true });

            if (response.startsWith('FORM_SUBMISSION:')) {
                const data = response.substring(16);
                return { success: true, output: `USER_DECISION_DATA: ${data}` };
            }

            return { success: true, output: `USER_MANUAL_RESPONSE: ${response}` };
        } catch (e: any) {
            return { success: false, output: `Form interaction failed: ${e.message}` };
        }
    }
};