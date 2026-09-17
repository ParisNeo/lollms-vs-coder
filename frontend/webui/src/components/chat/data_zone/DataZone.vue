<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useUiStore } from '../../../stores/ui';
import { useDiscussionsStore } from '../../../stores/discussions';

// Views
import DiscussionZone from './DiscussionZone.vue';
import PersonalityZone from './PersonalityZone.vue';
import MemoryZone from './MemoryZone.vue';
import ArtefactZone from './ArtefactZone.vue';
import ArtefactSplitView from '../ArtefactSplitView.vue';

// Icons
import IconMaximize from '../../../assets/icons/IconMaximize.vue';
import IconMinimize from '../../../assets/icons/IconMinimize.vue';
import IconChevronDown from '../../../assets/icons/IconChevronDown.vue';
import IconXMark from '../../../assets/icons/IconXMark.vue';
import IconDataZone from '../../../assets/icons/IconDataZone.vue';
import IconSparkles from '../../../assets/icons/IconSparkles.vue';
import IconThinking from '../../../assets/icons/IconThinking.vue';
import IconFolder from '../../../assets/icons/IconFolder.vue';
import IconPencil from '../../../assets/icons/IconPencil.vue';
import IconCode from '../../../assets/icons/IconCode.vue';

const uiStore = useUiStore();
const discussionsStore = useDiscussionsStore();
const { liveDataZoneTokens, activeDiscussionArtefacts } = storeToRefs(discussionsStore);

const storedWidth = parseInt(localStorage.getItem('lollms_unifiedWidth'), 10);
const dataZoneWidth = ref(storedWidth && storedWidth >= 400 ? storedWidth : 680);
const isResizing = ref(false);
const windowWidth = ref(window.innerWidth);

function updateWindowWidth() {
    windowWidth.value = window.innerWidth;
}

const isDataZoneExpanded = computed(() => uiStore.isDataZoneExpanded);
const activeTab = computed({
    get: () => uiStore.dataZoneTab,
    set: (val) => uiStore.dataZoneTab = val
});

const collapsed = ref({
    discussion: false, 
    personality: true,
    memory: true
});

const fileCount = computed(() => {
    const list = activeDiscussionArtefacts.value || [];
    const uniqueTitles = new Set(list.map(a => a.title));
    return uniqueTitles.size;
});

function setPanelWidth(width) {
    if (isDataZoneExpanded.value) {
        uiStore.toggleDataZoneExpansion();
    }
    dataZoneWidth.value = Math.max(380, Math.min(window.innerWidth - 80, width));
    localStorage.setItem('lollms_unifiedWidth', dataZoneWidth.value);
}

// Automatically switch to Workspace tab and expand width when an artefact is selected
watch(() => uiStore.activeSplitArtefactTitle, (newTitle) => {
    if (newTitle) {
        activeTab.value = 'workspace';
        if (dataZoneWidth.value < 700 && !isDataZoneExpanded.value) {
            setPanelWidth(Math.max(720, Math.round(window.innerWidth * 0.5)));
        }
    }
}, { immediate: true });

watch(activeTab, (newTab) => {
    if (newTab === 'workspace' && dataZoneWidth.value < 700 && !isDataZoneExpanded.value) {
        setPanelWidth(Math.max(720, Math.round(window.innerWidth * 0.5)));
    }
});

function startResize(event) {
    if (isDataZoneExpanded.value) return;
    isResizing.value = true;
    const startX = event.clientX;
    const startWidth = dataZoneWidth.value;

    const handleResize = (e) => {
        if (!isResizing.value) return;
        const delta = startX - e.clientX;
        dataZoneWidth.value = Math.max(380, Math.min(window.innerWidth - 80, startWidth + delta));
    };

    const stopResize = () => {
        isResizing.value = false;
        window.removeEventListener('mousemove', handleResize);
        window.removeEventListener('mouseup', stopResize);
        localStorage.setItem('lollms_unifiedWidth', dataZoneWidth.value);
    };

    window.addEventListener('mousemove', handleResize);
    window.addEventListener('mouseup', stopResize);
}

onMounted(() => {
    window.addEventListener('resize', updateWindowWidth);
});

onUnmounted(() => {
    window.removeEventListener('resize', updateWindowWidth);
});
</script>

<template>
    <div class="relative h-full flex shrink-0 border-l border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-950 z-20 shadow-2xl transition-[width] duration-150" 
         :class="[isDataZoneExpanded ? 'absolute inset-0 w-full z-40' : '']" 
         :style="isDataZoneExpanded ? {} : { width: `${dataZoneWidth}px` }">

        <!-- Resizer Handle -->
        <div @mousedown.prevent="startResize" 
             class="absolute top-0 bottom-0 -left-1.5 w-3 cursor-col-resize z-30 hover:bg-blue-500/40 transition-colors flex items-center justify-center group" 
             v-if="!isDataZoneExpanded"
             title="Drag to resize width">
            <div class="w-0.5 h-10 bg-gray-300 dark:bg-gray-600 rounded-full group-hover:bg-blue-500 transition-colors"></div>
        </div>

        <!-- Vertical Navigation Rail -->
        <div class="w-14 shrink-0 border-r border-gray-200 dark:border-gray-800 bg-gray-50/70 dark:bg-black flex flex-col items-center py-4 gap-3 select-none">
            <!-- Context Zones Tab -->
            <button @click="activeTab = 'context'" 
                    class="p-2.5 rounded-xl transition-all relative group"
                    :class="activeTab === 'context' ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20' : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-200'"
                    title="Context Explorer">
                <IconDataZone class="w-5 h-5" />
                <span class="absolute left-16 px-2 py-1 bg-gray-800 text-white text-[10px] rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-50">
                    Context Zones
                </span>
            </button>

            <!-- Files / Artefacts List Tab -->
            <button @click="activeTab = 'files'" 
                    class="p-2.5 rounded-xl transition-all relative group"
                    :class="activeTab === 'files' ? 'bg-amber-500 text-white shadow-lg shadow-amber-500/20' : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-200'"
                    title="Artefacts Repository">
                <IconFolder class="w-5 h-5" />
                <span v-if="fileCount > 0" class="absolute -top-1 -right-1 px-1.5 py-0.2 rounded-full text-[9px] font-black bg-amber-600 text-white border border-white dark:border-gray-900">
                    {{ fileCount }}
                </span>
                <span class="absolute left-16 px-2 py-1 bg-gray-800 text-white text-[10px] rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-50">
                    Files List ({{ fileCount }})
                </span>
            </button>

            <!-- Workspace Studio Tab -->
            <button @click="activeTab = 'workspace'" 
                    class="p-2.5 rounded-xl transition-all relative group"
                    :class="activeTab === 'workspace' ? 'bg-purple-600 text-white shadow-lg shadow-purple-500/20' : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-200'"
                    title="Workspace Studio">
                <IconCode class="w-5 h-5" />
                <div v-if="discussionsStore.activeUpdatingArtefacts && discussionsStore.activeUpdatingArtefacts.size > 0" class="absolute -top-1 -right-1 flex h-3 w-3">
                    <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-purple-400 opacity-75"></span>
                    <span class="relative inline-flex rounded-full h-3 w-3 bg-purple-500"></span>
                </div>
                <span class="absolute left-16 px-2 py-1 bg-gray-800 text-white text-[10px] rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-50">
                    Active Workspace
                </span>
            </button>
        </div>

        <div class="flex-1 flex flex-col min-w-0 overflow-hidden">
            <!-- Top Header & Sizing Controls -->
            <div class="shrink-0 bg-white dark:bg-gray-850 border-b border-gray-200 dark:border-gray-750 flex justify-between items-center px-4 h-13 shadow-xs select-none">
                <div class="flex flex-col min-w-0">
                    <span class="text-[9px] font-black uppercase tracking-widest text-gray-400">
                        {{ activeTab === 'context' ? 'Intelligence Context' : activeTab === 'files' ? 'Document Management' : 'Active Workspace' }}
                    </span>
                    <h3 class="text-sm font-bold text-gray-800 dark:text-gray-100 truncate">
                         {{ activeTab === 'context' ? 'Context Explorer' : activeTab === 'files' ? 'Discussion Files' : (uiStore.activeSplitArtefactTitle || 'Workspace Studio') }}
                    </h3>
                </div>

                <div class="flex items-center gap-1.5 shrink-0">
                    <!-- Sizing Presets (Shown in Workspace tab) -->
                    <div v-if="activeTab === 'workspace' && !isDataZoneExpanded" class="flex items-center gap-0.5 bg-gray-100 dark:bg-gray-750 p-0.5 rounded-lg text-[10px] font-bold font-mono">
                        <button @click="setPanelWidth(640)" class="px-2 py-0.5 rounded hover:bg-white dark:hover:bg-gray-650 transition-colors" :class="{ 'text-purple-600 dark:text-purple-400 bg-white dark:bg-gray-700 shadow-2xs': dataZoneWidth <= 680 }" title="Standard width (640px)">
                            Std
                        </button>
                        <button @click="setPanelWidth(Math.round(windowWidth * 0.5))" class="px-2 py-0.5 rounded hover:bg-white dark:hover:bg-gray-650 transition-colors" :class="{ 'text-purple-600 dark:text-purple-400 bg-white dark:bg-gray-700 shadow-2xs': Math.abs(dataZoneWidth - Math.round(windowWidth * 0.5)) < 40 }" title="Split 50%">
                            50%
                        </button>
                        <button @click="setPanelWidth(Math.round(windowWidth * 0.75))" class="px-2 py-0.5 rounded hover:bg-white dark:hover:bg-gray-650 transition-colors hidden sm:inline" :class="{ 'text-purple-600 dark:text-purple-400 bg-white dark:bg-gray-700 shadow-2xs': Math.abs(dataZoneWidth - Math.round(windowWidth * 0.75)) < 40 }" title="Wide 75%">
                            75%
                        </button>
                    </div>

                    <button @click="uiStore.toggleDataZoneExpansion()" class="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 transition-colors" :title="isDataZoneExpanded ? 'Restore width' : 'Maximize Workspace'">
                        <IconMinimize v-if="isDataZoneExpanded" class="w-4 h-4" />
                        <IconMaximize v-else class="w-4 h-4" />
                    </button>
                    <button @click="uiStore.toggleDataZone()" class="p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-950/40 text-gray-400 hover:text-red-500 transition-colors" title="Close Panel">
                        <IconXMark class="w-4 h-4" />
                    </button>
                </div>
            </div>

            <!-- Dynamic Body Content -->
            <div class="flex-1 overflow-hidden relative">

                <!-- TAB 1: CONTEXT ZONES -->
                <div v-if="activeTab === 'context'" class="h-full overflow-y-auto custom-scrollbar flex flex-col bg-gray-50/30 dark:bg-gray-900/30">
                    <div class="flex flex-col border-b border-gray-200 dark:border-gray-800">
                        <button @click="collapsed.discussion = !collapsed.discussion" 
                                class="w-full flex items-center justify-between p-4 hover:bg-gray-100 dark:hover:bg-gray-800/50 transition-colors group">
                            <div class="flex items-center gap-3">
                                <div class="p-1.5 rounded-md bg-blue-100 dark:bg-blue-900/30 text-blue-600">
                                    <IconDataZone class="w-4 h-4" />
                                </div>
                                <span class="text-sm font-bold text-gray-700 dark:text-gray-200">Discussion Instructions</span>
                            </div>
                            <IconChevronDown class="w-4 h-4 text-gray-400 transition-transform duration-300" :class="{'rotate-180': !collapsed.discussion}" />
                        </button>
                        <div v-show="!collapsed.discussion" class="h-80 p-2 pt-0"><DiscussionZone /></div>
                    </div>

                    <div class="flex flex-col border-b border-gray-200 dark:border-gray-800">
                        <button @click="collapsed.personality = !collapsed.personality" 
                                class="w-full flex items-center justify-between p-4 hover:bg-gray-100 dark:hover:bg-gray-800/50 transition-colors group">
                            <div class="flex items-center gap-3">
                                <div class="p-1.5 rounded-md bg-purple-100 dark:bg-purple-900/30 text-purple-600">
                                    <IconSparkles class="w-4 h-4" />
                                </div>
                                <span class="text-sm font-bold text-gray-700 dark:text-gray-200">AI Logic & Persona</span>
                            </div>
                            <IconChevronDown class="w-4 h-4 text-gray-400 transition-transform duration-300" :class="{'rotate-180': !collapsed.personality}" />
                        </button>
                        <div v-show="!collapsed.personality" class="h-64 p-2 pt-0"><PersonalityZone /></div>
                    </div>

                    <div class="flex flex-col grow min-h-0">
                        <button @click="collapsed.memory = !collapsed.memory" 
                                class="w-full flex items-center justify-between p-4 hover:bg-gray-100 dark:hover:bg-gray-800/50 transition-colors group">
                            <div class="flex items-center gap-3">
                                <div class="p-1.5 rounded-md bg-green-100 dark:bg-green-900/30 text-green-600">
                                    <IconThinking class="w-4 h-4" />
                                </div>
                                <span class="text-sm font-bold text-gray-700 dark:text-gray-200">Long-Term Facts</span>
                            </div>
                            <IconChevronDown class="w-4 h-4 text-gray-400 transition-transform duration-300" :class="{'rotate-180': !collapsed.memory}" />
                        </button>
                        <div v-show="!collapsed.memory" class="grow p-2 pt-0"><MemoryZone /></div>
                    </div>
                </div>

                <!-- TAB 2: ARTEFACTS LIST -->
                <div v-else-if="activeTab === 'files'" class="h-full overflow-hidden bg-white dark:bg-gray-900">
                    <ArtefactZone />
                </div>

                <!-- TAB 3: WORKSPACE SPLIT VIEW -->
                <div v-else-if="activeTab === 'workspace'" class="h-full overflow-hidden bg-white dark:bg-gray-950">
                    <ArtefactSplitView />
                </div>

            </div>
        </div>
    </div>
</template>

<style scoped>
@reference "tailwindcss";
.custom-scrollbar::-webkit-scrollbar { width: 4px; }
.custom-scrollbar::-webkit-scrollbar-thumb { @apply bg-gray-300 dark:bg-gray-600 rounded-full; }
</style>