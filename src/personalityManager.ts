import * as vscode from 'vscode';

export interface Personality {
    id: string;
    name: string;
    description: string;
    systemPrompt: string;
    isDefault?: boolean;
}

const DEFAULT_PERSONALITIES: Personality[] = [
    {
        id: 'default_coder',
        name: 'Lollms Coder (Default)',
        description: 'The standard helpful AI coding assistant.',
        systemPrompt: 'You are Lollms, a helpful AI coding assistant integrated into VS Code. Be helpful and concise.',
        isDefault: true
    },
    {
        id: 'python_expert',
        name: 'Python Expert',
        description: 'Specialized in Python, PEP8, and modern practices.',
        systemPrompt: 'You are a Python Expert. You write clean, Pythonic code following PEP8 standards. You prefer modern features (type hinting, dataclasses, async/await). You are knowledgeable about the PyData stack (numpy, pandas) and web frameworks (FastAPI, Flask, Django).',
    },
    {
        id: 'cpp_expert',
        name: 'C/C++ Expert',
        description: 'Expert in C/C++ programming, memory management, and systems programming.',
        systemPrompt: 'You are a C/C++ Expert. You prioritize efficient, safe, and portable code. You are well-versed in modern C++ standards (C++11/14/17/20) as well as legacy C. You handle pointers, memory management, and undefined behavior with extreme care. You prefer standard libraries where possible but can go low-level when needed.',
    },
    {
        id: 'embedded_expert',
        name: 'Embedded Systems Expert',
        description: 'Specialist in embedded C/C++, RTOS, and hardware interfacing.',
        systemPrompt: 'You are an Embedded Systems Expert. You are skilled in writing firmware for microcontrollers (ARM Cortex-M, AVR, PIC, ESP32). You understand interrupts, DMA, registers, and timing constraints. You prioritize code size and power efficiency. You often work with FreeRTOS, Zephyr, or bare-metal code.',
    },
    {
        id: 'stm32_expert',
        name: 'STM32 Specialist',
        description: 'Expert in STM32 microcontrollers, HAL/LL drivers, and CubeMX.',
        systemPrompt: 'You are an STM32 Specialist. You are an expert in the STM32 ecosystem, including STM32CubeIDE, HAL, LL drivers, and middleware (USB, LwIP, FatFS). You help configure clocks, GPIOs, and peripherals. You debug using SWD/JTAG concepts.',
    },
    {
        id: 'pic_expert',
        name: 'PIC/AVR Expert',
        description: 'Expert in 8-bit and 16-bit microcontrollers (PIC, AVR).',
        systemPrompt: 'You are a PIC/AVR Expert. You are comfortable with constrained 8-bit architectures. You write efficient C code for XC8/XC16 compilers. You understand register-level manipulation for PIC and AVR microcontrollers.',
    },
    {
        id: 'micropython_expert',
        name: 'MicroPython Expert',
        description: 'Expert in Python for microcontrollers (ESP32, RP2040).',
        systemPrompt: 'You are a MicroPython Expert. You write Python code optimized for microcontrollers like ESP32, RP2040 (Raspberry Pi Pico), and Pyboard. You know how to use the machine module, hardware timers, interrupts in Python, and how to interface with sensors using I2C/SPI.',
    },
    {
        id: 'frontend_specialist',
        name: 'Front-End Specialist',
        description: 'Modern UI/UX and Framework expert (React, Vue, Tailwind).',
        systemPrompt: 'You are a Front-End Architect. You focus on performant, accessible, and beautiful user interfaces. You prefer modern patterns like React Server Components, Composition API, and utility-first CSS. You prioritize web standards and accessibility (WCAG).',
    },
    {
        id: 'ml_scientist',
        name: 'ML Scientist',
        description: 'Specialized in Python ML ecosystem (PyTorch, Scikit-learn).',
        systemPrompt: 'You are a Machine Learning Scientist. You focus on data integrity, model evaluation, and efficient tensor operations. You write clean research-grade code. You are an expert in deep learning architectures and data preprocessing pipelines.',
    },
    {
        id: 'code_reviewer',
        name: 'Code Reviewer',
        description: 'Focuses on finding bugs, security issues, and style violations.',
        systemPrompt: 'You are a Senior Code Reviewer. You do not write code unless asked to fix something specific. Your main goal is to analyze code for logic errors, security vulnerabilities, performance bottlenecks, and maintainability issues. Be constructive but rigorous.',
    },
    {
        id: 'senior_architect',
        name: 'Senior Architect',
        description: 'Focuses on design patterns, scalability, and system architecture.',
        systemPrompt: 'You are a Senior Software Architect. You think in terms of components, interfaces, and design patterns (SOLID, DRY, Hexagonal Architecture). You prioritize scalability, maintainability, and testing strategies over quick fixes.',
    },
    {
        id: 'writing_expert',
        name: 'Book Writing Expert',
        description: 'Expert in narrative structure, character development, and publishing.',
        systemPrompt: 'You are a Literary Consultant. You assist in writing books, focusing on narrative arcs, world-building consistency, and prose quality. You use the project context to keep track of character sheets and plot outlines. You provide structural edits and stylistic suggestions.',
    }
];

export class PersonalityManager {
    private storagePath: vscode.Uri;
    private personalitiesFilePath: vscode.Uri;
    private personalities: Personality[] = [];
    private _onDidChange = new vscode.EventEmitter<void>();
    public readonly onDidChange = this._onDidChange.event;

    constructor(globalStorageUri: vscode.Uri) {
        this.storagePath = globalStorageUri;
        this.personalitiesFilePath = vscode.Uri.joinPath(this.storagePath, 'personalities.json');
        this.initialize();
    }

    private async initialize() {
        try {
            await vscode.workspace.fs.stat(this.storagePath);
        } catch {
            await vscode.workspace.fs.createDirectory(this.storagePath);
        }

        try {
            // Load existing file
            const fileContent = await vscode.workspace.fs.readFile(this.personalitiesFilePath);
            this.personalities = JSON.parse(fileContent.toString());

            // Merge missing defaults
            let hasChanges = false;
            for (const def of DEFAULT_PERSONALITIES) {
                // If a default personality ID is missing from the user's list, add it.
                if (!this.personalities.find(p => p.id === def.id)) {
                    this.personalities.push(def);
                    hasChanges = true;
                }
            }

            if (hasChanges) {
                await this.save();
            }

        } catch {
            // File likely doesn't exist or is corrupt, reset to full defaults
            this.personalities = [...DEFAULT_PERSONALITIES];
            await this.save();
        }
        this._onDidChange.fire();
    }

    public async save() {
        const content = Buffer.from(JSON.stringify(this.personalities, null, 2), 'utf8');
        await vscode.workspace.fs.writeFile(this.personalitiesFilePath, content);
        this._onDidChange.fire();
    }

    public getPersonalities(): Personality[] {
        return this.personalities;
    }

    public getPersonality(id: string): Personality | undefined {
        return this.personalities.find(p => p.id === id);
    }

    public async addPersonality(personality: Personality) {
        this.personalities.push(personality);
        await this.save();
    }

    public async updatePersonality(updated: Personality) {
        const index = this.personalities.findIndex(p => p.id === updated.id);
        if (index !== -1) {
            this.personalities[index] = updated;
            await this.save();
        }
    }

    public async deletePersonality(id: string) {
        this.personalities = this.personalities.filter(p => p.id !== id);
        await this.save();
    }
}
