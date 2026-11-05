import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const testWebPageTool: ToolDefinition = {
    name: "test_web_page",
    description: "Navigates to a web page or local server, captures full-page text, console diagnostics, and takes a visual screenshot injected directly into your vision stream.",
    isAgentic: true,
    isDefault: true,
    permissionGroup: 'internet_access',
    parameters: [
        { name: "url", type: "string", description: "The URL to test (e.g., 'http://localhost:3000', 'http://127.0.0.1:8000').", required: true },
        { name: "wait_for", type: "string", description: "Optional CSS selector to wait for before taking the screenshot.", required: false }
    ],
    async execute(params: { url: string, wait_for?: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
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
        const scriptUri = vscode.Uri.joinPath(scriptsDir, `web_page_${timestamp}.py`);
        const screenshotUri = vscode.Uri.joinPath(capturesDir, `page_${timestamp}.png`);
        const resultJsonUri = vscode.Uri.joinPath(scriptsDir, `result_page_${timestamp}.json`);

        const pythonScript = `import asyncio
import json
import os

async def main():
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        print(json.dumps({
            "success": False,
            "error": "PLAYWRIGHT_MISSING",
            "message": "Playwright is not installed. Run: pip install playwright && playwright install chromium"
        }))
        return

    result = {
        "success": False,
        "title": "",
        "url": "",
        "console_errors": [],
        "network_errors": [],
        "page_text": "",
        "screenshot_path": ""
    }

    target_url = ${JSON.stringify(params.url)}
    wait_selector = ${JSON.stringify(params.wait_for || "")}
    screenshot_file = ${JSON.stringify(screenshotUri.fsPath)}

    async with async_playwright() as p:
        browser = None
        try:
            browser = await p.chromium.launch(headless=True)
            page = await browser.new_page(viewport={"width": 1280, "height": 720})

            page.on("console", lambda msg: (
                result["console_errors"].append(f"[{msg.type.upper()}] {msg.text}")
                if msg.type in ["error", "warning"] else None
            ))
            page.on("pageerror", lambda err: result["console_errors"].append(f"[PAGE_ERROR] {str(err)}"))

            page.on("requestfailed", lambda req: result["network_errors"].append(f"[FAILED_REQUEST] {req.method} {req.url}"))
            page.on("response", lambda resp: (
                result["network_errors"].append(f"[HTTP {resp.status}] {resp.url}")
                if resp.status >= 400 else None
            ))

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

            try:
                body_text = await page.evaluate("() => document.body.innerText || ''")
                result["page_text"] = body_text[:2000].strip()
            except Exception:
                result["page_text"] = ""

            os.makedirs(os.path.dirname(screenshot_file), exist_ok=True)
            await page.screenshot(path=screenshot_file)
            result["screenshot_path"] = screenshot_file
            result["success"] = True
        except Exception as e:
            result["success"] = False
            result["error"] = str(e)
        finally:
            if browser:
                await browser.close()

    with open(${JSON.stringify(resultJsonUri.fsPath)}, "w", encoding="utf-8") as rf:
        json.dump(result, rf, ensure_ascii=False, indent=2)

if __name__ == "__main__":
    asyncio.run(main())
`;

        try {
            await fs.writeFile(scriptUri.fsPath, pythonScript, 'utf8');
            const relativeScriptPath = path.join('.lollms', 'scripts', `web_page_${timestamp}.py`).replace(/\\/g, '/');

            const execRes = await env.agentManager.runCommand(`python "${relativeScriptPath}"`, signal, { timeoutMs: 40000 });

            let testData: any = null;
            try {
                const jsonContent = await fs.readFile(resultJsonUri.fsPath, 'utf8');
                testData = JSON.parse(jsonContent);
            } catch {
                return {
                    success: false,
                    output: `Failed to inspect web page. Ensure playwright is installed: \`pip install playwright && playwright install chromium\`\n${execRes.output}`
                };
            }

            if (!testData.success && testData.error === "PLAYWRIGHT_MISSING") {
                return {
                    success: false,
                    output: "Playwright is not installed. Run: `pip install playwright && playwright install chromium`"
                };
            }

            // Inject screenshot into vision stream
            if (testData.screenshot_path) {
                try {
                    const imgBytes = await fs.readFile(testData.screenshot_path);
                    const b64 = Buffer.from(imgBytes).toString('base64');
                    await env.agentManager.ui.addMessageToDiscussion({
                        role: 'user',
                        content: [
                            { type: 'text', text: `📸 **Web Page View: ${params.url}**\nTitle: "${testData.title || ''}"` },
                            { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } }
                        ],
                        skipInPrompt: false
                    });
                } catch {}
            }

            const errBlock = (testData.console_errors && testData.console_errors.length > 0)
                ? `\n### 🛑 Console Errors:\n` + testData.console_errors.map((e: string) => `- ${e}`).join('\n')
                : '';

            const netBlock = (testData.network_errors && testData.network_errors.length > 0)
                ? `\n### ⚠️ Network Failures:\n` + testData.network_errors.map((e: string) => `- ${e}`).join('\n')
                : '';

            const summary = `### 🌐 Web Page Test: ${params.url}
- **Title**: "${testData.title || 'Untitled'}"
- **Status**: ${testData.success ? '✅ LOADED' : '❌ FAILED'}
- **Visual Capture**: Injected into your vision context.${errBlock}${netBlock}
### 📄 Visible Page Text:
\`\`\`
${testData.page_text || '(Empty)'}
\`\`\``;

            return {
                success: testData.success && (!testData.console_errors || testData.console_errors.length === 0),
                output: summary
            };

        } catch (err: any) {
            return { success: false, output: `Web page testing failed: ${err.message}` };
        } finally {
            try { await fs.unlink(scriptUri.fsPath); } catch {}
            try { await fs.unlink(resultJsonUri.fsPath); } catch {}
        }
    }
};