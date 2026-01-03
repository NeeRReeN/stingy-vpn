# Copilot Instructions

**Detailed Information**: For project overview, architecture, setup procedures, and coding conventions, refer to [AGENTS.md](../AGENTS.md) and the AGENTS.md files in each directory.

## GitHub Copilot Specific Instructions

- **Rule of thumb**: Ask the user for clarification on unclear points.
- **Keep the context**: Save long responses temporarily in `.github/tmp` directory as `response-YYYYMMDDHHmmss.md` for reuse in subsequent requests

### Guidelines for Response Generation

- Provide responses **in the same language as in the prompt**
- Do not use emojis
- Be clear when critiquing user opinions (whether agreeing or disagreeing); avoid ambiguous reactions
- Keep responses concise and focused on key points
- Accompany suggestions with visual, concrete examples (code snippets, diffs, etc.)
- Always verify latest best practices
- Use bullet points or tables to effectively explain relationships (pros and cons, trade-offs, etc.)

### Code Generation Guidelines and Guardrails

- Never hardcode secrets (API keys, tokens, private keys, etc.)
- Do not execute push operations without permission (CDK deploy, script execution, remote repository pushes, etc.)
- Do not add dependencies without permission
