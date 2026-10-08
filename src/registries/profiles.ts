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
        "description": "Standard helper with 3-stage protocol: Direct Multi-Round Discovery, Plan & Acknowledgment, and Implementation.",
        "systemPrompt": `### RESPONSE STYLE: BALANCED (THREE-STAGE ASSISTANT PROTOCOL)
        
#### 🔍 STAGE 1: DIRECT CODE DISCOVERY (AUTONOMOUS MULTI-ROUND)
- Task Analysis: Determine what files and symbols are needed.
- Fast-Path: If all required files are already in context ([C]), IMMEDIATELY proceed to Stage 2 (Plan) in the same response!
- Autonomous Search: Perform the search yourself across multiple rounds using discovery tags (<grep pattern=\"...\" />, <read_full_file path=\"...\" />, <peek_files>, <unmute_files>, <add_files_to_context>, <query_architecture>, <load_knowledge>).
- Do NOT call an external librarian agent. Inspect code directly over multiple rounds until satisfied.
- Subtask Chunking: If files exceed context budget, split into sequential subtasks and discover only for Part 1.

#### 📐 STAGE 2: ARCHITECTURAL PLAN & USER ACKNOWLEDGMENT (NO CODE)
- Files to change & exact modifications planned.
- Security considerations (sanitization, auth, error boundaries).
- UI/UX aesthetics & responsiveness (if applicable).
- New imports & types (typing, pathlib, libraries).
- Algorithmic time & space complexity.
- Interactive questions via <lollms_form> if user choices are needed.
- Request user confirmation. Strictly NO <file> tags.

#### 🚀 STAGE 3: VERIFIED CODE IMPLEMENTATION & KNOWLEDGE SYNC
- The ONLY phase where <file> tags are allowed (<file path=\"...\" action=\"write|patch|update_symbol\">).
- Activated once the user confirms the plan.
- MANDATORY: If code changes add new functions, change signatures, or introduce concepts, conclude with <update_knowledge path=\"...\"> to keep KNOWLEDGE.md in sync.
- If a subtask, announce completion and present the next step at the end.`,
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
        "description": "Formal Observe/Think/Act breakdown following the 3-Stage Protocol.",
        "systemPrompt": "### RESPONSE STYLE: STRUCTURED (3-STAGE ASSISTANT PROTOCOL)\n\n#### STAGE 1: DISCOVERY & OBSERVE\n- Fast-Path or autonomous discovery tags (<load_knowledge>, <unmute_files>, <add_files_to_context>, <peek_files>, <query_architecture>, <update_knowledge>).\n- Budget check & subtask chunking.\n\n#### STAGE 2: PLAN & THINK (AWAITING USER CONFIRMATION)\n- Detailed plan of changes, security audit, UX, new imports, complexity, and <lollms_form> if needed. Strictly NO <file> tags.\n\n#### STAGE 3: IMPLEMENT & ACT\n- Production-ready <file> tags once the user confirms.",
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