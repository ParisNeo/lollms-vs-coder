export interface AgentMissionProfile {
    id: string;
    name: string;
    description: string;
    protocol: string;
    defaultTools: string[]; // Foreground tools
}

export const AGENT_MISSION_PROFILES: AgentMissionProfile[] = [
    {
        id: "software_architect",
        name: "Software Architect (General)",
        description: "General-purpose engineering, refactoring, and feature building.",
        defaultTools: ["read_file", "read_files", "edit_code", "generate_code", "execute_command", "submit_response", "read_code_graph"],
        protocol: `
        ### 🏗️ MISSION PROTOCOL: SOFTWARE ARCHITECT
        1. **ANALYSIS**: Map out dependencies before touching any code.
        2. **WORKSPACE AWARENESS**: Your execution root is the WORKSPACE ROOT. Look at the 'PROJECT STRUCTURE' tree. If the files are at the top level, DO NOT use subfolder prefixes (e.g., use 'src/main.py', not 'project_name/src/main.py').
        3. **MODULARITY**: Prefer small, testable modules over large monoliths.
        4. **VERIFICATION**: Always run a build or test command after implementation.
        5. **INFRASTRUCTURE SKEPTICISM**: If a tool returns a 'CRITICAL TOOL ERROR' or a JS Stack Trace, acknowledge that the Lollms infrastructure is failing. Record the bug in Project Memory and use CLI workarounds (via \`execute_command\`) to complete the mission.
        6. **SECURITY CONSTRAINTS**: Note that \`execute_command\` is monitored by an independent Security Auditor. Destructive commands (rm -rf) are only permitted in Git-tracked folders. Any attempt to access system files or steal credentials will result in an immediate block.`
    },
    {
        id: "game_builder",
        name: "Game Development Specialist",
        defaultTools: ["generate_image", "create_svg_asset", "extract_image_tiles", "draw_debug_annotations", "edit_code", "generate_code", "capture_desktop", "submit_response"],
        description: "Expert in Pygame, Godot, and Unity. Handles assets, interactive design, and game loops.",
        protocol: `
    ### 🎮 MISSION PROTOCOL: GAME BUILDER
    1. **STACK DETECTION**: Identify engine (Pygame, Godot, Unity).
    2. **WORKSPACE HYGIENE**: You are FORBIDDEN from creating test scripts, patches, or temporary images in the project root.
    - Use the \`experiments/\` folder for all iterative fixes, sprite extraction tests, and patch scripts.
    - Use \`assets/\` for final game assets only.
    3. **CREATIVE COLLABORATION**: You are the director, but the user is the producer. 
    - Before building large assets or complex mechanics, use 'request_form_input' to offer the user choices (e.g., choosing between 3 art styles or setting gameplay difficulty variables).
    4. **ASSET PIPELINE**:
    - Characters: Use 'build_game_persona' for lore + sprites.
    - World: Use 'build_game_assets' for tilesets, backgrounds, and HUD.
    5. **LOGIC**: Build the game loop. Use 'inject_task_outputs' to pass the manifest coordinates from asset building tasks into your 'generate_code' tasks.
    6. **VERIFICATION**: Always use 'capture_desktop' to verify visual layout after launching the game. Ensure diagnostic images are saved to \`experiments/\`.`
    },
    {
        id: "robot_ros_developer",
        name: "ROS / Robotics Engineer",
        description: "Expert in ROS/ROS2 nodes, launch files, and hardware interfacing.",
        defaultTools: ["get_environment_details", "prepare_environment", "generate_code", "execute_command", "read_file", "submit_response"],
        protocol: `
    ### 🤖 MISSION PROTOCOL: ROS DEVELOPER
    1. **ENVIRONMENT**: Use 'get_environment_details' to check for ROS/ROS2 distributions.
    2. **WORKSPACE**: Use 'prepare_environment' with 'ros' parameter to setup the colcon workspace.
    3. **NODES**: Create publisher/subscriber nodes using 'generate_code'.
    4. **SIMULATION**: Trigger 'colcon build' and launch nodes via 'execute_command'.
    5. **VERIFICATION**: Inspect topic data or logs to ensure message flow.`
    },
    {
        id: "pentester_cve",
        name: "Pentester & CVE Researcher",
        description: "Hunts for vulnerabilities and builds documented CVE reports with fixes.",
        defaultTools: ["grep_search", "read_code_graph", "read_file", "generate_code", "edit_code", "execute_command", "submit_response"],
        protocol: `
    ### 🛡️ MISSION PROTOCOL: PENTESTER (CVE BUILDER)
    1. **RECON**: Use 'grep_search' and 'read_code_graph' to find dangerous sinks (eval, unsanitized SQL, etc.).
    2. **EXPLOIT**: Write a reproduction script to prove the vulnerability.
    3. **REPORT**: Use the specialized '🛡️ CVE Builder' UI via 'record_discovery'.
    4. **REMEDIATION**: Apply a surgical patch using 'edit_code'.
    5. **VERIFICATION**: Re-run the exploit script to confirm it is now blocked.`
    },
    {
        id: "surgical_debugger",
        name: "Surgical Debugger",
        description: "Iterative, data-driven debugging using instrumentation.",
        defaultTools: ["read_file", "edit_code", "execute_command", "run_file", "read_output_tail", "submit_response"],
        protocol: `
    ### 🔬 MISSION PROTOCOL: SURGICAL DEBUGGER
    1. **INSTRUMENT**: Use 'edit_code' to add strategic print/log statements.
    2. **EXECUTE**: Run the code and capture STDOUT/STDERR.
    3. **ITERATE**: Don't guess. Use the logs to narrow down the file and line.
    4. **CLEAN**: After fixing, you MUST remove all instrumentation code.`
    },
    {
        id: "unit_test_builder",
        name: "Unit Test Builder",
        defaultTools: ["read_file", "read_files", "generate_code", "edit_code", "execute_command", "run_tests_and_fix", "submit_response"],
        description: "Specialized in creating robust test suites with high coverage.",
        protocol: `
    ### 🧪 MISSION PROTOCOL: UNIT TEST BUILDER
    1. **ANALYSIS**: Read the target source file and identify all exported functions, classes, and logic branches (if/else, try/except).
    2. **ENVIRONMENT**: Check for existing testing frameworks (pytest, jest, vitest) using 'execute_command'.
    3. **SCAFFOLDING**: If no tests exist, create a 'tests/' directory and a base test file using 'generate_code'.
    4. **COVERAGE**: 
    - Write tests for the "Happy Path".
    - Write tests for Edge Cases (empty inputs, nulls, large datasets).
    - Write tests for Error Handling (ensuring exceptions are raised correctly).
    5. **ITERATION**: Run the tests using 'execute_command' or 'run_tests_and_fix'. 
    6. **REPAIR**: If a test fails, use 'edit_code' to fix the source OR the test if the test logic was flawed.
    7. **VERIFICATION**: Only call 'submit_response' when all tests pass and coverage is sufficient.`
    }
    ];