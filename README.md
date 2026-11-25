# Swiftline

A cross-border remittance prototype on **Canton Network**, written in **Daml**.

A sender locks a quote, funds move into escrow, and the provider settles the transfer in one atomic transaction that checks identity and limits, pays the recipient, and writes a receipt. Each party sees only its own part of the transfer.

> Portfolio prototype. Rates, balances, and the payout partner are mocked. It is not a licensed money-transfer service.

## Status

| Piece | State |
| --- | --- |
| Daml contracts (Token, Compliance, Quote, Transfer, Earn) | Done |
| Daml Script tests | 30 passing |
| Deployed to a Canton LocalNet (cn-quickstart) | Done |
| Full transfer run on the live ledger (`scripts/run-transfer.sh`) | Done |
| UI design (14 screens) | Done, static mockup |
| Web app using the 14-screen design, wired to the ledger | Built; core flow, Earn and Regulator view are live, other screens are design previews |
| Earn flow run on the live ledger (`scripts/run-earn.sh`) | Done |

## The problem

- The global average cost of sending $200 was **6.49%** in Q1 2025 (World Bank Remittance Prices Worldwide). The UN target is 3% by 2030.
- Costs are higher in some corridors, for example 8.46% on average for Sub-Saharan Africa in Q3 2025, and digital services were cheaper than non-digital ones (4.85% versus 7.16%).

## What already exists

Research notes from November 2026. Verify before quoting them in public.

- Incumbents are moving to stablecoin rails: Western Union (USDPT on Solana), MoneyGram (MGUSD on Stellar), Remitly (with Bridge, USDC), and Zelle (ZLUSD, starting with India). Wise has stayed skeptical.
- On Canton, the activity I found is institutional and business-to-business: stablecoin payroll, payment routing with USDCx, and regulated stablecoin issuers.

## The gap

I found no consumer-style remittance flow on Canton. The open space is **private, compliance-aware transfers** with built-in limits, receipts, and regulator visibility. This is my own analysis from that research, not a claim that nothing exists.

## How it works

```
Provider offers Quote  ->  Sender accepts (AcceptQuote)  ->  Funds locked in escrow (RemitTransfer)
                                                                       |
        Receipt  <-  Recipient paid  <-  Provider runs Settle (KYC + limit checks)   ... or Reject / CancelAfterDeadline
```

| Contract | Purpose |
| --- | --- |
| `Token.daml` | Currency token (`Holding`) with `MoveTo`, `Split`, and `Lock` (hands money to an escrow holder while letting the sender keep seeing it) |
| `Compliance.daml` | `KycAttestation`: per-transfer limit, expiry, and revocation |
| `Quote.daml` | Locked rate and fee. `AcceptQuote` checks expiry and balance and moves funds into escrow |
| `Transfer.daml` | `Settle`, `Reject`, `CancelAfterDeadline`, and the `Receipt` |
| `Earn.daml` | Fixed-rate staking: `StakeOffer`, `Stake`, `Redeem`, `ClaimPrincipal` |

Design choices worth noting:

- **Atomic settlement.** `Settle` checks the attestation, pays the recipient, and writes the receipt in one transaction. If any check fails, nothing happens.
- **Sender safety net.** If the provider does not settle by the deadline, the sender can take the money back alone (`CancelAfterDeadline`). The same idea protects stakers (`ClaimPrincipal` after maturity).
- **Privacy through observers.** The regulator and recipient see the transfer, and an outsider sees nothing. This is tested.

## Tests

30 Daml Script tests in `daml-tests/`, kept in a separate package so the contracts package stays free of the `daml-script` dependency.

They cover the happy path, over-limit transfers, expired and revoked attestations, expired quotes, underfunded payouts, wrong currencies, rejection and refunds, cancellation before and after the deadline, who may act, privacy and receipt visibility, and staking interest (full term, early redeem, and capped at maturity).

One test found a real bug: after `AcceptQuote`, the sender could not see the escrowed money, so `CancelAfterDeadline` failed. The `Lock` choice fixed it.

## Live run on Canton

`scripts/run-transfer.sh` runs one full transfer through the ledger's JSON API: it creates five parties, issues funds, verifies the sender, offers and accepts a quote, and settles.

Result of a real run: 500 USD sent, fee 3.00, rate 83, recipient receives **41,251.00 INR**, and the provider's payout funds drop by exactly that amount.

## Live Earn run

`scripts/run-earn.sh` locks 1000 USD, waits 15 seconds, and redeems. It uses an unrealistic demo rate (APR 100000.0) so interest is visible in seconds; a real rate would earn under a cent in that time.

Result of a real run: principal 1000.00 USD returned, interest 48.97 USD paid to the saver, and the provider's 100.00 USD reserve reduced to 51.03, so the interest came entirely from the reserve.

## Build and run

Requirements: Nix and direnv (for `dpm`), Docker Desktop, and [cn-quickstart](https://github.com/digital-asset/cn-quickstart). On Windows, WSL2 with about 8 GB or more for the LocalNet.

```bash
# build and test
cd daml-contracts && dpm build
cd ../daml-tests && dpm build && dpm test

# deploy: in cn-quickstart/quickstart/compose.yaml, under splice-onboarding volumes, add
#   - ../swiftline/daml-contracts/.daml/dist/remittance-0.1.0.dar:/canton/dars/remittance-0.1.0.dar
cd ~/cn-quickstart/quickstart && make stop && make start

# run one transfer on the live ledger
../swiftline/scripts/run-transfer.sh
```

## Web app

`app/` is a small Node server (no dependencies, Node 18+) plus the front end. The server holds the Keycloak credentials and talks to the ledger; the browser never sees them.

The front end loads the original design files from `ui-design/` (copied to `app/public/screens/`) through a tiny runtime (`runtime.js`), so the layouts are the design's own. Live ledger data is wired into these screens: Welcome (sets up demo data), Home, My money (USD balance), Send, Review, Track (the provider settles automatically a moment after you confirm), Receipt, Earn, and the Regulator view. Recurring, Alerts, Request money and Cash out are design previews with no contracts behind them.

```bash
# LocalNet running (make start), then:
export VALIDATOR_SECRET=<app-provider-validator client secret from the quickstart>
cd app && node server.js        # open http://localhost:8090
```

- `http://localhost:8090/` is the project brief; `/#/Welcome` is the phone-style app that follows the design.
- `http://localhost:8090/site.html` is the full-width website version: Home, Send, Activity (settle, reject, cancel, receipts), Earn (set your own rate, redeem, claim) and Privacy and Regulator views.
- `http://localhost:8090/console.html` is the older plain developer console, kept for reference; the website covers everything it does.
- The phone app's Earn screen stakes at the design's 4% yearly rate, so interest over a few seconds rounds to zero. On the website's Earn page you can set the rate (for example 10000000 for a fast demo), or use `scripts/run-earn.sh`.
- Wallet shows EUR and INR balances from the design as illustrative; only USD is live.

`node test/mock-ledger.js` plus `node test/ui.test.js` (phone app), `node test/site.test.js` (website) and `node test/console.test.js` run the app against a stand-in ledger (needs Playwright). That checks the server and screens only, not the real contracts.

## Tradeoffs and honest limits

- **Custodial by design.** To keep the app usable for older, non-technical senders, users never handle keys or seed phrases. That means the provider holds the keys, which conflicts with a fully decentralized design. This is a deliberate tradeoff.
- **Canton is permissioned.** Its strength is privacy and compliance, not open decentralization. I chose it for institutional realism.
- **Interest may be regulated.** Offering returns to consumers can count as a regulated financial product. The rates and lock periods here are placeholders, and the live demo uses an unrealistic rate so interest shows within seconds.
- **India constraints.** Stablecoin payouts there face a high USDT premium, a 30% tax on crypto gains plus 1% TDS, and the fact that stablecoins are not RBI-authorised. A real product would pay out through a licensed local partner, not hold crypto on the receiving side. Figures are from my research notes; verify them before relying on them.
- **Demo shortcuts.** All five parties sit on one participant and one admin token acts for them, so the run shows the contract logic but not privacy across separate participants. Payouts, KYC, and rates are mocked.

## Roadmap

- Put parties on separate participants (app-provider and app-user) to demonstrate cross-participant privacy.

## Repository layout

```
daml-contracts/   the contracts (build first)
daml-tests/       Daml Script tests (depends on the contracts DAR)
scripts/          run-transfer.sh and run-earn.sh, the live-ledger demos
app/              web app (design screens wired to the ledger), console, offline test ledger
ui-design/        the 14-screen app design
multi-package.yaml
```
