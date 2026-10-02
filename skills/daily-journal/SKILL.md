---
name: daily-journal
description: Keep a private daily journal in the workspace - add entries, or read back past days.
permissions:
  - fs:read
  - fs:write
---
# Daily journal

Journal files are in the workspace at journal/ followed by the date and .md, for example journal/2026-10-02.md.
Use today's date and time from the system prompt.

To add an entry, your very next action is to call the write_file tool. Do not read the file first and do not
show the entry to the user first. Give write_file these arguments:
- path: today's journal file, e.g. journal/2026-10-02.md
- append: true (so older entries are kept)
- content: a blank line, then "## " and the current local time (HH:MM) from the system prompt,
  then the entry in the user's own words, without a leading "Journal:"

After the tool confirms it, reply with one short sentence such as "Added to today's journal."

To read back what the user wrote on a day, call the read_file tool with that day's file and summarize it.
If the file does not exist, there is no entry for that day.
