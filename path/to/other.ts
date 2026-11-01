        // Update persistent companion conversation history
        panel.chatHistory.push({ role: 'user', content: instruction });

        const loopMessages: ChatMessage[] = [
            { role: 'system', content: systemPrompt },
            ...panel.chatHistory.slice(0, -1),
            { role: 'user', content: userPromptWithFile }
        ];

        const controller = new AbortController();
        let turnIndex = 0;
        const maxTurns = 5;
        let finalOutput = "";

        // --- MULTI-TURN AUTONOMOUS DISCOVERY & REPAIR ENGINE ---
        while (turnIndex < maxTurns && !controller.signal.aborted) {
            turnIndex++;
            let currentChunkBuffer = "";

            // Stream current turn
            panel._panel.webview.postMessage({
                command: 'updateChat',
                history: panel.chatHistory,
                streamingText: finalOutput
            });

            const rawTurnResponse = await this.lollmsAPI.sendChat(
                loopMessages,
                (chunk) => {
                    currentChunkBuffer += chunk;
                    panel._panel.webview.postMessage({
                        command: 'updateChat',
                        history: panel.chatHistory,
                        streamingText: finalOutput ? `${finalOutput}\n\n${currentChunkBuffer}` : currentChunkBuffer
                    });
                },
                controller.signal
            );

            const cleanTurn = stripThinkingTags(rawTurnResponse);
            finalOutput = finalOutput ? `${finalOutput}\n\n${cleanTurn}` : cleanTurn;

            // Inspect for discovery action tags
            const discoveryActions = this.extractDiscoveryActions(cleanTurn);

            if (discoveryActions.length === 0 || controller.signal.aborted) {
                // No further tools required; companion has finalized its response
                break;
            }

            // Execute tools across the project
            const actionResults: string[] = [];
            for (const act of discoveryActions) {
                if (controller.signal.aborted) break;
                panel.setLoading(true);

                let resultText = "";
                try {
                    if (act.type === 'grep') {
                        const searchRes = await this.contextManager.searchWorkspaceContent(
                            act.pattern,
                            { matchCase: false, wholeWord: false, include: act.path }
                        );
                        if (searchRes.length > 0) {
                            const snippet = searchRes.slice(0, 10).map(r => `${r.path}:${r.line} - ${r.snippet}`).join('\n');
                            resultText = `Grep matches for "${act.pattern}":\n${snippet}`;
                        } else {
                            resultText = `No matches found for "${act.pattern}".`;
                        }
                    } else if (act.type === 'read_full_file' || act.type === 'peek_files') {
                        const res = await this.contextManager.resolveWorkspaceFromPath(act.path);
                        if (res) {
                            const bytes = await vscode.workspace.fs.readFile(res.uri);
                            const text = Buffer.from(bytes).toString('utf8');
                            const lines = text.split('\n');
                            const maxLines = act.type === 'peek_files' ? Math.min(lines.length, 40) : lines.length;
                            resultText = `File content for \`${act.path}\` (${maxLines} lines):\n${lines.slice(0, maxLines).join('\n')}`;
                        } else {
                            resultText = `Could not resolve path "${act.path}".`;
                        }
                    } else if (act.type === 'sparql') {
                        const codeGraph = (this.contextManager as any).codeGraphManager;
                        if (codeGraph && typeof codeGraph.executeSparql === 'function') {
                            resultText = await codeGraph.executeSparql(act.query);
                        } else {
                            resultText = "SPARQL graph engine not active.";
                        }
                    } else if (act.type === 'show_symbol') {
                        const { showSymbolTool } = require('./tools/builtins/showSymbol');
                        const env = {
                            contextManager: this.contextManager,
                            lollmsApi: this.lollmsAPI,
                            workspaceRoot: vscode.workspace.workspaceFolders?.[0]
                        };
                        const symRes = await showSymbolTool.execute({ target: act.target, symbol: act.symbol }, env, controller.signal);
                        resultText = symRes.output;
                    }
                } catch (toolErr: any) {
                    resultText = `Error executing ${act.type}: ${toolErr.message}`;
                }

                actionResults.push(`### 🔍 Observation [${act.type}]:\n${resultText}`);

                // Embed visual tool execution card in stream
                const toolCard = `\n<details class="companion-tool-card" open><summary><i class="codicon codicon-search"></i> ${act.type.toUpperCase()}: ${act.pattern || act.path || act.target || 'Query'}</summary><pre>${resultText.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre></details>\n`;
                finalOutput += toolCard;
            }

            // Append assistant turn and observation turn to loop messages
            loopMessages.push({ role: 'assistant', content: cleanTurn });
            loopMessages.push({
                role: 'user',
                content: `### 📋 OBSERVATION RESULTS:\n${actionResults.join('\n\n')}\n\nBased on these observations, complete your answer and output the surgical <file> patch for \`${relativePath}\`.`
            });
        }

        // Strip memory and finalize
        const { content: cleanedFinal, memory = null } = extractAndStripMemory(stripThinkingTags(finalOutput));
        if (memory) {
            await this.memoryManager.updateMemory(memory);
        }

        // Commit assistant response to persistent history
        panel.chatHistory.push({ role: 'assistant', content: cleanedFinal });
        panel._panel.webview.postMessage({
            command: 'updateChat',
            history: panel.chatHistory,
            streamingText: ""
        });

        panel.addHistory(instruction, cleanedFinal);
        panel.setLoading(false);

    } catch (error: any) {
        vscode.window.showErrorMessage(`Lollms Companion Error: ${error.message}`);
        panel.setLoading(false);
    } finally {
        panel.setLoading(false);
    }
}

private extractDiscoveryActions(text: string): Array<{ type: string; pattern?: string; path?: string; target?: string; symbol?: string; query?: string }> {
    const actions: Array<{ type: string; pattern?: string; path?: string; target?: string; symbol?: string; query?: string }> = [];

    // 1. Grep tags: <grep pattern="..." path="..." /> or <grep>pattern</grep>
    const grepRegex = /<grep\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/grep>)/gi;
    let gMatch;
    while ((gMatch = grepRegex.exec(text)) !== null) {
        const attrStr = gMatch[1] || "";
        const inner = (gMatch[2] || "").trim();
        const pMatch = attrStr.match(/pattern=["']([^"']+)["']/i);
        const pathMatch = attrStr.match(/path=["']([^"']+)["']/i);
        const pattern = pMatch ? pMatch[1] : inner || attrStr.split(/\s+/)[0];
        if (pattern) {
            actions.push({ type: 'grep', pattern, path: pathMatch ? pathMatch[1] : undefined });
        }
    }

    // 2. Read full file: <read_full_file path="..." /> or <read_file path="..." />
    const readRegex = /<(?:read_full_file|read_file)\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:read_full_file|read_file)>)/gi;
    let rMatch;
    while ((rMatch = readRegex.exec(text)) !== null) {
        const attrStr = rMatch[1] || "";
        const pMatch = attrStr.match(/path=["']([^"']+)["']/i);
        const pathVal = pMatch ? pMatch[1] : (rMatch[2] || "").trim() || attrStr.split(/\s+/)[0];
        if (pathVal) {
            actions.push({ type: 'read_full_file', path: pathVal.replace(/^['"]|['"]$/g, '') });
        }
    }

    // 3. Peek files: <peek_files path="..." />
    const peekRegex = /<peek_files\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/peek_files>)/gi;
    let pkMatch;
    while ((pkMatch = peekRegex.exec(text)) !== null) {
        const attrStr = pkMatch[1] || "";
        const pMatch = attrStr.match(/path=["']([^"']+)["']/i);
        const pathVal = pMatch ? pMatch[1] : (pkMatch[2] || "").trim();
        if (pathVal) {
            actions.push({ type: 'peek_files', path: pathVal.replace(/^['"]|['"]$/g, '') });
        }
    }

    // 4. SPARQL: <sparql>...</sparql> or `<query_architecture>...</query_architecture>`
    const sparqlRegex = /<(?:sparql|query_architecture)>([\s\S]*?)<\/(?:sparql|query_architecture)>/gi;
    let sqMatch;
    while ((sqMatch = sparqlRegex.exec(text)) !== null) {
        const q = sqMatch[1].trim();
        if (q) {
            actions.push({ type: 'sparql', query: q });
        }
    }

    // 5. Show symbol: <show_symbol target="..." symbol="..." />
    const symRegex = /<show_symbol\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/show_symbol>)/gi;
    let sMatch;
    while ((sMatch = symRegex.exec(text)) !== null) {
        const attrStr = sMatch[1] || "";
        const tMatch = attrStr.match(/target=["']([^"']+)["']/i);
        const sNameMatch = attrStr.match(/symbol=["']([^"']+)["']/i);
        if (tMatch) {
            actions.push({ type: 'show_symbol', target: tMatch[1], symbol: sNameMatch ? sNameMatch[1] : '' });
        }
    }

    return actions;
}
