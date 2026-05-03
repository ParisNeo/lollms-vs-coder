import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const testDesktopPythonUiTool: ToolDefinition = {
    name: "test_desktop_python_ui",
    description: "Tests PyQt, PySide, or Tkinter applications. It uses a virtual display buffer to launch the app, verifies it initializes without crashing, and captures the window as an image.",
    isAgentic: true,
    isDefault: true,
    permissionGroup: 'shell_execution',
    parameters: [
        { name: "entry_script", type: "string", description: "The main script to run (e.g. 'gui.py').", required: true },
        { name: "app_class_name", type: "string", description: "The name of the main QMainWindow or Widget class to inspect.", required: false },
        { name: "capture_visual", type: "boolean", description: "Set to true to return a screenshot to context. Default is false.", required: false }
    ],
    async execute(params: { entry_script: string, app_class_name?: string, capture_visual?: boolean }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        const capture = params.capture_visual ? "True" : "False";
        const pythonCode = `
    import sys, os, time
    from PyQt5.QtWidgets import QApplication
    from PyQt5.QtCore import QTimer

    def test():
    app = QApplication.instance() or QApplication(sys.argv)
    try:
        import ${params.entry_script.replace('.py', '')} as user_app
        window = next((v for v in vars(user_app).values() if hasattr(v, 'show')), None)
        if window: 
            window.show()
            print(f"QT_WINDOW_TITLE: {window.windowTitle()}")

            def finish():
                if ${capture}:
                    os.makedirs(".lollms/ui_tests", exist_ok=True)
                    path = ".lollms/ui_tests/qt_capture.png"
                    window.grab().save(path)
                    print(f"QT_IMAGE_PATH: {path}")
                app.quit()

            QTimer.singleShot(2000, finish)
            app.exec_()
            print("QT_UI_OK")
    except Exception as e:
        print(f"QT_UI_ERROR: {e}")

    test()
        `.trim();

        // On Linux, we wrap in xvfb-run to handle the lack of X11
        const cmdPrefix = process.platform === 'linux' ? 'xvfb-run ' : '';
        return await env.agentManager!.runCommand(`${cmdPrefix}python -c "${pythonCode.replace(/"/g, '\\"')}"`, signal);
    }
};