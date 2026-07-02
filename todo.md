- Add a configuration setting for auto context so that we can select what level of agression we need in selecting file (respect context size :75% max, no restrictions: recover maximum potential files, Minimal: try to select the smallest set of files that is useful to this, signatures: select only signatures for files that shouldn't be modified but needed to understand the context and full file content for the files to be used), implement RLM with a REPL to enhance this.
- Add RLM mode with REPL.
- upgrade ascii_colors skills
- Add skills for ScrapeMaster and safe_store

- Add notes building and storing (like skills), notes are for uset and skills for ai
- Add the possibility to have multiple profiles et switch between
- The librarian must be able to access the images if there are images in the discussion
- The default context length is not taking into consideration the settings. Make it modifiable directly in discussion settings
- Images does not work on ollama binding
- When there is an image in the message the missage bubble is not editable
- when the llm selects more files, we are loosing the message!! Please make sure when the llm is not operating in auto context mode, if it needs more files, it shows a ui with a add to context button where the user can do it before continuing to prompt the llm
-   
- Actual command not found, wanted to execute lollms-vs-coder.editSkill /1505


fix search functionality in both discussion and dedicated search view (Webview error: sanitizer is not defined)
applyall is broken
librarian integration with the llm is not correct
add all to conext button is not working

When viewing the hunk original text, show the file name and hunk number.
Allow editing.
Add a set as done button.
Before attempting fix, make sure it is not just a simple indentation incompatibility
prompt the ai not to add non existing comments to the search code as this would block the application of the hunk

verify status is not working


OK Fix the surgical update so it doesn't add extra indentation tab to the text when selected and don't show lollms's icon
OK in discussion when using the auto context badge, don't remove the original prompt, keep it in the input zone.

OK Code tags are rendered as long code block. Cap its height adn use scrollbars

usage ui is not working, delete button not working

Surgical updates MUST be fast. So no heavy computations, just the current file and the selection. The LLM may beed more fiels and trigger more files selection but in a single shot (not a complex librarian way, just say I need these, we add them and rerun) It must be as fast as possible.

Add a fast librarian mode (single shot, just take a look at the current task and the tree and infer the files that need to be added)
Make skills md with claude style

# IMPORTANT
- add a new tool that loads a selection. add some metadata to the selection file so that the LLM can list selections and get their description then can select one
- details what's happening when 🧠 Loading file content... It is very long sometimes making the ui freeze
- adding external files is not working
- Add information about the context size/file size in tokens in the built context
- Add a new personality to build optimized files selections for a specific problem. it starts be cleaning up the context then does the selection

- when using manual fix, the search doesn't find the text even though I can find it manually, and then the ui is blocked (can't close the modal until I close the whole tab)
- delete all tool is not working and is notasking the user for confirmation.
- add a reprompt button that reprompts the llm about the failed hunk updates so it fix that.
- in dynamic mode, when the applyall failes and auto apply is on, reprompt to fix the unmatched hunks
- 


# New recommendations
## Context and Memory Management (The Primary Source of CPU & Token Bloat) [OK]
- O(N²) Search and Verification Overhead:
Instead of recursively sorting and stringifying large objects on every turn, compute an MD5 or SHA-256 hash of the normalized parameters once upon creation and store it alongside the task metadata.


- Synchronous JSON & File Stat Checking inside Ingestion Loops:
In src/contextManager.ts (inside getContextContent), the code loops over every file in the active context, checks its existence on disk, and optionally reads or parses its contents.
utilize a cached directory snapshot instead of querying the physical disk on every token recount.

## Webview Rendering and IPC Communication (UI Latency) [OK]
- Massive JSON Payloads over VS Code's IPC Channel
In src/commands/chatPanel/chatPanel.ts (inside updateContextAndTokens), the extension packages the full text of all active files and sends it to the webview:
Lazy-Load Code Previews: Only send the list of file paths to the Webview. When the user clicks to expand a specific file in the Accordion UI, request its content on-demand via a fast postMessage('requestFileContent', filePath) callback.
String Truncation: Cap the initial preview block sent over IPC to a safe length (e.g., 5,000 characters).

- Redundant Virtual DOM Re-renders in the Webview
In src/commands/chatPanel/webview/messageRenderer.ts, rendering streaming text chunks triggers complete Markdown and KaTeX math parsing passes:
Throttle Renditions: Introduce a rendering queue that flushes updates to the DOM at a controlled interval (e.g., every 150ms) rather than on every incoming token chunk.


## Resource-Intensive Code Graph Compilation (Network & CPU Load)
- Eager Graph Compilation on Startup
src/codeGraphManager.ts can perform heavy parallel parsing during the activation path if not carefully controlled:
Searching and parsing hundreds of files using regex matching (even with worker threads) consumes significant memory and CPU cycles during the extension's startup sequence.
Keep the graph build entirely lazy. Do not invoke buildGraph() on startup. Instead, only initiate graph builds when the user opens the "Architecture Graph" tab or explicitly runs a SPARQL-lite structural query.

- Non-incremental Import Path Resolution
The linkGraphStructure() method in src/codeGraphManager.ts reconstructs the entire network of file nodes and imports from scratch during updates.
If only one file is modified, rebuilding the entire graph is highly inefficient and scales poorly with codebase size.
Implement a localized dependency resolver. When a file is updated, remove only its associated outgoing edges and re-link its specific imports, preserving the rest of the in-memory graph.