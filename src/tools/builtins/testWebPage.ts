import * as vscode from 'vscode';
import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const testWebPageTool: ToolDefinition = {
    name: "test_web_page",
    description: "Navigates to a web page (or local server), takes a screenshot, and extracts the visible text. Requires 'playwright' installed in the python environment.",
    isAgentic: true,
    isDefault: true,
    permissionGroup: 'internet_access',
    parameters: [
        { name: "url", type: "string", description: "The URL to test (e.g., http://localhost:3000).", required: true },
        { name: "wait_for", type: "string", description: "Optional CSS selector to wait for before taking the screenshot.", required: false }
    ],
    async execute(params: { url: string, wait_for?: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        const isAllowed = config.get<boolean>('agent.permissions.webTesting') || false;

        if (!isAllowed) {
            return { 
                success: false, 
                output: "🛑 **Permission Denied:** Web Testing (headless browser) is disabled. Please enable 'Web Testing' in Lollms Agent Permissions settings." 
            };
        }

        const pythonCode = `
import asyncio
from playwright.async_api import async_playwright
import base64
import os

async def run():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page(viewport={'width': 1280, 'height': 720})
        try:
            await page.goto("${params.url}")
            if "${params.wait_for || ''}":
                await page.wait_for_selector("${params.wait_for}")
            else:
                await page.wait_for_load_state("networkidle")
            
            # Extract text
            text = await page.evaluate("document.body.innerText")
            
            # Take screenshot
            os.makedirs(".lollms", exist_ok=True)
            screenshot_path = ".lollms/last_web_test.png"
            await page.screenshot(path=screenshot_path)
            
            print(f"WEB_TEST_SUCCESS")
            print(f"URL: {params.url}")
            print(f"CONTENT_START\\n{text[:2000]}\\nCONTENT_END")
        except Exception as e:
            print(f"WEB_TEST_ERROR: {e}")
        finally:
            await browser.close()

asyncio.run(run())
        `.trim();

        const result = await env.agentManager!.runCommand(`python -c '${pythonCode.replace(/'/g, "'\\''")}'`, signal);
        
        if (result.success && result.output.includes("WEB_TEST_SUCCESS")) {
            // Propose showing the image in UI
            const msg = `**Web Test Results for ${params.url}**\\n\\nVisual captured to \`.lollms/last_web_test.png\`.\\n\\n<generateImage prompt="Visual of the tested web page" path=".lollms/last_web_test.png" />\\n\\n**Page Text Content:**\\n\${result.output.split('CONTENT_START')[1].split('CONTENT_END')[0]}`;
            return { success: true, output: msg };
        }
        
        return { success: false, output: "Failed to test web page. Ensure 'playwright' is installed: \`pip install playwright && playwright install chromium\`\\n\\nError: " + result.output };
    }
};