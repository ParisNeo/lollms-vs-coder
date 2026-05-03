import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const requestFormInputTool: ToolDefinition = {
    name: "request_form_input",
    description: "Prompts the user with a structured interactive form (Radios, Checkboxes, Sliders, Text). Use this for design decisions, selecting between generated options, or configuring game mechanics.",
    isAgentic: true,
    isDefault: true,
    parameters: [
        { name: "title", type: "string", description: "The title of the form (e.g., 'Select Sprite Style').", required: true },
        { name: "description", type: "string", description: "Brief instructions for the user.", required: true },
        { name: "fields", type: "array", description: "Array of field objects: {name, type: 'radio'|'checkbox'|'select'|'slider'|'text'|'textarea', label, options: ['A','B'], min, max, default}.", required: true },
        { name: "submit_label", type: "string", description: "The text on the submit button.", required: false }
    ],
    async execute(params: { title: string, description: string, fields: any[], submit_label?: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!env.agentManager) return { success: false, output: "Agent Manager not found." };

        // 1. Construct the <lollms_form> XML string
        let formXml = `<lollms_form id="form_${Date.now()}" title="${params.title.replace(/"/g, '&quot;')}" description="${params.description.replace(/"/g, '&quot;')}">\n`;
        
        params.fields.forEach(f => {
            const label = f.label.replace(/"/g, '&quot;');
            const name = f.name;
            const def = f.default !== undefined ? `value="${f.default}"` : "";
            
            if (f.type === 'radio' || f.type === 'select' || f.type === 'checkbox_group') {
                const options = f.options.join(',');
                formXml += `  <input type="${f.type}" name="${name}" label="${label}" options="${options}" ${def} />\n`;
            } else if (f.type === 'slider' || f.type === 'number' || f.type === 'range') {
                formXml += `  <input type="range" name="${name}" label="${label}" min="${f.min || 0}" max="${f.max || 100}" ${def} />\n`;
            } else {
                formXml += `  <input type="${f.type}" name="${name}" label="${label}" ${def} />\n`;
            }
        });

        const btnLabel = params.submit_label || "Confirm Selection";
        formXml += `  <submit label="${btnLabel}" />\n`;
        formXml += `</lollms_form>`;

        // 2. Trigger the UI request
        try {
            // We use the 'isAgentZone' option to ensure it renders inside the plan task in the sidebar
            const response = await env.agentManager.ui.requestUserInput(formXml, signal, { isAgentZone: true });
            
            if (response.startsWith('FORM_SUBMISSION:')) {
                const data = response.substring(16);
                return { success: true, output: `USER_DECISION: ${data}` };
            }
            
            return { success: true, output: `USER_RESPONSE: ${response}` };
        } catch (e: any) {
            return { success: false, output: `Form interaction failed: ${e.message}` };
        }
    }
};