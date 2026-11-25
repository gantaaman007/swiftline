#!/usr/bin/env bash
# Runs one Swiftline transfer on the Canton LocalNet (app-provider participant, port 3975).
# Flow: parties -> funds -> identity check -> quote -> accept -> settle -> receipt.
set -euo pipefail

KC="http://keycloak.localhost:8082/realms/AppProvider/protocol/openid-connect/token"
API="http://localhost:3975"
PKG="#remittance"

# ---- admin token (same client the quickstart's onboarding uses) ----
ADMIN=$(curl -s --resolve keycloak.localhost:8082:127.0.0.1 "$KC" \
  -d client_id=app-provider-validator \
  -d client_secret=${VALIDATOR_SECRET:?set VALIDATOR_SECRET} \
  -d grant_type=client_credentials -d scope=openid | jq -r .access_token)
[ -n "$ADMIN" ] && [ "$ADMIN" != "null" ] || { echo "Could not get admin token"; exit 1; }

get()  { curl -s -H "Authorization: Bearer $ADMIN" "$API$1"; }
post() { curl -s -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" -X POST "$API$1" -d "$2"; }

USER_ID=$(get /v2/authenticated-user | jq -r .user.id)
echo "Admin ledger user: $USER_ID"

# ---- parties (reuse if they already exist) ----
party() {
  local hint=$1 found
  found=$(get /v2/parties | jq -r --arg h "$hint::" '.partyDetails[].party | select(startswith($h))' | head -1)
  if [ -z "$found" ]; then
    found=$(post /v2/parties "{\"partyIdHint\":\"$hint\",\"identityProviderId\":\"\"}" | jq -r '.partyDetails.party')
  fi
  [ -n "$found" ] && [ "$found" != "null" ] || { echo "Could not create party $hint"; exit 1; }
  echo "$found"
}
ISSUER=$(party swiftline_issuer);       PROVIDER=$(party swiftline_provider)
SENDER=$(party swiftline_sender);       RECIPIENT=$(party swiftline_recipient)
REGULATOR=$(party swiftline_regulator)
echo "Parties ready:"; printf '  %s\n' "$ISSUER" "$PROVIDER" "$SENDER" "$RECIPIENT" "$REGULATOR"

# ---- let the admin user act as all of them ----
RIGHTS=$(jq -n --arg u "$USER_ID" --argjson ps "$(printf '%s\n' "$ISSUER" "$PROVIDER" "$SENDER" "$RECIPIENT" "$REGULATOR" | jq -R . | jq -s .)" \
  '{userId:$u, identityProviderId:"", rights: ($ps | map({kind:{CanActAs:{value:{party:.}}}}) + ($ps | map({kind:{CanReadAs:{value:{party:.}}}})))}')
post "/v2/users/$USER_ID/rights" "$RIGHTS" | jq -c . | head -c 300; echo

# ---- submit one command and return the created events ----
CMD=0
submit() {  # submit <actAs> <command-json>
  CMD=$((CMD+1))
  local body resp
  body=$(jq -n --arg id "swiftline-$(date +%s)-$CMD" --arg p "$1" --argjson c "$2" \
    '{commands:{commands:[$c], commandId:$id, actAs:[$p], readAs:[$p]}}')
  resp=$(post /v2/commands/submit-and-wait-for-transaction "$body")
  if echo "$resp" | jq -e '.transaction' >/dev/null 2>&1; then
    echo "$resp"
  else
    echo "COMMAND FAILED:" >&2; echo "$resp" | head -c 1200 >&2; echo >&2; exit 1
  fi
}
create() { jq -n --arg t "$PKG:$1" --argjson a "$2" '{CreateCommand:{templateId:$t, createArguments:$a}}'; }
exercise() { jq -n --arg t "$PKG:$1" --arg c "$2" --arg ch "$3" --argjson a "$4" \
  '{ExerciseCommand:{templateId:$t, contractId:$c, choice:$ch, choiceArgument:$a}}'; }
cid_of() {  # cid_of <response> <template-suffix>
  echo "$1" | jq -r --arg s "$2" '[.transaction.events[] | select(has("CreatedEvent")) | .CreatedEvent | select(.templateId | endswith($s)) | .contractId] | first'
}

NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
IN10M=$(date -u -d '+10 minutes' +%Y-%m-%dT%H:%M:%SZ)
IN1D=$(date -u -d '+1 day' +%Y-%m-%dT%H:%M:%SZ)
IN30D=$(date -u -d '+30 days' +%Y-%m-%dT%H:%M:%SZ)

echo "1/6 Issuing 1200 USD to the sender"
R=$(submit "$ISSUER" "$(create Remit.Token:Holding "$(jq -n --arg i "$ISSUER" --arg o "$SENDER" '{issuer:$i,owner:$o,currency:"USD",amount:"1200.0",viewers:[]}')")")
USD=$(cid_of "$R" ":Holding")

echo "2/6 Issuing 1,000,000 INR to the provider (payout funds)"
R=$(submit "$ISSUER" "$(create Remit.Token:Holding "$(jq -n --arg i "$ISSUER" --arg o "$PROVIDER" '{issuer:$i,owner:$o,currency:"INR",amount:"1000000.0",viewers:[]}')")")
INR=$(cid_of "$R" ":Holding")

echo "3/6 Provider verifies the sender (identity attestation)"
R=$(submit "$PROVIDER" "$(create Remit.Compliance:KycAttestation "$(jq -n --arg p "$PROVIDER" --arg s "$SENDER" --arg r "$REGULATOR" --arg v "$IN30D" \
  '{provider:$p,subject:$s,regulator:$r,limitCurrency:"USD",perTransferLimit:"2000.0",validUntil:$v}')")")
KYC=$(cid_of "$R" ":KycAttestation")

echo "4/6 Provider offers a quote: 83 INR per USD, fee 0.6% (min 1.50)"
R=$(submit "$PROVIDER" "$(create Remit.Quote:Quote "$(jq -n --arg p "$PROVIDER" --arg s "$SENDER" --arg e "$IN10M" \
  '{provider:$p,sender:$s,fromCurrency:"USD",toCurrency:"INR",rate:"83.0",feeRate:"0.006",minFee:"1.5",expiresAt:$e}')")")
QUOTE=$(cid_of "$R" ":Quote")

echo "5/6 Sender accepts the quote for 500 USD (funds move to escrow)"
R=$(submit "$SENDER" "$(exercise Remit.Quote:Quote "$QUOTE" AcceptQuote "$(jq -n --arg r "$RECIPIENT" --arg g "$REGULATOR" --arg h "$USD" --arg b "$IN1D" \
  '{recipient:$r,regulator:$g,sendAmount:"500.0",holdingCid:$h,settleBy:$b}')")")
TRANSFER=$(cid_of "$R" ":RemitTransfer")

echo "6/6 Provider settles: checks run, recipient is paid, receipt written"
R=$(submit "$PROVIDER" "$(exercise Remit.Transfer:RemitTransfer "$TRANSFER" Settle "$(jq -n --arg a "$KYC" --arg p "$INR" '{attestationCid:$a,payoutCid:$p}')")")

echo; echo "=== Contracts created by the settlement ==="
echo "$R" | jq -r '.transaction.events[] | select(has("CreatedEvent")) | .CreatedEvent | "\(.templateId)\n  \(.createArgument | tostring)"'
