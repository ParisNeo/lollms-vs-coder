add active skills list to the context information and to the context number of tokens
Fix the add skills functionality (it is not adding any skills to the app)
Add a tree view to view the content of skills and CRUD skills
Add a configuration setting for auto context so that we can select what level of agression we need in selecting file (respect context size :75% max, no restrictions: recover maximum potential files, Minimal: try to select the smallest set of files that is useful to this, signatures: select only signatures for files that shouldn't be modified but needed to understand the context and full file content for the files to be used), implement RLM with a REPL to enhance this.
Add RLM mode with REPL.