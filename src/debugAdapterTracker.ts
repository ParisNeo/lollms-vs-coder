import * as vscode from 'vscode';
import { debugErrorManager } from './extensionState';

export class LollmsDebugAdapterTracker implements vscode.DebugAdapterTracker {
    async onDidSendMessage(message: any) {
        if (message.type === 'event' && message.event === 'stopped' && message.body.reason === 'exception') {
            const session = vscode.debug.activeDebugSession;
            if (session) {
                // Fetch details asynchronously
                this.handleException(session, message.body.threadId);
            }
        }
    }

    private async handleException(session: vscode.DebugSession, threadId: number) {
        try {
            // Try to get exception details
            let message = "Exception occurred";
            try {
                const exceptionInfo = await session.customRequest('exceptionInfo', { threadId });
                message = exceptionInfo.details?.message || exceptionInfo.description || message;
            } catch (e) {
                // exceptionInfo request might not be supported by all debuggers
            }
            
            // Get Stack Trace (top frame) to locate the file/line
            const stackTrace = await session.customRequest('stackTrace', { threadId, startFrame: 0, levels: 1 });
            
            if (stackTrace && stackTrace.stackFrames && stackTrace.stackFrames.length > 0) {
                const topFrame = stackTrace.stackFrames[0];
                const source = topFrame.source;
                
                if (source && source.path) {
                    const uri = vscode.Uri.file(source.path);
                    const line = topFrame.line;
                    
                    // Try to get more stack frames for context
                    let stackString = "";
                    try {
                        const fullStack = await session.customRequest('stackTrace', { threadId, startFrame: 0, levels: 20 });
                        stackString = fullStack.stackFrames.map((f: any) => `${f.name} (${f.source?.path || 'unknown'}:${f.line})`).join('\n');
                    } catch {
                        stackString = "Stack trace unavailable";
                    }
                    
                    debugErrorManager.setError(message, stackString, uri, line);
                }
            }
        } catch (e) {
            console.error("Lollms Debug Tracker Error:", e);
        }
    }
}

export class LollmsDebugAdapterTrackerFactory implements vscode.DebugAdapterTrackerFactory {
    createDebugAdapterTracker(session: vscode.DebugSession): vscode.ProviderResult<vscode.DebugAdapterTracker> {
        return new LollmsDebugAdapterTracker();
    }
}
