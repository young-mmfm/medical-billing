| Area | Component | Choice |
|---|---|---|
| Core | Language | TypeScript |
| Core | Browser driver | Playwright |
| Core | AI browser layer | Stagehand |
| Core | Model | Claude Sonnet (runtime), Opus (discovery/authoring) |
| Runtime | Browser hosting | Browserbase (`env: "BROWSERBASE"`) |
| Runtime | Workers | Own infra, existing Temporal fleet |
| Runtime | Browser endpoint | Injected via env var; `LOCAL` + `mcr.microsoft.com/playwright` as fallback path |
| Data access | Primary | Internal JSON API found via HAR recon |
| Data access | HTTP client | `context.request` (APIRequestContext); `request.newContext({ storageState })` where session is cookie-only |
| Data access | Fallback 1 | `page.evaluate(fetch)` when TLS fingerprint or signed headers matter |
| Data access | Fallback 2 | DOM extraction via Stagehand |
| Execution | Pattern | `observe()` → cache action → `act(cachedAction)` |
| Execution | Cache | Stagehand `cacheDir` + `serverCache`; keys scoped `{customer}:{emr}:{version}:{workflow}:{step}` |
| Execution | Fallback tiers | Cached action → re-observe step → `agent()` → human queue |
| Execution | Write paths | No auto-heal; proposed action to human review queue before execution |
| Auth | Secrets | Vault or AWS Secrets Manager |
| Auth | MFA | Shared TOTP seed via `otplib`; persisted device-trust `storageState` as fallback |
| Auth | Session model | One `BrowserContext` per login; close page after login |
| Validation | Schema | Zod |
| Validation | Checks | Verbatim grounding against page text, cross-reference vs. known patient data, confidence routing |
| Orchestration | Engine | Temporal |
| Observability | LLM | Stagehand OTel spans |
| Observability | Browser | Playwright tracing (`screenshots`, `snapshots`, `sources`), discarded on success |
| Observability | Video | On retry only |
| Observability | Evidence | Encrypted object store, short retention |
| Testing | Evals | Saved HTML/HAR fixtures run in CI |
| Claims | Transport | REST clearinghouse API |
| Claims | Response handling | Webhooks for 999 / 277CA / 835; fetch payload by transaction ID |
| Claims | Correlation | Patient Control Number ≤17 chars; line item control number (loop 2400) |
| Claims | Silent claims | Scheduled 276/277 status inquiry job |
| Not building | Live view / takeover | Covered by Browserbase |
| Not building | Self-hosted Chromium | Fallback only, unbuilt until a customer requires it |
