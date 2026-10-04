# Scene 4: skills with permission manifests (I-6): consent on first use, then the answer.
Output demo/out/04-skills.mp4
Source demo/tapes/_settings.tape

Hide
Type "MINICLAW_DEMO_SKILLS=1 demo/setup.sh >/dev/null && cd /tmp/miniclaw-demo && export PS1='\[\e[1;35m\]miniclaw-demo\[\e[0m\] $ ' && alias miniclaw='bun ~/Desktop/OpenClaw/src/index.ts' && clear"
Enter
Sleep 1s
Show

Type "miniclaw skills"
Enter
Sleep 4s
Type "clear && miniclaw chat"
Enter
Wait@30s /you ›/
Sleep 1s
Type "What's the weather in Delhi right now?"
Sleep 500ms
Enter
Wait@120s /Allow\?/
Sleep 3s
Type "y"
Enter
Wait@120s /Allow\?/
Sleep 3s
Type "a"
Enter
Wait@120s /you ›/
Sleep 3s
Type "Who was Alan Turing? Two sentences."
Sleep 500ms
Enter
Wait@120s /Allow\?/
Sleep 3s
Type "y"
Enter
Wait@120s /you ›/
Sleep 3s
Type "/skills"
Enter
Sleep 4s
Type "/exit"
Enter
Sleep 1s
