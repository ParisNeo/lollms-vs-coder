- OK when adding a folder, just add its children and don't attempt to add the folder itself to the discussion as content
- OK verify why no context is in discussion
- OK when in a discussion, then we go to another page and come back to the discussion, the content is lost fix that
- OK Add custom prompt to code selection
- OK at first run, the templates are empty. make sure they are repopulated and handle migration from previous installations.
- OK add the possibility to copy the message as markdown
- OK add stop generation
- OK add tokens progressbar
- OK fix actions for py files
- OK add the possibility to activate/deactivate file rewrite/file patch
- OK .vue files are not loading
- some files like jupyter and vue files must be loadable

- if there is a .gitignore, apply it to the context selection
- fuse generate code and rewrite code
- add firewall with rules for execution

- when refreshing remove any selected files that do not exist anymore

- when using File: syntax, the LLM needs to provide full code without any placeholder

- add inspection

- add the possibility to save selection
- add the possibility to use personalities


URGENT:
- don't calculate context size when updating the tree. instead calculate it when a discussion is loaded.



## Summary
Three problems observed after upgrading to the latest **Lollms VS Coder** release:
 
| # | Area                | Short description |
|---|---------------------|-------------------|
| 1 | Saving configuration| “Save & Close” fails with *Failed to save configuration* |
| 2 | Context selection   | Highlighted files diverge from the stored context (folder removal, stale highlights) |
| 3 | Cosmetic            | Placeholder strings (`welcome.title`, `welcome.item*`) appear in new discussions |
 
---
 
## 1️⃣ Saving configuration
 
**Steps to reproduce**
 
1. Open **Lollms Settings**.  
2. Change any setting (e.g., toggle a switch, edit a field).  
3. Click **Save & Close**.
 
**Expected behaviour**  
Settings are persisted and the panel closes without error.
 
**Actual behaviour**  
A toast/notification appears: `Failed to save configuration`.  
No changes are written to the config file.
 
**Environment**
 
- OS: Windows 11 (10.0.22631)  
- VS Code: 1.89.1  
- Lollms VS Coder: *latest* (vX.Y.Z)  
- Node / npm: 18.20.0  
 
---
 
## 2️⃣ Context selection
 
### a) Stale highlights after upgrade
**Steps**
 
1. Open a project that already has a saved context.  
2. Upgrade to the newest Lollms VS Coder version.  
3. Open the **Context** view.
 
**Expected** – Files previously highlighted remain highlighted.  
**Actual** – The old context is still listed, but none of its files are highlighted.
 
### b) Sync mismatch between saved context and UI highlights
**Steps**
 
1. Save a context file.  
2. Edit the file manually (remove most entries).  
3. Load the edited file back via the UI.
 
**Expected** – UI highlights exactly match the loaded context.  
**Actual** – Highlights stay as they were; they only sync after a full VS Code reload (`Developer: Reload Window`).
 
### c) Folder handling inconsistency
**Steps**
 
1. Add a folder (e.g., `src/`) to the context.  
2. Verify that every file inside `src/` appears in the context list.  
3. Remove the folder from the context.
 
**Expected** – All files that originated from that folder disappear as well.  
**Actual** – Only the folder entry is removed; the individual files remain in the list.
 
---
 
## 3️⃣ Cosmetic issue
 
When starting a brand new discussion the UI still shows the raw keys:
```
welcome.title
welcome.item1
welcome.item2
welcome.item3
welcome.item4
```
 
 
These should be replaced by the actual welcome message (or hidden) once the first user message is sent.
 
---
 
## Additional notes
 
- No custom extensions or themes are installed.  
- The problem persists after a full VS Code reload (`Developer: Reload Window`).  
- Console output (via **Help → Toggle Developer Tools**) shows only the “Failed to save configuration” toast; no stack trace.
 
---
 
## Suggested next steps (optional)
 
1. Verify write permissions on the settings JSON file.  
2. Ensure the context store is refreshed after a version bump.  
3. Clear or replace the welcome message placeholders when a discussion is initialized.
 
---
 
*Feel free to ask for more logs or details – happy to help get this fixed!* 🙏
