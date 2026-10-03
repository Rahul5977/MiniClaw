# Task benchmark: llama3.1:8b

- 30 tasks × 2 run(s), 2026-10-03 12:53
- The simulated user approves every action; web content is faked for repeatable results.

| Metric | Value |
|---|---|
| **Task success rate** | **46/60 (77%)** |
| Tool-call validity | 64/65 (98%) |
| Avg model steps per task | 2.0 |
| Avg time per task | 18.2 s |
| Avg prompt tokens per task | 3,354 |
| Runs needing a nudge | 1/60 |

| Category | Success |
|---|---|
| chat | 4/6 (67%) |
| files | 12/14 (86%) |
| shell | 4/4 (100%) |
| web | 5/6 (83%) |
| memory | 6/6 (100%) |
| reminders | 7/8 (88%) |
| notes | 2/2 (100%) |
| skills | 2/6 (33%) |
| multi-step | 4/8 (50%) |

Failures:

- `chat-no-tools`: used tools or no joke
- `chat-no-tools`: used tools or no joke
- `file-copy`: final.txt missing or different
- `file-copy`: final.txt missing or different
- `web-to-file`: solar.md missing or off-topic
- `reminder-cancel`: left: Go to the gym, Call mom
- `skill-weather`: temperature missing
- `skill-weather`: temperature missing
- `skill-journal`: journal entry missing
- `skill-journal`: journal entry missing
- `multi-csv-total`: total.txt has: 0
- `multi-csv-total`: total.txt has: 0
- `multi-web-reminder`: no reminder at 09:00 on 20 Oct
- `multi-web-reminder`: no reminder at 09:00 on 20 Oct
