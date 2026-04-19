import * as vscode from 'vscode';
import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const captureDesktopTool: ToolDefinition = {
    name: "capture_desktop",
    description: "Captures a screenshot of the current primary monitor. Useful for verifying GUI application states.",
    isAgentic: true,
    isDefault: true,
    parameters: [
        { name: "label", type: "string", description: "A label for this screenshot (e.g., 'after_launch').", required: false }
    ],
    async execute(params: { label?: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        const timestamp = Date.now();
        const filename = `.lollms/screenshot_\${params.label || timestamp}.png`;
        
        const pythonCode = `
try:
    import pyautogui
    import os
    os.makedirs(".lollms", exist_ok=True)
    pyautogui.screenshot("${filename}")
    print("SCREENSHOT_OK")
except ImportError:
    print("ERROR: pyautogui not installed. Run 'pip install pyautogui pillow'")
except Exception as e:
    print(f"ERROR: {e}")
        `.trim();

        const result = await env.agentManager!.runCommand(`python -c '${pythonCode.replace(/'/g, "'\\''")}'`, signal);
        
        if (result.output.includes("SCREENSHOT_OK")) {
            return { 
                success: true, 
                output: `Desktop captured successfully to \`${filename}\`.\\n\\n<generateImage prompt="Current screen state" path="${filename}" />` 
            };
        }
        return { success: false, output: "Failed to capture screen: " + result.output };
    }
};