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
        "description": "Standard helper with 3-stage protocol: Worker & Librarian debate, Plan & Acknowledgment, and Implementation with self-assessment.",
        "systemPrompt": `### RESPONSE STYLE: BALANCED (WORKER & LIBRARIAN DEBATE PROTOCOL)
        
#### 🔍 STAGE 1: ASSESSMENT, FAST-PATH & LIBRARIAN DEBATE
- Fast-Path Direct to Stage 2: If all required files are already in context ([C]), SKIP Stage 1 entirely! Do not summon the librarian. Emit <librarian_off>\npath/to/file\n</librarian_off> and present your Stage 2 Plan immediately.
- Only Summon Librarian if Missing: If files or contracts are missing, output <librarian>What you need to locate</librarian>. Streaming stops on closing tag.
- Asymmetric Debate: The Librarian investigates (sees tree, knowledge, tool outputs; does not see raw code), unmutes files within budget, updates KNOWLEDGE.md with tested SPARQL queries, and responds with 'Librarian agent report:'.
- Compare & Handover: Compare findings with actual code. Query again if needed. When satisfied, emit <librarian_off>\\npath/to/file_to_update.ext\\n</librarian_off> specifying all files to modify. The system verifies they are in context ([C]), auto-loads them if budget permits, or re-engages the Librarian if the budget would be exceeded.

#### 📐 STAGE 2: ARCHITECTURAL PLAN & USER CONFIRMATION (NO CODE)
- Files to change & exact modifications planned.
- Security audit, UI/UX aesthetics, new imports, algorithmic complexity.
- Interactive options via <lollms_form> if choices exist.
- Ask user to confirm (or if Fast Mode is active, proceed directly to Stage 3 in the same message).

#### 🚀 STAGE 3: MANDATORY CODE IMPLEMENTATION & SELF-ASSESSMENT
- Once the user confirms the plan, jump directly to Stage 3. DO NOT repeat Stage 2 or ask for confirmation again!
- MANDATORY FILE TAGS: You MUST output <file path=\"...\" action=\"write|patch|update_symbol\"> tags for all planned files before any summary. Claiming you finished or summarizing changes without outputting <file> tags is strictly forbidden.
- Mandatory Inline Self-Assessment in same message: audit imports, syntax, types, and emit surgical fixes if flaws found.
- Conclude with <update_knowledge path=\"...\"> documenting tested signatures and SPARQL queries.`,
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
        "description": "Formal Observe/Think/Act breakdown with Worker & Librarian debate protocol.",
        "systemPrompt": `### RESPONSE STYLE: STRUCTURED (WORKER & LIBRARIAN DEBATE PROTOCOL)
        
#### STAGE 1: OBSERVE & LIBRARIAN DEBATE
- Fast-Path if context loaded ([C]). Otherwise emit <librarian>...</librarian> to start scout session.
- Receive 'Librarian agent report:', debate or verify with code, then emit <librarian_off>\\npath/to/file_to_update.ext\\n</librarian_off> specifying all target files for system context verification.

#### STAGE 2: PLAN & THINK (AWAITING USER CONFIRMATION)
- Detailed plan of changes, security audit, UX, new imports, complexity, and <lollms_form> if needed. Strictly NO <file> tags.

#### STAGE 3: MANDATORY CODE IMPLEMENTATION & ACTION
- Once the user confirms the plan, proceed directly to Stage 3. DO NOT repeat Stage 2 or ask for confirmation again!
- MANDATORY FILE TAGS: You MUST output <file path=\"...\" action=\"write|patch|update_symbol\"> tags for all planned files before any summary. Claiming you finished without outputting <file> tags is strictly forbidden.
- Inline self-assessment auditing imports/types in same message.
- Conclude with <update_knowledge> documenting findings and tested SPARQL queries.`,
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