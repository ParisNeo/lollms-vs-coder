import { ToolDefinition, ToolExecutionEnv } from '../tool';
import * as path from 'path';
import * as fs from 'fs/promises';

export const uiInteractionTool: ToolDefinition = {
    name: "execute_ui_interaction",
    description: "Executes a complex UI interaction script. Support for Web (Playwright) and Desktop (PyAutoGUI/PyQt/Pygame). The script must handle its own interaction logic and screenshots.",
    isAgentic: true,
    isDefault: true,
    permissionGroup: 'shell_execution',
    parameters: [
        { name: "engine", type: "string", description: "The engine to use: 'web' (Playwright) or 'desktop' (PyAutoGUI).", required: true },
        { name: "script", type: "string", description: "The Python script containing the interaction logic.", required: true },
        { name: "requirements", type: "array", description: "List of pip packages needed (e.g., ['playwright', 'pyautogui']).", required: false }
    ],
    async execute(params: { engine: string, script: string, requirements?: string[] }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!env.workspaceRoot || !env.agentManager) return { success: false, output: "Workspace context required." };

        const scriptDir = path.join(env.workspaceRoot.uri.fsPath, ".lollms", "ui_tests");
        await fs.mkdir(scriptDir, { recursive: true });
        
        const scriptPath = path.join(scriptDir, `test_${Date.now()}.py`);
        
        // --- MULTI-ENGINE WRAPPER ---
        let wrappedScript = "";
        if (params.engine === 'web') {
            wrappedScript = `
import asyncio
from playwright.async_api import async_playwright
import os

async def run():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context()
        page = await context.new_page()
        try:
${params.script.split('\n').map(l => '            ' + l).join('\n')}
            await page.screenshot(path=".lollms/last_ui_frame.png")
            print("UI_TEST_FINISHED")
        except Exception as e:
            print(f"UI_TEST_ERROR: {e}")
            await page.screenshot(path=".lollms/error_frame.png")
        finally:
            await browser.close()

asyncio.run(run())
`;
        } else {
            wrappedScript = `
import pyautogui
import os
import time
import subprocess

# Desktop Engine setup
pyautogui.FAILSAFE = True
os.makedirs(".lollms", exist_ok=True)

try:
    # Interaction logic provided by agent
${params.script.split('\n').map(l => '    ' + l).join('\n')}
    pyautogui.screenshot(".lollms/last_ui_frame.png")
    print("UI_TEST_FINISHED")
except Exception as e:
    print(f"UI_TEST_ERROR: {e}")
    pyautogui.screenshot(".lollms/error_frame.png")
`;
        }

        await fs.writeFile(scriptPath, wrappedScript);

        // 1. Install Requirements if needed
        if (params.requirements?.length) {
            env.agentManager.ui.addMessageToDiscussion({ role: 'system', content: `🛠️ **Equipping UI Engine**: Installing ${params.requirements.join(', ')}...` });
            await env.agentManager.runCommand(`pip install ${params.requirements.join(' ')}`, signal);
        }

        // 2. Execute with Virtual Display handling if on Linux
        const isLinux = process.platform === 'linux';
        const cmd = isLinux ? `xvfb-run python "${scriptPath}"` : `python "${scriptPath}"`;
        
        const result = await env.agentManager.runCommand(cmd, signal);
        
        let output = result.output;
        if (result.success) {
            output += `\n\n**Visual Evidence**: <image_result path=".lollms/last_ui_frame.png" />`;
        } else {
            output += `\n\n**Crash State**: <image_result path=".lollms/error_frame.png" />`;
        }

        return { success: result.success, output };
    }
};