---
name: board-import
description: Put GitHub issues and pull requests on the pi-workgraph board through its import endpoint. Issues become drafts; pull requests become review cards. Use when the user asks to add, import, pull in, queue, or sweep a repo's issues or pull requests (for example "add the issues in emulate" or "put emulate's open PRs up for review"), or to put specific issue, pull request, Linear, or Slack links on the board.
---

# Put work on the board

The board is pi-workgraph-ui. Its address is `$PWUI_URL` when that is set, and
`http://127.0.0.1:4517` otherwise. Start every command block below with:

```sh
board="${PWUI_URL:-http://127.0.0.1:4517}"
```

The board never looks for work on its own. You choose the links, and it creates
one card per link:

- An issue becomes a **draft**. A draft does nothing until Garen approves it on
  the board.
- A pull request becomes a **review card** in the Judging column. What
  happens to it next depends on what the user asked for:
  - Only to add it: the board reviews it on its own, one pull request at a
    time, changes nothing on GitHub, and keeps the findings on the card.
  - Work on it (fix it, check it against something, watch its checks, merge
    it, comment on it): send what they asked as `instructions` with the links.
    The card then runs as work on the board, where every step shows.

The board does the work, not you. Whatever the user asks for beyond adding the
cards goes to the board as `instructions` (see below). Do none of it yourself,
even though you could: no reviewing, no pushing, no approving, no merging, no
commenting on GitHub. Work done from here leaves nothing on the board to look
at, and the board would then do it a second time. A request to add cards does
not authorize approving, editing, or deleting cards. Do not create cards by
any other
route (workgraph tools, `gh issue create`, writing to a store): the endpoint is
what records where each card came from and keeps a repeat from making a second
one.

## Find the repo

```sh
curl -sS "$board/api/projects" | jq -r '.[] | [.id, .name, .path] | @tsv'
```

Each line is a repo's id, its name, and the path of its checkout.

- Match the name the user gave against the name. Take one exact match; if
  there is none, a single case-insensitive match is fine.
- With no match or more than one, ask which repo, listing the names. Do not
  guess, and do not add a repo to the board yourself.
- If curl reports that it could not connect, the board is not reachable at
  that address. Say so, give the address, and stop. Do not start a board
  yourself.
- Keep the id and the checkout path in shell variables named `id` and
  `checkout`. Never assign a variable named `path`: in zsh that replaces the
  command search path, and every later command fails with "command not found".

## Choose the links

Go by what the user asked for: issues, pull requests, or both. If the request
names neither ("add emulate"), ask which.

```sh
# Open issues, one link per line
gh issue list --state open --limit 100 --json url --jq '.[].url'

# Open pull requests, one link per line, drafts left out
gh pr list --state open --draft=false --limit 100 --json url --jq '.[].url'
```

`gh` has to know which GitHub repository to read. The checkout path from the
list above is a directory on the board's machine. When that directory exists
here, run `gh` inside it (`cd "$checkout"`) and it reads the checkout's remote.
When it does not, ask the user for the repository and pass `--repo owner/name`
instead.

Run the list commands by themselves first, so you know the counts and that they
worked.

- When the user narrows the request ("the bugs", "the ones assigned to me",
  "about auth", "the PRs waiting on me"), use gh's own filters: `--label`,
  `--assignee @me`, `--author @me`, `--search 'review-requested:@me'`.
- When the user gives specific links, send those instead of listing anything.
  Issue, pull request, Linear, and Slack links all work.
- Include draft pull requests only when the user asks for them: drop
  `--draft=false`.
- If nothing matches, say so and stop. An empty `urls` list is rejected.
- A request takes at most 100 links. If a list comes back with exactly 100, or
  issues and pull requests together pass 100, tell the user the counts and ask
  how to narrow it before importing anything.

## Import in one request

Keep only the list commands the request calls for:

```sh
board="${PWUI_URL:-http://127.0.0.1:4517}"
cd "$checkout" && {
  gh issue list --state open --limit 100 --json url --jq '.[].url' &&
  gh pr list --state open --draft=false --limit 100 --json url --jq '.[].url'
} | jq -Rn '{urls: [inputs]}' |
  curl -sS -X POST "$board/api/projects/$id/import" \
    -H 'content-type: application/json' -d @-
```

`jq -Rn '{urls: [inputs]}'` turns the lines into the request body. For links
the user gave you, write the body directly: `{"urls": ["...", "..."]}`.

Send every link in ONE request. The board resolves them all before creating
anything and plans the whole batch of drafts in a single run; a request per
link would start a planning run per link.

The reply is JSON:

- `created`: the new cards (`id`, `title`). A review card's title starts with
  `Review PR #`; the rest are drafts.
- `started`: the ids of the pull request cards that were given your
  `instructions` and are now running as work. Empty when you sent none.
- `skipped`: links that already have a card in that repo, closed cards
  included. This is normal on a repeat. Never send `"force": true` unless the
  user explicitly asks for a second card for the same link.
- `existing`: the card each skipped link already has (`ref`, `id`).
- `notes`: degradations worth passing on, such as a missing API key.
- `{"error": "..."}` instead: nothing was created. Report the message; it names
  the link at fault. Sending the same request again is safe.

## When the user asks for work on the pull requests

Put what they asked for in the same request, as `instructions`:

```sh
board="${PWUI_URL:-http://127.0.0.1:4517}"
printf '%s\n' "$link_one" "$link_two" |
  jq -Rn --arg instructions "$instructions" \
    '{urls: [inputs], instructions: $instructions}' |
  curl -sS -X POST "$board/api/projects/$id/import" \
    -H 'content-type: application/json' -d @-
```

- Keep the user's own words for what they want, with every condition they
  gave ("ensure CI is green, then merge", "post a comment saying thanks"). A
  run merges or comments only when the instructions say so in so many words,
  so do not add such a step and do not drop one.
- Whoever reads the instructions has none of this conversation. Replace
  anything only you can resolve ("the monorepo", "the usual checks") with what
  it points to: a repository, a path, a link.
- Instructions reach new pull request cards only. A draft never gets them: an
  issue waits for Garen's approval. Say so if the user expected otherwise.
- A link listed in `existing` already had a card, so the board left it alone.
  If the request is about that pull request too, send its card a follow-up,
  once:

  ```sh
  jq -n --arg instructions "$instructions" '{instructions: $instructions}' |
    curl -sS -X POST "$board/api/projects/$id/issues/$card/follow-up" \
      -H 'content-type: application/json' -d @-
  ```

  A follow-up restarts whatever that card was doing. Never send one twice for
  the same request, and send none for a pull request that is already merged or
  closed (`gh pr view "$link" --json state`); say that it is instead.

## Sweeping more than one repo

Only when the user asks for several repos or all of them. Do one repo at a
time, one request each, and skip repos where `gh` finds no GitHub repository.
Before sweeping every watched repo, tell the user how many cards that would be
in total and wait for a yes: it can be a lot, and every pull request card
starts a review.

## Report

Say, per repo, how many drafts and how many review cards were added and how
many links were already on the board. List the new titles when there are ten or
fewer. The cards are at `$board/#/board/<id>`. Do not claim anything was
approved or reviewed: importing only creates cards. For pull requests you only
added, say that the board will review them one at a time and that the findings
will be on each card. For pull requests you sent instructions for, say that the
board has started work on them and that its progress shows on each card. Never
report an outcome (fixed, merged, commented) that you did not see.
