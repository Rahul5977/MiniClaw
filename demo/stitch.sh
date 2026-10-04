#!/usr/bin/env bash
# Joins title cards and scene recordings into one 1920x1080 video: demo/out/miniclaw-demo.mp4.
# Terminal scenes have their idle stretches (waiting for the model) sped up about 2x and
# end with a 2-second hold so the final screen can be read.
set -euo pipefail
cd "$(dirname "$0")/out"
BG=0x1e1e2e   # the terminal theme's background
FIT="scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=$BG,setsar=1"
ENC=(-c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p -r 30 -an)
mkdir -p parts && rm -f parts/*.mp4 parts/list.txt

n=0
part() {  # part <input> <filter>
  n=$((n + 1))
  local out; out=$(printf 'parts/%02d.mp4' "$n")
  ffmpeg -v error -y -i "$1" -vf "$2" "${ENC[@]}" "$out"
  echo "file '$(basename "$out")'" >> parts/list.txt
}
card()  { part "cards/$1.mp4" "fps=30,$FIT"; }
scene() { part "$1" "fps=30,mpdecimate=max=1,setpts=N/(30*TB),$FIT,tpad=stop_mode=clone:stop_duration=2"; }

card 00-intro
card 01; scene 01-basics.mp4
card 02; scene 02-plan.mp4
card 03; scene 03-memory.mp4
card 04; scene 04-skills.mp4
card 05; scene 05-safety.mp4
card 08; part 08-dashboard.mp4 "fps=30,$FIT,tpad=stop_mode=clone:stop_duration=2"
card 06; scene 06-recorder.mp4
card 07; scene 07-evaluation.mp4
card 99-outro

ffmpeg -v error -y -f concat -safe 0 -i parts/list.txt -c copy -movflags +faststart miniclaw-demo.mp4
rm -rf parts
printf 'miniclaw-demo.mp4: %.0f seconds\n' "$(ffprobe -v error -show_entries format=duration -of csv=p=0 miniclaw-demo.mp4)"
