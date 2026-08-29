# Basics

A system that handles the process after a patient sees a provider. This includes:
- Turning information from the EMR into something that can be turned into a claim
- Actually sending the claim to the payer, which is sometimes done by clicking buttons in the EMR and sometimes can be done by sending an API request from our systems to a clearinghouse
- In the success case:
    - Claim is successfully approved
    - Payer sends money to the provider's bank account
    - Payer sends a description of what they paid out
    - We then collect the remaining amount from the patient

- Failure modes:
    - We mess up the part where we turn information into the claim
        - This can result in a rejected claim, or it can turn into an incorrect but processed claim
    - Payer never responds, we need to contact them to determine the status
    - Payer denies the claim
        - We decide whether to resubmit the claim or appeal the claim and go do that
    - We submitted the claim successfully and the payer paid, but there's something wrong with what we submitted and we need to amend what we submitted to insurance

- The system won't be able to handle every case that comes up. In that case, it needs to allow a person (either someone at Reclaim, someone at the provider, or someone at the provider's billing dept) to take action and provide notes on what happened

- It's possible that the system also needs to handle the prior authorization before the patient receives care as well
    - In which case we check what the patient likely needs to pay based on the insurance rules

# (Maybe Agent) workflows

- We track each high-level stage into a log. Stages: extract claim info, generate claim, submit claim, etc.
    - Actions are what we show to humans.
- We might need to save examples of what happened when the agents took specific actions. This is so future agent runs can
pull this into context when they want to learn how to do a task or how to get a failure mode.
    - Can expose this as an MCP endpoint that searches for these specific traces when the agent gets stuck.
    - Or we can just save its learnings under specific tags and this can be looked up as necessary
    - Can maybe also have a way for a person to guide the agent on what to do when they are stuck
    - Maybe we can also have a human manually explore how to do a task and have that recorded, then have an agent generate learnings


Terms used below, defined once:

- **Clearinghouse** — a middleman service between us and the many payers. We send it claims; it checks formatting, routes each claim to the right payer, and passes back the payer's responses. It does not decide whether a claim gets paid.
- **Claim file / batch** — we usually send many claims at once in a single file, rather than one at a time.
- **Acknowledgment** — a machine reply telling us a claim was *accepted into the payer's processing queue*. It is not a payment decision, just confirmation the claim wasn't thrown out at the door. These come back in stages: first "we received your file," then "claim #3 in your file is accepted, claim #7 is rejected for a bad member ID." Industry names for these replies are 999 and 277CA; we mostly just care that each claim reached "accepted."
- **Adjudication** — the payer actually deciding what it will pay on a claim.
- **Remittance advice (also called an ERA, or "the 835")** — the payer's itemized explanation of how it processed a batch of claims: for each claim, what was allowed, what the payer paid, what was written off, and what the patient owes. It's a structured data file, not a PDF we have to read.
- **EFT** — the payer's actual bank deposit. Arrives separately from the remittance advice, sometimes on a different day.
- **Trace number (TRN)** — an ID shared by a remittance advice and its matching deposit. It's how we tell which explanation goes with which pile of money.
- **Contractual adjustment** — the gap between what we billed and what the payer's contract allows. We agreed not to collect it. Not a patient bill.
- **Recoupment / offset** — the payer clawing back money from an earlier claim by paying us less on a current one.
- **Unapplied cash** — money we received but haven't yet matched to a specific patient account or claim.

---

- Trigger: documentation from clinic is finalized; ready for RCM to submit the claim
    1. **Extract** — browser agent pulls the encounter facts out of the EMR.
        - Per-clinic / per-EMR navigation instructions, since builds and templates differ between installs of the same EMR.
        - Output is a *structured encounter record*, not a claim: what drug was given, its NDC (the manufacturer's product ID for that exact vial/package), the dose, how much was given and how much was thrown away, the route, the start and stop times of the infusion, the diagnosis, who administered it, where, and whether the chart was signed.
        - Every field carries a source citation (screen / element / screenshot region) so a human can check it without re-driving the browser.
        - The critical numbers — drug, NDC, dose, units, start/stop times, waste — get read a second time, independently. If the two reads disagree, a human decides. We do not let the model break the tie.
        - Why this is its own stage: if the agent misreads a fact (40mg as 400mg, or grabs last month's visit), the resulting claim is perfectly well-formed and simply wrong. Nothing downstream catches that — the format checks pass, the coding looks right. It gets paid, and then we owe the money back. That's a different and worse failure than a claim that gets rejected.
    2. **Code** — turn the encounter record into billable claim lines.
        - Separate stage from extract so we can redo the coding without re-driving the browser, and redo the extraction without re-arguing the coding. Different failure modes, different test sets.
        - Resources the coding agent gets:
            - The structured encounter record from step 1
            - Which payer and which plan the patient has; the contracted rates if we have them
            - The prior authorization **and its scope** — prior authorization is the payer's advance approval for an expensive drug, and it's granted for a specific drug, a specific date range, a specific quantity, and a specific care setting. Having an approval number is not the same as being covered: if the patient got a higher dose than approved, or came in after the date range expired, it doesn't apply. All four have to line up.
            - That payer's own rules about how this drug should be billed and when it considers the treatment medically necessary
            - The code sets — the standardized vocabularies claims are written in:
                - A lookup from the drug's NDC to its billing code, plus the conversion into billing units (payers bill drugs in their own unit sizes, which rarely match the vial size)
                - The procedure codes for the act of administering an infusion, which depend on how long it ran and whether other drugs were given in the same visit
                - Modifiers — short suffixes that flag special circumstances, e.g. that some of the drug was discarded
                - Diagnosis codes
            - Previously accepted claims for the same drug + payer + clinic, as worked examples. This is where the saved-traces idea earlier in this doc pays off.
            - The clinic's own internal item list, mapping their inventory names to billing codes
        - The NDC→billing-unit conversion is a table lookup plus arithmetic that the agent **calls as a tool**, never does in its head. Getting it wrong is one of the most common causes of both denials and overpayments.
    3. **Check** — fixed, non-AI rules gate the claim before anything is submitted.
        - The agent decides; the rules gate. Keep that split — it's the main safety property of this design.
    4. **Verify** — a second LLM reviews the *coding judgment* (was this the right code for this situation), not the extracted facts. Facts are covered by the double-read in step 1; a second model reading the same screen tends to make the same mistake.
    5. **Persist** — the extraction artifact and the coding artifact are saved unchangeably and linked to the claim.
        - When a payer denies the claim six weeks later, or we discover a paid claim was wrong and have to amend it, the question is always "what did we believe at the time, and why did we believe it." If those artifacts can be edited or aren't linked to the claim, we can't answer that, can't measure whether we're improving, and can't defend the claim if asked.
    6. **Submit** — the claim goes out.
        - Two possible paths, and they are **not** fallbacks for each other — they decide who owns the claim's status. If we submit through the EMR's own billing module, the EMR holds the real claim state and our database is a copy that will slowly drift out of sync. If we submit through the clearinghouse, we hold the real state and the EMR has no idea what happened.
        - Pick one as authoritative **per clinic**, and record that choice in the data model. Everything downstream — checking claim status, posting payments, aging reports — depends on knowing which system to believe.
        - This stage is not finished when we hit send. It's finished when each claim comes back **accepted** (see acknowledgment, above). A claim that was transmitted but never acknowledged is the classic way claims silently disappear — nobody rejected it, nobody's processing it, and we don't find out until the filing deadline has passed. So the acknowledgment tracking belongs here, not only in the "we never hear back" trigger below.

- Trigger: happy path after submitting claim
    7. Mostly ordinary software, plus a queue for the cases it can't settle.
        - One remittance advice covering many claims is **not** a hard case — it's the normal case, and it's fully mechanical. The file is structured: a section per claim, a subsection per line item, itemized adjustments, and totals that reconcile against the deposit. We parse it and post it. No judgment needed.
        - What does need a queue is narrower:
            - **Matching each remittance advice to its deposit** — normally the shared trace number does it. It fails when the bank feed drops or mangles the trace number, when one deposit covers several remittance files, or when the money and the explanation arrive days apart.
            - **Clawbacks** — the file tells us plainly that the payer withheld money to recover an earlier overpayment, and the arithmetic is unambiguous. What needs a person is figuring out *which* old claim it refers to and whether the payer was right to take it.
            - **Denial routing** — this is the real judgment work. Posting a routine contractual write-off is mechanical. But when a payer denies for, say, missing prior authorization, someone has to decide: fix and resubmit, appeal, absorb it, or bill the patient. Each denial reason implies different work and different deadlines.
            - **Unapplied cash** — automatic matching places most payments; the leftovers need someone to research where the money belongs.

- Trigger: we never hear back about specific claims
    1. Agent uses the browser to check the clearinghouse or payer portal to make sure nothing is off-track
    2. If nothing happens there, we might need to make a phone call to the payer

- Trigger: the batched claims we sent to the clearinghouse is incorrectly formatted in some way
    1. How is this sent to our software systems? Is it a sycnronous request, webhook or something?
    2. An agent takes a look at what was sent and potentially modifies things to get them accepted (if we have info on which claims were bad we can move those out of the batch)

- Trigger: we get money information back after submitting claim




# User journeys





