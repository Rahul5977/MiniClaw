#!/usr/bin/env bash
# Prints a centered title card in the terminal (used by VHS to render cards between scenes).
# Usage: card.sh "Title" "Subtitle" ["extra line"...]
cols=$(tput cols); rows=$(tput lines)
center() { local text="$1" plain; plain=$(printf '%s' "$text" | sed 's/\x1b\[[0-9;]*m//g'); printf '%*s%s\n' $(( (cols - ${#plain}) / 2 )) '' "$text"; }
clear
lines=$(( $# + 2 ))
for _ in $(seq 1 $(( (rows - lines) / 2 ))); do echo; done
center $'\e[1;38;5;216m'"$1"$'\e[0m'
echo
center $'\e[38;5;189m'"$2"$'\e[0m'
shift 2
for extra in "$@"; do echo; center $'\e[2m'"$extra"$'\e[0m'; done
tput civis
