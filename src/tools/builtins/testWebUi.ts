import * as vscode from 'vscode';
import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const testWebUiTool: ToolDefinition = {
    name: "test_web_ui",
    description: "Launches a web-based UI (FastAPI, React, HTML) and captures its state. It can perform actions like clicking buttons or typing text before taking a screenshot for visual verification.",
    isAgentic: true,
    isDefault: true,
    permissionGroup: 'internet_access',
    parameters: [
        { name: "url", type: "string", description: "The URL to test (e.g., http://localhost:8000).", required: true },
        { name: "actions", type: "array", description: "Optional list of steps: [{'type': 'click', 'selector': '#btn'}, {'type': 'type', 'selector': 'input', 'text': 'val'}].", required: false },
        { name: "wait_for_selector", type: "string", description: "Wait for this element to appear before capturing.", required: false },
        { name: "capture_visual", type: "boolean", description: "Set to true only if you need to SEE the result to verify a complex layout. Default is false to save tokens.", required: false }
        ],
        async execute(params: { url: string, actions?: any[], wait_for_selector?: string, capture_visual?: boolean }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        const actionsJson = JSON.stringify(params.actions || []);
        const capture = params.capture_visual ? "True" : "False";
        const pythonCode = `
        import asyncio
        from playwright.async_api import async_playwright
        import json, os

        async def run():
        async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()
        try:
            await page.goto("${params.url}")
            if "${params.wait_for_selector || ''}":
                await page.wait_for_selector("${params.wait_for_selector}", timeout=5000)

            actions = json.loads('${actionsJson}')
            for action in actions:
                if action['type'] == 'click': await page.click(action['selector'])
                elif action['type'] == 'type': await page.fill(action['selector'], action['text'])

            title = await page.title()
            print(f"WEB_UI_TITLE: {title}")

            if ${capture}:
                os.makedirs(".lollms/ui_tests", exist_ok=True)
                path = ".lollms/ui_tests/web_capture.png"
                await page.screenshot(path=path)
                print(f"WEB_UI_IMAGE_PATH: {path}")
            print("WEB_UI_OK")
        except Exception as e:
            print(f"WEB_UI_ERROR: {e}")
        finally:
            await browser.close()

        asyncio.run(run())
        `.trim();

        const result = await env.agentManager!.runCommand(`python -c "${pythonCode.replace(/"/g, '\\"')}"`, signal);
        if (result.output.includes("WEB_UI_OK")) {
            let output = `Web UI responding. Title: "${result.output.split('WEB_UI_TITLE: ')[1]?.split('\\n')[0]}"`;
            if (result.output.includes("WEB_UI_IMAGE_PATH")) {
                const path = result.output.split("WEB_UI_IMAGE_PATH: ")[1].split('\\n')[0].trim();
                output += ` <image_result path="${path}" />`;
            }
            return { success: true, output };
        }
        return { success: false, output: "Web testing failed. Ensure 'playwright' is installed.\n" + result.output };
    }
};