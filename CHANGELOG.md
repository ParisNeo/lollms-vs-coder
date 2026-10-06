Of course! Here is the updated changelog for version **0.3.7**, incorporating the recent fixes and improvements.

# Changelog

All notable changes to the "Lollms VS Coder" extension will be documented in this file.

## [2026-10-06 23:01]

- feat(registries): update chat command registry to 0.3.7

## [2026-10-07 00:15]

- `fix(vision-tokens): prevent base64 image data URIs from being counted as text tokens, isolating prompt text and charging fixed multimodal vision cost (~600 tokens) instead of millions of text characters`
- `fix(governor): scrub base64 image data URIs from userPromptText before calculating Governor token budget and passing prompt to Governor LLM`

## [2026-10-06 23:35]

- `fix(governor): preserve complete chain of thoughts and investigation rounds in Governor chat message, rendering all previous rounds above the live stream without overwriting earlier text`
- `feat(governor): format completed rounds with thoughts, tool invocations (<read_full_file>, <peek_files>, <grep>, <sparql>), and observations in real time`

## [2026-10-06 23:05]

- `feat(governor): implement Worker-Governor Collaboration Protocol enabling the worker to summon the Governor mid-turn via <ask_governor>...</ask_governor> in Co-Engineer mode`
- `feat(governor): allow user to trigger the Governor at any time via <governor> directives or UI triggers to realign context`
- `feat(governor): enshrine the Worker-Governor Collaboration Protocol into the Global Mission Briefing Doctrine`

## [2026-10-06 22:45]

- `fix(raw-modal): automatically close the Raw Aider Block modal when validating a single hunk or the last remaining hunk as manually applied`

## [2026-10-06 22:20]

- `feat(governor): reinstate trigger threshold gating in ContextGovernor.arbitrate to bypass Governor on turns where active load is safely within threshold, preventing unnecessary latency`
- `feat(governor): provide dual-token accounting to Governor audit: total candidate pool tokens (muted + unmuted) vs. current unmuted tokens, with mandate to fit active unmuted tokens below threshold`
- `feat(governor): stream real-time Governor reasoning, tool invocations (<read_full_file>, <peek_files>, <grep>, <sparql>), decisions, and prepared worker report directly into chat message`
- `feat(governor): update permanent Sovereign Context Governor Doctrine with smart threshold gating, dual-token accounting, and real-time user visibility`

## [2026-10-06 20:10]

- `feat(governor): enshrine Sovereign Context Governor Doctrine into permanent global project mission briefing`
- `fix(governor): eliminate premature 95% bypass so Governor actively arbitrates on every coding task, categorizing mandatory edit files vs. context reference files and unmuting only needed files`
- `feat(governor): inject <governor_report> directly into the user's prompt turn containing reference contracts, function signatures, and multi-phase partitioning instructions`
- `fix(governor): ensure multi-phase execution stepper in ChatPanel mutes completed phase files, unmutes next phase files, and automatically triggers continuation prompts across all phases`

## [2026-10-06 19:35]

- `fix(governor): deactivate thinking mode ({ thinking: false, reasoningEffort: 'none' }) across all Context Governor API calls, eliminating reasoning monologues and token waste during multi-round arbitration`

## [2026-10-06 18:30]

- `feat(governor): comprehensive Context Governor overhaul with fixed budget awareness, dual-source structure inference (informed by .lollms/structure.md or project tree), and active multi-round scouting`
- `feat(governor): add <read_full_file> tool enabling Governor to load and inspect full file contents for a single round to extract interfaces and contracts into scratchpad without permanent context pollution`
- `feat(governor): implement tri-tier file categorization (edit_files, context_files, unneeded_files) and 3-case arbitration (fit_all, fit_edits_only, split_multi_part)`
- `feat(governor): generate high-density <governor_report> containing extracted signatures, schemas, and contracts from muted reference files, injected directly into prompt context`
- `feat(governor): implement multi-part task partitioning when edit files exceed context budget, automatically staging changes, muting completed files, unmuting next files, and triggering continuation prompts`

## [2026-10-05 10:46]

- `feat(discussions): inherit muting pattern from previous discussion when creating a new discussion while preserving independent muting states for each discussion on disk`

## [2026-10-05 10:40]

- `fix(clipboard-image): resolve image pasting in discussion input panel by inspecting both clipboard items and files, supporting multi-image pastes, and adding container-level paste interception`
- `fix(clipboard-image): render staged image cards using explicit <img> elements to guarantee visual preview without CSS background-image data URI parsing failures`

## [2026-10-05 10:35]

- `feat(context-expansion): automatically unmute files when requested via <add_files_to_context> across chat, Co-Engineer mode, and automation pipelines`
- `feat(context-expansion): highlight muted files in orange with [MUTED] badge and eye-closed icon inside <add_files_to_context> cards, dynamically updating button to 'Unmute & Add to Context'`

## [2026-10-04 21:30]

- `feat(governor): inject Governor's Codebase Architecture & Workings Guide (.lollms/structure.md) at the bottom of the system prompt across chat executions, snapshots, and clipboard exports`
- `fix(governor): enforce strict architectural purity mandate on .lollms/structure.md, preventing Governor from recording muting/keeping decisions, token budgets, or temporary session events in the structure guide, and adding automated sanitizer cleanStructureContent to purge event noise`

## [2026-10-04 21:10]

- `fix(grep): eliminate catastrophic slowdowns during Governor grep searches by treating git grep exit code 1 (zero matches) as clean empty results instead of falling into full-disk findstr, strictly excluding build/dist/out, venv/.venv, py compilation folders (__pycache__), node_modules, and .git, and replacing uncontrolled findstr with bounded VS Code file searches`

## [2026-10-04 20:45]

- `feat(wizard): revamp New Discussion Wizard into a two-column studio with live context load bar, target budget and capacity exceed warning banner, interactive candidate files list with active/muted toggles, one-click Context Governor integration, and full support for pasting text/images and attaching images to the opening prompt`

## [2026-10-04 20:10]

- `fix(hud): resolve External Research globe button click event swallowing, ensuring the Grounding and Research modal opens reliably`
- `fix(search-ui): repair web search result rendering container lookup for DuckDuckGo, Google, Wikipedia, and StackOverflow`
- `feat(grounding): add dedicated YouTube Transcript tab to Grounding Center with direct ingestion into .lollms/external_files/, and add Wikipedia search engine support`

## [2026-10-04 19:45]

- `feat(linter-repair): add automatic post-patch error detection auditing language server diagnostics after code is applied, displaying an interactive alert button (⚠️ X Errors · Fix in Studio) on file mutation cards and batch rows`
- `feat(linter-repair): introduce Governor-style two-column File Repair Studio displaying line-by-line spotted diagnostics and live disk preview on the right, with multi-round surgical Aider patching, real-time error clearance, and user acceptance at any time`

## [2026-10-04 19:25]

- `refactor(hud): remove redundant fork icon button from Selected Files header summary, keeping Fork Chat and Fork & Compress consolidated inside the section toolbar`
- `feat(hud): separate External & Research into its own dedicated collapsible section backed by .lollms/external_files, supporting document imports (PDF, DOCX, TXT, MD, etc.) with individual muting and removal`

## [2026-10-04 19:00]

- `feat(hud): display an eye icon (👁️) in front of vision-capable models in the HUD model selector badge and dropdown menu for immediate multimodal awareness`
- `feat(settings): add dedicated 'Vision Support' settings tab with per-model manual overrides (Auto-Detect, Vision Supported, Text Only) and custom model pattern rules to easily configure bindings that do not report vision capabilities`

## [2026-10-04 18:25]

- `feat(hud): add 'Fork & Compress' button near 'Fork Chat' in the Context Explorer HUD and Actions menu, replicating all active files and mute states while compressing previous session history into two alternating messages (developer recap + assistant confirmation) to preserve strict user/assistant alternation`

## [2026-10-04 17:50]

- `feat(governor-ui): allow setting custom token budgets (Target LLM Presets for 8k, 16k, 32k, 64k, 128k, 200k, 1M, and custom inputs) in Context Governor Studio to prepare tailored prompts for any external LLM`
- `feat(governor-ui): add interactive Effort Level selector (None, Low, Medium, High) to Context Governor Studio, dynamically controlling model reasoning depth and thinking budget during context arbitration`

## [2026-10-04 12:20]

- `feat(governor-ui): add interactive Stop Generation button to Context Governor Studio, wire AbortController cancellation to preserve partial discoveries, guarantee grep and SPARQL tools are always enabled for Governor, and support autonomous workspace file discovery via <add_files_to_context>`
- `feat(governor-ui): embed live context progress bar into Context Governor Studio displaying exact context capacity, active content load, target threshold marker, and color-coded budget status`
- `fix(governor): prevent single-round exit when LLM outputs conversational intent, enforce multi-round deep reasoning with high reasoning effort, and mandate pipeline tracing with aggressive pruning of large unrelated files`

## [2026-10-03 13:12]

- ref(chats-ui): delete ArtefactSplitView, DataZone, and CodeMirrorComponent

## [2026-10-03 15:00]

- `feat(governor): unify automatic context governor arbitration with Governor Studio structure, adding discovery step chips, real-time stream updates with live reasoning, <add_files_to_context> workspace discovery, and dual-tier reference extraction`

## [2026-10-03 14:45]

- `feat(governor): empower Context Governor with exact token budget awareness, 100% transparent file size breakdowns, dual-tier strategy (active context for files to edit vs .lollms/structure.md for reference-only files), and ability to discover and add files from the workspace tree`

## [2026-10-03 14:30]

- `feat(hud): replace Project Structure (File Manifest) in the Intelligence Context Explorer HUD with Governor's Report & Findings (.lollms/structure.md), rendering rich markdown analysis of code workings with edit, copy, and auto-generate actions`

## [2026-10-03 12:40]

- `feat(governor): stream LLM thinking and output in real time into Governor Studio stream with live reasoning blocks, expose contextGovernorMaxRounds in Settings panel with minimum 15 (default 20), and render live discovery actions in real time`

## [2026-10-03 12:25]

- `fix(governor): prevent silent swallow of LLM connection failures, halt immediately when LLM server is offline with clear diagnostic errors instead of generating instantaneous fake selections, and enforce multi-round exploration when server is active`

## [2026-10-03 12:10]

- `fix(governor): mandate multi-round exploration before finalizing context selection, intelligently preserve core code files during structural/overview queries, wire real-time round progress to Governor Studio HUD, and persist .lollms/structure.md`

## [2026-10-03 11:15]

- `feat(governor): implement persistent Codebase Structure Guide (.lollms/structure.md) for both Discussion and Manual Context Governor with multi-round exploration (up to 20 rounds), SPARQL/grep access, <structure> write/patch updates, and cumulative architectural learning`

## [2026-10-01 23:34]

- feat(chat): update chat panel implementation and context management

## [2026-10-01 22:57]

- feat(chat): update chat panel implementation and context management

## [2026-10-02 00:55]

- `feat(hud-explorer): collapse Project Structure (File Manifest) by default on startup, add recursive collapse/expand subfolders button for all folders with children, and add live file search bar in HUD context files view`

## [2026-10-02 01:25]

- `fix(build): resolve unexpected closing parenthesis syntax error in webview events.ts from dangling legacy prompt code`

## [2026-10-02 01:15]

- `fix(governor): replace blocked window.prompt in Context Governor Studio and Bulk Operations modal with accessible inline preset naming inputs and native VS Code input box integration`

## [2026-10-02 01:05]

- `fix(model-optimizer): wire openTestAndOptimize message handler in configView, add Test & Optimize button to Discussion Settings modal in chatPanel, and implement webviewReady handshake in ModelOptimizerPanel`

## [2026-10-01 22:15]

- `fix(build): resolve missing ModelOptimizerPanel export and bundle compilation error in commandRegistry`

## [2026-10-01 21:50]

- `feat(model-optimizer): add 'Test and Optimize' benchmark suite to evaluate patching precision (automated via applySearchReplace), prompt adherence, and anti-hallucination across temperature ranges (including model-native automatic defaults); support AI Judge Agent and Human Review; bind and persist optimal settings per model`

## [2026-10-01 20:30]

- `feat(governor): empower Context Governor with multi-round tool execution (<grep>, <sparql>, <peek_files>), iterative learning, preselection budget verification with file size breakdown reprompting, <reveal_only> and <mute_only> functions, and <signatures> architectural/mermaid explainers for muted files`

## [2026-09-30 23:35]

- `feat(context-files): add visibility status sorting (Visible First & Muted First) to project files list and bulk operations modal`

## [2026-09-30 23:10]

- `feat(file-activation): add Unmute & Reprompt button to File Content Activation card and include unmute operations in Execute All Actions bulk pipeline`

## [2026-09-30 22:30]

- `fix(context-tree): eliminate unwanted scrolling when toggling file/folder mute status via in-place DOM updates, anchor scroll containers, and display file sizes even when muted`

## [2026-09-30 22:15]

- `feat(governor): overhaul Context Governor into an interactive two-column studio with continuous prompt/reprompt negotiation on the left and live muting scheme management with discovery steps on the right`

## [2026-09-30 18:45]

- `fix(webview): elevate Context Governor modal z-index to 110000 so it displays above the New Discussion wizard dialog`

## [2026-09-30 18:35]

- `feat(wizard): add Context Governor button to New Discussion initialization wizard to adapt initial file selection via intelligent muting`

## [2026-09-30 16:22]

- feat(ch:webui): fix ChatPanel webview CSS/HTML refactoring for dynamic event handling & DOM updates

## [2026-09-30 14:25]

- `fix(webview): repair truncated HTML markup in bulk-delete-modal that corrupted the DOM and prevented all subsequent modals from opening`

## [2026-09-29 23:45]

- `fix(context): resolve reset context files not clearing selection by eliminating legacy key resurrection in ContextStateProvider, purging stale caches, and clearing webview file registries`

## [2026-09-29 23:15]

- `fix(prompt): replace fragile ripgrep mega-glob with robust scanner, add direct-crawl failsafe in generateIsolatedProjectTree, and guarantee non-empty PROJECT STRUCTURE injection into prompt`

## [2026-09-29 23:35]

- `fix(activation): eliminate duplicate runTestsAndReport command registration preventing extension activation, initialize ContextStateProvider before command registration, and deduplicate menu elements`

## [2026-09-29 23:25]

- `fix(clipboard): initialize _contextManager in ChatPanel constructor and add direct readdirSync fallback to ensure project tree is never omitted in exported prompts`

## [2026-09-29 23:05]

- `fix(tree): remove grep-gate suppressing project tree, guarantee tree tokens in HUD token bar, and ensure persistent project structure visibility`

## [2026-09-29 22:55]

- `fix(tree): resolve tree scanning blocking on absolute workspace paths, add dedicated Project Structure viewer to Chat HUD, and enable Active Workspace Explorer in chat sidebar tab`

#
- fix(config): sanitize SSL cert path input and clean up config# [Unreleased]

- feat(chat): enhance chat panel with persona support and UI improvements

#
- chore(release): bump to v0.5.52 and refine command implementations# [Unreleased]

- chore(core): bump version to 0.5.51 and update agent, companion panel, extension, notebook tools, quick edit, and code generation utilities

#
- feat(extension): add new Aider mode options and update localizations# [Unreleased]

- chore(release): bump version to 0.5.53 and add utility helpers

#
- feat: enhance chat panel UI and actions handling# [Unreleased]

- chore: bump version to 0.5.54 and refactor extension modules

#
- feat(chatPanel): enhance chat panel functionality and styling# [Unreleased]

- chore(release): bump version to 0.5.56 and update changelog

## [2026-09-28 16:00]

- `feat(bindings): migrate legacy connection profiles to ServerBindings with full deactivation support to hide models from inactive servers`

## [2026-09-28 15:30]

- `fix(configView): resolve Uncaught TypeError: Cannot set properties of null (setting 'onclick') on webview initialization and bump version to 1.0.38`

## [2026-09-28 15:30]

- `fix(configView): resolve Uncaught TypeError: Cannot set properties of null (setting 'onclick') on webview initialization and bump version to 1.0.38`

## [2026-09-28 09:15]

- `fix(lollmsAPI): update version to 1.0.36 and correct minor bug in chatPanel component initialization`

## [2026-09-25 19:27]

- fix(lollmsAPI): update version to v1.0.35

## [2026-09-23 01:01]

- fix(doc:update version to 1.0.34)

## [2026-09-20 21:53]

- BUILD(chat-panel): update minor version in package.json for v1.0.32

## [2026-09-20 20:42]

- fix(chat-panel): update webview components for mission briefing and file op system

## [2026-09-20 08:57]

- fix(api): update version in package.json to v1.0.30

## [2026-09-17 12:34]

- `chore(vscode): update release version to 1.0.27 and add lollms_code to .gitignore`

## [2026-09-17 11:18]

- 1.0.27

## [2026-09-07 22:12]

- fix(chats): update event handling for dynamic content rendering and file operations in chat panel webviews

## [2026-09-07 00:15]

- `fix(version): bump lollms-vs-coder version to 1.0.15`

## [2026-09-04 11:34]

- feat(chatPanel): enhance webview UI and update extension version to 1.0.13

## [2026-09-03 00:57]

- refactor: update agent management and chat panel logic

## [2026-08-31 00:22]

- feat(chat): enhance message rendering and prompt templates

## [2026-08-27 02:42]

- feat(chatPanel): enhance webview UI and update version to 1.0.10

## [2026-08-24 01:20]

- feat(chatPanel): enhance webview rendering and update version to 1.0.6

## [2026-08-23 18:07]

- feat(chatPanel): enhance webview plugin system and update version to 1.0.4

## [2026-08-20 21:31]

- feat(chat): enhance chat panel webview and code graph management

## [2026-08-20 01:33]

- feat(chat-panel): major update to chat panel webview and bump version to 1.0.0

## [2026-08-19 00:25]

- refactor: update agent management, chat panel UI, and built-in tools

## [2026-07-16 21:15]

- feat(chatPanel): update webview components and refine event handling

## [2026-07-15 01:18]

- refactor(chatPanel): overhaul chat panel implementation and update version to 0.12.4

## [2026-07-06 19:01]

- chore: bump version to 0.11.7 and update core chat panel components

## [2026-07-06 10:53]

- refactor(chatPanel): update chat panel logic and bump version to 0.11.6

## [2026-07-03 02:30]

- refactor(ui): update chat and panel components for improved context and rendering

## [2026-07-01 18:40]

- refactor: update version to 0.11.2 and improve general system stability

## [2026-06-30 13:34]

- feat(chatPanel): enhance webview UI and update version to 0.10.7

## [2026-06-30 00:30]

- feat(chatPanel): improve webview rendering and update version to 0.10.6

## [2026-06-29 01:28]

- style(chatPanel): use VS Code theme variables and fix apply button logic

## [2026-06-28 09:46]

- feat: upgrade to version 0.10.2 and enhance chat panel and agent management

## [2026-06-22 21:47]

- chore(deps): bump js-yaml from 4.1.0 to 4.1.1

## [2026-06-21 22:03]

- refactor(chat): update chat panel webview and refresh skill definitions

## [2026-06-21 14:07]

- refactor(chat-panel): update chat panel logic and bump version to 0.9.2

## [2026-06-20 22:27]

- feat(chat-panel): enhance agent tool handling and update version to 0.9.0

## [2026-06-19 12:44]

- feat(chatPanel): enhance webview message rendering and plugin functionality

## [2026-06-18 00:56]

- refactor(chat): update chat panel logic and context manager processing

## [2026-06-17 22:58]

- feat(chatPanel): enhance chat panel UI and integrate agent management improvements

## [2026-06-14 06:27]

- refactor(ui): improve path matching logic for synchronization and expansion blocks

## [2026-06-12 01:54]

- feat(core): Update package versions and enhance agent/command flow

## [2026-06-11 05:15]

- feat(chat-panel): Implement code graph management and enhance guardian protocol

## [2026-06-08 00:56]

- feat(agent/context): Refine agent management and code graph linking

## [2026-06-05 09:12]

- feat(extension): Release v0.8.86 and implement core graph manager refinements

## [2026-06-04 00:34]

- feat: Release version 0.8.85 and adjust request timeout configuration

## [2026-06-03 23:18]

- feat(lollms-vs-coder): Update version and enhance chat panel/code graph functionality

## [2026-06-02 00:40]

- feat(skills): add ascii-colors skill suite and improve chat panel UX

## [2026-05-26 00:13]

- feat(release): bump version to 0.8.75 with chat panel and skills updates

## [2026-05-22 01:24]

- chore(release): bump version to 0.8.70

## [2026-05-15 22:40]

- fix(webview): add null safety and refine image asset dimensions handling

## [2026-05-15 14:57]

- feat(ui, tools, images): release v0.8.63 — chat panel overhaul, image asset tools, and agent system updates

## [2026-05-12 00:00]

- fix(chat): resolve agent mode state reset and polish UI for v0.8.62

## [2026-05-11 01:27]

- feat(chat): add Text-to-Image (TTI) support with model configuration

## [2026-05-08 13:22]

- chore(release): bump version to 0.8.61 and clean up codebase

## [2026-05-07 12:57]

- feat(chat): enhance agent mode with memory block rendering and verification rules

## [2026-05-05 00:07]

- release: version 0.8.58 with multi-area improvements

## [2026-05-04 19:54]

- feat(tools): enhance code tools diagnostics and Python interpreter setup

## [2026-05-04 00:23]

- refactor(core): bump v0.8.57 with chat UI, tool system and context management overhaul

## [2026-05-03 14:06]

- fix(agent): improve context amnesia detection and failure recovery messaging

## [2026-04-30 14:44]

- feat(chat): enhance webview event handling and improve system integration

## [2026-04-30 00:00]

- refactor(agent): implement agentic system overhaul with ReAct protocol

## [2026-04-29 08:54]

- chore(deps): Update package-lock.json dependencies

## [2026-04-29 08:53]

- feat: Update version and refine agent failure handling

## [2026-04-27 22:50]

- feat: Release 0.8.50 and update core agent and command registration

## [2026-04-26 22:29]

- feat(core): Implement Sovereign Architecture and Agent Management

## [2026-04-26 02:10]

- feat(agent/chat): Update version and refine agent/chat panel functionality

## [2026-04-25 15:24]

- Subject: feat(release): Update version and refactor agent/command system

## [2026-04-24 00:09]

- Refactor: Major structural updates and dependency bumps

## [2026-04-21 02:17]

- feat: add architecture analysis and improve chat panel stability

## [2026-04-19 02:06]

- Refactor: Update project dependencies, agent logic, and command panel UI

## [2026-04-14 07:05]

- feat: bump version to 0.8.3 with git dashboard and chat panel improvements

## [2026-04-13 19:27]

- feat(gui): enhance Git Dashboard with resizable panels and UI improvements

## [2026-04-13 12:59]

- **feat: Add project memory integration and Git Dashboard improvements**

## [2026-04-11 12:35]

- feat: update skills system with enhanced failure handling and author attribution

## [2026-04-10 01:04]

- feat: enhance code graph analysis and agent message handling

## [2026-04-07 10:07]

- feat: enhance context management and chat panel with improved system prompts

## [2026-04-06 11:05]

- chore: bump version to 0.7.38 with chat panel and provider improvements

## [2026-04-04 08:03]

- feat: enhance chat panel UI and message handling

## [2026-04-02 00:55]

- feat: release v0.7.35 with UI enhancements and command system improvements

## [2026-03-30 02:19]

- git commit -m "feat: v0.7.33 - enhance chat panel UI/events and core system integration

## [2026-03-25 07:47]

- feat: v0.7.27 - Add debug mode logging and UI refinements

## [2026-03-24 01:20]

- feat: add settings action and enhance chat panel UI/functionality

## [2026-03-22 12:30]

- feat: update chat panel UI styling and message rendering

## [2026-03-22 09:54]

- refactor: streamline chat panel, UI badges, and selection decorator

## [2026-03-21 23:25]

- feat: major version bump to 0.7.22 with extensive chat panel and core updates

## [2026-03-21 11:10]

- feat: bump version to 0.7.20 and enhance chat panel functionality

## [2026-03-19 00:43]

- feat: update chat panel UI, automation pipeline, and skill integrations

## [2026-03-16 07:21]

- feat: bump version to 0.7.13 and update Git dashboard integration

## [2026-03-16 01:16]

- Add robust path handling and enhance Git dashboard interactions

## [2026-03-15 23:30]

- feat: add changelog entry for v0.7.12 release

## [2026-03-15 23:30]

- feat: update to v0.7.12 with extensive enhancements

## [2026-03-15 02:20]

- feat: bump version to 0.7.10 and enhance chat panel functionality

## [2026-03-14 12:47]

- feat: bump version to 0.7.8 and update chat/help panel UI & logic

## [2026-03-12 07:01]

- feat: bump version to 0.7.7 and enhance Lollms VS Code integration

## [2026-03-09 02:21]

- **feat: bump version to 0.7.5 and overhaul chat panel UI & logic**

## [2026-03-08 02:48]

- feat: bump extension version to 0.7.2 and enhance core functionality

## [2026-03-05 08:14]

- **feat: bump version to 0.7.1 and enhance chat panel UI & capabilities**

## [2026-03-05 03:41]

- **feat: bump version to 0.7.0 and enhance chat panel UI**

## [2026-03-04 22:57]

- feat: improve skill management UI and remove unused export command

## [2026-03-04 14:28]

- feat: bump version to 0.6.24 and add extensive UI, command, and utility enhancements

## [2026-03-02 07:29]

- **feat: improve context handling and UI updates**

## [2026-03-01 21:36]

- feat: bump version to 0.6.20 and improve chat panel, big data processing, and tool integrations

## [2026-03-01 11:52]

- **chore: bump to v0.6.19 and update i18n strings**

## [2026-02-25 13:26]

- feat: bump version to 0.6.14 and enhance chat panel UI/logic

## [2026-02-23 14:26]

- **feat: Enhance chat panel UI and messaging workflow**

## [2026-02-23 02:56]

- **feat:** bump package version to 0.6.9 and enhance agent, chat panel, and tooling UI

## [2026-02-19 23:42]

- feat: bump to v0.6.8 – enhance chat panel and add Git integration

## [2026-02-19 23:42]

- feat: bump to v0.6.8 and enhance chat panel & Git integration

## [2026-02-18 00:27]

- feat: add discussion search command and UI

## [2026-02-17 22:50]

- feat(chat panel): improve UI, add webview handlers, and extend commands

## [2026-02-17 08:34]

- docs: add note to generate commit‑message block for future generations

## [2026-02-17 08:33]

- feat(chatPanel): bump to v0.6.3 and add active panel helper

## [2026-02-16 03:36]

- feat: bump to v0.6.2 and add extensive enhancements

## [2026-02-13 16:07]

- feat: bump version to 0.6.0 and revamp chat panel UI/logic

## [2026-02-13 09:26]

- refactor: overhaul lollms_apps skill XML

## [2026-02-13 09:21]

- chore: bump version to 0.5.99

## [2026-02-12 19:38]

- feat: add new built‑in tools and enhance chat panel UI

## [2026-02-11 16:03]

- feat: add Internet Help search feature and related UI

## [2026-02-11 00:55]

- feat: bump to v0.5.94, refactor chat panel and message rendering

## [2026-02-10 19:08]

- feat(chat-panel): improve UI layout, add DOM helpers and enhanced event handling

## [2026-02-10 11:04]

- chore: bump version to 0.5.93

## [2026-02-06 01:58]

- feat: bump to v0.5.91 and enhance chat panel UI & context handling

## [2026-02-05 22:37]

- chore: bump version to 0.5.90 and apply minor refactors

## [2026-02-05 11:27]

- feat: bump version to 0.5.89 and enhance chat panel, tools, and context handling

## [2026-02-04 00:05]

- chore: bump version to 0.5.87 and refactor chat panel & webview utilities

## [2026-02-01 16:13]

- chore: bump version to 0.5.82 and polish UI/logic

## [2026-01-31 22:36]

- chore: bump version to 0.5.79 and apply minor UI, config, and API fixes

## [2026-01-29 01:26]

- chore: bump version to 0.5.78

## [2026-01-28 21:12]

- feat: bump to v0.5.77, add RLM state handling and UI tweaks

## [2026-01-28 12:47]

- **feat: bump extension version to 0.5.75 and improve chat panel functionality**

## [2026-01-25 19:57]

- **feat: update chat panel UI and bump extension version**

## [2026-01-24 00:30]

- **feat: bump extension version and polish chat panel UI**

## [2026-01-23 08:47]

- **feat: bump to v0.5.70, enhance chat panel & context handling, add built‑in tools**

## [2026-01-20 08:08]

- chore: bump version to 0.5.67 and update chat panel UI

## [2026-01-18 13:22]

- chore(release): bump to v0.5.66 and update chat panel UI

## [2026-01-17 19:16]

- fix(chatPanel): replace broken emojis with proper icons

## [2026-01-17 08:46]

- chore(release): bump to 0.5.63 and update chat panel

## [2026-01-14 16:17]

- chore(release): bump version to 0.5.62 and update changelog

## [2026-01-14 09:35]

- refactor(contextManager): replace logStep with actionLog

## [0.5.4] - 2025-10-22

### ✨ Features

-   **Enhanced Code Graph**: The interactive code graph view has been significantly upgraded.
    -   **Multiple Views**: A new dropdown menu allows you to switch between different graph visualizations:
        -   **Call Graph**: The classic view showing function/method calls and file containment.
        -   **Import Graph**: A new view that visualizes the import relationships between files.
        -   **Class Diagram**: A simplified UML-style view showing classes, their methods, and the calls between them.
    -   **Interactive Metadata**: Hovering over any node (file, class, or function) in the graph now displays a tooltip with detailed information, including its type and documentation/docstring.

## [0.3.7] - 2025-09-24

### ✨ Features

-   **Enhanced Jupyter Notebook Support**: When `.ipynb` files are added to the context, they are now intelligently parsed. Instead of sending raw JSON, the extension extracts and formats code and markdown cells into a clean, readable format for the AI.

### 🐛 Bug Fixes & Polish

-   **Fixed Critical "Apply" Button Bug**: The "Apply" button on AI-generated file content now works reliably. It correctly creates or overwrites the target file, makes the change **undoable** (you can use `Ctrl+Z`), and automatically switches the editor to view the modified file.
-   **Fixed File Context Recognition**: The "AI Context Files" tree now correctly recognizes and displays `.vue` files and other text-based formats like `.ipynb` (Jupyter Notebooks), allowing them to be properly included in the AI's context.

## [0.3.6] - 2025-09-24

### ✨ Features

-   **Added Code Inspector**: A new "Inspect" button (🔍) appears on AI-generated code blocks.
-   **Security Analysis**: The inspector checks code for bugs, errors, vulnerabilities, and malicious content.
-   **Intelligent Feedback**: The inspector provides clear feedback: "OK" for safe code, automatic fixes for minor bugs, and detailed warnings for serious vulnerabilities or malicious code.
-   **Configurable Inspector**: New settings allow you to enable/disable the inspector, specify a separate model for security checks, and customize the inspection system prompt.

### 🐛 Bug Fixes & Polish

-   **Fixed**: The AI Agent now receives the user's OS (`win32`, `linux`, etc.) in its system prompt and is strictly instructed to generate OS-compatible scripts, preventing cross-platform errors.
-   **Improved**: The chat panel now adds an "Execute" button to Windows Batch (`.bat`, `.cmd`) code blocks.

## [0.3.5] - 2025-09-24

### 🐛 Bug Fixes & Polish

-   **Fixed**: Scripts executed from the chat panel now run from a temporary folder (`.lollms/temp_scripts`) within the workspace root, ensuring the correct working directory and preventing "No such file or directory" errors.
-   **Changed**: Replaced the "Generate Commit Message" text button in the Source Control panel with the Lollms icon for a cleaner UI.
-   **Improved**: Enhanced the system prompt for git commit message generation with stricter instructions to ensure more reliable and correctly formatted output, especially from smaller language models.

## [0.3.4] - 2025-09-24

### ✨ Features

-   **Added**: An **Execute** button (▶️) now appears on shell script code blocks (`bash`, `shell`, `sh`, `powershell`, `cmd`, `bat`) in the chat, allowing for direct execution.
-   **Added**: The script runner now supports PowerShell and Windows Batch/CMD scripts.
-   **Added**: The AI Agent can now use a `set_launch_entrypoint` action to programmatically set the main executable file in the project's `.vscode/launch.json`.
-   **Added**: The AI Agent can now use the `auto_select_context_files` action to intelligently select and add relevant files to its own context based on a sub-objective.

## [0.3.3] - 2025-09-24

### ✨ Features

-   **Added**: A new **Execute Project** button (▶️) has been added to the chat input area, allowing users to run the project using the active VS Code launch configuration.
-   **Added**: The extension now automatically analyzes the output of an executed project. If the exit code is non-zero, it prompts the AI to analyze the error and suggest a fix.
-   **Improved**: The "Auto-Select Context Files" command now seamlessly transitions into a new chat discussion, sending the user's objective to the AI with the newly selected files already in context.

## [0.3.2] - 2025-09-23

### ✨ Features & UI/UX Improvements

-   **Added**: A "Show Log" button (📜) now appears on assistant messages, allowing users to view the raw API request and response for debugging.
-   **Added**: A "Save as Prompt" button (💾) has been added to assistant messages for easily saving useful AI responses.
-   **Improved**: The sidebar view order has been reorganized to **Discussions**, **AI Context Files**, and then **Prompts**.
-   **Improved**: Prompt groups in the sidebar are now collapsed by default for a cleaner initial view.
-   **Improved**: Discussion title generation is now more robust, instructing the AI to return a JSON object to prevent it from answering the prompt directly.

## [0.3.0] - Agent Mode

### ✨ Features

-   **Introduced Agent Mode**: A powerful new mode where the AI can create and execute multi-step plans to achieve complex objectives.
-   **Execution Plan View**: The agent's plan is displayed dynamically in the chat, showing the status of each task (Pending, In Progress, Completed, Failed).
-   **Autonomous Self-Correction**: The agent can now analyze failures, revise its plan, and retry tasks without user intervention.
-   **User Intervention**: If the agent fails to self-correct, it will pause and ask the user for guidance (Stop, Continue, or View Log).

## [0.2.5] - Git Integration & Inline Suggestions

### ✨ Features

-   **Git Integration**: Added the ability to generate conventional commit messages based on staged or unstaged changes directly from the Source Control panel.
-   **Inline Autocomplete**: Introduced an experimental "ghost text" inline suggestion feature that provides single-line code completions as you type.
-   **Help Panel**: Added a comprehensive help panel accessible from the sidebar.
-   **Status Bar UI**: Added status bar items for quick access to starting a chat and selecting a model.

## [0.2.0] - Advanced Code Actions & Prompts

### ✨ Features

-   **Prompt Management**: Implemented a robust system for managing custom prompts, which are stored in a JSON file in the extension's global storage.
-   **AI-Powered Code Actions**: Added a "Lollms Actions..." CodeLens that appears over selected code, allowing users to apply AI actions like "Refactor", "Explain", and "Find Bugs".
-   **Inline Diff Viewer**: Code modification actions now present their suggestions in an inline diff view, with "Accept" and "Reject" options.
-   **Custom Action Modal**: Users can now create one-time custom prompts for code actions through a dedicated modal.
-   **Sidebar Prompt Views**: Added "Chat Prompts" and "Code Actions" tree views to the sidebar for organizing and accessing custom prompts.

## [0.1.0] - Initial Release

### ✨ Features

-   **Core Chat Functionality**: An integrated webview panel for conversational AI chat.
-   **Lollms API Integration**: Connects to any Lollms-compatible API for model inference.
-   **Settings Panel**: A dedicated UI for configuring the API URL, key, and model name.
-   **Discussion Management**: Chat sessions are saved as "Discussions" and can be viewed, reopened, and deleted from the sidebar.
-   **AI Context Management**: A file tree view in the sidebar allows users to manually select files and folders to be included in the AI's context.