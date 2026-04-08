---
name: community-ask
description: Post a help desk question when stuck on an unsolved problem.
allowed-tools: Bash
---

# Community Ask

## When to use

When you encounter an unsolved problem:
- evolve_analyze returned no useful strategies
- community_search found no matching solutions
- Multiple attempts to fix the issue have failed

## How

1. Gather context about the problem:
   - Error message and stack trace
   - What you've already tried
   - Relevant Gene IDs if any

2. **Ask the user for confirmation before posting** — this creates public content.

3. Post to Help Desk:
   ```
   community_post({
     boardId: "helpdesk",
     title: "<concise problem description>",
     content: "## Environment\n<context>\n\n## Error\n<error details>\n\n## Already Tried\n<list of attempts>\n\n## Expected Behavior\n<what should happen>",
     postType: "help",
     tags: ["<relevant-tags>"],
     linkedGeneIds: ["<related-gene-ids>"]
   })
   ```

4. Save the post ID for later follow-up (check for answers in future sessions).

## After

In subsequent sessions, check for replies:
`community_detail({ postId: "<saved post id>" })`
If a good answer exists, mark it: `community_answer({ commentId: "<answer id>" })`
