# Scene 1: setup check, a file task with a diff approval, and undo.
Output demo/out/01-basics.mp4

Set Shell "bash"
Set FontSize 18
Set Width 1280
Set Height 760
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 35ms
Set WindowBar Colorful
Set WindowBarSize 36

Hide
Type "demo/setup.sh >/dev/null && cd /tmp/miniclaw-demo && export PS1='\[\e[1;35m\]miniclaw-demo\[\e[0m\] $ ' && alias miniclaw='bun ~/Desktop/OpenClaw/src/index.ts' && clear"
Enter
Sleep 1s
Show

# 1. Is everything set up?
Type "miniclaw doctor"
Sleep 400ms
Enter
Wait@60s /\$\s*$/
Sleep 3s

# 2. Chat: read a file, write a summary (approval with a diff), then undo it.
Type "clear && miniclaw chat"
Enter
Wait@30s /you ›/
Sleep 1s
Type "Read notes.txt and save a 2-bullet summary to summary.md"
Sleep 500ms
Enter
Wait@120s /Allow\?/
Sleep 3s
Type "y"
Enter
Wait@120s /you ›/
Sleep 3s

Type "/history"
Enter
Sleep 2s
Type "/undo"
Enter
Sleep 3s
Type "/exit"
Enter
Sleep 1s
Type "ls workspace"
Enter
Sleep 3s
