# Option 1: Call insurance
- Status
    - Patient, Treatment, Date of service, Insurance
    - submitted | approved | paid | underpaid | processing
- Trying to get more information after a denial
    - Reference # is for the call itself
    - Give them the messages that we received
    - Ask them what's next
    - Provide information to the provider on what to do next

- Clearing house will return back data about whether the payer suggests we resubmit or whether they denied it outright
    - Sometimes they'll give you a code CO-16 denial code, which you'll want to resubmit
    -


# Data model so far

Database
- Payers
    - They might have different numbers for chemo drugs, other drugs, etc
    - Phone number
    - Hours when they accept calls

(This is how the agent gets a history of what's been done so far)
- Claim event log
    - claim ID
    - sequence number
    - json blob of information
- Calls
    - claim ID
    - sequence number
    - location of transcript in S3
    - status
    - json blob: LLM json output afterwards

S3
- Call transcripts



# Workflows

- We got a denial from an insurance payer. "Insufficient medical records"
- This isn't in our tribal knowledge of what to do next and it's not likely that someone at the provider knows what to do with it
- Look up (internally) the right phone number to call
- We navigate the hold + phone tree

- Bad case: this is the wrong number
- The person on the line tells us to call a different number
- Record this and note this for Reclaim operator

- Happy case:
- We provide the following information:
    - Patient
        - Legal name
        - DOB
        - Member ID
    - Date of service
    - Insurance
        - Claim #
    - Clinic
        - Name
        - Billing Provider NPI
        - Billing Tax ID
- We tell them what we've done so far and what we got back from them
- They tell us some information, we decide whether that's sufficient for the next step on resubmitting or filing an appeal
    - For filing an appeal, we'll want to note down what channel to appeal through

# Parts of the system

- There's some serivce that we use that does the actual calling / navigating hold + phone tree
- We're going to want a live voice model that handles the actual call
    - This voice model service should directly provide the transcript to later be processed by an LLM
- After the voice model is done with the call, we process through an LLM to extract all the structured data


