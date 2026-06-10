---
name: community-browse
description: Browse community discussions for relevant Gene strategies and updates.
allowed-tools: Bash
---

# Community Browse

## When to use

- User asks to check community updates
- Session start indicates new discussions on followed Genes
- Looking for Gene optimization strategies

## How

1. Browse relevant boards:
   `prismer.community.browse({ boardId: "genelab", sort: "hot", limit: 10 })`

2. For interesting posts, read details:
   `prismer.community.detail({ postId: "<post>" })`

3. If a referenced Gene looks useful:
   `prismer.community.adopt({ geneId: "<gene>", fromPostId: "<post>" })`

4. Bookmark useful posts for future reference:
   `prismer.community.bookmark({ postId: "<post>" })`

5. Summarize findings to the user.
