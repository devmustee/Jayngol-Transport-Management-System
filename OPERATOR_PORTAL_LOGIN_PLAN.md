# Jayngol Plan: Setting Up an Operator's Portal Login

Status: Built (19 Nov 2026) with the suggested answers, not yet released.

**As built:**
- On the operator's Details, Portal login reads "Not set up · Set up login" or "Set up · Reset PIN". The link opens the PIN form, which now sits directly under Details.
- Edit has a Portal login section under Guarantor, saved in the same step as the details. An empty PIN leaves the login as it is.
- Only a working operator can be given a login. A login stops working, and the operator is signed out, when they leave or are sacked; it works again if they are reinstated.
- The Operators list has a "No portal login" filter, and each working operator without a login is marked.
- The code is `updateOperator` and `listOperators` in src/services/operators.ts, `setOperatorPin` in src/services/users.ts, and `login` and `resolveSession` in src/services/auth.ts. It is covered in tests/access.test.ts.
- No database change.

## 1. What happens today

- **Where it is now:** the Manager can already set an operator's portal login. It is a closed **Set up portal login** section near the bottom of the operator's page, under the deposit, the statement buttons and the tricycle history. Nothing points to it.
- **On Details:** the row "Portal login: Not set up" is plain text, not a link.
- **On Edit:** the Edit page has no login section. The PIN box appears only when an operator is first added.
- **Why most operators show "Not set up":**
  - Operator portal logins were removed when the system was prepared for go-live.
  - Operators added since were added without a PIN, so they show "Not set up" too.

Nothing is broken. The control is hard to find, and the Edit page, where the Manager naturally looks, doesn't have it.

## 2. The fix

1. **"Not set up" leads somewhere.** On the operator's Details card, the Portal login row reads:
   - **Not set up · Set up login**, where "Set up login" goes to the login section;
   - **Set up · Reset PIN**, once a login exists.
2. **The login section moves up**, directly under Details, and opens by itself when it was reached from that link.
3. **The Edit page gets a "Portal login" section** under Guarantor:
   - **When there's no login:** "6-digit PIN (optional)". Leave it empty to save the other changes without a login.
   - **When a login exists:** "New PIN (optional)". Leave it empty to keep the current PIN.
   - **One save:** the details and the PIN are saved together, so the operator never ends up with one saved and not the other.
4. **Only the Manager and Assistant Manager see these controls (as today, `operator.manage`).** The PIN is never shown again after saving.
5. **Who can have a login:** only operators who are working. Operators who have left or been sacked don't get the set-up link (question 2).
6. **The Operators list** gets a "No portal login" filter, so the Manager can see who still needs one.

No database change. The login already uses the operator's phone number and stays in step when the phone changes.

## 3. Questions for the owner

| # | Question | Suggested answer |
| --- | --- | --- |
| 1 | Should the Assistant Manager also be able to set an operator's PIN, or only the Manager? | Both, as today. |
| 2 | Should operators who have left keep or get a login? | No new login for them. An existing one stops working when they leave (check, and fix if it does not). |
| 3 | Should the operator be told their PIN by the system? | No. The Manager tells them in person, since SMS is off. |

## 4. Work and tests

Half a day.

- On a working operator's page, "Set up login" reaches a PIN form, and saving it makes Details read "Set up".
- On Edit, an empty PIN saves the details and leaves the login as it was. A filled PIN creates or resets the login in the same save.
- A wrong PIN (not 6 digits) shows its error, and nothing is saved.
- A phone number already used by another login shows "This phone number is already used by another login.", and nothing is saved.
- An operator who has left has no set-up link.
- The operator can sign in with their phone number and the new PIN.
- Every form works at 375 px.
