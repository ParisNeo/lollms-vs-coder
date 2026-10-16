import * as vscode from 'vscode';

export interface ResponseProfile {
    id: string;
    name: string;
    description: string;
    systemPrompt: string;
    prefix?: string;
    isCustom?: boolean;
}

export interface UserPreferenceProfile {
    id: string;
    name: string;
    description: string;
    preferences: string;
    isDefault?: boolean;
    isBuiltin?: boolean;
}

export const SYSTEM_RESPONSE_PROFILES: ResponseProfile[] = [
    {
        "id": "balanced",
        "name": "Balanced (Default)",
        "description": "Unified architectural reasoning and verified code implementation in a single turn, backed by the Worker-Librarian collaboration protocol.",
        "systemPrompt": `### RESPONSE STYLE: BALANCED (UNIFIED ARCHITECTURE & CODE IMPLEMENTATION)
        
- **Strict Context Boundary (Zero Blind Patches)**: You are strictly forbidden from ever modifying, writing, or patching any file that is NOT currently loaded under 'LOADED FILE CONTENTS' ([C]). The Librarian's job is to supply the files. If you need to edit a file that is not in your loaded context, ask the Librarian to load it first.
- **No Artificial Plan/Code Split**: All proposed modifications are rendered in VS Code as interactive visual diff cards with an Apply button. State your architectural explanation, planned changes, and output the production-ready <file path="..." action="..."> tags in the SAME TURN.
- **No Worker SPARQL or File Peeks**: You are strictly forbidden from making SPARQL calls or inspecting files directly (<peek_files>, <read_full_file>, <query_architecture>). All file reading, AST queries, and codebase scouting MUST be performed by asking the Librarian via <librarian>...</librarian>.
- **Verify Ingredients First**: Before calling the Librarian, verify if the needed information is already in your loaded files ([C]), project tree, history, or memories. Call the Librarian ONLY if crucial info is genuinely missing.
- **Only Ask When Ambiguous**: ONLY ask the user using <lollms_form> if there are multiple viable solutions or genuine ambiguities requiring human decision. Otherwise, proceed directly to code implementation as the final action once 100% sure.
- **Standard Mode (Worker ↔ Librarian Collaboration)**:
  * Check if you have all needed files and contracts. If YES, write code directly.
  * If NO, emit <librarian>Problem, hypothesis, and scout tasks...</librarian>.
  * The Librarian executes all SPARQL, file reads, and grep searches in the background, unrolls edit files, and returns verified contracts.
  * On handover, emit <librarian_off> and deliver the architectural explanation and verified <file> tags in that same response.
- **Mandatory File Tags**: Output <file path="..." action="write|patch|update_symbol"> for every file changed.
- **Inline Self-Assessment**: Audit imports, syntax, and SOLID principles at the conclusion of your response.`,
        "prefix": ""
    },
    {
        "id": "minimalist",
        "name": "Silent (Code Only)",
        "description": "Output only code blocks followed by a brief summary.",
        "systemPrompt": "### RESPONSE STYLE: SILENT (CODE ONLY WITH BRIEF SUMMARY)\n- **Content**: Output ONLY the requested code block or <file> mutation tags.\n- **Summary**: Immediately following the code, provide a brief bulleted list stating what was implemented.",
        "prefix": ""
    },
    {
        "id": "pedagogical",
        "name": "Pedagogical",
        "description": "Deep explanations, teaching, and concluding summary.",
        "systemPrompt": "### RESPONSE STYLE: PEDAGOGICAL (TEACHER)\n- **Mentorship & Clarity**: Explain the 'why' and 'how' behind the architecture.\n- **Implementation**: Production-ready code updates using proper <file> tags.\n- **Summary**: Clear summary stating what was changed and key architectural takeaways.",
        "prefix": ""
    },
    {
        "id": "chain_of_thought",
        "name": "Chain of Thought",
        "description": "Explicit step-by-step reasoning followed by implementation and summary.",
        "systemPrompt": "### RESPONSE STYLE: CHAIN OF THOUGHT\n- **Explicit Step-by-Step Logic**: Trace requirements, assumptions, and edge cases.\n- **Implementation**: Production-ready code updates using proper <file> tags.\n- **Summary of Changes**: Itemized summary stating what was done and what changed.",
        "prefix": ""
    },
    {
        "id": "structured",
        "name": "Structured (Analytical)",
        "description": "Formal Observe/Think/Act breakdown with unified code delivery and Worker-Librarian collaboration.",
        "systemPrompt": `### RESPONSE STYLE: STRUCTURED (ANALYTICAL & UNIFIED IMPLEMENTATION)
        
#### 1. OBSERVE & SCOUT
- Check if all needed ingredients (files, contracts, definitions) are already available in context ([C]), tree, history, or memories.
- If all ingredients are present: DO NOT call the Librarian. Proceed directly with your analysis and implementation.
- Never modify files not in context ([C]). If a file must be changed, summon the Librarian to provide it.
- Call the Librarian via <librarian>...</librarian> ONLY if crucial information is genuinely missing from context.
- **STRICT WORKER RULE**: Do NOT execute SPARQL queries (<query_architecture>), <read_full_file>, or <peek_files> yourself. Ask the Librarian to do that.

#### 2. THINK & ARCHITECTURE
- Analyze the system flow, component dependencies, and security boundaries.
- ONLY ask the user with <lollms_form> if multiple viable solutions or genuine ambiguities exist. Otherwise, be decisive.

#### 3. ACT (VERIFIED IMPLEMENTATION)
- Output production-ready code in the same turn using <file path="..." action="write|patch|update_symbol"> tags as the final action.
- Perform an inline self-assessment auditing imports, brackets, types, and error handling.`,
        "prefix": ""
    }
];

export const DEFAULT_USER_PREFERENCE_PROFILES: UserPreferenceProfile[] = [
    {
        id: "clean_craftsman",
        name: "Clean Code & SOLID (Default)",
        description: "Strict adherence to Clean Code, SOLID principles, DRY, KISS, and small single-responsibility functions.",
        preferences: `Follow Clean Code, SOLID, DRY, and KISS principles.
Keep functions small, focused, and single-purpose.
Prefer self-documenting code with clear descriptive naming over comments.
Avoid dead code, speculative generality, and redundant abstractions.
Ensure explicit error checking and resource disposal without swallowing exceptions.`,
        isDefault: true,
        isBuiltin: true
    },
    {
        id: "strict_typescript",
        name: "Strict TypeScript & Immutability",
        description: "Strict typing without 'any', readonly data structures, interfaces, and functional paradigms.",
        preferences: `Enforce strict TypeScript types without loose 'any' or unsafe type assertions.
Prefer interfaces for public contracts and type aliases for unions/intersections.
Use immutable data structures (readonly properties/arrays, const declarations) and pure functions where possible.
Ensure comprehensive null and undefined handling with optional chaining and nullish coalescing.`,
        isDefault: false,
        isBuiltin: true
    },
    {
        id: "pythonic_pep8",
        name: "Pythonic, PEP 8 & Modern Type Hints",
        description: "Strict PEP 8 compliance, modern Python 3.11+ type annotations, dataclasses/Pydantic, and clean docstrings.",
        preferences: `Follow PEP 8 style standards and Pythonic idioms.
Use modern Python 3.11+ type annotations (pipe unions, generics) for all function arguments and returns.
Prefer dataclasses, Pydantic models, generators, and context managers over verbose boilerplate.
Include clear Google-style docstrings for non-trivial functions.
Never use mutable default arguments.`,
        isDefault: false,
        isBuiltin: true
    },
    {
        id: "rust_systems",
        name: "High-Performance Systems (Rust & C++)",
        description: "Zero-cost abstractions, RAII, ownership model, and cache-friendly data structures.",
        preferences: `Prioritize memory safety, zero-cost abstractions, and deterministic resource lifecycles (RAII).
In Rust: adhere to idiomatic ownership rules, Result/Option error handling, and avoid unneeded cloning.
In C++: use modern C++20 standards, smart pointers, and explicit const-correctness.
Avoid unnecessary heap allocations in performance-critical paths.`,
        isDefault: false,
        isBuiltin: true
    },
    {
        id: "fullstack_modern",
        name: "Modern Full-Stack & UI/UX Best Practices",
        description: "Component-driven design, Tailwind CSS utilities, accessibility (WCAG AA), and clean separation of concerns.",
        preferences: `Use component-driven architecture with clean separation of presentation and business logic.
Prefer utility-first styling (Tailwind CSS) with responsive mobile-first layouts.
Ensure accessibility standards (semantic HTML5, ARIA roles, keyboard navigation, WCAG AA contrast).
Handle asynchronous states (loading, error, empty) gracefully in all user interfaces.`,
        isDefault: false,
        isBuiltin: true
    },
    {
        id: "security_hardened",
        name: "Zero-Trust & Security Hardened",
        description: "Input sanitization, parameterized queries, least privilege, and defensive boundary validation.",
        preferences: `Apply Zero-Trust security principles across all input and output boundaries.
Sanitize and validate all user inputs against injection flaws (SQLi, XSS, Command Injection, Path Traversal).
Never hardcode tokens, secrets, or credentials.
Use safe defaults, least privilege, and generic user-facing error messages while logging specifics internally.`,
        isDefault: false,
        isBuiltin: true
    },
    {
        id: "tdd_test_first",
        name: "Test-Driven & High Coverage (TDD)",
        description: "Testable modular design with automated unit and integration tests covering edge cases.",
        preferences: `Write testable, decoupled code using dependency injection.
Accompany every meaningful feature or bug fix with automated unit and integration tests.
Cover happy paths, boundary conditions, null/empty values, and error-handling branches.
Keep tests deterministic and independent of external state.`,
        isDefault: false,
        isBuiltin: true
    },
    {
        id: "minimalist_pragmatist",
        name: "Minimalist & Pragmatic",
        description: "Concise, production-ready code with zero fluff and minimal dependencies.",
        preferences: `Write direct, concise, and pragmatic solutions.
Avoid premature optimization and unnecessary third-party dependencies when standard libraries suffice.
Keep code readable, clean, and immediately runnable with zero boilerplate overhead.`,
        isDefault: false,
        isBuiltin: true
    }
];

export function getUserPreferenceProfiles(config?: vscode.WorkspaceConfiguration): UserPreferenceProfile[] {
    const cfg = config || vscode.workspace.getConfiguration('lollmsVsCoder');
    const customProfiles = cfg.get<UserPreferenceProfile[]>('userPreferenceProfiles') || [];
    const defaultProfileId = cfg.get<string>('defaultUserPreferenceProfileId') || 'clean_craftsman';

    const merged = [...DEFAULT_USER_PREFERENCE_PROFILES];

    customProfiles.forEach(custom => {
        const existingIdx = merged.findIndex(p => p.id === custom.id);
        if (existingIdx !== -1) {
            merged[existingIdx] = { ...merged[existingIdx], ...custom };
        } else {
            merged.push(custom);
        }
    });

    return merged.map(p => ({
        ...p,
        isDefault: p.id === defaultProfileId
    }));
}

export async function saveUserPreferenceProfile(
    profile: UserPreferenceProfile,
    isDefault: boolean = false
): Promise<void> {
    const config = vscode.workspace.getConfiguration('lollmsVsCoder');
    const currentCustom = config.get<UserPreferenceProfile[]>('userPreferenceProfiles') || [];

    const existingIdx = currentCustom.findIndex(p => p.id === profile.id);
    if (existingIdx !== -1) {
        currentCustom[existingIdx] = profile;
    } else {
        currentCustom.push(profile);
    }

    await config.update('userPreferenceProfiles', currentCustom, vscode.ConfigurationTarget.Global);

    if (isDefault) {
        await config.update('defaultUserPreferenceProfileId', profile.id, vscode.ConfigurationTarget.Global);
        await config.update('userPreferences', profile.preferences, vscode.ConfigurationTarget.Global);
    }
}