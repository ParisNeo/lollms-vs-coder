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

## Problem in websearch
apply all **MUST** save all updated files
