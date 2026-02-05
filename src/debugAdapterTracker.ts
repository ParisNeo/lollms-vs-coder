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
            const stackTrace = await session.customRequest('stackTrace', { threadId, startFrame: 0, levels: 20 });
            
            if (stackTrace && stackTrace.stackFrames && stackTrace.stackFrames.length > 0) {
                const topFrame = stackTrace.stackFrames[0];
                const source = topFrame.source;
                
                if (source && source.path) {
                    const uri = vscode.Uri.file(source.path);
                    const line = topFrame.line;
                    
                    // Format Stack Trace
                    const stackString = stackTrace.stackFrames.map((f: any) => 
                        `${f.name} (${f.source?.path || 'unknown'}:${f.line})`
                    ).join('\n');

                    // --- NEW: Fetch Variable Values (Locals) ---
                    let localsString = "";
                    try {
                        const scopes = await session.customRequest('scopes', { frameId: topFrame.id });
                        if (scopes && scopes.scopes) {
                            // Find the 'Locals' scope - name can vary by debugger
                            const localScope = scopes.scopes.find((s: any) => 
                                s.name === 'Locals' || s.presentationHint === 'locals'
                            );

                            if (localScope) {
                                const variables = await session.customRequest('variables', { 
                                    variablesReference: localScope.variablesReference 
                                });
                                
                                if (variables && variables.variables) {
                                    localsString = variables.variables.map((v: any) => 
                                        `${v.name} = ${v.value} (${v.type || 'unknown'})`
                                    ).join('\n');
                                }
                            }
                        }
                    } catch (varError) {
                        localsString = "Local variables unavailable.";
                    }
                    
                    debugErrorManager.setError(message, stackString, uri, line, localsString);
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
