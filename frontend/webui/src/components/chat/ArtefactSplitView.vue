<template>
  <div v-if="isVisible" class="h-full w-full flex flex-col bg-white dark:bg-gray-950 overflow-hidden relative">
    
    <!-- Top Workspace Master Toolbar -->
    <div class="px-3 py-2 border-b border-gray-200 dark:border-gray-800 bg-gray-50/90 dark:bg-gray-900/80 flex items-center justify-between gap-2 shrink-0 flex-wrap select-none z-10">
      
      <!-- Left: File Type Badge, Title, Unsaved Dot & Metrics -->
      <div class="flex items-center gap-2.5 min-w-0">
        <div class="px-2 py-0.5 rounded-md text-[10px] font-black uppercase tracking-wider font-mono border" :class="fileTypeBadgeClass">
          {{ fileTypeLabel }}
        </div>

        <div class="flex flex-col min-w-0">
          <div class="flex items-center gap-2">
            <h3 class="font-bold text-xs sm:text-sm text-gray-900 dark:text-white truncate max-w-[160px] sm:max-w-xs" :title="title">
              {{ title }}
            </h3>
            <span v-if="hasUnsavedChanges" class="flex h-2 w-2 relative" title="Unsaved changes (Ctrl+S)">
              <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
              <span class="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
            </span>
          </div>
          <span class="text-[10px] text-gray-400 font-mono leading-none">
            v{{ selectedVersion || 1 }} &middot; {{ wordCount }} words &middot; {{ (dbContent || '').length }} chars
          </span>
        </div>
      </div>

      <!-- Center & Right: Modes, Versions, LoLLMs Prompts & Actions -->
      <div class="flex items-center gap-1.5 sm:gap-2 shrink-0 flex-wrap">
        
        <!-- View Mode Selector (Split vs Code vs Live Preview) -->
        <div class="flex items-center bg-gray-200/70 dark:bg-gray-800 p-0.5 rounded-xl text-xs font-bold">
          <button 
            v-if="isRenderable"
            @click="activeViewMode = 'split'" 
            class="px-2.5 py-1 rounded-lg transition-all flex items-center gap-1 cursor-pointer"
            :class="activeViewMode === 'split' ? 'bg-white dark:bg-gray-700 text-purple-600 dark:text-purple-400 shadow-xs' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'"
            title="Side-by-side Code and Live Preview"
          >
            <span>Split</span>
          </button>
          <button 
            @click="activeViewMode = 'editor'" 
            class="px-2.5 py-1 rounded-lg transition-all flex items-center gap-1 cursor-pointer"
            :class="activeViewMode === 'editor' ? 'bg-white dark:bg-gray-700 text-blue-600 dark:text-blue-400 shadow-xs' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'"
            title="Code Editor Only"
          >
            <IconCode class="w-3.5 h-3.5" />
            <span class="hidden sm:inline">Code</span>
          </button>
          <button 
            v-if="isRenderable"
            @click="activeViewMode = 'preview'" 
            class="px-2.5 py-1 rounded-lg transition-all flex items-center gap-1 cursor-pointer"
            :class="activeViewMode === 'preview' ? 'bg-white dark:bg-gray-700 text-emerald-600 dark:text-emerald-400 shadow-xs' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'"
            :title="isHtml ? 'Interactive Canvas' : 'Document Preview'"
          >
            <IconEye class="w-3.5 h-3.5" />
            <span class="hidden sm:inline">{{ isHtml ? 'Canvas' : 'Preview' }}</span>
          </button>
        </div>

        <!-- Versions Selector -->
        <div v-if="artefactGroup && artefactGroup.versions.length > 1" class="flex items-center bg-gray-100 dark:bg-gray-800 rounded-lg px-2 py-1 gap-1.5">
          <span class="text-[9px] font-black text-gray-400 uppercase tracking-wider">Ver</span>
          <select v-model="selectedVersion" @change="loadVersion(selectedVersion)" class="bg-transparent border-none text-xs font-bold text-blue-600 dark:text-blue-400 focus:ring-0 p-0 pr-4 cursor-pointer">
            <option v-for="v in artefactGroup.versions" :key="v.version" :value="v.version">
              v{{ v.version }} {{ v.version === artefactGroup.versions[0].version ? '(Latest)' : '' }}
            </option>
          </select>
        </div>

        <!-- Prompt AI Changes Action (Ctrl+K) -->
        <button 
          @click="openAiPromptModal"
          class="btn btn-secondary btn-xs flex items-center gap-1 font-bold text-purple-600 dark:text-purple-300 hover:bg-purple-50 dark:hover:bg-purple-950/40"
          title="Ask LoLLMs to modify this code (Ctrl+K)"
        >
          <IconSparkles class="w-3.5 h-3.5 text-purple-500" />
          <span class="hidden md:inline">Prompt Changes</span>
        </button>

        <!-- Save Button -->
        <button 
          @click="handleSave()" 
          :disabled="isSaving || isLiveUpdating"
          class="btn btn-primary btn-xs flex items-center gap-1 shadow-sm"
          title="Save new version (Ctrl+S)"
        >
          <IconAnimateSpin v-if="isSaving" class="w-3.5 h-3.5 animate-spin" />
          <IconSave v-else class="w-3.5 h-3.5" />
          <span>Save v{{ (artefactGroup?.versions[0]?.version || 0) + 1 }}</span>
        </button>

        <!-- More Actions Dropdown Menu -->
        <DropdownMenu title="Actions" icon="menu" button-class="p-1.5 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200" collection="ui">
          <!-- Diff Inspection -->
          <button @click="openVersionDiff" class="menu-item">
            <IconClock class="w-4 h-4 mr-2 text-purple-500" />
            <span>Compare Version Diff</span>
          </button>
          <button @click="handleUndo" :disabled="artefactGroup?.versions.length < 2 || isSaving" class="menu-item">
            <IconArrowPath class="w-4 h-4 mr-2 text-blue-500" />
            <span>Quick Undo to Previous Version</span>
          </button>
          <button @click="handleCreateDiscussionFromVersion" class="menu-item">
            <IconGitBranch class="w-4 h-4 mr-2 text-emerald-500" />
            <span>Start New Chat with this Version</span>
          </button>
          <div class="menu-divider"></div>
          
          <!-- Exports -->
          <button v-for="fmt in exportFormats" :key="fmt.value" @click="handleExport(fmt.value)" class="menu-item">
            <IconArrowDownTray class="w-4 h-4 mr-2 text-gray-400" />
            <span>Export as {{ fmt.label }}</span>
          </button>
          <button @click="download" class="menu-item">
            <IconArrowDownTray class="w-4 h-4 mr-2 text-gray-500" />
            <span>Download Raw File</span>
          </button>
          <div class="menu-divider"></div>
          
          <!-- Library Exports -->
          <button @click="handlePushToLibrary('note')" class="menu-item">
            <IconPencil class="w-4 h-4 mr-2 text-amber-500" />
            <span>Save as Global Note</span>
          </button>
          <button @click="handlePushToLibrary('skill')" class="menu-item">
            <IconSparkles class="w-4 h-4 mr-2 text-teal-500" />
            <span>Save as Global Skill</span>
          </button>
          <button @click="handlePushToLibrary('saved')" class="menu-item">
            <IconFileText class="w-4 h-4 mr-2 text-blue-500" />
            <span>Save to Featured Library</span>
          </button>
        </DropdownMenu>

        <!-- Close Workspace -->
        <button @click="closeView" class="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors" title="Close Workspace">
          <IconXMark class="w-4 h-4" />
        </button>
      </div>
    </div>

    <!-- Live AI Generating Bar -->
    <div v-if="isLiveUpdating" class="h-1 bg-gradient-to-r from-blue-500 via-purple-500 to-indigo-500 w-full animate-pulse shrink-0"></div>

    <!-- Main Viewport Host -->
    <div class="flex-1 overflow-hidden relative flex flex-col bg-white dark:bg-gray-950">
      
      <!-- Loading Overlay -->
      <div v-if="isFetching" class="absolute inset-0 z-20 bg-white/70 dark:bg-gray-950/70 backdrop-blur-xs flex flex-col items-center justify-center">
        <IconAnimateSpin class="w-8 h-8 text-blue-500 animate-spin mb-2" />
        <span class="text-xs font-bold text-gray-500">Synchronizing file content...</span>
      </div>

      <!-- Error Screen -->
      <div v-else-if="loadError" class="absolute inset-0 flex flex-col items-center justify-center text-red-500 p-6 text-center z-20">
        <IconError class="w-12 h-12 mb-3 opacity-60" />
        <p class="text-sm font-bold">{{ loadError }}</p>
        <button @click="loadVersion(selectedVersion)" class="mt-4 btn btn-secondary btn-sm">Retry</button>
      </div>

      <!-- VIEW 1: DATA SPREADSHEET (CSV/DATA) -->
      <template v-else-if="isDataArtifact">
        <InteractiveDataGrid 
          :discussionId="discussionsStore.currentDiscussionId"
          :title="title"
          :version="selectedVersion"
          class="absolute inset-0 h-full w-full"
        />
      </template>

      <!-- VIEW 2: SPLIT MODE (Editor on Left, Live Canvas on Right) -->
      <template v-else-if="activeViewMode === 'split' && isRenderable">
        <div class="h-full w-full flex flex-col md:flex-row overflow-hidden relative">
          <!-- Left: Code Editor -->
          <div class="h-1/2 md:h-full w-full md:w-1/2 border-b md:border-b-0 md:border-r border-gray-200 dark:border-gray-800 flex flex-col overflow-hidden">
            <CodeMirrorEditor 
              v-model="dbContent" 
              :language="detectedLanguage"
              :renderable="false"
              class="h-full w-full border-none rounded-none"
              placeholder="Type or update code..."
            />
          </div>

          <!-- Right: Live Execution Canvas -->
          <div class="h-1/2 md:h-full w-full md:w-1/2 flex flex-col overflow-hidden bg-gray-50 dark:bg-gray-950 relative">
            <div class="px-3 py-1.5 border-b border-gray-200 dark:border-gray-800 bg-gray-100/60 dark:bg-gray-900/60 flex items-center justify-between text-xs select-none shrink-0">
              <div class="flex items-center gap-2">
                <span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                <span class="font-bold text-[10px] uppercase tracking-wider text-gray-500">Live Runtime</span>
              </div>
              <div class="flex items-center gap-1">
                <button @click="reloadSandbox" class="p-1 rounded text-gray-400 hover:text-blue-500" title="Reload Canvas (Ctrl+R)">
                  <IconRefresh class="w-3.5 h-3.5" :class="{ 'animate-spin': isReloadingSandbox }" />
                </button>
                <button @click="openInNewTab" class="p-1 rounded text-gray-400 hover:text-emerald-500" title="Open in New Tab">
                  <IconGlobeAlt class="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            <!-- Canvas Viewport -->
            <div class="flex-1 overflow-auto custom-scrollbar relative">
              <iframe 
                v-if="isHtml" 
                :key="sandboxKey"
                :srcdoc="dbContent" 
                class="w-full h-full border-0 bg-white" 
                sandbox="allow-scripts allow-forms allow-modals"
              ></iframe>
              <div v-else-if="isSvg" class="w-full h-full flex items-center justify-center p-6 bg-white dark:bg-gray-950 overflow-auto">
                <div v-html="dbContent" class="max-w-full max-h-full"></div>
              </div>
              <div v-else-if="isMermaid" class="w-full h-full p-4 overflow-auto">
                <MermaidViewer :mermaid-code="dbContent" />
              </div>
              <div v-else class="p-6 prose dark:prose-invert max-w-none">
                <MessageContentRenderer :content="dbContent" />
              </div>
            </div>
          </div>
        </div>
      </template>

      <!-- VIEW 3: FULL EDITOR ONLY -->
      <template v-else-if="activeViewMode === 'editor' || !isRenderable">
        <div class="h-full w-full">
          <CodeMirrorEditor 
            v-model="dbContent" 
            :language="detectedLanguage"
            :renderable="false"
            class="h-full w-full border-none rounded-none"
            placeholder="Type or update code..."
          />
        </div>
      </template>

      <!-- VIEW 4: FULL PREVIEW / RUN CANVAS -->
      <template v-else-if="activeViewMode === 'preview'">
        <div class="h-full w-full flex flex-col overflow-hidden bg-white dark:bg-gray-950">
          <div class="px-4 py-2 border-b border-gray-200 dark:border-gray-800 bg-gray-50/90 dark:bg-gray-900/90 flex items-center justify-between text-xs select-none shrink-0">
            <div class="flex items-center gap-2">
              <span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
              <span class="font-bold text-[10px] uppercase tracking-wider text-gray-500">
                {{ isHtml ? 'Sandboxed HTML5 / WebGL Canvas' : (isSvg ? 'Vector SVG Canvas' : 'Document Preview') }}
              </span>
            </div>

            <div class="flex items-center gap-2">
              <!-- Viewport Emulation Presets -->
              <div v-if="isHtml" class="flex items-center gap-0.5 bg-gray-200/70 dark:bg-gray-800 p-0.5 rounded-lg text-[10px] font-bold">
                <button @click="previewViewport = 'desktop'" class="px-2 py-0.5 rounded transition-colors" :class="previewViewport === 'desktop' ? 'bg-white dark:bg-gray-700 text-blue-600 shadow-2xs' : 'text-gray-500'">Desktop</button>
                <button @click="previewViewport = 'tablet'" class="px-2 py-0.5 rounded transition-colors" :class="previewViewport === 'tablet' ? 'bg-white dark:bg-gray-700 text-blue-600 shadow-2xs' : 'text-gray-500'">Tablet</button>
                <button @click="previewViewport = 'mobile'" class="px-2 py-0.5 rounded transition-colors" :class="previewViewport === 'mobile' ? 'bg-white dark:bg-gray-700 text-blue-600 shadow-2xs' : 'text-gray-500'">Mobile</button>
              </div>

              <button @click="reloadSandbox" class="btn btn-secondary btn-xs flex items-center gap-1">
                <IconRefresh class="w-3.5 h-3.5" :class="{ 'animate-spin': isReloadingSandbox }" />
                <span>Reload</span>
              </button>
              <button @click="openInNewTab" class="btn btn-secondary btn-xs flex items-center gap-1">
                <IconGlobeAlt class="w-3.5 h-3.5" />
                <span>New Tab</span>
              </button>
            </div>
          </div>

          <div class="flex-1 overflow-auto custom-scrollbar flex items-center justify-center p-2" :class="previewViewport !== 'desktop' ? 'bg-gray-200/50 dark:bg-gray-900/50' : ''">
            <div class="h-full transition-all duration-300 overflow-hidden shadow-sm"
                 :class="{
                   'w-full': previewViewport === 'desktop',
                   'w-[768px] border-2 border-gray-300 dark:border-gray-700 rounded-xl bg-white': previewViewport === 'tablet',
                   'w-[375px] border-2 border-gray-300 dark:border-gray-700 rounded-xl bg-white': previewViewport === 'mobile'
                 }">
              <iframe v-if="isHtml" :key="sandboxKey" :srcdoc="dbContent" class="w-full h-full border-0 bg-white" sandbox="allow-scripts allow-forms allow-modals"></iframe>
              <div v-else-if="isSvg" class="w-full h-full flex items-center justify-center p-8 bg-white dark:bg-gray-950 overflow-auto"><div v-html="dbContent" class="max-w-full max-h-full"></div></div>
              <div v-else-if="isMermaid" class="w-full h-full p-4 overflow-auto"><MermaidViewer :mermaid-code="dbContent" /></div>
              <div v-else class="p-8 max-w-4xl mx-auto prose dark:prose-invert"><MessageContentRenderer :content="dbContent" /></div>
            </div>
          </div>
        </div>
      </template>

    </div>

    <!-- Teleported Split Diff Comparison Modal -->
    <DiffViewerModal 
      :is-open="isDiffModalOpen"
      :original-text="diffOriginalContent"
      :modified-text="diffProposedContent"
      :title="`${title} &middot; Diff Comparison`"
      :language="detectedLanguage"
      :is-selection="false"
      @accept="handleAcceptDiff"
      @insert-below="handleInsertBelowDiff"
      @close="isDiffModalOpen = false"
    />

    <!-- Teleported AI Prompt to Change Modal -->
    <Teleport to="body">
      <div 
        v-if="isAiPromptModalOpen" 
        @click.self="isAiPromptModalOpen = false" 
        @keydown.esc="isAiPromptModalOpen = false"
        class="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150"
      >
        <div class="bg-white dark:bg-gray-800 w-full max-w-lg rounded-2xl shadow-2xl overflow-hidden border border-gray-200 dark:border-gray-700 flex flex-col animate-in zoom-in-95 duration-150">
          <div class="px-5 py-3.5 border-b dark:border-gray-700 flex items-center justify-between bg-gradient-to-r from-purple-600 to-indigo-600 text-white select-none">
            <div class="flex items-center gap-2.5">
              <IconSparkles class="w-4 h-4 text-amber-300" />
              <div>
                <h3 class="font-bold text-sm leading-tight">Prompt Changes &middot; {{ title }}</h3>
                <p class="text-[11px] opacity-80 mt-0.5">Describe what LoLLMs should modify (results reviewed in Split Diff)</p>
              </div>
            </div>
            <button @click="isAiPromptModalOpen = false" class="p-1 hover:bg-white/20 rounded-lg">
              <IconXMark class="w-5 h-5" />
            </button>
          </div>

          <div class="p-5 space-y-4">
            <div>
              <label class="block text-xs font-bold uppercase tracking-wider text-gray-500 mb-1.5">
                Instructions for LoLLMs:
              </label>
              <textarea 
                ref="aiPromptInputRef"
                v-model="aiPromptQuery"
                @keydown.enter.exact.prevent="submitAiPromptChange"
                rows="3"
                class="input-field w-full text-xs leading-relaxed resize-none py-2.5"
                placeholder="e.g. Add a reset button, change lighting colors, fix rotation logic..."
              ></textarea>
              <p class="text-[10px] text-gray-400 mt-1 flex items-center justify-between">
                <span>Press <kbd class="px-1 py-0.5 rounded bg-gray-100 dark:bg-gray-700 font-mono">Enter</kbd> to generate</span>
                <span><kbd class="px-1 py-0.5 rounded bg-gray-100 dark:bg-gray-700 font-mono">Shift+Enter</kbd> for newline</span>
              </p>
            </div>

            <!-- Quick Template Suggestions -->
            <div>
              <span class="text-[10px] font-bold uppercase tracking-wider text-gray-400 block mb-1.5">Quick Suggestions:</span>
              <div class="flex flex-wrap gap-1.5">
                <button 
                  v-for="sug in quickSuggestions" 
                  :key="sug"
                  type="button" 
                  @click="aiPromptQuery = sug; aiPromptInputRef?.focus()"
                  class="px-2 py-1 rounded-lg text-[11px] font-medium bg-gray-100 dark:bg-gray-700/60 hover:bg-purple-100 dark:hover:bg-purple-950/40 text-gray-700 dark:text-gray-300 hover:text-purple-700 dark:hover:text-purple-300 border border-gray-200 dark:border-gray-600 transition-colors"
                >
                  {{ sug }}
                </button>
              </div>
            </div>
          </div>

          <div class="px-5 py-3 border-t dark:border-gray-700 bg-gray-50/70 dark:bg-gray-850/70 flex items-center justify-between select-none">
            <button type="button" @click="isAiPromptModalOpen = false" class="btn btn-secondary btn-xs">Cancel</button>
            <button 
              type="button" 
              @click="submitAiPromptChange" 
              :disabled="!aiPromptQuery.trim() || isAiGenerating"
              class="btn btn-primary btn-xs px-4 flex items-center gap-1.5 shadow-sm bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white font-bold"
            >
              <IconAnimateSpin v-if="isAiGenerating" class="w-3.5 h-3.5 animate-spin" />
              <IconSparkles v-else class="w-3.5 h-3.5 text-amber-300" />
              <span>Generate & Inspect Diff</span>
            </button>
          </div>
        </div>
      </div>
    </Teleport>

  </div>

  <!-- EMPTY WORKSPACE HUB -->
  <div v-else class="h-full flex flex-col items-center justify-center p-6 text-center bg-gray-50 dark:bg-gray-900 overflow-y-auto custom-scrollbar">
    <div class="max-w-md w-full space-y-6 animate-in fade-in zoom-in-95 duration-200">
      <div class="space-y-2">
        <div class="w-14 h-14 rounded-2xl bg-gradient-to-tr from-purple-600 to-indigo-600 text-white flex items-center justify-center mx-auto shadow-lg shadow-purple-500/20">
          <IconCode class="w-7 h-7" />
        </div>
        <h3 class="text-lg font-black text-gray-900 dark:text-white tracking-tight">Workspace Studio</h3>
        <p class="text-xs text-gray-500 max-w-sm mx-auto">
          Build, inspect, and run code and documents side-by-side with real-time AI assistance.
        </p>
      </div>

      <!-- Quick Open from Current Discussion -->
      <div v-if="discussionArtefacts.length > 0" class="p-4 bg-white dark:bg-gray-800 rounded-2xl border border-gray-200/80 dark:border-gray-700 shadow-xs space-y-2.5 text-left">
        <span class="text-[10px] font-black uppercase tracking-wider text-gray-400 block px-1">Open File in Discussion</span>
        <div class="space-y-1.5 max-h-48 overflow-y-auto custom-scrollbar pr-1">
          <div 
            v-for="art in discussionArtefacts" 
            :key="art.title"
            @click="openSpecificArtefact(art.title)"
            class="flex items-center justify-between p-2 rounded-xl hover:bg-gray-100 dark:hover:bg-gray-700/60 transition-colors cursor-pointer border border-transparent hover:border-gray-200 dark:hover:border-gray-600"
          >
            <div class="flex items-center gap-2.5 min-w-0">
              <span class="text-xs">📄</span>
              <span class="text-xs font-bold text-gray-800 dark:text-gray-200 truncate">{{ art.title }}</span>
            </div>
            <span class="text-[10px] font-mono px-2 py-0.5 rounded-md bg-purple-50 text-purple-600 dark:bg-purple-950/40 dark:text-purple-300 font-bold shrink-0">
              Open &rarr;
            </span>
          </div>
        </div>
      </div>

      <!-- Starter Templates -->
      <div class="space-y-2 text-left">
        <span class="text-[10px] font-black uppercase tracking-wider text-gray-400 block px-1">Starter Templates</span>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          <button @click="createFromTemplate('html')" class="p-3 bg-white dark:bg-gray-800 hover:bg-orange-50/50 dark:hover:bg-orange-950/20 border border-gray-200 dark:border-gray-700 rounded-xl transition-all text-left flex items-start gap-2.5 cursor-pointer">
            <span class="text-xl shrink-0">🌐</span>
            <div class="min-w-0">
              <h4 class="text-xs font-bold text-gray-900 dark:text-white">3D Web App (HTML5)</h4>
              <p class="text-[10px] text-gray-500 mt-0.5">Three.js / WebGL canvas</p>
            </div>
          </button>

          <button @click="createFromTemplate('python')" class="p-3 bg-white dark:bg-gray-800 hover:bg-blue-50/50 dark:hover:bg-blue-950/20 border border-gray-200 dark:border-gray-700 rounded-xl transition-all text-left flex items-start gap-2.5 cursor-pointer">
            <span class="text-xl shrink-0">🐍</span>
            <div class="min-w-0">
              <h4 class="text-xs font-bold text-gray-900 dark:text-white">Python Script</h4>
              <p class="text-[10px] text-gray-500 mt-0.5">Runs via in-browser Pyodide</p>
            </div>
          </button>

          <button @click="createFromTemplate('svg')" class="p-3 bg-white dark:bg-gray-800 hover:bg-purple-50/50 dark:hover:bg-purple-950/20 border border-gray-200 dark:border-gray-700 rounded-xl transition-all text-left flex items-start gap-2.5 cursor-pointer">
            <span class="text-xl shrink-0">🎨</span>
            <div class="min-w-0">
              <h4 class="text-xs font-bold text-gray-900 dark:text-white">SVG Graphic</h4>
              <p class="text-[10px] text-gray-500 mt-0.5">Vector illustration & diagram</p>
            </div>
          </button>

          <button @click="createFromTemplate('mermaid')" class="p-3 bg-white dark:bg-gray-800 hover:bg-teal-50/50 dark:hover:bg-teal-950/20 border border-gray-200 dark:border-gray-700 rounded-xl transition-all text-left flex items-start gap-2.5 cursor-pointer">
            <span class="text-xl shrink-0">📊</span>
            <div class="min-w-0">
              <h4 class="text-xs font-bold text-gray-900 dark:text-white">Mermaid Diagram</h4>
              <p class="text-[10px] text-gray-500 mt-0.5">Flowcharts & architectures</p>
            </div>
          </button>
        </div>
      </div>

      <div class="pt-2">
        <button @click="uiStore.dataZoneTab = 'files'" class="btn btn-secondary btn-xs">
          Browse All Discussion Files &rarr;
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch, onMounted, onUnmounted, nextTick } from 'vue';
import { useUiStore } from '../../stores/ui';
import { useDiscussionsStore } from '../../stores/discussions';
import { useNotesStore } from '../../stores/notes';
import { useSkillsStore } from '../../stores/skills';
import { useAuthStore } from '../../stores/auth';
import { useDataStore } from '../../stores/data';
import { usePyodideStore } from '../../stores/pyodide';
import CodeMirrorEditor from '../ui/CodeMirrorComponent/index.vue';
import DiffViewerModal from '../ui/CodeMirrorComponent/DiffViewerModal.vue';
import MermaidViewer from '../modals/InteractiveMermaid.vue';
import MessageContentRenderer from '../ui/MessageContentRenderer/MessageContentRenderer.vue';
import InteractiveDataGrid from '../ui/DataGrid/InteractiveDataGrid.vue';
import DropdownMenu from '../ui/DropdownMenu/DropdownMenu.vue';
import apiClient from '../../services/api';
import { oneDark } from '@codemirror/theme-one-dark';

// Icons
import IconXMark from '../../assets/icons/IconXMark.vue';
import IconArrowDownTray from '../../assets/icons/IconArrowDownTray.vue';
import IconRefresh from '../../assets/icons/IconRefresh.vue';
import IconPencil from '../../assets/icons/IconPencil.vue';
import IconArrowPath from '../../assets/icons/IconArrowPath.vue';
import IconClock from '../../assets/icons/IconClock.vue';
import IconGitBranch from '../../assets/icons/ui/IconGitBranch.vue';
import IconError from '../../assets/icons/IconError.vue';
import IconSparkles from '../../assets/icons/IconSparkles.vue';
import IconAnimateSpin from '../../assets/icons/IconAnimateSpin.vue';
import IconCode from '../../assets/icons/IconCode.vue';
import IconEye from '../../assets/icons/IconEye.vue';
import IconFileText from '../../assets/icons/IconFileText.vue';
import IconSave from '../../assets/icons/IconSave.vue';
import IconGlobeAlt from '../../assets/icons/IconGlobeAlt.vue';

const uiStore = useUiStore();
const authStore = useAuthStore();
const discussionsStore = useDiscussionsStore();
const notesStore = useNotesStore();
const skillsStore = useSkillsStore();
const dataStore = useDataStore();
const pyodideStore = usePyodideStore();

const title = computed(() => uiStore.activeSplitArtefactTitle);
const isVisible = computed(() => !!title.value);

// View State
const activeViewMode = ref('split');
const selectedVersion = ref(null);
const dbContent = ref('');
const pristineContent = ref('');
const isSaving = ref(false);
const isFetching = ref(false);
const loadError = ref(null);

// Live Sandbox State
const sandboxKey = ref(0);
const isReloadingSandbox = ref(false);
const previewViewport = ref('desktop');

// Diff Modal State
const isDiffModalOpen = ref(false);
const diffOriginalContent = ref('');
const diffProposedContent = ref('');

// AI Custom Prompt Changes State
const isAiPromptModalOpen = ref(false);
const aiPromptQuery = ref('');
const aiPromptInputRef = ref(null);
const isAiGenerating = ref(false);

const hasUnsavedChanges = computed(() => {
    return dbContent.value !== pristineContent.value;
});

const wordCount = computed(() => {
    const text = dbContent.value || '';
    return text.trim() ? text.trim().split(/\s+/).length : 0;
});

const discussionArtefacts = computed(() => {
    return discussionsStore.activeDiscussionArtefacts || [];
});

const isLiveUpdating = computed(() => {
    if (!title.value || !discussionsStore.activeUpdatingArtefacts) return false;
    if (typeof discussionsStore.activeUpdatingArtefacts.has !== 'function') return false;
    return discussionsStore.activeUpdatingArtefacts.has(title.value);
});

const artefactGroup = computed(() => {
    if (!title.value) return null;
    const isSaved = discussionsStore.currentDiscussionId === 'saved';
    const all = isSaved ? (discussionsStore.allUserArtefacts || []) : (discussionsStore.activeDiscussionArtefacts || []);
    const versions = all.filter(a => a.title === title.value).sort((a, b) => b.version - a.version);
    return versions.length > 0 ? { title: title.value, versions } : null;
});

const isDataArtifact = computed(() => {
    return artefactGroup.value?.versions[0]?.artefact_type === 'data';
});

// Content Type Detection
const isHtml = computed(() => {
    const t = (title.value || '').toLowerCase();
    const c = (dbContent.value || '').toLowerCase();
    return t.endsWith('.html') || t.endsWith('.htm') || c.includes('<!doctype') || c.includes('<html');
});

const isSvg = computed(() => {
    const t = (title.value || '').toLowerCase();
    return t.endsWith('.svg') || (dbContent.value || '').trim().startsWith('<svg');
});

const isMermaid = computed(() => {
    const t = (title.value || '').toLowerCase();
    return t.endsWith('.mmd') || t.endsWith('.mermaid') || (dbContent.value || '').startsWith('graph ') || (dbContent.value || '').startsWith('sequenceDiagram');
});

const isMarkdown = computed(() => {
    const t = (title.value || '').toLowerCase();
    return t.endsWith('.md') || t.endsWith('.markdown');
});

const isPython = computed(() => (title.value || '').toLowerCase().endsWith('.py'));
const isJs = computed(() => {
    const t = (title.value || '').toLowerCase();
    return t.endsWith('.js') || t.endsWith('.ts');
});

const isRenderable = computed(() => isHtml.value || isSvg.value || isMermaid.value || isMarkdown.value);

const fileTypeLabel = computed(() => {
    if (isHtml.value) return 'HTML5';
    if (isPython.value) return 'Python';
    if (isJs.value) return 'JS/TS';
    if (isSvg.value) return 'SVG';
    if (isMermaid.value) return 'Mermaid';
    if (isMarkdown.value) return 'Markdown';
    return 'Document';
});

const fileTypeBadgeClass = computed(() => {
    if (isHtml.value) return 'bg-orange-50 dark:bg-orange-950/40 text-orange-600 dark:text-orange-400 border-orange-200 dark:border-orange-800';
    if (isPython.value) return 'bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 border-blue-200 dark:border-blue-800';
    if (isJs.value) return 'bg-yellow-50 dark:bg-yellow-950/40 text-yellow-700 dark:text-yellow-400 border-yellow-200 dark:border-yellow-800';
    if (isSvg.value) return 'bg-purple-50 dark:bg-purple-950/40 text-purple-600 dark:text-purple-400 border-purple-200 dark:border-purple-800';
    if (isMermaid.value) return 'bg-teal-50 dark:bg-teal-950/40 text-teal-600 dark:text-teal-400 border-teal-200 dark:border-teal-800';
    return 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800';
});

const detectedLanguage = computed(() => {
    if (isHtml.value) return 'html';
    if (isPython.value) return 'python';
    if (isJs.value) return 'javascript';
    if (isSvg.value) return 'xml';
    if (isMermaid.value) return 'mermaid';
    return 'markdown';
});

const exportFormats = computed(() => {
    const formats = [];
    if (authStore.export_to_txt_enabled) formats.push({ label: 'Text (.txt)', value: 'txt' });
    if (authStore.export_to_markdown_enabled) formats.push({ label: 'Markdown (.md)', value: 'md' });
    if (authStore.export_to_html_enabled) formats.push({ label: 'HTML (.html)', value: 'html' });
    if (authStore.export_to_pdf_enabled) formats.push({ label: 'PDF (.pdf)', value: 'pdf' });
    if (authStore.export_to_docx_enabled) formats.push({ label: 'Word (.docx)', value: 'docx' });
    return formats;
});

const quickSuggestions = computed(() => {
    if (isHtml.value) {
        return [
            'Add a reset orientation button',
            'Improve colors, lighting and shadow',
            'Make layout responsive for mobile',
            'Add smooth animations and transitions',
            'Fix rotation controls'
        ];
    }
    if (isPython.value) {
        return [
            'Add error handling and typing',
            'Optimize algorithmic efficiency',
            'Refactor into modular classes',
            'Add pytest unit tests'
        ];
    }
    return [
        'Improve phrasing and clarity',
        'Structure with clean headings',
        'Fix grammar and syntax',
        'Add an executive summary'
    ];
});

async function loadVersion(v) {
    if (!title.value || v === null) return;
    isFetching.value = true;
    try {
        const data = await discussionsStore.fetchArtefactContent({
            discussionId: discussionsStore.currentDiscussionId,
            artefactTitle: title.value,
            version: v,
            strategy: 'raw'
        });
        
        let raw = '';
        if (typeof data === 'string') raw = data;
        else if (data && typeof data === 'object') raw = data.content ?? '';
        
        const isVueAppHtml = raw.includes('id="app"') && (raw.includes('/ui_assets/') || raw.includes('index-'));
        if (isVueAppHtml) {
            loadError.value = 'API routing error: Static file handler intercepted the request.';
            dbContent.value = '';
            pristineContent.value = '';
            return;
        }

        loadError.value = null;
        let cleaned = raw.trim();
        const headerPattern = /^--- (Document|Skill|Note|Artefact): .*? ---/i;
        const footerPattern = /--- End (Document|Skill|Note|Artefact)(?:: .*?)? ---$/i;
        cleaned = cleaned.replace(headerPattern, '').replace(footerPattern, '').trim();

        dbContent.value = cleaned;
        pristineContent.value = cleaned;
    } catch (err) {
        loadError.value = 'Failed to load artefact content.';
        dbContent.value = '';
        pristineContent.value = '';
    } finally {
        isFetching.value = false;
    }
}

// Watch active artefact title & version changes
const watcherKey = computed(() => {
    if (!artefactGroup.value) return null;
    return `${artefactGroup.value.title}-${artefactGroup.value.versions.length}`;
});

watch(watcherKey, async (newVal, oldVal) => {
    if (!newVal) {
        dbContent.value = '';
        pristineContent.value = '';
        selectedVersion.value = null;
        return;
    }

    const group = artefactGroup.value;
    if (!group) return;

    const isNewFile = !oldVal || newVal.split('-')[0] !== oldVal.split('-')[0];
    if (isNewFile) {
        dbContent.value = '';
        pristineContent.value = '';
    }

    const latest = group.versions[0]?.version;
    if (!latest) {
        dbContent.value = '';
        pristineContent.value = '';
        selectedVersion.value = 1;
        return;
    }

    selectedVersion.value = latest;
    await loadVersion(latest);
}, { immediate: true });

async function handleSave(forceType = null) {
    if (isLiveUpdating.value) return;
    isSaving.value = true;
    try {
        await discussionsStore.updateArtefact({
            discussionId: discussionsStore.currentDiscussionId,
            artefactTitle: title.value,
            newContent: dbContent.value,
            artefactType: forceType || undefined,
            updateInPlace: false
        });

        pristineContent.value = dbContent.value;

        if (discussionsStore.currentDiscussionId !== 'saved') {
            await discussionsStore.fetchContextStatus(discussionsStore.currentDiscussionId);
        }

        uiStore.addNotification(forceType ? `Converted to ${forceType}.` : "New version saved.", "success");
    } finally {
        isSaving.value = false;
    }
}

async function handleUndo() {
    if (!artefactGroup.value || artefactGroup.value.versions.length < 2) return;
    const prevVersion = artefactGroup.value.versions[1].version;
    await discussionsStore.revertArtefact({
        discussionId: discussionsStore.currentDiscussionId,
        artefactTitle: title.value,
        version: prevVersion
    });
    selectedVersion.value = prevVersion;
    await loadVersion(prevVersion);
}

async function handleCreateDiscussionFromVersion() {
    if (!selectedVersion.value || !title.value) return;
    const confirmed = await uiStore.showConfirmation({
        title: 'Start New Chat?',
        message: `Create a new discussion and pre-load it with v${selectedVersion.value} of "${title.value}"?`,
        confirmText: 'Start Chat'
    });
    if (confirmed.confirmed) {
        await discussionsStore.createDiscussionWithArtefactVersion({
            discussionId: discussionsStore.currentDiscussionId,
            artefactTitle: title.value,
            version: selectedVersion.value
        });
    }
}

async function handleExport(format) {
    if (!dbContent.value) {
        uiStore.addNotification("Nothing to export.", "warning");
        return;
    }
    discussionsStore.exportRawContent({ 
        content: dbContent.value, 
        format,
        filename: title.value || 'workspace_export'
    });
}

function download() {
    if (!dbContent.value) return;
    const blob = new Blob([dbContent.value], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = title.value || 'document.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

async function handlePushToLibrary(type) {
    if (!dbContent.value) return;
    isSaving.value = true;
    try {
        if (type === 'saved') {
            await discussionsStore.saveArtefactToLibrary({
                discussionId: discussionsStore.currentDiscussionId,
                artefactTitle: title.value,
                version: selectedVersion.value
            });
            uiStore.addNotification("Saved to global Featured Library.", "success");
        } else if (type === 'note') {
            const cleanTitle = title.value.replace(/\.[^/.]+$/, '');
            await notesStore.createNote({ title: cleanTitle, content: dbContent.value });
            await notesStore.fetchNotes();
            uiStore.addNotification("Saved to global Notes Library.", "success");
        } else if (type === 'skill') {
            const cleanTitle = title.value.replace(/\.[^/.]+$/, '');
            await skillsStore.createSkill({
                name: cleanTitle,
                content: dbContent.value,
                category: artefactGroup.value?.versions[0]?.category || 'General',
                description: `Skill: ${cleanTitle}`
            });
            await skillsStore.fetchSkills();
            uiStore.addNotification("Saved to global Skills Library.", "success");
        }
    } finally {
        isSaving.value = false;
    }
}

function reloadSandbox() {
    isReloadingSandbox.value = true;
    sandboxKey.value++;
    setTimeout(() => { isReloadingSandbox.value = false; }, 350);
}

function openInNewTab() {
    if (!dbContent.value) return;
    const mime = isHtml.value ? 'text/html' : (isSvg.value ? 'image/svg+xml' : 'text/plain');
    const blob = new Blob([dbContent.value], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 600000);
}

function openVersionDiff() {
    if (artefactGroup.value && artefactGroup.value.versions.length > 1) {
        const prev = artefactGroup.value.versions[1];
        diffOriginalContent.value = prev.content || pristineContent.value;
    } else {
        diffOriginalContent.value = pristineContent.value;
    }
    diffProposedContent.value = dbContent.value;
    isDiffModalOpen.value = true;
}

function handleAcceptDiff() {
    isDiffModalOpen.value = false;
    handleSave();
}

function handleInsertBelowDiff() {
    isDiffModalOpen.value = false;
}

function openAiPromptModal() {
    aiPromptQuery.value = '';
    isAiPromptModalOpen.value = true;
    nextTick(() => { aiPromptInputRef.value?.focus(); });
}

async function submitAiPromptChange() {
    const query = aiPromptQuery.value.trim();
    if (!query || isAiGenerating.value) return;

    isAiPromptModalOpen.value = false;
    isAiGenerating.value = true;

    const lang = detectedLanguage.value || 'text';
    const prompt = `You are LoLLMs AI Senior Software Architect.
File Title: ${title.value}
Language/Type: ${lang}

<file_context>
${dbContent.value}
</file_context>

User Instruction:
${query}

Instructions:
1. Provide the complete modified code for the entire file.
2. Output ONLY the code inside a single \`\`\`${lang} ... \`\`\` block.
3. Keep the implementation 100% complete with zero placeholders.`;

    try {
        uiStore.addNotification(`LoLLMs is generating: ${query}...`, 'info', 3500);
        const res = await apiClient.post('/api/lollms/generate', {
            prompt,
            max_new_tokens: 4096,
            temperature: 0.2
        }, {
            timeout: 600000 // 10-minute timeout for large artefact revisions
        });

        const rawResult = res.data?.generated_text || '';
        const match = rawResult.match(/```(?:\w+)?\r?\n([\s\S]*?)```/);
        const cleanCode = match ? match[1].trimEnd() : rawResult.trim();

        if (cleanCode) {
            diffOriginalContent.value = dbContent.value;
            diffProposedContent.value = cleanCode;
            isDiffModalOpen.value = true;
            dbContent.value = cleanCode;
            reloadSandbox();
        }
    } catch (e) {
        console.error("AI prompt changes failed:", e);
        if (e.code === 'ECONNABORTED' || e.message?.includes('timeout')) {
            uiStore.addNotification('Generation timed out. Try selecting a specific code block or using a faster model.', 'warning', 7000);
        } else {
            uiStore.addNotification(e.response?.data?.detail || 'AI code generation failed.', 'error');
        }
    } finally {
        isAiGenerating.value = false;
    }
}

function closeView() {
    uiStore.activeSplitArtefactTitle = null;
    uiStore.dataZoneTab = 'files';
}

function openSpecificArtefact(artTitle) {
    uiStore.activeSplitArtefactTitle = artTitle;
}

async function createFromTemplate(templateType) {
    const discussionId = discussionsStore.currentDiscussionId;
    if (!discussionId) {
        uiStore.addNotification('Please select or start a discussion first.', 'warning');
        return;
    }

    let artTitle = '';
    let content = '';
    let artType = 'document';

    if (templateType === 'html') {
        artTitle = `canvas_app_${Date.now().toString(36)}.html`;
        artType = 'html';
        content = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Interactive 3D Scene</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #0f172a; color: #f8fafc; font-family: system-ui, sans-serif; overflow: hidden; height: 100vh; }
    #canvas-container { width: 100vw; height: 100vh; display: block; }
    .overlay { position: fixed; top: 20px; left: 20px; background: rgba(15, 23, 42, 0.85); padding: 16px; border-radius: 12px; border: 1px solid #334155; }
    button { background: #3b82f6; color: white; border: none; padding: 8px 16px; border-radius: 6px; font-weight: bold; cursor: pointer; }
    button:hover { background: #2563eb; }
  </style>
</head>
<body>
  <div class="overlay">
    <h2>Interactive 3D Sandbox</h2>
    <p style="font-size: 12px; color: #94a3b8; margin-bottom: 8px;">Rendered via Three.js</p>
    <button onclick="toggleRotate()">Toggle Spin</button>
  </div>
  <div id="canvas-container"></div>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"><\/script>
  <script>
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.getElementById('canvas-container').appendChild(renderer.domElement);

    const geometry = new THREE.BoxGeometry(1.5, 1.5, 1.5);
    const material = new THREE.MeshStandardMaterial({ color: 0x6366f1, metalness: 0.3, roughness: 0.4 });
    const cube = new THREE.Mesh(geometry, material);
    scene.add(cube);

    const light = new THREE.DirectionalLight(0xffffff, 1.2);
    light.position.set(5, 5, 5);
    scene.add(light);
    scene.add(new THREE.AmbientLight(0xffffff, 0.4));
    camera.position.z = 4;

    let rotating = true;
    function toggleRotate() { rotating = !rotating; }
    function animate() {
      requestAnimationFrame(animate);
      if (rotating) { cube.rotation.x += 0.01; cube.rotation.y += 0.015; }
      renderer.render(scene, camera);
    }
    animate();
  <\/script>
</body>
</html>`;
    } else if (templateType === 'python') {
        artTitle = `script_${Date.now().toString(36)}.py`;
        artType = 'code';
        content = `"""
LoLLMs Python Sandbox Script
Runnable directly via in-browser Pyodide.
"""

def fibonacci(n: int) -> list[int]:
    sequence = [0, 1]
    while len(sequence) < n:
        sequence.append(sequence[-1] + sequence[-2])
    return sequence[:n]

if __name__ == "__main__":
    count = 15
    print(f"Generated first {count} Fibonacci numbers:")
    print(fibonacci(count))
`;
    } else if (templateType === 'svg') {
        artTitle = `vector_graphic_${Date.now().toString(36)}.svg`;
        artType = 'image';
        content = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="100%" height="100%">
  <defs>
    <linearGradient id="grad1" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#8b5cf6;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#3b82f6;stop-opacity:1" />
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="#0f172a" rx="20"/>
  <circle cx="200" cy="200" r="120" fill="url(#grad1)" opacity="0.9"/>
  <text x="200" y="210" font-family="system-ui, sans-serif" font-size="22" font-weight="bold" fill="#ffffff" text-anchor="middle">LoLLMs Vector</text>
</svg>`;
    } else if (templateType === 'mermaid') {
        artTitle = `diagram_${Date.now().toString(36)}.mmd`;
        artType = 'document';
        content = `graph TD
    A[Client UI] -->|WebSocket / HTTP| B[FastAPI Gateway]
    B --> C{Dispatcher}
    C -->|Text Gen| D[LLM Engine]
    C -->|Vector Index| E[SafeStore RAG]
    C -->|Interactive Canvas| F[Workspace Sandbox]
`;
    }

    try {
        isFetching.value = true;
        await discussionsStore.createArtefactManual({
            discussionId,
            title: artTitle,
            content,
            type: artType
        });
        uiStore.activeSplitArtefactTitle = artTitle;
        activeViewMode.value = (templateType === 'html' || templateType === 'svg' || templateType === 'mermaid') ? 'split' : 'editor';
        uiStore.addNotification(`Created '${artTitle}' from template.`, 'success');
    } finally {
        isFetching.value = false;
    }
}

function handleGlobalKeydown(e) {
    if (!isVisible.value) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (hasUnsavedChanges.value) handleSave();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'r' && (activeViewMode.value === 'split' || activeViewMode.value === 'preview')) {
        e.preventDefault();
        reloadSandbox();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        openAiPromptModal();
    }
}

onMounted(() => {
    window.addEventListener('keydown', handleGlobalKeydown);
});

onUnmounted(() => {
    window.removeEventListener('keydown', handleGlobalKeydown);
});
</script>

<style scoped>
@reference "tailwindcss";

.custom-scrollbar::-webkit-scrollbar {
    width: 6px;
    height: 6px;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
    @apply bg-gray-300 dark:bg-gray-700 rounded-full;
}
</style>