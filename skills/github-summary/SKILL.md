---
name: github-summary
description: Summarize a public GitHub repository - what it is, popularity, and its latest commits.
permissions:
  - net:api.github.com
---
# GitHub repository summary

1. Get the repository as `owner/name`. Accept a full URL like `https://github.com/openclaw/openclaw`.
2. Call `web_fetch` with `https://api.github.com/repos/<owner>/<name>` and
   `fields: ["full_name", "description", "language", "stargazers_count", "forks_count", "open_issues_count", "pushed_at", "license.spdx_id"]`.
3. Call `web_fetch` with `https://api.github.com/repos/<owner>/<name>/commits?per_page=5` and
   `fields: ["*.commit.message", "*.commit.author.name", "*.commit.author.date"]`.
4. Reply with:
   - one sentence on what the project is,
   - stars, forks, open issues, main language and license on one line,
   - the 5 latest commits as bullets: first line of the message, author, date (YYYY-MM-DD).
5. If the API says "Not Found" the repo is private or doesn't exist; say so. If it mentions a rate limit, ask the user to try again later.
