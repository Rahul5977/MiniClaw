# Scene 3: memory (I-5): the agent proposes, you confirm; it remembers after a restart; /forget.
Output demo/out/03-memory.mp4
Source demo/tapes/_settings.tape

Hide
Type "demo/setup.sh >/dev/null && cd /tmp/miniclaw-demo && export PS1='\[\e[1;35m\]miniclaw-demo\[\e[0m\] $ ' && alias miniclaw='bun ~/Desktop/OpenClaw/src/index.ts' && clear"
Enter
Sleep 1s
Show

Type "miniclaw chat"
Enter
Wait@30s /you ›/
Sleep 1s
Type "Hi! I'm Rahul. I'm vegetarian and I live in Patna."
Sleep 500ms
Enter
Wait@120s /later\]/
Sleep 2s
Type "y"
Enter
Wait@30s /later\]/
Sleep 2s
Type "y"
Enter
Wait@30s /you ›/
Sleep 1s
Type "/memory"
Enter
Sleep 3s
Type "/exit"
Enter
Sleep 1s

# Restart: a new conversation still knows the confirmed facts.
Type "clear && miniclaw chat"
Enter
Wait@30s /you ›/
Type "/new"
Enter
Sleep 1s
Type "Suggest one dinner dish for me tonight. One line."
Sleep 500ms
Enter
Wait@120s /you ›/
Sleep 3s
Type "/forget patna"
Enter
Wait@30s /no\]/
Sleep 1s
Type "y"
Enter
Sleep 1s
Type "/memory"
Enter
Sleep 3s
Type "/exit"
Enter
Sleep 1s
Type "cat data/memory/MEMORY.md | tail -3"
Enter
Sleep 3s
