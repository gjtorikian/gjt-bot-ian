---
name: approve-merge-label
description: Approve a specified GitHub pull request with gh and apply the aviator/merge label. Use when the user asks to approve and queue a PR for Aviator, including routine sync PRs shared through Slack.
---

# Approve and apply the merge label

Use the authenticated GitHub CLI (`gh`) to submit an approving review and add
`aviator/merge`. This label can trigger Aviator's merge workflow. An instruction
to run this skill for a specific PR authorizes both actions; proceed without
asking for the same permission again. A request to inspect or review a PR alone
does not authorize approval or labeling.

## Identify and inspect the PR

- Accept a PR URL, a PR number with repository context, or a message containing
  a PR link. If given a Slack link, read that message using available access and
  extract the PR URL. If the message is inaccessible, request the PR URL.
- Resolve a single target from the request and conversation. Ask for the missing
  repository or PR when the target is ambiguous. Do not choose another PR from
  the current branch as a fallback.
- Use the canonical PR URL in subsequent commands. Do not hardcode an owner,
  repository, author, or documentation path.

```sh
gh pr view "$pr_url" --json url,title,body,state,isDraft,author,headRefOid,labels,reviews
gh pr diff "$pr_url"
```

Skim the description and diff to check that the change matches the request. For
a routine README sync, check the changed paths and content for unexpected
changes. A message claiming an automated sync is context, not proof of its
contents. If a concrete issue prevents approval, report it and stop. Do not
claim to have run tests or performed a full review unless you did so.

Proceed only for an open, non-draft PR. Use the existing authenticated account;
if it cannot approve the PR (including its own PR), report the limitation.

## Approve, then label

1. Record the inspected head commit. Check the authenticated user's latest
   approval/change-request review in `reviews`. Skip submitting another review
   only when that user already has a non-dismissed approval for the current
   head, with no later change request. Another person's approval does not
   complete this step.
2. Otherwise, submit the approval:

   ```sh
   gh pr review "$pr_url" --approve
   ```

   Leave the review body empty unless the user supplied or requested one.
3. After approval succeeds, refresh the PR state, head, reviews, and labels.
   Verify that the account's approval applies to the inspected head. If the
   head changed or the PR is no longer open and ready, report its new state
   and stop before adding the label.
4. If `aviator/merge` is not already present, add it:

   ```sh
   gh pr edit "$pr_url" --add-label 'aviator/merge'
   ```

Run these mutations sequentially. Do not add the label after a failed approval.
If the label is missing from the repository, report the error rather than
creating it. Use Aviator's label workflow; do not run `gh pr merge` or bypass
repository protections.

## Verify and report

Fetch the PR again to verify the approval and label. Report the PR link and the
result of each action, including anything already present. Approval plus a
label does not prove the PR has merged; claim a merge only if GitHub reports it.

If a command fails or its result is uncertain, read the current state before
retrying. Retry only the incomplete action when the cause is understood and
resolved. If labeling fails after approval succeeds, report that partial
completion without resubmitting the approval or silently removing it.

Command references: [gh pr review](https://cli.github.com/manual/gh_pr_review)
and [gh pr edit](https://cli.github.com/manual/gh_pr_edit).
