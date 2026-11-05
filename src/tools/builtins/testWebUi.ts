import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const testWebUiTool: ToolDefinition = {
    name: "test_web_ui",
    description: "Launches and interacts with a web-based UI (React, Vue, FastAPI, Flask, HTML, etc.). Executes user actions (click, fill, press, hover, scroll, wait), captures console errors, network failures, DOM text, and takes visual screenshots fed directly into the agent's vision stream.",
    isAgentic: true,
    isDefault: true,
    permissionGroup: 'internet_access',
    parameters: [
        { name: "url", type: "string", description: "The URL to navigate to (e.g. 'http://localhost:3000', 'http://127.0.0.1:8000').", required: true },
        { 
            name: "actions", 
            type: "array", 
            description: "Optional list of sequential browser interactions. Examples: [{'type': 'click', 'selector': '#submit-btn'}, {'type': 'fill', 'selector': 'input[name=username]', 'text': 'admin'}, {'type': 'press', 'selector': 'input', 'key': 'Enter'}, {'type': 'hover', 'selector': '.menu'}, {'type': 'wait', 'ms': 1000}, {'type': 'scroll', 'y': 500}].", 
            required: false 
        },
        { name: "wait_for_selector", type: "string", description: "Optional CSS selector to wait for before executing actions or taking screenshot.", required: false },
        { name: "capture_visual", type: "boolean", description: "Whether to take a screenshot and feed it into vision context. Default is true so you can inspect the visual render.", required: false },
        { name: "viewport_width", type: "number", description: "Optional browser viewport width in pixels (default 1280).", required: false },
        { name: "viewport_height", type: "number", description: "Optional browser viewport height in pixels (default 720).", required: false }
    ],
    async execute(
        params: { 
            url: string; 
            actions?: any[]; 
            wait_for_selector?: string; 
            capture_visual?: boolean;
            viewport_width?: number;
            viewport_height?: number;
        }, 
        env: ToolExecutionEnv, 
        signal: AbortSignal
    ): Promise<{ success: boolean; output: string; }> {
        if (!params.url) {
            return { success: false, output: "Error: 'url' parameter is required." };
        }
        if (!env.agentManager) {
            return { success: false, output: "Error: Agent environment not initialized." };
        }

        const workspaceFolder = env.workspaceRoot || vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return { success: false, output: "Error: No active workspace folder." };
        }

        const scriptsDir = vscode.Uri.joinPath(workspaceFolder.uri, '.lollms', 'scripts');
        const capturesDir = vscode.Uri.joinPath(workspaceFolder.uri, '.lollms', 'assets', 'web_captures');
        await vscode.workspace.fs.createDirectory(scriptsDir).then(undefined, () => {});
        await vscode.workspace.fs.createDirectory(capturesDir).then(undefined, () => {});

        const timestamp = Date.now();
        const scriptFileName = `web_test_${timestamp}.py`;
        const scriptUri = vscode.Uri.joinPath(scriptsDir, scriptFileName);
        const screenshotFileName = `capture_${timestamp}.png`;
        const screenshotUri = vscode.Uri.joinPath(capturesDir, screenshotFileName);
        const resultJsonUri = vscode.Uri.joinPath(scriptsDir, `result_${timestamp}.json`);

        const captureVisual = params.capture_visual !== false;
        const width = params.viewport_width || 1280;
        const height = params.viewport_height || 720;
        const actionsJson = JSON.stringify(params.actions || []);

        // Playwright test runner script
        const pythonScript = `import asyncio
import json
import os
import sys

async def main():
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        print(json.dumps({
            "success": False,
            "error": "PLAYWRIGHT_MISSING",
            "message": "Playwright is not installed in the active environment. Please install it with: pip install playwright && playwright install chromium"
        }))
        return

    result = {
        "success": False,
        "title": "",
        "url": "",
        "console_errors": [],
        "console_logs": [],
        "network_errors": [],
        "executed_actions": [],
        "page_text": "",
        "screenshot_path": ""
    }

    target_url = ${JSON.stringify(params.url)}
    wait_selector = ${JSON.stringify(params.wait_for_selector || "")}
    actions = ${actionsJson}
    screenshot_file = ${JSON.stringify(screenshotUri.fsPath)}
    should_capture = ${captureVisual ? "True" : "False"}

    async with async_playwright() as p:
        browser = None
        try:
            browser = await p.chromium.launch(headless=True)
            page = await browser.new_page(viewport={"width": ${width}, "height": ${height}})

            # Capture console logs and errors
            page.on("console", lambda msg: (
                result["console_errors"].append(f"[{msg.type.upper()}] {msg.text}")
                if msg.type in ["error", "warning"]
                else result["console_logs"].append(f"[{msg.type}] {msg.text[:200]}")
            ))
            page.on("pageerror", lambda err: result["console_errors"].append(f"[UNHANDLED_EXCEPTION] {str(err)}"))

            # Capture failed network requests & HTTP errors
            page.on("requestfailed", lambda req: result["network_errors"].append(
                f"[FAILED_REQUEST] {req.method} {req.url} - {req.failure}"
            ))
            page.on("response", lambda resp: (
                result["network_errors"].append(f"[HTTP {resp.status}] {resp.url}")
                if resp.status >= 400
                else None
            ))

            # Navigate
            await page.goto(target_url, wait_until="domcontentloaded", timeout=25000)
            if wait_selector:
                await page.wait_for_selector(wait_selector, timeout=8000)
            else:
                try:
                    await page.wait_for_load_state("networkidle", timeout=4000)
                except Exception:
                    pass

            result["title"] = await page.title()
            result["url"] = page.url

            # Execute sequential actions
            for idx, act in enumerate(actions):
                act_type = act.get("type", "").lower()
                sel = act.get("selector", "")
                try:
                    if act_type == "click":
                        await page.click(sel, timeout=5000)
                        result["executed_actions"].append(f"Step {idx+1}: Clicked '{sel}'")
                    elif act_type in ["fill", "type"]:
                        text_val = act.get("text", "")
                        await page.fill(sel, text_val, timeout=5000)
                        result["executed_actions"].append(f"Step {idx+1}: Filled '{sel}' with '{text_val}'")
                    elif act_type == "press":
                        key_val = act.get("key", "Enter")
                        if sel:
                            await page.press(sel, key_val, timeout=5000)
                        else:
                            await page.keyboard.press(key_val)
                        result["executed_actions"].append(f"Step {idx+1}: Pressed key '{key_val}'")
                    elif act_type == "hover":
                        await page.hover(sel, timeout=5000)
                        result["executed_actions"].append(f"Step {idx+1}: Hovered over '{sel}'")
                    elif act_type == "select":
                        val = act.get("value", "")
                        await page.select_option(sel, val, timeout=5000)
                        result["executed_actions"].append(f"Step {idx+1}: Selected option '{val}' on '{sel}'")
                    elif act_type == "scroll":
                        scroll_y = act.get("y", 400)
                        await page.evaluate(f"window.scrollBy(0, {scroll_y})")
                        result["executed_actions"].append(f"Step {idx+1}: Scrolled by y={scroll_y}")
                    elif act_type in ["wait", "sleep"]:
                        wait_ms = act.get("ms", 1000)
                        await asyncio.sleep(wait_ms / 1000.0)
                        result["executed_actions"].append(f"Step {idx+1}: Waited {wait_ms}ms")
                    elif act_type == "wait_for_selector":
                        await page.wait_for_selector(sel, timeout=8000)
                        result["executed_actions"].append(f"Step {idx+1}: Waited for selector '{sel}'")
                except Exception as act_err:
                    result["executed_actions"].append(f"Step {idx+1} [FAILED]: {act_type} on '{sel}': {str(act_err)}")
                    result["console_errors"].append(f"Action {idx+1} Failed: {str(act_err)}")

            # Extract visible DOM text
            try:
                body_text = await page.evaluate("() => document.body.innerText || ''")
                result["page_text"] = body_text[:2500].strip()
            except Exception:
                result["page_text"] = ""

            # Capture visual screenshot
            if should_capture:
                os.makedirs(os.path.dirname(screenshot_file), exist_ok=True)
                await page.screenshot(path=screenshot_file, full_page=False)
                result["screenshot_path"] = screenshot_file

            result["success"] = True
        except Exception as e:
            result["success"] = False
            result["error"] = str(e)
        finally:
            if browser:
                await browser.close()

    result_file = ${JSON.stringify(resultJsonUri.fsPath)}
    with open(result_file, "w", encoding="utf-8") as rf:
        json.dump(result, rf, ensure_ascii=False, indent=2)

if __name__ == "__main__":
    asyncio.run(main())
`;

        try {
            await fs.writeFile(scriptUri.fsPath, pythonScript, 'utf8');

            const relativeScriptPath = path.join('.lollms', 'scripts', scriptFileName).replace(/\\/g, '/');
            const runCmd = `python "${relativeScriptPath}"`;
            
            env.agentManager.ui.addMessageToDiscussion({
                role: 'system',
                content: `🌐 **Testing Web UI:** Navigating to \`${params.url}\`${params.actions && params.actions.length > 0 ? ` with ${params.actions.length} interaction steps` : ''}...`,
                skipInPrompt: true
            });

            const execRes = await env.agentManager.runCommand(runCmd, signal, { timeoutMs: 45000 });

            // Read parsed result JSON
            let testData: any = null;
            try {
                const jsonContent = await fs.readFile(resultJsonUri.fsPath, 'utf8');
                testData = JSON.parse(jsonContent);
            } catch {
                // If script crashed before creating JSON, inspect stdout
                const stdout = execRes.output || "";
                if (stdout.includes("PLAYWRIGHT_MISSING")) {
                    return {
                        success: false,
                        output: "Playwright is not installed in the Python environment.\nPlease run in terminal: `pip install playwright && playwright install chromium`"
                    };
                }
                return {
                    success: false,
                    output: `Web UI testing execution error:\n${execRes.output}`
                };
            }

            if (!testData.success && testData.error === "PLAYWRIGHT_MISSING") {
                return {
                    success: false,
                    output: "Playwright is not installed.\nPlease install it: `pip install playwright && playwright install chromium`"
                };
            }

            // If visual was captured, read screenshot, convert to base64, and inject into discussion
            let visualNotice = "";
            if (captureVisual && testData.screenshot_path) {
                try {
                    const imgBytes = await fs.readFile(testData.screenshot_path);
                    const b64 = Buffer.from(imgBytes).toString('base64');
                    const dataUri = `data:image/png;base64,${b64}`;

                    await env.agentManager.ui.addMessageToDiscussion({
                        role: 'user',
                        content: [
                            { type: 'text', text: `📸 **Web App Screenshot Captured (${params.url})**\nTitle: "${testData.title || 'Untitled'}"\nConsole Errors: ${testData.console_errors?.length || 0} | Network Errors: ${testData.network_errors?.length || 0}` },
                            { type: 'image_url', image_url: { url: dataUri } }
                        ],
                        skipInPrompt: false
                    });

                    visualNotice = `\n- **Visual Screenshot**: Captured and injected into your vision stream as \`${path.basename(testData.screenshot_path)}\`. You can directly see the rendered layout, buttons, and styles above.`;
                } catch (imgErr) {
                    console.warn("Failed to encode web screenshot:", imgErr);
                }
            }

            // Assemble structured diagnostic report
            const consoleErrors = (testData.console_errors && testData.console_errors.length > 0)
                ? `\n### 🛑 BROWSER CONSOLE ERRORS & WARNINGS (${testData.console_errors.length}):\n` + testData.console_errors.map((e: string) => `- ${e}`).join('\n')
                : `\n### 🟢 BROWSER CONSOLE: No errors detected.`;

            const networkErrors = (testData.network_errors && testData.network_errors.length > 0)
                ? `\n### ⚠️ NETWORK FAILURES & HTTP ERRORS (${testData.network_errors.length}):\n` + testData.network_errors.map((e: string) => `- ${e}`).join('\n')
                : `\n### 🟢 NETWORK: All HTTP requests succeeded.`;

            const actionsExecuted = (testData.executed_actions && testData.executed_actions.length > 0)
                ? `\n### 🖱️ EXECUTED INTERACTION STEPS:\n` + testData.executed_actions.map((a: string) => `- ${a}`).join('\n')
                : "";

            const visibleTextSnippet = testData.page_text
                ? `\n### 📄 VISIBLE PAGE CONTENT:\n\`\`\`\n${testData.page_text}\n\`\`\``
                : "";

            const hasIssues = (testData.console_errors && testData.console_errors.length > 0) ||
                              (testData.network_errors && testData.network_errors.length > 0) ||
                              !testData.success;

            const summary = `### 🌐 WEB UI TEST REPORT: ${params.url}
- **Page Title**: "${testData.title || 'N/A'}"
- **Final URL**: ${testData.url || params.url}
- **Status**: ${testData.success ? (hasIssues ? '⚠️ LOADED WITH ISSUES' : '✅ HEALTHY') : '❌ FAILED'}${visualNotice}
${actionsExecuted}
${consoleErrors}
${networkErrors}
${visibleTextSnippet}`;

            return {
                success: testData.success && !hasIssues,
                output: summary
            };

        } catch (err: any) {
            return {
                success: false,
                output: `Failed to execute web UI test: ${err.message}`
            };
        } finally {
            // Clean up temporary script and result JSON files
            try { await fs.unlink(scriptUri.fsPath); } catch {}
            try { await fs.unlink(resultJsonUri.fsPath); } catch {}
        }
    }
};