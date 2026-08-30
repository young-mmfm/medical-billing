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
