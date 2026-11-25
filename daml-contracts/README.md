# Swiftline contracts

Flow: Provider offers a **Quote** -> Sender accepts and money moves into escrow (**RemitTransfer**)
-> Provider runs **Settle**, which checks the **KycAttestation**, pays the recipient, and writes a **Receipt**,
all in one transaction.

| File | Purpose |
| --- | --- |
| Token.daml | Currency token (Holding) with MoveTo and Split |
| Compliance.daml | Identity attestation with a per-transfer limit and expiry |
| Quote.daml | Locked rate and fee; AcceptQuote moves funds into escrow |
| Transfer.daml | Settle, Reject, CancelAfterDeadline, and the Receipt |
| Earn.daml | Fixed-rate staking: StakeOffer, Stake, Redeem, ClaimPrincipal |

Tests live in `../daml-tests`. Build this package first: `dpm build`.
