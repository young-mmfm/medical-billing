# Current
- When available, hit the backend endpoints of the web server directly.
- Otherwise, use Playwright for deterministic scripts.
- To start, we might need to have different Playwright scripts for each customer. We can see how well they generalize over time.
- To create the initial Playwright script per customer and when things break, let's do manual fixing for now.
- Later, we can see if we can use Playwright Agents can help us do the onboarding.
- And see if we can have a more agent in-the-browser supplement if the deterministic Playwright script doesn't work for a specific use case.
    - If we save all of these edge cases, we can just test all the agents on these edge cases and pick the best one
- (Or maybe we could have LLM steps that can help guide the Playwright script if it is incorrect, but that seems more complicated)

- If this approach doesn't end up working, after we have a few customers we can see if an AI approach that assumes very little knowlege of each site works reliably (it'll be slower, but maybe it can save us time on engineering). And another thing to test is a mixture of deterministic playwright with an AI agent. 

# Deprecated
| Area | Component | Choice |
|---|---|---|
| Core | Language | TypeScript |
| Core | Browser driver | Playwright |
| Core | AI browser layer | Stagehand |
| Core | Model | Claude Sonnet (runtime), Opus (discovery/authoring) |
| Runtime | Browser hosting | Browserbase (`env: "BROWSERBASE"`) |
| Runtime | Workers | Own infra, existing Temporal fleet |
| Data access | Primary | Internal JSON API found via HAR recon |
| Data access | Fallback | Use Stagehand |
| Validation | Schema | Zod |
| Validation | Checks | Verbatim grounding against page text, cross-reference vs. known patient data, confidence routing |
