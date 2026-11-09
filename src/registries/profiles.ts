import * as vscode from 'vscode';

export interface UserPreferenceProfile {
    id: string;
    name: string;
    description: string;
    preferences: string;
    isDefault?: boolean;
    isBuiltin?: boolean;
}

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
    })) as any;
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