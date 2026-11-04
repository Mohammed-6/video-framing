#!/bin/sh
# Side-by-side check of reframing: source frames vs rendered 9:16 frames at the same moments.
# Run inside the media-worker container:
#   sh compare-frames.sh <source blob> <render blob> <clip start seconds> <out.png> [t1 t2 t3]
set -e
SRC="/data/blobs/$1"; OUT="/data/blobs/$2"; START="$3"; DEST="$4"; shift 4
TIMES="${*:-2 9 16}"
cd /tmp
inputs=""; n=0
for t in $TIMES; do
  s=$(python -c "print($t + $START)")
  ffmpeg -loglevel error -y -ss "$s" -i "$SRC" -frames:v 1 -vf scale=-2:480 "src_$t.png"
  ffmpeg -loglevel error -y -ss "$t" -i "$OUT" -frames:v 1 -vf scale=-2:480 "out_$t.png"
  inputs="$inputs -i src_$t.png -i out_$t.png"; n=$((n + 2))
done
ffmpeg -loglevel error -y $inputs -filter_complex "hstack=inputs=$n" "$DEST"
echo "wrote $DEST"
