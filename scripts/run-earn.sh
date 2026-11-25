#!/usr/bin/env bash
# Runs the Earn (staking) flow on the Canton LocalNet (app-provider participant, port 3975).
# Flow: issue funds -> provider offers a stake -> saver locks money -> wait -> provider redeems with interest.
#
# DEMO RATE: a realistic rate (e.g. 5% a year) earns well under one cent in a few seconds, which rounds
# down to 0.00. So this demo uses an absurd APR (100000.0 = 10,000,000% a year) to make interest visible
# in ~15 seconds. The contract logic is identical; only the rate is unrealistic.
set -euo pipefail

KC="http://keycloak.localhost:8082/realms/AppProvider/protocol/openid-connect/token"
API="http://localhost:3975"
PKG="#remittance"
APR="100000.0"
WAIT_SECONDS=15

ADMIN=$(curl -s --resolve keycloak.localhost:8082:127.0.0.1 "$KC" \
  -d client_id=app-provider-validator \
  -d client_secret=${VALIDATOR_SECRET:?set VALIDATOR_SECRET} \
  -d grant_type=client_credentials -d scope=openid | jq -r .access_token)
[ -n "$ADMIN" ] && [ "$ADMIN" != "null" ] || { echo "Could not get admin token"; exit 1; }

get()  { curl -s -H "Authorization: Bearer $ADMIN" "$API$1"; }
post() { curl -s -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" -X POST "$API$1" -d "$2"; }

USER_ID=$(get /v2/authenticated-user | jq -r .user.id)

party() {
  local hint=$1 found
  found=$(get /v2/parties | jq -r --arg h "$hint::" '.partyDetails[].party | select(startswith($h))' | head -1)
  if [ -z "$found" ]; then
    found=$(post /v2/parties "{\"partyIdHint\":\"$hint\",\"identityProviderId\":\"\"}" | jq -r '.partyDetails.party')
  fi
  [ -n "$found" ] && [ "$found" != "null" ] || { echo "Could not create party $hint"; exit 1; }
  echo "$found"
}
ISSUER=$(party swiftline_issuer); PROVIDER=$(party swiftline_provider); SAVER=$(party swiftline_sender)
echo "Issuer:   $ISSUER"; echo "Provider: $PROVIDER"; echo "Saver:    $SAVER"

RIGHTS=$(jq -n --arg u "$USER_ID" --argjson ps "$(printf '%s\n' "$ISSUER" "$PROVIDER" "$SAVER" | jq -R . | jq -s .)" \
  '{userId:$u, identityProviderId:"", rights: ($ps | map({kind:{CanActAs:{value:{party:.}}}}) + ($ps | map({kind:{CanReadAs:{value:{party:.}}}})))}')
post "/v2/users/$USER_ID/rights" "$RIGHTS" >/dev/null

CMD=0
submit() {  # submit "<party> [<party> ...]" <command-json>   (all listed parties act, so their events are visible)
  CMD=$((CMD+1))
  local parties body resp
  parties=$(printf '%s\n' $1 | jq -R . | jq -s .)
  body=$(jq -n --arg id "swiftline-earn-$(date +%s)-$CMD" --argjson ps "$parties" --argjson c "$2" \
    '{commands:{commands:[$c], commandId:$id, actAs:$ps, readAs:$ps}}')
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
cid_of() { echo "$1" | jq -r --arg s "$2" '[.transaction.events[] | select(has("CreatedEvent")) | .CreatedEvent | select(.templateId | endswith($s)) | .contractId] | first'; }

echo "1/5 Issuing 1000 USD to the saver"
R=$(submit "$ISSUER" "$(create Remit.Token:Holding "$(jq -n --arg i "$ISSUER" --arg o "$SAVER" '{issuer:$i,owner:$o,currency:"USD",amount:"1000.0",viewers:[]}')")")
SAVER_USD=$(cid_of "$R" ":Holding")

echo "2/5 Issuing 100 USD to the provider (interest reserve)"
R=$(submit "$ISSUER" "$(create Remit.Token:Holding "$(jq -n --arg i "$ISSUER" --arg o "$PROVIDER" '{issuer:$i,owner:$o,currency:"USD",amount:"100.0",viewers:[]}')")")
RESERVE=$(cid_of "$R" ":Holding")

echo "3/5 Provider offers a stake: APR $APR (demo rate), 30-day lock, minimum 50"
R=$(submit "$PROVIDER" "$(create Remit.Earn:StakeOffer "$(jq -n --arg p "$PROVIDER" --arg o "$SAVER" --arg a "$APR" \
  '{provider:$p,owner:$o,currency:"USD",apr:$a,lockDays:"30",minAmount:"50.0"}')")")
OFFER=$(cid_of "$R" ":StakeOffer")

echo "4/5 Saver locks the 1000 USD"
R=$(submit "$SAVER" "$(exercise Remit.Earn:StakeOffer "$OFFER" StartStake "$(jq -n --arg h "$SAVER_USD" '{holdingCid:$h}')")")
STAKE=$(cid_of "$R" ":Stake")
echo "   Stake created. Waiting $WAIT_SECONDS seconds so interest builds up..."
sleep "$WAIT_SECONDS"

echo "5/5 Provider redeems: principal returns and interest is paid from the reserve"
R=$(submit "$PROVIDER $SAVER" "$(exercise Remit.Earn:Stake "$STAKE" Redeem "$(jq -n --arg r "$RESERVE" '{reserveCid:$r}')")")

echo; echo "=== Contracts created by the redemption ==="
echo "$R" | jq -r '.transaction.events[] | select(has("CreatedEvent")) | .CreatedEvent | "\(.templateId)\n  owner=\(.createArgument.owner)  amount=\(.createArgument.amount)  currency=\(.createArgument.currency)"'
echo
echo "Expected: one USD holding of 1000.0 (principal) and one smaller holding (interest) for the saver,"
echo "and the provider's reserve reduced by the same interest amount."
