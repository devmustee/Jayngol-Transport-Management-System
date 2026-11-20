# Move money: fixes plan

From the review on 20 Nov 2026. Each problem below was checked on the test database.

## 1. The same cash handed over twice

**Now:** a waiting handover doesn't hold the sender's cash. Someone with ₦10,000 can promise ₦10,000 to two people. The second person to accept gets "The sender no longer holds this much cash."

**Change:**
- Work out *free cash* as the cash held minus the handovers still waiting from that person (`pendingOutKobo`).
- Check a new handover, or any other move out of that person's cash, against free cash. The same check applies to loans, expenses and savings refunds paid from cash, since they all go through `assertCashHeld`.
- The From list shows "Cash held by Usman (₦213,800, ₦20,000 waiting to be handed over)".
- The error reads: "Only ₦X is free. ₦Y is waiting in handovers to Z."

**Question A:** should waiting handovers also block loans and expenses paid from that cash? *Suggested: yes.* Otherwise the handover can still fail when it is accepted.

## 2. The Manager taking an Assistant's cash without their OK

**Now:** the Manager can pick an Assistant's cash in From, hand it to themselves, and accept it. The Assistant isn't told and can't withdraw it.

**Change:**
- **Tell the owner of the cash.** Whenever a move takes cash from someone other than the person recording it, that person gets a notice. For example: "Alhaji moved ₦5,000 of your cash to the Bank."
- **Let them object.** On a waiting handover, the person whose cash it is can withdraw it, alongside the person who recorded it.
- **Stop self-acceptance.** If the Manager records a handover from an Assistant's cash to themselves, it waits for the *Assistant* to confirm "I gave this cash". The Manager's own accept button doesn't appear. Both sides have then agreed.

**Question B:** should the Manager still be able to send an Assistant's cash *straight* to the Bank or the Owner?
- Option 1 (suggested): yes, with the teller photo as proof, and the Assistant is told.
- Option 2: no. Only the Assistant can record moves out of their own cash.

## 3. The bank balance going negative

**Now:** with ₦0 in the bank, a move of ₦999,999,999 from Bank to Owner is saved.

**Change:**
- Once a bank opening balance is set, refuse moves out of the bank beyond the book balance: "The bank book shows only ₦X."
- Before an opening balance is set, the book isn't trusted. Save the move, but show a warning line.
- Moves from the Owner aren't limited, because that is the Owner putting money in.

## 4. A reversal sending cash to a disabled account

**Now:** reversing a bank deposit made by someone who has since been disabled gives the cash back to them, where nobody can move it.

**Change:**
- If the person who would get the cash back is no longer active staff, refuse: "Usman is no longer staff. Record the correction as a move from the Bank instead."
- Also check that the receiver can still hold cash before reversing a handover.

## 5. Clearer messages

- **Sender disabled:** accepting a handover from someone whose account has been disabled says "Usman is no longer staff, so this handover cannot be accepted. Refuse it." It no longer says "no longer holds this much cash".
- **Saving a move:** the message says what happened:
  - "₦20,000 paid into the bank."
  - "₦20,000 handed to the Owner."
  - "Waiting for Usman to accept ₦20,000."

## 6. The form

- Show the teller number and photo only when the move is cash into the bank. Show the reference alone for bank to cash.
- Remove the place already chosen in From from the To list.
- Under the amount, show a line that follows what is typed: "Usman will have ₦193,800 left".
- No JavaScript needed to submit: the server checks stay as they are.

## Not changing

- Who can move money: Manager and Assistant Manager, same as now.
- The ledger tables. No migration is needed. Free cash is worked out from the `money_transfers` rows with status `pending`.

## Tests

New cases in `tests/cash-trail.test.ts`:
1. A second handover beyond free cash is refused.
2. A loan from cash that is held in a waiting handover is refused.
3. A Manager-made handover from an Assistant's cash:
   - the Assistant is told;
   - the Assistant can withdraw it;
   - the Manager can't accept their own.
4. The bank is refused below zero once there is an opening balance, and only warns before one.
5. A reversal to a disabled account is refused.
6. The message when the sender has been disabled.

Then run the full suite, the build, and check the form at 360 px.
