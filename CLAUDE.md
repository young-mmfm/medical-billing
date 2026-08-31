# Scoping out tasks
- Always verify information before coding.
  - For example, before implementing a Mastra agent, you should read their docs, install their SDK, and look at the interface in their SDK.
- When writing complex features or significant refactors, always follow the `.claude/PLANS.md` template. Create a `docs/agent-features/{FEATURE_NAME}-plan.md` based on the template and maintain it
from design to implementation.

# Minimal changes
- Keep changes to the minimum necessary to deliver the next core functionality. Keep them small enough for a human to read and understand. Only add code (request arguments, implementations, DB schemas, etc) that will be used imminently, not for future use. Only add abstractions when it makes the code better now.
  - As an example, when implementing a Mastra agent, you should already be reading documentation before coding. The documentation should guide you on whether prompt additions are necessary for the task.

# Code comments
- Do not generate or modify code comments. I will do so myself.
- If a comment seems necessary, check whether better names or structure remove the need.

# Misc
- Don't commit and push without my explicit permission.
- The code is currently in demo form. When I authorize a push, you should always push directly to origin/main, rebasing when necessary.

# General conventions
- Typescript rules at docs/typescript.md

# Writing and running CLIs
- Persist stdout to a file in cli_outputs/ so that I can review the execution history afterwards, even if it fails.
- Persist the ouputs of the CLI itself to cli_outputs as well.
- Output these filepaths

# Shared agent resources
- Everything in .claude is shared with all coding agents.
