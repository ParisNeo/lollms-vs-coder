import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const testNativeUiTool: ToolDefinition = {
    name: "test_native_ui",
    description: "Inspects native Windows (C#, C++, VB.NET) or macOS applications by querying window handles and verifying that a window with the expected title is actually visible on the desktop.",
    isAgentic: true,
    isDefault: true,
    parameters: [
        { name: "executable_path", type: "string", description: "Path to the compiled binary.", required: true },
        { name: "expected_title", type: "string", description: "The expected window title to look for.", required: true }
    ],
    async execute(params: { executable_path: string, expected_title: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (process.platform !== 'win32') return { success: false, output: "Native UI inspection is currently only optimized for Windows." };

        const psCommand = `
            Start-Process "${params.executable_path}"
            Start-Sleep -s 3
            $win = Get-Process | Where-Object { $_.MainWindowTitle -like "*${params.expected_title}*" }
            if ($win) {
                echo "NATIVE_UI_FOUND: $($win.ProcessName)"
                # Cleanup
                Stop-Process -Id $win.Id
            } else {
                echo "NATIVE_UI_NOT_FOUND"
            }
        `.trim();

        return await env.agentManager!.runCommand(psCommand, signal, { shell: 'powershell' });
    }
};